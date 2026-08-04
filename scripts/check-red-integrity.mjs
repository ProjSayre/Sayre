// Mechanically checks the two guarantees .sdd/stages/review.md's "Red-test integrity" and
// "Spec trace" checks describe (PL-03c review Critical 3): that no file red.md hashed has changed
// without an explicit, named declaration in changes.md, and that every behavioral test red.md lists
// cites a @spec marker that actually resolves to a real AC-*/EC-* item in spec.md.
//
// Usage:
//   node scripts/check-red-integrity.mjs
//
// Why this exists as a script rather than review-stage prose (see .sdd/stages/review.md and
// changes.md's "Deviations from spec" for the full reasoning): an LLM reviewer cannot compute a
// SHA-256 digest by reading a file — honoring the old prose instruction already meant shelling out
// to a hash command, ad hoc, with no fixture and no record of whether it ran correctly. This script
// is that same mechanical step, committed once instead of retyped from prose every run.
//
// What this script decides mechanically, and what it deliberately leaves to `review`'s judgment:
//   - MECHANICAL (this script): did a listed file's content hash change; is the change named in
//     changes.md's "## Red-test changes" section; does every cited @spec ID actually resolve to a
//     real AC-*/EC-* item in spec.md; is red.md internally consistent (non-empty Impact map, no
//     RED-BROKEN entry left in it).
//   - JUDGMENT (stays with `review`, per .sdd/stages/review.md): is the *reason* given for a
//     declared red-test change legitimate; is a new, marker-less test file actually behavioral.
//
// Exits 0 with a JSON report printed to stdout when there is nothing to block on (including the
// legitimate "no .pipeline/red.md for this run" case — a ticket that predates the `red` stage, or a
// re-invocation of review with no red stage in this run, same as this very ticket's own first
// review round). Exits 1 (also printing the same JSON report, plus a summary line to stderr) when
// any mechanical violation is found.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractSection } from './build-ledger-index.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');
const pipelineDir = join(repoRoot, '.pipeline');

const TEST_FILE_PATTERN = /\.test\.(m?js|ts|tsx)$|(^|\/)test_[^/]+\.py$/;
const SPEC_ID_PATTERN = /(?:AC|EC)-\d+[a-z]?/;

function readPipelineFile(name, { required = true } = {}) {
  const path = join(pipelineDir, name);
  if (!existsSync(path)) {
    if (required) {
      process.stderr.write(`check-red-integrity: .pipeline/${name} does not exist.\n`);
      process.exit(1);
    }
    return null;
  }
  return readFileSync(path, 'utf8');
}

function parseBulletList(section) {
  if (!section) return [];
  return [...section.matchAll(/^-[ \t]+(\S.*)$/gm)].map((match) => match[1].trim());
}

/** "## Content hashes (SHA-256)" entries: "- path/to/file.ts: <64-hex-digit-hash>". */
function parseContentHashes(redMarkdown) {
  const section = extractSection(redMarkdown, 'Content hashes (SHA-256)');
  const map = new Map();
  if (!section) return map;
  for (const match of section.matchAll(/^-[ \t]+(\S.*?):[ \t]*([0-9a-fA-F]{64})[ \t]*$/gm)) {
    map.set(match[1].trim(), match[2].toLowerCase());
  }
  return map;
}

/** "## @spec mapping" entries: "- path/to/file.ts: AC-1, AC-2" (comma- or space-separated). */
function parseSpecMapping(redMarkdown) {
  const section = extractSection(redMarkdown, '@spec mapping');
  const map = new Map();
  if (!section) return map;
  for (const line of section.split(/\r?\n/)) {
    const match = line.match(/^-[ \t]+(\S.*?):[ \t]*(.+)$/);
    if (!match) continue;
    const ids = match[2].split(/[,\s]+/).map((id) => id.trim()).filter(Boolean);
    map.set(match[1].trim(), ids);
  }
  return map;
}

/** Every `@spec <ID> [<ID> ...]` marker occurring anywhere in a test file's actual content — the
 * project's comment idiom per .sdd/stages/red.md ("// @spec AC-3 EC-1" for TS/JS, "# @spec AC-3"
 * for Python). Read from the file itself, not only from red.md's self-reported mapping, since the
 * mapping could go stale relative to the file it describes. */
