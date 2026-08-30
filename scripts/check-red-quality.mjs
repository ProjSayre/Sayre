#!/usr/bin/env node
// PL-CI-QUAL: the red-test quality / anti-dupe gate. Blocks two failure classes a purely mechanical
// "does the file exist and hash-match" check (scripts/check-red-integrity.mjs) cannot see: an
// undeclared duplicate @spec covering a requirement an existing test already covers, and a "test"
// that never actually asserts anything (empty stub, or an assertion that is true by construction and
// proves nothing). `red` self-runs this before finishing; `tester` is the sole authoritative,
// gating invocation, publishing the verdict on its own JSON sidecar for `review` to consume — this
// script itself is never re-run by `review`.
//
// Usage:
//   node scripts/check-red-quality.mjs [--json] [--dir <pipelineDir>] [--cwd <repoRoot>]
//
// Exit codes:
//   0 — status "clean" (no blocking violation; an advisory may still be present) or "no-red-json"
//       (no red-stage JSON sidecar for this run — the /pipeline-lite and /inline-edit lanes).
//   1 — status "violations-found" (at least one blocking violation).
//   2 — the check could not be performed at all (an unrecognized flag, an unreadable/invalid red-stage
//       JSON sidecar, or a listed test file that cannot be read). Never reported as "clean".
//
// Reads only the red-stage JSON sidecar, through pipeline-contracts.mjs's readRedJson — never any
// markdown report, and nothing from the planning stage's own JSON or markdown either. Human output
// goes to stdout on a completed run (clean, violations-found, or no-red-json) and to stderr on a
// tooling failure, every line prefixed "check-red-quality: ".
//
// Known limitations, documented rather than overclaimed (see PL-CI-QUAL's edge cases EC-5/EC-6):
// (1) a segment runs from one @spec marker to the next, so a single marker covering
// several test blocks is satisfied by any one assertion anywhere in that span — an assertion-free
// block later in the same segment is not separately caught. Mark every test individually for full
// per-test coverage. (2) an assertion-shaped token appearing only inside a comment or a string
// literal (e.g. a test whose real subject is the literal text "expect(") still counts as an
// assertion — this is plain text scanning, not an AST parse, so it can be satisfied spuriously.

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRedJson } from './pipeline-contracts.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(scriptsDir, '..');

/** The four blocking violation kinds this script can report. */
export const QUALITY_VIOLATION_KINDS = [
  'duplicate-spec-id', 'no-assertion', 'tautological-only', 'bad-duplicate-declaration',
];

/** The one advisory kind — reported, never blocking, never affecting the exit code. */
export const QUALITY_ADVISORY_KINDS = ['twin-file'];

/** Substrings/regexes counted as "this segment asserts something." Deliberately plain text
 * scanning, not an AST parse — see this file's header for the two documented false-positive/
 * false-negative limitations that follow from that choice. Covers Node's `assert`/`assert.*`
 * (TS/JS), Jest/Vitest `expect(...)`, chai's `.should.`, Python's `unittest` `self.assert*(...)`,
 * and a bare Python `assert <expr>` statement. */
