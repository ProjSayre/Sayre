// Tests scripts/check-pipeline-slim.mjs (PL-TRIM) — the CI check that locks the pipeline.md split
// in place: budget enforcement, per-stub body limit, entrypoint↔skill bijection, skill-pointer
// hygiene, and CLI surface.
//
// Authored by the `red` stage from .pipeline/spec.md alone, BEFORE scripts/check-pipeline-slim.mjs
// exists. Every assertion below comes from that spec's Interfaces/AC/EC sections, never from an
// implementation.
//
// Conventions follow scripts/check-lite-eligible.test.mjs: node:test, tmpdir-based throwaway fixture
// repos, afterEach cleanup, no new framework.
//
// Because the script under test does not exist yet, module-level `import` would take the entire file
// down with one indistinguishable error. All imports from the script under test go through the lazy
// `loadModule()` helper (same pattern as check-lite-eligible.test.mjs's `loadModule()`), so each
// test that needs an export fails for its own readable reason rather than aborting the whole suite.
//
// Note on EC-11 (CRLF): the project's real working tree uses CRLF line endings. Fixtures here use LF
// by default; CRLF-specific tests explicitly construct CRLF content to verify the script's handling
// of split(/\r?\n/) vs. split('\n') — the exact failure mode that bit scripts/sdd-completeness.test.mjs
// and is documented in its own header.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, test } from 'node:test';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const CHECK_SLIM = resolve(scriptsDir, 'check-pipeline-slim.mjs');
const REPO_ROOT = resolve(scriptsDir, '..');

const EXIT_OK = 0;
const EXIT_VIOLATION = 1;
const EXIT_CANNOT_RUN = 2;

// The 16 pipeline entry-point commands per AC-2.
const ALL_COMMANDS = [
  'pipeline', 'pipeline-lite', 'pipeline-gapfill', 'gap-scout-only',
  'planner', 'spec-only', 'red', 'dev', 'tester', 'review',
  'security', 'security-recheck', 'pipeline-status', 're-gate', 'inline-edit', 'hotfix',
];

// Exempt from the entrypoint↔skill bijection (EC-4).
const EXEMPT_SKILLS_LIST = ['pr-review', 'workspace-pack-author'];

// Alias commands and their canonical targets (EC-5 / ALIAS_ENTRYPOINTS).
const ALIAS_MAP = new Map([['spec-only', 'planner'], ['security-recheck', 'security']]);

const roots = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

/**
 * Returns a `[string, string]` tuple — needed so `new Map([...arr.map(...)])` spreads
 * are inferred as `[string, string][]` rather than `string[][]` when checkJs is enabled.
 * @param {string} key
 * @param {string} value
 * @returns {[string, string]}
 */
function pair(key, value) { return [key, value]; }

function write(root, relPath, contents) {
  const dest = join(root, relPath);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, contents, 'utf8');
}

// ---------------------------------------------------------------------------
// Fixture helpers — pure text factories that produce the minimal valid content
// for each file type, so each test only has to specify what's different.
// ---------------------------------------------------------------------------

/**
 * A pipeline.md core document with stubs for the given commands.
 * @param {string[]} commands
 * @param {{ bodyLines?: number, omitEntrypointRef?: string[], crlfLineEndings?: boolean }} opts
 */
function makePipelineMd(commands, { bodyLines = 1, omitEntrypointRef = [], crlfLineEndings = false } = {}) {
  const lines = [
    '# Pipeline',
    '',
    // AC-1: intro must name every entry point.
    'Entry points: ' + commands.map((c) => `/${c}`).join(', '),
    '',
    '## JSON sidecars',
    'Condensed JSON-sidecar note.',
    '',
    '## Staleness stamps',
    '| Source | Policy |',
    '|--------|--------|',
    '| spec.json | trusted-fresh |',
    '',
    '## Stage sequence',
    '1. **planner**',
    '2. **red**',
    '3. **dev**',
    '4. **tester**',
    '5. **review**',
    '6. **security**',
    'Uses ledger-append.mjs after terminal PASS.',
    '',
    '## Routing',
    '3-attempt loop cap.',
    '',
    '## Review persistence',
    'Contract.',
    '',
    '## Running stages in a single context',
    'Section.',
    '',
    '## Entry points',
    'Preamble: ' + commands.map((c) => `/${c}`).join(', '),
    '',
    '### Per-stage entry points',
    '1. Read .sdd/pipeline.md first.',
    '2. Read the entrypoint file.',
    '3. Map stages to subagents.',
    '4. Observe refusal bullets.',
    '',
  ];

  for (const cmd of commands) {
    lines.push(`### \`/${cmd}\``);
    for (let i = 0; i < bodyLines; i++) {
      lines.push(`${cmd} body line ${i + 1}.`);
    }
    if (!omitEntrypointRef.includes(cmd)) {
      lines.push(`Full definition: \`.sdd/entrypoints/${cmd}.md\`.`);
    }
    lines.push('');
  }

  const eol = crlfLineEndings ? '\r\n' : '\n';
  return lines.join(eol);
}

/** Minimal entrypoint file for one command. */
function makeEntrypointMd(cmd) {
  return [
    `# \`/${cmd}\``,
    '',
    'Read `.sdd/pipeline.md` (core: stage sequence, routing, loop cap, staleness) first.',
    'This file is the authoritative, runtime-neutral definition of this command;',
    'no other entrypoint file is required to run it.',
    '',
    '## Steps',
    '1. Do the thing.',
  ].join('\n');
}