function extractSpecMarkersFromContent(content) {
  const ids = new Set();
  for (const match of content.matchAll(/@spec[ \t]+((?:(?:AC|EC)-\d+[a-z]?[ \t]*)+)/g)) {
    for (const id of match[1].trim().split(/\s+/)) if (id) ids.add(id);
  }
  return ids;
}

/** Every AC-n / EC-n token appearing in spec.md's "## Acceptance criteria" and "## Edge cases"
 * sections — the set an @spec marker must resolve against. Deliberately permissive about exactly
 * how planner.md renders the ID inline (bold, plain, trailing colon, ...): any occurrence of the
 * token in either section counts as a real, resolvable ID. */
function extractKnownSpecIds(specMarkdown) {
  const acceptance = extractSection(specMarkdown, 'Acceptance criteria') ?? '';
  const edgeCases = extractSection(specMarkdown, 'Edge cases') ?? '';
  const ids = new Set();
  for (const match of `${acceptance}\n${edgeCases}`.matchAll(new RegExp(SPEC_ID_PATTERN, 'g'))) {
    ids.add(match[0]);
  }
  return ids;
}

function isDeclaredInChanges(changesMarkdown, filePath) {
  if (!changesMarkdown) return false;
  const section = extractSection(changesMarkdown, 'Red-test changes');
  if (!section) return false;
  return section.includes(filePath);
}

function sha256OfFile(absolutePath) {
  return createHash('sha256').update(readFileSync(absolutePath)).digest('hex');
}

/** Repo-relative paths changed or newly added in the working tree right now (staged, unstaged, and
 * untracked) — the same "prefer the live diff" approach scripts/ledger-append.mjs uses for its own
 * "files touched" detection, reused here only to surface *candidate* new test files, never to gate
 * on. Best-effort: an empty result (not a git repo, no HEAD yet) just means no candidates reported,
 * not a failure — this is informational only. */
function diffCandidateFiles() {
  const files = new Set();
  try {
    const diffOutput = execFileSync('git', ['diff', '--name-only', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
    for (const line of diffOutput.split(/\r?\n/)) if (line.trim()) files.add(line.trim());
  } catch {
    // Not a git repo, no HEAD yet, or git unavailable.
  }
  try {
    const untrackedOutput = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: repoRoot, encoding: 'utf8' });
    for (const line of untrackedOutput.split(/\r?\n/)) if (line.trim()) files.add(line.trim());
  } catch {
    // Same fallback reasoning as above.
  }
  return [...files].sort();
}