export const ASSERTION_PATTERNS = [
  /\bassert\.\w+\(/,
  /\bself\.assert\w+\(/,
  /\bassert\s*\(/,
  /\bassert\s+[^\s(]/,
  /\bexpect\(/,
  /\.should\./,
];

/** Regexes for an assertion that is true by construction and proves nothing — the "tautological"
 * half of R4. A segment whose every matched assertion is also one of these is `tautological-only`. */
export const TAUTOLOGY_PATTERNS = [
  /\bassert\.ok\(\s*true\s*\)/,
  /\bassert\(\s*true\s*\)/,
  /\bexpect\(\s*true\s*\)\.toBe\(\s*true\s*\)/,
  /\bassert\.strictEqual\(\s*1\s*,\s*1\s*\)/,
  /\bassert\.equal\(\s*1\s*,\s*1\s*\)/,
  /^[ \t]*assert\s+True[ \t]*$/m,
];

// A listed test file matching this pattern counts as a candidate sibling for R5's twin-file check —
// the same convention scripts/check-red-integrity.mjs's own TEST_FILE_PATTERN uses.
const TEST_FILE_PATTERN = /\.test\.(m?js|ts|tsx)$|(^|\/)test_[^/]+\.py$/;

// A `@spec <ID> [<ID> ...]` marker, in either // or # comment idiom — the id list is whatever
// follows on that same line.
const SPEC_MARKER_RE = /@spec[ \t]+((?:(?:AC|EC)-\d+[a-z]?[ \t]*)+)/;

/**
 * Split a test file's content into one segment per `@spec` marker: from the marker line through the
 * line before the next `@spec` marker (or EOF). Text above the first marker is not a segment.
 * @param {string} content
 * @returns {Array<{ specIds: string[], startLine: number, text: string }>}
 */
export function specSegments(content) {
  const lines = content.split(/\r?\n/);
  const segments = [];
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const match = SPEC_MARKER_RE.exec(lines[i]);
    if (match) {
      if (current) segments.push(current);
      const specIds = match[1].trim().split(/\s+/).filter(Boolean);
      current = { specIds, startLine: i + 1, text: `${lines[i]}\n` };
    } else if (current) {
      current.text += `${lines[i]}\n`;
    }
  }
  if (current) segments.push(current);
  return segments;
}

/** The basename up to (not including) its first "." — "widget.extra.test.mjs" and "widget.test.mjs"
 * share the stem "widget". Used only by R5's twin-file comparison. */
function stem(filename) {
  const idx = filename.indexOf('.');
  return idx === -1 ? filename : filename.slice(0, idx);
}

/** Removes every TAUTOLOGY_PATTERNS match from `text`, then asks whether any ASSERTION_PATTERNS
 * match remains — i.e. whether at least one assertion in this segment is NOT tautological. */
function hasNonTautologicalAssertion(text) {
  let stripped = text;
  for (const pattern of TAUTOLOGY_PATTERNS) {
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
    stripped = stripped.replace(new RegExp(pattern.source, flags), '');
  }
  return ASSERTION_PATTERNS.some((pattern) => pattern.test(stripped));
}

/**
 * Pure evaluator over already-read inputs — no disk or git access here, so the test suite can drive
 * every rule directly without a temp repo per case.
 * @param {{ tests: Array<{ path: string, specIds: string[], sha256: string,
 *                          classification: string, duplicateOf?: string,
 *                          justification?: string, extends?: string }>,
 *          fileContents: Map<string, string>,
 *          newFiles: Set<string> | null,
 *          siblingTestFiles: Map<string, string[]> }} input
 * @returns {{ ok: boolean, filesChecked: string[], violations: Array<{kind:string,path:string,detail:string}>,
 *             advisories: Array<{kind:string,path:string,detail:string}>, notes: string[] }}
 */
export function evaluateRedQuality({ tests, fileContents, newFiles, siblingTestFiles }) {
  const violations = [];
  const advisories = [];
  const notes = [];
  const filesChecked = tests.map((test) => test.path);
  const byPath = new Map(tests.map((test) => [test.path, test]));

  // R1 (self case) / EC-7 — one entry citing the same id twice in its own specIds.
  for (const test of tests) {
    const seen = new Set();
    const selfDupes = new Set();
    for (const id of test.specIds) {
      if (seen.has(id)) selfDupes.add(id);
      seen.add(id);
    }
    for (const id of selfDupes) {
      violations.push({
        kind: 'duplicate-spec-id',
        path: test.path,
        detail: `"${test.path}" lists "${id}" twice within its own specIds array — a self-duplication, not a cross-file overlap.`,
      });
    }
  }

  // R1 (cross-file case) — an id cited by two or more distinct entries.
  const idToEntries = new Map();
  for (const test of tests) {
    for (const id of new Set(test.specIds)) {
      if (!idToEntries.has(id)) idToEntries.set(id, []);
      idToEntries.get(id).push(test);
    }
  }
  for (const [id, entries] of idToEntries) {
    if (entries.length < 2) continue;
    for (let i = 1; i < entries.length; i++) {
      const entry = entries[i];
      const target = entry.duplicateOf ? byPath.get(entry.duplicateOf) : null;
      const legitimate = Boolean(
        target && target.specIds.includes(id) && entry.justification && entry.justification.trim().length > 0,
      );
      if (!legitimate) {
        violations.push({
          kind: 'duplicate-spec-id',
          path: entry.path,
          detail: entry.duplicateOf
            ? `"${entry.path}" cites "${id}", already covered by "${entries[0].path}", and its duplicateOf ("${entry.duplicateOf}") does not legitimately explain this overlap.`
            : `"${entry.path}" cites "${id}", already covered by "${entries[0].path}", with no duplicateOf declared.`,
        });
      }
    }
  }

  // R2 — a duplicateOf declaration that doesn't describe a real overlap.
  for (const test of tests) {
    if (!test.duplicateOf) continue;
    const target = byPath.get(test.duplicateOf);
    if (!target) {
      violations.push({
        kind: 'bad-duplicate-declaration',
        path: test.path,
        detail: `"${test.path}"'s duplicateOf ("${test.duplicateOf}") does not name another entry in the red-stage test list.`,
      });
      continue;
    }
    const overlaps = test.specIds.some((id) => target.specIds.includes(id));
    if (!overlaps) {
      violations.push({
        kind: 'bad-duplicate-declaration',
        path: test.path,
        detail: `"${test.path}"'s duplicateOf ("${test.duplicateOf}") shares no specIds with the declaring entry.`,
      });
    }
  }

  // R3 / R4 — every @spec segment in every listed file needs a real, non-tautological assertion.
  for (const test of tests) {
    const content = fileContents.get(test.path) ?? '';
    const segments = specSegments(content);
    if (segments.length === 0) {
      notes.push(`"${test.path}" carries no "@spec" marker at all — check-red-integrity.mjs owns that gap; there is nothing for R3/R4 to check here.`);
      continue;
    }
    for (const segment of segments) {
      const idList = segment.specIds.join(' ');
      const hasAssertion = ASSERTION_PATTERNS.some((pattern) => pattern.test(segment.text));
      if (!hasAssertion) {
        violations.push({
          kind: 'no-assertion',
          path: test.path,
          detail: `"${test.path}": the @spec ${idList} segment starting at line ${segment.startLine} has no assertion — it reads like a stub, not a real test.`,
        });
        continue;
      }
      if (!hasNonTautologicalAssertion(segment.text)) {
        violations.push({
          kind: 'tautological-only',
          path: test.path,
          detail: `"${test.path}": the @spec ${idList} segment starting at line ${segment.startLine} has only assertions that are true by construction — it proves nothing.`,
        });
      }
    }
  }

  // R5 — twin-file advisory (never blocking). Skipped entirely, with a note, when the caller could
  // not determine which listed files are new this run (no git, or not a repository).
  if (newFiles === null) {
    notes.push('git is unavailable, or this is not a git repository — the twin-file (R5) advisory check was skipped entirely.');
  } else {
    for (const test of tests) {
      if (!newFiles.has(test.path)) continue;
      const ownStem = stem(basename(test.path));
      const siblings = siblingTestFiles.get(test.path) ?? [];
      const twin = siblings.find((name) => stem(name) === ownStem);
      if (!twin) continue;
      if (test.extends) {
        if (fileContents.has(test.extends)) continue; // a real, readable extends target suppresses it
        notes.push(`"${test.path}" declares extends "${test.extends}", which does not exist on disk — the twin-file advisory is not suppressed by a dangling declaration.`);
      }
      advisories.push({
        kind: 'twin-file',
        path: test.path,
        detail: `"${test.path}" is new this run and shares its stem with sibling test file "${twin}" in the same directory — consider extending it (declare "extends") instead of a near-twin.`,
      });
    }
  }

  return { ok: violations.length === 0, filesChecked, violations, advisories, notes };
}

/** Read-only `git` plumbing, tolerating every failure (not a repository, no HEAD yet, git missing
 * from PATH) by returning `{ available: false }` rather than throwing — R5 fails soft on any of
 * those, per this script's own documented EC-11/EC-17 behavior. */
function computeGitContext(repoRoot) {
  try {
    const out = execFileSync('git', ['ls-tree', '-r', '--name-only', 'HEAD'], {
      cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    const headFiles = new Set(out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
    return { available: true, headFiles };
  } catch {
    return { available: false, headFiles: null };
  }
}

/**
 * Reads the red-stage JSON sidecar (via pipeline-contracts.mjs's readRedJson) and the files it
 * lists from disk, then evaluates R1–R5. Throws on anything that makes the check impossible — a
 * malformed sidecar, or a listed file that cannot be read — which the CLI turns into exit 2.
 * @param {{ pipelineDir?: string, repoRoot?: string }} [opts]
 * @returns {{ status: string, ok: boolean, filesChecked: string[],
 *             violations: Array<{kind:string,path:string,detail:string}>,
 *             advisories: Array<{kind:string,path:string,detail:string}>, notes: string[] }}
 */
export function checkRedQuality({ pipelineDir, repoRoot } = {}) {
  const resolvedRepoRoot = repoRoot ?? defaultRepoRoot;
  const resolvedPipelineDir = pipelineDir ?? join(resolvedRepoRoot, '.pipeline');

  const redJson = readRedJson(resolvedPipelineDir, { required: false });
  if (redJson === null) {
    return {
      status: 'no-red-json', ok: true, filesChecked: [], violations: [], advisories: [],
      notes: [`No red-stage JSON sidecar under "${resolvedPipelineDir}" for this run — nothing to check.`],
    };
  }

  const tests = redJson.tests;
  const fileContents = new Map();
  for (const test of tests) {
    const absolutePath = join(resolvedRepoRoot, test.path);
    let content;
    try {
      content = readFileSync(absolutePath, 'utf8');
    } catch (error) {
      throw new Error(`"${test.path}" is listed as a test but could not be read (${error.message}).`);
    }
    fileContents.set(test.path, content);
  }
  // Best-effort: also read a declared extends target, if any, purely as an existence/readability
  // signal for R5's dangling-extends case (EC-10) — never throws when the target is missing.
  for (const test of tests) {
    if (test.extends && !fileContents.has(test.extends)) {
      try {
        fileContents.set(test.extends, readFileSync(join(resolvedRepoRoot, test.extends), 'utf8'));
      } catch {
        // Leave absent — this absence is exactly the signal evaluateRedQuality's R5 reads.
      }
    }
  }

  const gitContext = computeGitContext(resolvedRepoRoot);
  const notes = [];
  let newFiles = null;
  if (gitContext.available) {
    newFiles = new Set(tests.filter((test) => !gitContext.headFiles.has(test.path)).map((test) => test.path));
  }

  const siblingTestFiles = new Map();
  for (const test of tests) {
    const absoluteDir = dirname(join(resolvedRepoRoot, test.path));
    let entries = [];
    try {
      entries = readdirSync(absoluteDir);
    } catch {
      entries = [];
    }
    const ownBasename = basename(test.path);
    siblingTestFiles.set(
      test.path,
      entries.filter((name) => name !== ownBasename && TEST_FILE_PATTERN.test(name)),
    );
  }

  const evaluation = evaluateRedQuality({ tests, fileContents, newFiles, siblingTestFiles });
  return {
    status: evaluation.violations.length > 0 ? 'violations-found' : 'clean',
    ok: evaluation.violations.length === 0,
    filesChecked: evaluation.filesChecked,
    violations: evaluation.violations,
    advisories: evaluation.advisories,
    notes: [...notes, ...evaluation.notes],
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = 'Usage: node scripts/check-red-quality.mjs [--json] [--dir <pipelineDir>] [--cwd <repoRoot>]';

function parseArgs(argv) {
  let jsonMode = false;
  let dir = null;
  let cwd = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') {
      jsonMode = true;
      continue;
    }
    if (arg === '--dir') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`--dir requires a path value (got ${value === undefined ? '(nothing)' : JSON.stringify(value)}).`);
      }
      dir = value;
      i++;
      continue;
    }
    if (arg === '--cwd') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`--cwd requires a path value (got ${value === undefined ? '(nothing)' : JSON.stringify(value)}).`);
      }
      cwd = value;
      i++;
      continue;
    }
    throw new Error(`unrecognized flag "${arg}" — known flags: --json, --dir <path>, --cwd <path>. A typo'd flag must never look like it worked.`);
  }
  return { jsonMode, dir, cwd };
}

function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`check-red-quality: ${error.message}\n  ${USAGE}\n`);
    process.exit(2);
  }

  const repoRoot = parsed.cwd ? resolve(parsed.cwd) : defaultRepoRoot;
  const pipelineDir = parsed.dir ? resolve(parsed.dir) : join(repoRoot, '.pipeline');

  let result;
  try {
    result = checkRedQuality({ pipelineDir, repoRoot });
  } catch (error) {
    process.stderr.write(`check-red-quality: ${error.message}\n`);
    process.exit(2);
  }

  const output = {
    status: result.status,
    filesChecked: result.filesChecked,
    violations: result.violations,
    advisories: result.advisories,
    notes: result.notes,
  };

  if (parsed.jsonMode) {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } else if (result.status === 'no-red-json') {
    process.stdout.write(`check-red-quality: ${result.notes[0]}\n`);
  } else {
    process.stdout.write(`check-red-quality: ${output.filesChecked.length} file(s) checked, ${output.violations.length} violation(s), ${output.advisories.length} advisory(ies).\n`);
    for (const note of output.notes) process.stdout.write(`check-red-quality: note: ${note}\n`);
  }

  if (result.status === 'violations-found') {
    for (const violation of output.violations) {
      process.stderr.write(`check-red-quality: [${violation.kind}] ${violation.path}: ${violation.detail}\n`);
    }
    process.stderr.write(`check-red-quality: ${output.violations.length} violation(s) found — see above.\n`);
    process.exit(1);
  }
  process.exit(0);
}

// realpathSync resolves macOS /var/folders -> /private/var/folders symlinks so the comparison holds
// whether the script is invoked from the real checkout or from a mkdtemp fixture root.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