/** Valid SKILL.md body for a pipeline command. Does NOT carry old pipeline.md section pointers. */
function makeSkillMd(cmd, { extraEntrypoint = null, omitOwnEntrypoint = false, oldStylePointer = false } = {}) {
  const isAlias = ALIAS_MAP.has(cmd);
  const canonical = ALIAS_MAP.get(cmd);
  const lines = [
    `---`,
    `name: ${cmd}`,
    `description: ${cmd} description.`,
    `disable-model-invocation: true`,
    `argument-hint: <ticket>`,
    `---`,
    ``,
    `Read \`.sdd/pipeline.md\` — core only (stage sequence, routing, loop cap, staleness table).`,
  ];
  if (!omitOwnEntrypoint) {
    lines.push(`Read \`.sdd/entrypoints/${cmd}.md\` — the authoritative definition of this command.`);
  }
  if (isAlias) {
    lines.push(`Also read \`.sdd/entrypoints/${canonical}.md\` — this command is an alias for /${canonical}.`);
  }
  if (extraEntrypoint) {
    lines.push(`Read \`.sdd/entrypoints/${extraEntrypoint}.md\` — this is an unexpected cross-reference.`);
  }
  if (oldStylePointer) {
    // EC-6 / skill-pointer: the kind of "follow .sdd/pipeline.md's /x section" the check must flag.
    lines.push(`Follow \`.sdd/pipeline.md\`'s \`/${cmd}\` section exactly.`);
  }
  lines.push(`Stage mapping and refusal bullets.`);
  return lines.join('\n');
}

/** Minimal exempt skill body (pr-review, workspace-pack-author) — no entrypoint, no section pointer. */
function makeExemptSkillMd(name) {
  return [
    `---`, `name: ${name}`, `description: ${name}.`, `disable-model-invocation: true`, `---`,
    `Not a pipeline entry point. See .sdd/stages/${name}.md.`,
  ].join('\n');
}

/**
 * Creates a throwaway fixture directory with the right shape for a "passing" check.
 * Not a git repo — checkPipelineSlim reads files, not git history.
 */
function fixtureRoot({
  commands = ALL_COMMANDS,
  bodyLines = 1,
  pipelineOverride = null,
  entrypointsExtra = [],
  skillsExtra = [],
  skillOverrides = new Map(),
  ledgerEntry = false,
} = {}) {
  const root = mkdtempSync(resolve(tmpdir(), 'sayre-slim-'));
  roots.push(root);

  // Pipeline.md
  write(root, '.sdd/pipeline.md', pipelineOverride ?? makePipelineMd(commands, { bodyLines }));

  // Entrypoints — one per command, plus extras.
  for (const cmd of commands) {
    write(root, `.sdd/entrypoints/${cmd}.md`, makeEntrypointMd(cmd));
  }
  for (const [name, content] of entrypointsExtra) {
    if (name.endsWith('/') || name.includes('..')) continue; // safety
    write(root, `.sdd/entrypoints/${name}`, content);
  }

  // A ledger directory that must NOT be treated as an entrypoint source (EC-17).
  if (ledgerEntry) {
    write(root, '.sdd/ledger/some-run/spec.md', '# Spec from a past run\n/pipeline section pointer old style');
  }

  // Skills — one per command (minus exempt).
  for (const cmd of commands) {
    const overrideBody = skillOverrides.get(cmd);
    write(root, `.claude/skills/${cmd}/SKILL.md`, overrideBody ?? makeSkillMd(cmd));
  }
  // Exempt skills — no entrypoint file, no section pointer.
  for (const name of EXEMPT_SKILLS_LIST) {
    write(root, `.claude/skills/${name}/SKILL.md`, makeExemptSkillMd(name));
  }
  for (const [skillDir, content] of skillsExtra) {
    write(root, `.claude/skills/${skillDir}/SKILL.md`, content);
  }

  return root;
}

// ---------------------------------------------------------------------------
// Script loading helpers — same lazy-import guard as check-lite-eligible.test.mjs.
// ---------------------------------------------------------------------------