function main() {
  const redPath = join(pipelineDir, 'red.md');
  if (!existsSync(redPath)) {
    // Legitimate absence, not a violation — a ticket that predates the `red` stage (PL-03a-style),
    // or a review re-invocation with no red stage this run. Mirrors ledger-append.mjs's own
    // no-red.md handling. Nothing to check; nothing to block on.
    console.log(JSON.stringify({ status: 'no-red-md', violations: [], notes: ['No .pipeline/red.md for this run — nothing to check.'] }, null, 2));
    console.log('check-red-integrity: no .pipeline/red.md for this run — nothing to check.');
    process.exit(0);
  }
  const redMarkdown = readFileSync(redPath, 'utf8');
  const specMarkdown = readPipelineFile('spec.md');
  const changesMarkdown = readPipelineFile('changes.md', { required: false });

  const violations = [];
  const notes = [];

  // --- red.md's own internal integrity -----------------------------------------------------------
  const impactMap = extractSection(redMarkdown, 'Impact map');
  if (!impactMap) violations.push('red.md has no "## Impact map" section, or it is empty — .sdd/stages/red.md requires the impact map\'s presence or absence to be stated explicitly, never left blank.');
  if (/RED-BROKEN/.test(redMarkdown)) violations.push('red.md contains a "RED-BROKEN" entry somewhere in the document — .sdd/stages/red.md is explicit that red may not finish while any test is RED-BROKEN.');

  const hashes = parseContentHashes(redMarkdown);
  const testPaths = parseBulletList(extractSection(redMarkdown, 'Test paths'));
  const specMapping = parseSpecMapping(redMarkdown);
  const knownIds = extractKnownSpecIds(specMarkdown);

  for (const path of testPaths) {
    if (!hashes.has(path)) violations.push(`"${path}" is listed under "## Test paths" but has no recorded hash under "## Content hashes (SHA-256)".`);
  }

  // --- Red-test integrity: rehash every listed file, compare against red.md's recorded hash ------
  for (const [path, expectedHash] of hashes) {
    const absolutePath = join(repoRoot, path);
    if (!existsSync(absolutePath)) {
      violations.push(`"${path}" is listed in red.md's "## Content hashes (SHA-256)" but no longer exists on disk.`);
      continue;
    }
    const actualHash = sha256OfFile(absolutePath);
    if (actualHash === expectedHash) continue;
    if (isDeclaredInChanges(changesMarkdown, path)) {
      notes.push(`"${path}"'s content hash changed (from ${expectedHash} to ${actualHash}) and is declared in changes.md's "## Red-test changes" section — review must judge whether the stated reason is legitimate.`);
    } else {
      violations.push(`"${path}"'s content hash changed (from ${expectedHash} to ${actualHash}) and changes.md does not declare this change in a "## Red-test changes" section — an undeclared red-test change is exactly the failure this check exists to catch.`);
    }
  }

  // --- Spec trace: every listed test must cite at least one @spec ID that resolves to spec.md ----
  for (const path of testPaths) {
    const idsFromMapping = specMapping.get(path) ?? [];
    const absolutePath = join(repoRoot, path);
    const idsFromFile = existsSync(absolutePath) ? extractSpecMarkersFromContent(readFileSync(absolutePath, 'utf8')) : new Set();
    const allIds = new Set([...idsFromMapping, ...idsFromFile]);

    if (allIds.size === 0) {
      violations.push(`"${path}" cites no "@spec" marker at all — neither in red.md's "## @spec mapping" nor in the file's own content.`);
      continue;
    }
    for (const id of allIds) {
      if (!knownIds.has(id)) violations.push(`"${path}" cites "@spec ${id}", which does not resolve to a real AC-*/EC-* item in spec.md's "## Acceptance criteria" or "## Edge cases" sections.`);
    }
  }

  // --- Candidates: new test files in the diff not covered by red.md's Test paths (report only) ---
  const testPathSet = new Set(testPaths);
  const candidateNewTests = diffCandidateFiles().filter((path) => TEST_FILE_PATTERN.test(path) && !testPathSet.has(path));
  for (const path of candidateNewTests) {
    const absolutePath = join(repoRoot, path);
    const hasMarker = existsSync(absolutePath) && extractSpecMarkersFromContent(readFileSync(absolutePath, 'utf8')).size > 0;
    if (!hasMarker) {
      notes.push(`"${path}" is a new test file in the diff, not listed in red.md's "## Test paths", and carries no "@spec" marker — review should judge whether it is behavioral (tester may only add non-behavioral coverage).`);
    }
  }

  const report = {
    status: violations.length > 0 ? 'violations-found' : 'clean',
    testPathsChecked: testPaths,
    hashesChecked: [...hashes.keys()],
    candidateNewTests,
    violations,
    notes,
  };
  // JSON first (machine-readable, for tooling), then each note/violation restated as its own plain
  // line — JSON.stringify escapes embedded quotes, which makes the JSON block itself awkward to
  // grep/match against for a human or a test; these plain lines are not JSON-escaped.
  console.log(JSON.stringify(report, null, 2));
  for (const note of notes) console.log(`check-red-integrity: note: ${note}`);

  if (violations.length > 0) {
    for (const violation of violations) process.stderr.write(`check-red-integrity: violation: ${violation}\n`);
    process.stderr.write(`check-red-integrity: ${violations.length} violation(s) found — see above. review must set NEEDS_FIXES.\n`);
    process.exit(1);
  }
  console.log(`check-red-integrity: no violations found (${testPaths.length} test path(s), ${hashes.size} hash(es) checked).`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    // extractSection throws rather than exiting directly when a heading is ambiguous (see its own
    // comment in build-ledger-index.mjs, PL-03c round 3) — catch it here so the CLI still prints
    // one clean, prefixed message and exits 1, instead of a raw Node stack trace.
    process.stderr.write(`check-red-integrity: ${error.message}\n`);
    process.exit(1);
  }
}
