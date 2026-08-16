#!/usr/bin/env node
/**
 * Pipeline slimness check (PL-TRIM): verifies that .sdd/pipeline.md stays under its line budget,
 * each command stub is self-contained (≤8 non-blank lines, names its entrypoint), the
 * entrypoint↔skill bijection holds, and no skill retains a "follow .sdd/pipeline.md's /x section"
 * pointer.
 *
 * Usage:
 *   node scripts/check-pipeline-slim.mjs          # human-readable report
 *   node scripts/check-pipeline-slim.mjs --json   # { ok, lineCount, budget, violations: [...] }
 *
 * Exit 0 = slim and consistent. Exit 1 = at least one violation. Exit 2 = the check could not be
 * performed (missing .sdd/pipeline.md, missing .sdd/entrypoints/, missing .claude/skills/, unknown
 * flag). The 1/2 split matches check-bounds.mjs and check-lite-eligible.mjs: collapsing "the check
 * failed" into "the split is clean" is how a broken gate reads as a passing one.
 *
 * Failure output goes to stderr prefixed `check-pipeline-slim: `.
 */

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The line budget .sdd/pipeline.md must stay under. 300 per PL-TRIM; the plan's target body is 150–250. */
export const PIPELINE_LINE_BUDGET = 300;

/** Max non-blank body lines allowed between a `### `/<cmd>`` stub heading and the next heading. */
export const STUB_BODY_LINE_BUDGET = 8;

/** Skills that legitimately have no entrypoint: not pipeline entry points at all. */
export const EXEMPT_SKILLS = new Set(['pr-review', 'workspace-pack-author']);

/** alias command -> the canonical entrypoint it is permitted to defer to, and only that one. */
export const ALIAS_ENTRYPOINTS = new Map([['spec-only', 'planner'], ['security-recheck', 'security']]);

/** The six violation kinds this check can report. */
export const SLIM_VIOLATION_KINDS = [
  'budget', 'stub-body', 'missing-entrypoint', 'orphan-entrypoint', 'skill-pointer', 'unstubbed-entrypoint',
];

/** @typedef {{ kind: string, path: string, detail: string }} SlimViolation */

// ---------------------------------------------------------------------------
// Stub heading parser — extracts command name from ### `/<cmd>[args]` headings.
// ---------------------------------------------------------------------------
const STUB_HEADING_RE = /^###\s+`\/([a-z][a-z0-9-]*)/;
const HEADING_RE = /^#{2,}/;

/**
 * Parse pipeline.md content into a Map<cmd, bodyLines[]> of stub sections.
 * Only `### `/<cmd>...`` headings are treated as stubs (must start with backtick-slash).
 * @param {string} content
 * @returns {Map<string, string[]>}
 */
function parseStubs(content) {
  const stubs = new Map();
  let currentCmd = null;
  let bodyLines = [];
  for (const line of content.split(/\r?\n/)) {
    const stubMatch = line.match(STUB_HEADING_RE);
    if (stubMatch) {
      if (currentCmd !== null) stubs.set(currentCmd, bodyLines);
      currentCmd = stubMatch[1];
      bodyLines = [];
    } else if (HEADING_RE.test(line) && currentCmd !== null) {
      stubs.set(currentCmd, bodyLines);
      currentCmd = null;
      bodyLines = [];
    } else if (currentCmd !== null) {
      bodyLines.push(line);
    }
  }
  if (currentCmd !== null) stubs.set(currentCmd, bodyLines);
  return stubs;
}

// Regex matching "follow/see .sdd/pipeline.md's /cmd" — the disallowed old-style pointer form.
// Derived from spec's Interfaces section.
const SECTION_POINTER_RE = /\.sdd\/pipeline\.md`?'?s?\s+(?:own\s+)?"?`?\/[a-z][a-z0-9-]*/i;

// Regex to find all .sdd/entrypoints/<cmd>.md references in a skill body.
const ENTRYPOINT_REF_RE = /\.sdd\/entrypoints\/([a-z][a-z0-9-]*)\.md/g;

/**
 * Pure evaluator over already-read file contents, so the test suite can construct fixtures without
 * writing a temp repo for every case.
 * @param {{ pipeline: string, entrypoints: Map<string,string>, skills: Map<string,string> }} input
 * @returns {{ ok: boolean, lineCount: number, budget: number, violations: SlimViolation[] }}
 */