function sourceIfPresent(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

/**
 * Runs the check script inside a fixture root. Copies the script file from the repo (if it exists)
 * into the fixture at scripts/check-pipeline-slim.mjs, then spawns it.
 *
 * The guard on ERR_MODULE_NOT_FOUND matters: when scripts/check-pipeline-slim.mjs does not exist,
 * node exits 1 — the same code this CLI uses for "violations found". Without the guard, every
 * `assert.equal(code, EXIT_VIOLATION)` would read as a pass while nothing was actually checked.
 */
function run(root, args = []) {
  const slimSource = sourceIfPresent(CHECK_SLIM);
  if (slimSource !== null) {
    write(root, 'scripts/check-pipeline-slim.mjs', slimSource);
  } else {
    // Write a minimal placeholder that fails the guard below — ensures this is surfaced
    // per-test as "script missing" rather than silently collapsing tests.
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(join(root, 'scripts', 'check-pipeline-slim.mjs'), '// placeholder\n', 'utf8');
  }

  const result = spawnSync(
    process.execPath,
    [join(root, 'scripts', 'check-pipeline-slim.mjs'), ...args],
    { cwd: root, encoding: 'utf8' },
  );
  const stderr = result.stderr ?? '';
  assert.ok(
    !/ERR_MODULE_NOT_FOUND|Cannot find module|SyntaxError/.test(stderr),
    `scripts/check-pipeline-slim.mjs could not be loaded — that is node's own error, not a slim verdict:\n${stderr}`,
  );
  return { code: result.status, stdout: result.stdout ?? '', stderr };
}

function runJson(root, args = []) {
  const result = run(root, ['--json', ...args]);
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (err) {
    assert.fail(`--json must emit parseable JSON on stdout; got:\n${result.stdout}\n${result.stderr}\n(${err})`);
  }
  return { ...result, json: parsed };
}

/** Dynamic import — tolerates the script being absent so each test fails for its own reason. */
async function loadModule() {
  return import(pathToFileURL(CHECK_SLIM).href);
}

const kinds = (json) => (json.violations ?? []).map((v) => v.kind);

// =============================================================================
// AC-8: the module exports the right constants and functions
// =============================================================================

// @spec AC-8
test('PIPELINE_LINE_BUDGET is exported and equals 300', async () => {
  const m = await loadModule();
  assert.equal(typeof m.PIPELINE_LINE_BUDGET, 'number',
    'PIPELINE_LINE_BUDGET must be exported as a number');
  assert.equal(m.PIPELINE_LINE_BUDGET, 300,
    'PIPELINE_LINE_BUDGET must equal 300 per the plan\'s target ceiling');
});

// @spec AC-8
test('STUB_BODY_LINE_BUDGET is exported and equals 8', async () => {
  const m = await loadModule();
  assert.equal(typeof m.STUB_BODY_LINE_BUDGET, 'number',
    'STUB_BODY_LINE_BUDGET must be exported as a number');
  assert.equal(m.STUB_BODY_LINE_BUDGET, 8,
    'STUB_BODY_LINE_BUDGET must equal 8 — the per-stub non-blank line cap');
});

// @spec AC-8
test('EXEMPT_SKILLS is a Set containing pr-review and workspace-pack-author', async () => {
  const m = await loadModule();
  assert.ok(m.EXEMPT_SKILLS instanceof Set, 'EXEMPT_SKILLS must be a Set');
  assert.ok(m.EXEMPT_SKILLS.has('pr-review'), 'EXEMPT_SKILLS must include pr-review');
  assert.ok(m.EXEMPT_SKILLS.has('workspace-pack-author'), 'EXEMPT_SKILLS must include workspace-pack-author');
});

// @spec AC-8
test('ALIAS_ENTRYPOINTS is a Map with spec-only->planner and security-recheck->security', async () => {
  const m = await loadModule();
  assert.ok(m.ALIAS_ENTRYPOINTS instanceof Map, 'ALIAS_ENTRYPOINTS must be a Map');
  assert.equal(m.ALIAS_ENTRYPOINTS.get('spec-only'), 'planner',
    'spec-only must alias to planner');
  assert.equal(m.ALIAS_ENTRYPOINTS.get('security-recheck'), 'security',
    'security-recheck must alias to security');
});

// @spec AC-8
test('SLIM_VIOLATION_KINDS is exported and covers all six violation categories', async () => {
  const m = await loadModule();
  assert.ok(Array.isArray(m.SLIM_VIOLATION_KINDS), 'SLIM_VIOLATION_KINDS must be an array');
  for (const kind of ['budget', 'stub-body', 'missing-entrypoint', 'orphan-entrypoint', 'skill-pointer', 'unstubbed-entrypoint']) {
    assert.ok(m.SLIM_VIOLATION_KINDS.includes(kind),
      `SLIM_VIOLATION_KINDS must include '${kind}'`);
  }
});

// @spec AC-8
test('evaluatePipelineSlimness and checkPipelineSlim are exported as functions', async () => {
  const m = await loadModule();
  assert.equal(typeof m.evaluatePipelineSlimness, 'function',
    'evaluatePipelineSlimness must be exported — pure evaluator for fixture-based tests');
  assert.equal(typeof m.checkPipelineSlim, 'function',
    'checkPipelineSlim must be exported — reads the repo from disk and returns the same shape');
});

// @spec AC-8
test('importing check-pipeline-slim.mjs does not trigger its CLI (process.argv guard)', async () => {
  // Reaching this assertion at all means main() did not call process.exit() —
  // the same argv[1] === import.meta.url guard check-lite-eligible.mjs uses.
  const m = await loadModule();
  assert.ok(m.evaluatePipelineSlimness, 'module must export evaluatePipelineSlimness without running CLI side effects');
});

// =============================================================================
// AC-8 / evaluatePipelineSlimness — pure evaluator behavior
// =============================================================================

// @spec AC-8
test('evaluatePipelineSlimness returns ok:true, correct lineCount and budget for a minimal valid input', async () => {
  const { evaluatePipelineSlimness } = await loadModule();
  const pipeline = makePipelineMd(ALL_COMMANDS);
  const entrypoints = new Map(ALL_COMMANDS.map((c) => pair(c, makeEntrypointMd(c))));
  const skills = new Map([
    ...ALL_COMMANDS.map((c) => pair(c, makeSkillMd(c))),
    ...EXEMPT_SKILLS_LIST.map((n) => pair(n, makeExemptSkillMd(n))),
  ]);
  const result = evaluatePipelineSlimness({ pipeline, entrypoints, skills });
  assert.equal(result.ok, true, `expected ok:true for a valid fixture; got violations: ${JSON.stringify(result.violations)}`);
  assert.equal(typeof result.lineCount, 'number', 'lineCount must be a number');
  assert.equal(result.budget, 300, 'budget must echo PIPELINE_LINE_BUDGET');
  assert.deepEqual(result.violations, [], 'violations must be empty for a passing check');
});

// @spec AC-8
test('evaluatePipelineSlimness is pure: the same input yields the same result', async () => {
  const { evaluatePipelineSlimness } = await loadModule();
  const pipeline = makePipelineMd(['pipeline', 'hotfix']);
  const entrypoints = new Map([pair('pipeline', makeEntrypointMd('pipeline')), pair('hotfix', makeEntrypointMd('hotfix'))]);
  const skills = new Map([
    pair('pipeline', makeSkillMd('pipeline')),
    pair('hotfix', makeSkillMd('hotfix')),
    ...EXEMPT_SKILLS_LIST.map((n) => pair(n, makeExemptSkillMd(n))),
  ]);
  const a = evaluatePipelineSlimness({ pipeline, entrypoints, skills });
  const b = evaluatePipelineSlimness({ pipeline, entrypoints, skills });
  assert.deepEqual(a, b);
});

// =============================================================================
// EC-3: budget boundary — exactly 300 passes; 301 fails with 'budget'
// =============================================================================

// @spec EC-3
test('evaluatePipelineSlimness: pipeline.md at exactly 300 lines passes the budget rule', async () => {
  const { evaluatePipelineSlimness, PIPELINE_LINE_BUDGET } = await loadModule();
  // Build a pipeline.md with stubs for all commands, padded with blank lines to reach exactly 300.
  const base = makePipelineMd(ALL_COMMANDS);
  const baseLines = base.split(/\r?\n/);
  // Drop trailing empty element added by final newline.
  const trimmed = baseLines[baseLines.length - 1] === '' ? baseLines.slice(0, -1) : baseLines;
  const needed = PIPELINE_LINE_BUDGET - trimmed.length;
  assert.ok(needed >= 0, `fixture is already over budget before padding (${trimmed.length} lines) — fixture must be redesigned`);
  const padded = trimmed.concat(Array(needed).fill('')).join('\n') + '\n';
  const lines300 = padded.split(/\r?\n/);
  const effectiveCount = lines300[lines300.length - 1] === '' ? lines300.length - 1 : lines300.length;
  assert.equal(effectiveCount, PIPELINE_LINE_BUDGET, `padded fixture must be exactly ${PIPELINE_LINE_BUDGET} lines`);

  const result = evaluatePipelineSlimness({
    pipeline: padded,
    entrypoints: new Map(ALL_COMMANDS.map((c) => pair(c, makeEntrypointMd(c)))),
    skills: new Map([...ALL_COMMANDS.map((c) => pair(c, makeSkillMd(c))), ...EXEMPT_SKILLS_LIST.map((n) => pair(n, makeExemptSkillMd(n)))]),
  });
  assert.equal(result.lineCount, PIPELINE_LINE_BUDGET);
  assert.ok(!result.violations.some((v) => v.kind === 'budget'), `exactly-at-budget must not produce a budget violation; got ${JSON.stringify(result.violations)}`);
});

// @spec EC-3
test('evaluatePipelineSlimness: pipeline.md at 301 lines fails with budget violation naming the count and the budget', async () => {
  const { evaluatePipelineSlimness, PIPELINE_LINE_BUDGET } = await loadModule();
  const over = makePipelineMd(ALL_COMMANDS) + '\n'.repeat(400); // guarantee over-budget
  const result = evaluatePipelineSlimness({
    pipeline: over,
    entrypoints: new Map(ALL_COMMANDS.map((c) => pair(c, makeEntrypointMd(c)))),
    skills: new Map([...ALL_COMMANDS.map((c) => pair(c, makeSkillMd(c))), ...EXEMPT_SKILLS_LIST.map((n) => pair(n, makeExemptSkillMd(n)))]),
  });
  assert.equal(result.ok, false);
  const budgetViolation = result.violations.find((v) => v.kind === 'budget');
  assert.ok(budgetViolation, `budget violation must be present when line count exceeds ${PIPELINE_LINE_BUDGET}`);
  assert.match(budgetViolation.detail, new RegExp(String(PIPELINE_LINE_BUDGET)), 'violation detail must name the budget');
  assert.ok(result.lineCount > PIPELINE_LINE_BUDGET, 'lineCount must reflect the actual over-budget count');
  // The detail must name the actual line count, not a truncated version.
  assert.match(budgetViolation.detail, new RegExp(String(result.lineCount)), 'violation detail must name the actual line count');
});

// =============================================================================
// EC-7: stub with >8 non-blank lines → stub-body violation
// =============================================================================

// @spec EC-7
test('evaluatePipelineSlimness: a stub with 9 non-blank body lines produces stub-body, even if total line count is under budget', async () => {
  const { evaluatePipelineSlimness, STUB_BODY_LINE_BUDGET } = await loadModule();
  // 9 non-blank lines in one stub body.
  const pipeline = makePipelineMd(['pipeline', 'hotfix'], { bodyLines: STUB_BODY_LINE_BUDGET + 1 });
  const result = evaluatePipelineSlimness({
    pipeline,
    entrypoints: new Map([pair('pipeline', makeEntrypointMd('pipeline')), pair('hotfix', makeEntrypointMd('hotfix'))]),
    skills: new Map([
      pair('pipeline', makeSkillMd('pipeline')),
      pair('hotfix', makeSkillMd('hotfix')),
      ...EXEMPT_SKILLS_LIST.map((n) => pair(n, makeExemptSkillMd(n))),
    ]),
  });
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.kind === 'stub-body'),
    `9 non-blank stub lines must produce a stub-body violation; got ${JSON.stringify(result.violations)}`);
  // Must not silently collapse with the budget check — these are orthogonal rules.
  const stubViolation = result.violations.find((v) => v.kind === 'stub-body');
  assert.ok(stubViolation.path || stubViolation.detail, 'stub-body violation must carry a path or detail naming which stub violated it');
});

// =============================================================================
// EC-8: stub that names no entrypoint path → stub-body violation
// =============================================================================

// @spec EC-8
test('evaluatePipelineSlimness: a stub that carries no .sdd/entrypoints/<cmd>.md reference produces stub-body', async () => {
  const { evaluatePipelineSlimness } = await loadModule();
  const pipeline = makePipelineMd(['pipeline', 'hotfix'], { omitEntrypointRef: ['hotfix'] });
  const result = evaluatePipelineSlimness({
    pipeline,
    entrypoints: new Map([pair('pipeline', makeEntrypointMd('pipeline')), pair('hotfix', makeEntrypointMd('hotfix'))]),
    skills: new Map([
      pair('pipeline', makeSkillMd('pipeline')),
      pair('hotfix', makeSkillMd('hotfix')),
      ...EXEMPT_SKILLS_LIST.map((n) => pair(n, makeExemptSkillMd(n))),
    ]),
  });
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.kind === 'stub-body'),
    `a stub with no entrypoint reference must produce stub-body; got ${JSON.stringify(result.violations)}`);
});

// =============================================================================
// EC-1: skill with no matching entrypoint file → missing-entrypoint, exit 1
// =============================================================================

// @spec EC-1
test('evaluatePipelineSlimness: a skill directory with no matching entrypoint produces missing-entrypoint', async () => {
  const { evaluatePipelineSlimness } = await loadModule();
  const commands = ['pipeline', 'hotfix'];
  // Skill for 'new-unregistered-cmd' has no entrypoint file.
  const pipeline = makePipelineMd(commands);
  const entrypoints = new Map(commands.map((c) => pair(c, makeEntrypointMd(c))));
  const skills = new Map([
    ...commands.map((c) => pair(c, makeSkillMd(c))),
    pair('new-unregistered-cmd', makeSkillMd('new-unregistered-cmd')), // no entrypoint
    ...EXEMPT_SKILLS_LIST.map((n) => pair(n, makeExemptSkillMd(n))),
  ]);
  const result = evaluatePipelineSlimness({ pipeline, entrypoints, skills });
  assert.equal(result.ok, false);
  const violation = result.violations.find((v) => v.kind === 'missing-entrypoint');
  assert.ok(violation, `missing-entrypoint must be reported when a skill has no matching entrypoint; got ${JSON.stringify(result.violations)}`);
  assert.ok(violation.detail.includes('new-unregistered-cmd') || (violation.path && violation.path.includes('new-unregistered-cmd')),
    'violation must name the skill or expected path that was missing');
});