export function evaluatePipelineSlimness({ pipeline, entrypoints, skills }) {
  const violations = [];

  // Rule 1 — budget: .sdd/pipeline.md total line count ≤ PIPELINE_LINE_BUDGET.
  const splitLines = pipeline.split(/\r?\n/);
  const lineCount = splitLines[splitLines.length - 1] === '' ? splitLines.length - 1 : splitLines.length;
  if (lineCount > PIPELINE_LINE_BUDGET) {
    violations.push({
      kind: 'budget',
      path: '.sdd/pipeline.md',
      detail: `line count ${lineCount} exceeds budget of ${PIPELINE_LINE_BUDGET}`,
    });
  }

  // Parse stubs once (used by rules 2 and 6).
  const stubs = parseStubs(pipeline);

  // Rule 2 — stub-body: each stub ≤ STUB_BODY_LINE_BUDGET non-blank lines AND names its entrypoint.
  for (const [cmd, body] of stubs) {
    const nonBlankCount = body.filter((l) => l.trim() !== '').length;
    const bodyText = body.join('\n');
    const hasRef = bodyText.includes(`.sdd/entrypoints/${cmd}.md`);
    if (nonBlankCount > STUB_BODY_LINE_BUDGET || !hasRef) {
      violations.push({
        kind: 'stub-body',
        path: `.sdd/pipeline.md#${cmd}`,
        detail: !hasRef
          ? `stub for /${cmd} does not contain .sdd/entrypoints/${cmd}.md`
          : `stub for /${cmd} has ${nonBlankCount} non-blank lines (limit ${STUB_BODY_LINE_BUDGET})`,
      });
    }
  }

  // Non-exempt skill names (for rules 3–5).
  const nonExemptSkillNames = [...skills.keys()].filter((n) => !EXEMPT_SKILLS.has(n));

  // Rule 3 — missing-entrypoint: every non-exempt skill body contains .sdd/entrypoints/<name>.md
  // AND that entrypoint exists in the map.
  for (const name of nonExemptSkillNames) {
    const body = skills.get(name);
    const hasRef = body.includes(`.sdd/entrypoints/${name}.md`);
    const epExists = entrypoints.has(name);
    if (!hasRef || !epExists) {
      violations.push({
        kind: 'missing-entrypoint',
        path: `.claude/skills/${name}/SKILL.md`,
        detail: !epExists
          ? `skill '${name}' has no matching entrypoint at .sdd/entrypoints/${name}.md`
          : `skill body for '${name}' does not reference .sdd/entrypoints/${name}.md`,
      });
    }
  }

  // Rule 4 — orphan-entrypoint: every entrypoint has a matching non-exempt skill.
  const skillSet = new Set(nonExemptSkillNames);
  for (const ep of entrypoints.keys()) {
    if (!skillSet.has(ep)) {
      violations.push({
        kind: 'orphan-entrypoint',
        path: `.sdd/entrypoints/${ep}.md`,
        detail: `entrypoint '${ep}' has no matching skill directory`,
      });
    }
  }

  // Rule 5 — skill-pointer: no old-style pipeline.md section pointer, and no cross-entrypoint refs
  // (except alias → canonical, which is explicitly permitted).
  for (const name of nonExemptSkillNames) {
    const body = skills.get(name);
    const canonical = ALIAS_ENTRYPOINTS.get(name);

    if (SECTION_POINTER_RE.test(body)) {
      violations.push({
        kind: 'skill-pointer',
        path: `.claude/skills/${name}/SKILL.md`,
        detail: `skill '${name}' contains a disallowed pipeline.md section pointer`,
      });
    }

    const re = new RegExp(ENTRYPOINT_REF_RE.source, 'g');
    let m;
    while ((m = re.exec(body)) !== null) {
      const ref = m[1];
      if (ref === name) continue;
      if (canonical && ref === canonical) continue;
      violations.push({
        kind: 'skill-pointer',
        path: `.claude/skills/${name}/SKILL.md`,
        detail: `skill '${name}' references .sdd/entrypoints/${ref}.md but does not own it`,
      });
    }
  }

  // Rule 6 — unstubbed-entrypoint: every entrypoint must have a matching stub in pipeline.md.
  for (const ep of entrypoints.keys()) {
    if (!stubs.has(ep)) {
      violations.push({
        kind: 'unstubbed-entrypoint',
        path: `.sdd/entrypoints/${ep}.md`,
        detail: `entrypoint '${ep}' has no matching ### \`/${ep}\` stub in .sdd/pipeline.md`,
      });
    }
  }

  return { ok: violations.length === 0, lineCount, budget: PIPELINE_LINE_BUDGET, violations };
}