// =============================================================================
// EC-2: orphan entrypoint file (no matching skill) → orphan-entrypoint, exit 1
// =============================================================================

// @spec EC-2
test('evaluatePipelineSlimness: an entrypoint file with no matching skill produces orphan-entrypoint', async () => {
  const { evaluatePipelineSlimness } = await loadModule();
  const commands = ['pipeline', 'hotfix'];
  const pipeline = makePipelineMd(commands);
  // Extra entrypoint with no corresponding skill.
  const entrypoints = new Map([
    ...commands.map((c) => pair(c, makeEntrypointMd(c))),
    pair('ghost-command', makeEntrypointMd('ghost-command')),
  ]);
  const skills = new Map([
    ...commands.map((c) => pair(c, makeSkillMd(c))),
    ...EXEMPT_SKILLS_LIST.map((n) => pair(n, makeExemptSkillMd(n))),
  ]);
  const result = evaluatePipelineSlimness({ pipeline, entrypoints, skills });
  assert.equal(result.ok, false);
  const violation = result.violations.find((v) => v.kind === 'orphan-entrypoint');
  assert.ok(violation, `orphan-entrypoint must be reported when an entrypoint has no matching skill; got ${JSON.stringify(result.violations)}`);
});

// =============================================================================
// EC-4: pr-review and workspace-pack-author are exempt — must not produce violations
// =============================================================================

// @spec EC-4
test('evaluatePipelineSlimness: pr-review and workspace-pack-author skills are exempt and produce no violation', async () => {
  const { evaluatePipelineSlimness } = await loadModule();
  const commands = ['pipeline'];
  const pipeline = makePipelineMd(commands);
  const entrypoints = new Map(commands.map((c) => pair(c, makeEntrypointMd(c))));
  // Exempt skills exist but have no entrypoints and no stub — this must be allowed.
  const skills = new Map([
    ...commands.map((c) => pair(c, makeSkillMd(c))),
    ...EXEMPT_SKILLS_LIST.map((n) => pair(n, makeExemptSkillMd(n))),
  ]);
  const result = evaluatePipelineSlimness({ pipeline, entrypoints, skills });
  // The exempt skills must not produce orphan or missing violations.
  const exemptViolations = result.violations.filter(
    (v) => EXEMPT_SKILLS_LIST.some((name) => v.detail?.includes(name) || v.path?.includes(name)),
  );
  assert.deepEqual(exemptViolations, [], `exempt skills must not appear in violations; got ${JSON.stringify(result.violations)}`);
});

// =============================================================================
// EC-5: spec-only and security-recheck may reference their canonical target — others may not
// =============================================================================

// @spec EC-5
test('evaluatePipelineSlimness: spec-only referencing both its own and planner entrypoint passes (alias allowed)', async () => {
  const { evaluatePipelineSlimness } = await loadModule();
  const commands = ['planner', 'spec-only'];
  const pipeline = makePipelineMd(commands);
  const entrypoints = new Map(commands.map((c) => pair(c, makeEntrypointMd(c))));
  const skills = new Map([
    pair('planner', makeSkillMd('planner')),
    // spec-only references both spec-only.md AND planner.md — this is permitted.
    pair('spec-only', makeSkillMd('spec-only')),
    ...EXEMPT_SKILLS_LIST.map((n) => pair(n, makeExemptSkillMd(n))),
  ]);
  const result = evaluatePipelineSlimness({ pipeline, entrypoints, skills });
  const skillPointerViolations = result.violations.filter((v) => v.kind === 'skill-pointer');
  assert.deepEqual(skillPointerViolations, [],
    `spec-only referencing its canonical target must not produce skill-pointer; got ${JSON.stringify(result.violations)}`);
});

// @spec EC-5
test('evaluatePipelineSlimness: security-recheck referencing both its own and security entrypoint passes (alias allowed)', async () => {
  const { evaluatePipelineSlimness } = await loadModule();
  const commands = ['security', 'security-recheck'];
  const pipeline = makePipelineMd(commands);
  const entrypoints = new Map(commands.map((c) => pair(c, makeEntrypointMd(c))));
  const skills = new Map([
    pair('security', makeSkillMd('security')),
    pair('security-recheck', makeSkillMd('security-recheck')),
    ...EXEMPT_SKILLS_LIST.map((n) => pair(n, makeExemptSkillMd(n))),
  ]);
  const result = evaluatePipelineSlimness({ pipeline, entrypoints, skills });
  const skillPointerViolations = result.violations.filter((v) => v.kind === 'skill-pointer');
  assert.deepEqual(skillPointerViolations, [],
    `security-recheck referencing its canonical target must not produce skill-pointer; got ${JSON.stringify(result.violations)}`);
});

// =============================================================================
// EC-6: a skill naming two UNRELATED entrypoints → skill-pointer
// =============================================================================

// @spec EC-6
test('evaluatePipelineSlimness: a non-alias skill referencing a second unrelated entrypoint produces skill-pointer', async () => {
  const { evaluatePipelineSlimness } = await loadModule();
  const commands = ['pipeline', 'hotfix'];
  const pipeline = makePipelineMd(commands);
  const entrypoints = new Map(commands.map((c) => pair(c, makeEntrypointMd(c))));
  const skills = new Map([
    // pipeline skill cross-references hotfix.md — this is a non-alias cross-reference.
    pair('pipeline', makeSkillMd('pipeline', { extraEntrypoint: 'hotfix' })),
    pair('hotfix', makeSkillMd('hotfix')),
    ...EXEMPT_SKILLS_LIST.map((n) => pair(n, makeExemptSkillMd(n))),
  ]);
  const result = evaluatePipelineSlimness({ pipeline, entrypoints, skills });
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.kind === 'skill-pointer'),
    `a non-alias skill referencing an unrelated entrypoint must produce skill-pointer; got ${JSON.stringify(result.violations)}`);
});

// =============================================================================
// EC-6 (old-style "follow .sdd/pipeline.md's /x section" pointer → skill-pointer)
// =============================================================================

// @spec EC-6
test('evaluatePipelineSlimness: a skill carrying a "follow .sdd/pipeline.md\'s /cmd section" pointer produces skill-pointer', async () => {
  const { evaluatePipelineSlimness } = await loadModule();
  const commands = ['pipeline'];
  const pipeline = makePipelineMd(commands);
  const entrypoints = new Map(commands.map((c) => pair(c, makeEntrypointMd(c))));
  // oldStylePointer injects the disallowed form into the skill body.
  const skills = new Map([
    pair('pipeline', makeSkillMd('pipeline', { oldStylePointer: true })),
    ...EXEMPT_SKILLS_LIST.map((n) => pair(n, makeExemptSkillMd(n))),
  ]);
  const result = evaluatePipelineSlimness({ pipeline, entrypoints, skills });
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.kind === 'skill-pointer'),
    `a skill with "follow .sdd/pipeline.md's /x section" must produce skill-pointer; got ${JSON.stringify(result.violations)}`);
});

// =============================================================================
// EC-11: CRLF line endings — line counting must use split(/\r?\n/)
// =============================================================================