/**
 * Reads the repo from disk and returns the same shape as evaluatePipelineSlimness.
 * Throws on missing required directories/files (the caller's job to turn into exit 2).
 * @param {string} [repoRoot]
 * @returns {{ ok: boolean, lineCount: number, budget: number, violations: SlimViolation[] }}
 */
export function checkPipelineSlim(repoRoot = process.cwd()) {
  const pipelinePath = join(repoRoot, '.sdd', 'pipeline.md');
  const entrypointsDir = join(repoRoot, '.sdd', 'entrypoints');
  const skillsDir = join(repoRoot, '.claude', 'skills');

  if (!existsSync(pipelinePath)) throw new Error(`missing .sdd/pipeline.md`);
  if (!existsSync(entrypointsDir)) throw new Error(`missing .sdd/entrypoints/`);
  if (!existsSync(skillsDir)) throw new Error(`missing .claude/skills/`);

  const pipeline = readFileSync(pipelinePath, 'utf8');

  // Read entrypoints: only .md files (non-.md and subdirectories are ignored, EC-12).
  // Also exclude .sdd/ledger/ entirely (EC-17) — it's outside .sdd/entrypoints/, so it's not
  // walked here; the walk is scoped to entrypointsDir.
  const entrypoints = new Map();
  for (const name of readdirSync(entrypointsDir)) {
    if (!name.endsWith('.md')) continue;
    const fullPath = join(entrypointsDir, name);
    try {
      if (statSync(fullPath).isDirectory()) continue;
    } catch {
      continue;
    }
    const cmd = name.slice(0, -3); // strip .md
    entrypoints.set(cmd, readFileSync(fullPath, 'utf8'));
  }

  // Read skills: one entry per directory that contains a SKILL.md.
  const skills = new Map();
  for (const dir of readdirSync(skillsDir)) {
    const skillPath = join(skillsDir, dir, 'SKILL.md');
    if (!existsSync(skillPath)) continue;
    skills.set(dir, readFileSync(skillPath, 'utf8'));
  }

  return evaluatePipelineSlimness({ pipeline, entrypoints, skills });
}

// ---------------------------------------------------------------------------
// CLI main
// ---------------------------------------------------------------------------

function die(msg) {
  process.stderr.write(`check-pipeline-slim: ${msg}\n`);
  process.exit(2);
}

function assertKnownFlags(args, known) {
  for (const arg of args) {
    if (!known.has(arg)) die(`unrecognized flag: ${arg}\n  Usage: node scripts/check-pipeline-slim.mjs [--json]`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  assertKnownFlags(args, new Set(['--json']));
  const jsonMode = args.includes('--json');

  let result;
  const repoRoot = resolve(fileURLToPath(import.meta.url), '..', '..');
  try {
    result = checkPipelineSlim(repoRoot);
  } catch (err) {
    die(err.message);
  }

  if (jsonMode) {
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exit(result.ok ? 0 : 1);
  }

  if (result.ok) {
    process.stdout.write(
      `check-pipeline-slim: ok — .sdd/pipeline.md is ${result.lineCount}/${result.budget} lines, all rules pass\n`,
    );
    process.exit(0);
  }

  process.stderr.write(`check-pipeline-slim: ${result.violations.length} violation(s) found:\n`);
  for (const v of result.violations) {
    process.stderr.write(`  [${v.kind}] ${v.path}: ${v.detail}\n`);
  }
  process.exit(1);
}

// Guard: only run CLI when invoked directly, not when imported.
// realpathSync resolves macOS /var/folders → /private/var/folders symlinks so the
// comparison holds whether the script is in the real repo or in a tmpdir fixture.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