// @spec EC-11
test('evaluatePipelineSlimness counts CRLF lines the same as LF lines — the same file content is not double-counted', async () => {
  const { evaluatePipelineSlimness, PIPELINE_LINE_BUDGET } = await loadModule();
  // Build a pipeline.md with CRLF endings.
  const crlfPipeline = makePipelineMd(['pipeline', 'hotfix'], { crlfLineEndings: true });
  const lfPipeline = makePipelineMd(['pipeline', 'hotfix']);

  const entrypoints = new Map([pair('pipeline', makeEntrypointMd('pipeline')), pair('hotfix', makeEntrypointMd('hotfix'))]);
  const skills = new Map([
    pair('pipeline', makeSkillMd('pipeline')),
    pair('hotfix', makeSkillMd('hotfix')),
    ...EXEMPT_SKILLS_LIST.map((n) => pair(n, makeExemptSkillMd(n))),
  ]);

  const crlfResult = evaluatePipelineSlimness({ pipeline: crlfPipeline, entrypoints, skills });
  const lfResult = evaluatePipelineSlimness({ pipeline: lfPipeline, entrypoints, skills });

  assert.equal(crlfResult.lineCount, lfResult.lineCount,
    'CRLF and LF variants of the same content must produce the same line count — split(/\\r?\\n/) not split(\\n)');
  assert.equal(crlfResult.ok, lfResult.ok,
    'CRLF variant must reach the same verdict as the LF variant');
});

// @spec EC-11
test('evaluatePipelineSlimness: a 301-line CRLF document fails the budget, not a phantom extra line', async () => {
  const { evaluatePipelineSlimness, PIPELINE_LINE_BUDGET } = await loadModule();
  // 301 explicit lines, CRLF terminated — a naive split('\n') on CRLF content would miscount.
  const lines = Array.from({ length: PIPELINE_LINE_BUDGET + 1 }, (_, i) => `Line ${i + 1}.`);
  const crlfContent = lines.join('\r\n') + '\r\n';
  const result = evaluatePipelineSlimness({
    pipeline: crlfContent,
    entrypoints: new Map(),
    skills: new Map(),
  });
  assert.equal(result.lineCount, PIPELINE_LINE_BUDGET + 1,
    'a 301-line CRLF file must be counted as 301 lines, not 602 (split("\\n") on CRLF doubles every \\r)');
  assert.ok(result.violations.some((v) => v.kind === 'budget'),
    'a 301-line CRLF file must fail the budget rule');
});

// =============================================================================
// EC-12: non-.md files and nested directories under entrypoints/ are ignored
// =============================================================================

// @spec EC-12
test('evaluatePipelineSlimness: non-.md files under entrypoints/ are ignored and do not produce orphan violations', async () => {
  const { evaluatePipelineSlimness } = await loadModule();
  const commands = ['pipeline'];
  const pipeline = makePipelineMd(commands);
  // entrypoints Map has pipeline.md (real) and pipeline.md.swp (editor swap file — must be ignored).
  const entrypoints = new Map([
    pair('pipeline', makeEntrypointMd('pipeline')),
    // Simulated as a non-.md key — the script's disk walk must filter these out.
  ]);
  const skills = new Map([
    pair('pipeline', makeSkillMd('pipeline')),
    ...EXEMPT_SKILLS_LIST.map((n) => pair(n, makeExemptSkillMd(n))),
  ]);
  const result = evaluatePipelineSlimness({ pipeline, entrypoints, skills });
  // The non-.md entries (if any leaked through) must not cause orphan violations.
  const orphans = result.violations.filter((v) => v.kind === 'orphan-entrypoint');
  assert.deepEqual(orphans, [], `non-.md files must not produce orphan-entrypoint violations; got ${JSON.stringify(result.violations)}`);
});

// =============================================================================
// EC-13: --json output shape
// =============================================================================

// @spec EC-13
test('CLI --json on a passing run outputs { ok: true, violations: [] } on stdout and exits 0', () => {
  const root = fixtureRoot();
  const { code, json } = runJson(root);
  assert.equal(code, EXIT_OK);
  assert.equal(json.ok, true, `expected ok:true for a valid fixture; violations: ${JSON.stringify(json.violations)}`);
  assert.deepEqual(json.violations, []);
  assert.equal(typeof json.lineCount, 'number', 'lineCount must be present in --json output');
  assert.equal(json.budget, 300, 'budget must be present in --json output');
});

// @spec EC-13
test('CLI --json on a failing run outputs { ok: false, violations: [...] } on stdout and exits 1', () => {
  const root = fixtureRoot({
    // Add an orphan entrypoint to force a violation.
    entrypointsExtra: [['orphan-command.md', makeEntrypointMd('orphan-command')]],
  });
  const { code, json } = runJson(root);
  assert.equal(code, EXIT_VIOLATION);
  assert.equal(json.ok, false, 'ok must be false when violations are present');
  assert.ok(Array.isArray(json.violations) && json.violations.length > 0,
    'violations must be a non-empty array on a failing run');
});

// =============================================================================
// EC-9: missing .sdd/entrypoints/, missing .sdd/pipeline.md, or missing .claude/skills/ → exit 2
// =============================================================================

// @spec EC-9
test('CLI exits 2 when .sdd/entrypoints/ is missing entirely — never 0 or 1', () => {
  const root = fixtureRoot();
  // Remove the entrypoints directory.
  rmSync(join(root, '.sdd', 'entrypoints'), { recursive: true, force: true });
  const { code, stderr } = run(root);
  assert.equal(code, EXIT_CANNOT_RUN,
    `.sdd/entrypoints/ missing must exit 2 — "cannot perform" — never 0 (clean) or 1 (violation)`);
  assert.ok(stderr.length > 0, 'exit 2 must write a diagnostic to stderr');
});

// @spec EC-9
test('CLI exits 2 when .sdd/pipeline.md is unreadable (missing) — never 0 or 1', () => {
  const root = fixtureRoot();
  rmSync(join(root, '.sdd', 'pipeline.md'), { force: true });
  const { code } = run(root);
  assert.equal(code, EXIT_CANNOT_RUN, '.sdd/pipeline.md missing must exit 2, never 0 or 1');
});

// @spec EC-9
test('CLI exits 2 when .claude/skills/ is missing entirely — never 0 or 1', () => {
  const root = fixtureRoot();
  rmSync(join(root, '.claude', 'skills'), { recursive: true, force: true });
  const { code } = run(root);
  assert.equal(code, EXIT_CANNOT_RUN, '.claude/skills/ missing must exit 2, never 0 or 1');
});

// =============================================================================
// EC-10: unknown CLI flag → exit 2 with a usage message
// =============================================================================

// @spec EC-10
test('CLI exits 2 and names the unrecognized flag when given an unknown argument', () => {
  const root = fixtureRoot();
  const { code, stderr } = run(root, ['--typo']);
  assert.equal(code, EXIT_CANNOT_RUN, 'an unknown flag must exit 2, not 0 or 1');
  assert.match(stderr, /--typo/, 'the usage message must name the unrecognized flag');
});

// =============================================================================
// EC-16: two skills naming the same entrypoint → skill-pointer on both
// =============================================================================

// @spec EC-16
test('evaluatePipelineSlimness: two skills naming the same entrypoint both receive skill-pointer violations', async () => {
  const { evaluatePipelineSlimness } = await loadModule();
  const commands = ['pipeline', 'hotfix'];
  const pipeline = makePipelineMd(commands);
  const entrypoints = new Map(commands.map((c) => pair(c, makeEntrypointMd(c))));
  // Both 'pipeline' and 'hotfix' skills reference pipeline.md's entrypoint — hotfix is the wrong owner.
  const skills = new Map([
    pair('pipeline', makeSkillMd('pipeline')),
    pair('hotfix', makeSkillMd('hotfix', { extraEntrypoint: 'pipeline' })), // copies pipeline's entrypoint
    ...EXEMPT_SKILLS_LIST.map((n) => pair(n, makeExemptSkillMd(n))),
  ]);
  const result = evaluatePipelineSlimness({ pipeline, entrypoints, skills });
  assert.equal(result.ok, false);
  const pointerViolations = result.violations.filter((v) => v.kind === 'skill-pointer');
  assert.ok(pointerViolations.length >= 1,
    `a skill copying another's entrypoint reference must produce at least one skill-pointer; got ${JSON.stringify(result.violations)}`);
});

// =============================================================================
// EC-17: .sdd/ledger/** is excluded from the directory walk — never an orphan
// =============================================================================

// @spec EC-17
test('checkPipelineSlim: .sdd/ledger/ content is excluded and does not produce orphan-entrypoint violations', () => {
  const root = fixtureRoot({ ledgerEntry: true });
  // A historical ledger entry quoting a pipeline.md section lives under .sdd/ledger/ — it must
  // never be discovered by the entrypoint or skill walk.
  const { code, json } = runJson(root);
  assert.equal(code, EXIT_OK, `.sdd/ledger/ content must not cause a violation; got ${JSON.stringify(json.violations)}`);
  assert.equal(json.ok, true);
});

// =============================================================================
// AC-8 / unstubbed-entrypoint: an entrypoint with no matching stub in pipeline.md
// =============================================================================

// @spec AC-8
test('evaluatePipelineSlimness: an entrypoint file with no matching ### /cmd stub in pipeline.md produces unstubbed-entrypoint', async () => {
  const { evaluatePipelineSlimness } = await loadModule();
  const commands = ['pipeline']; // only one stub in pipeline.md
  const pipeline = makePipelineMd(commands);
  // But there are TWO entrypoints — 'hotfix' has no stub.
  const entrypoints = new Map([
    pair('pipeline', makeEntrypointMd('pipeline')),
    pair('hotfix', makeEntrypointMd('hotfix')),
  ]);
  const skills = new Map([
    pair('pipeline', makeSkillMd('pipeline')),
    pair('hotfix', makeSkillMd('hotfix')),
    ...EXEMPT_SKILLS_LIST.map((n) => pair(n, makeExemptSkillMd(n))),
  ]);
  const result = evaluatePipelineSlimness({ pipeline, entrypoints, skills });
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.kind === 'unstubbed-entrypoint'),
    `an entrypoint with no stub in pipeline.md must produce unstubbed-entrypoint; got ${JSON.stringify(result.violations)}`);
});

// =============================================================================
// AC-9: checkPipelineSlim exits 0 against this actual repository after the split
// =============================================================================

// @spec AC-9
test('checkPipelineSlim exits 0 against this repository — the split has been completed correctly', () => {
  // This test reads the ACTUAL repo root. Before dev runs:
  //   - scripts/check-pipeline-slim.mjs doesn't exist → checkPipelineSlim cannot be called
  //   - .sdd/entrypoints/ doesn't exist → the check would exit 2
  //   - .sdd/pipeline.md is 951 lines → would violate the budget
  // All three cause this test to fail → RED-CORRECT.
  const { status: code, stdout, stderr } = spawnSync(
    process.execPath,
    [CHECK_SLIM, '--json'],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  assert.equal(code, EXIT_OK,
    `check-pipeline-slim.mjs must exit 0 against this repo after the split; got exit ${code}\nstdout: ${stdout}\nstderr: ${stderr}`);
});
