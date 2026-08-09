// Tests scripts/check-lite-eligible.mjs (PL-11) — the mechanical eligibility gate for the
// `/pipeline-lite` lane: is this change provably small enough, and clear enough of the barred paths,
// to skip `red` and `security` at all?
//
// Authored by the `red` stage from .pipeline/spec.md alone, BEFORE scripts/check-lite-eligible.mjs
// exists. Every assertion below comes from that spec's Interfaces/AC/EC sections, never from an
// implementation.
//
// Conventions follow scripts/ledger-append.test.mjs and scripts/check-bounds.test.mjs: node:test,
// tmpdir()-based throwaway fixture repos, afterEach cleanup, no new framework. The script under test
// imports scripts/check-bounds.mjs by relative path and that file reads .sdd/bounds.yml relative to
// its own location, so a fixture repo carries copies of both plus a synthetic .sdd/bounds.yml.
//
// The bounds fixtures below are written from a self-contained literal (`boundsYml()`), deliberately
// NOT derived from the real .sdd/bounds.yml: this suite needs to construct the "no lite_eligibility
// block at all" and "malformed block" states (EC-16) independently of whatever the real file happens
// to say on any given day, and appending to / stripping from the real file would make those fixtures
// silently change meaning the moment the real file gains the block.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, test } from 'node:test';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const CHECK_LITE_ELIGIBLE = resolve(scriptsDir, 'check-lite-eligible.mjs');
const checkBoundsSource = readFileSync(resolve(scriptsDir, 'check-bounds.mjs'), 'utf8');

const ELIGIBLE = 0;
const INELIGIBLE = 1;
const CANNOT_RUN = 2;

const roots = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

/** Read the script under test lazily, tolerating its absence, so a missing file surfaces as a
 * per-test failure with a clear message (see `run()` below) rather than a module-level throw that
 * takes every test in this file down with one indistinguishable error. */
function sourceIfPresent(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

/** A self-contained bounds.yml in exactly the shape scripts/check-bounds.mjs's `readBounds()` parses.
 * `lite` may be an object (the well-formed case), `null` (the block absent entirely — EC-16), or a
 * raw string of YAML lines to splice under `lite_eligibility:` (the malformed cases — EC-16).
 *
 * `max_line_length` defaults to a deliberately generous 100000 (security round FND-22ef4b5c746e) —
 * this fixture's OTHER tests write files/lines nowhere near that size, so the default must never trip
 * the new bound; tests that specifically exercise `max_line_length` override it with a tight value.
 *
 * @param {{ lite?: { max_files: number, max_changed_lines: number, max_line_length?: number } | string | null }} [options]
 *   Annotated explicitly (the same fix check-bounds.mjs's own `assertKnownFlags` needed, per that
 *   file's header comment) because plain JS parameter-shape inference from a destructuring default
 *   only sees the default value's own shape (an object), which then flags every string-argument call
 *   site below (EC-16's malformed-block cases) as a type error — a false positive from missing type
 *   information, not a real defect in the fixture. */
function boundsYml({ lite = { max_files: 5, max_changed_lines: 150, max_line_length: 100000 } } = {}) {
  let liteBlock = '';
  if (typeof lite === 'string') {
    liteBlock = `\nlite_eligibility:\n${lite}\n`;
  } else if (lite) {
    liteBlock = `\nlite_eligibility:\n  max_files: ${lite.max_files}\n  max_changed_lines: ${lite.max_changed_lines}\n  max_line_length: ${lite.max_line_length}\n`;
  }
  return [
    'version: 1',
    '',
    'lanes:',
    '  frontend:',
    '    allow:',
    '      - apps/web/**',
    '      - docs/**',
    '  full:',
    '    allow:',
    '      - "**"',
    '',
    'deny_for_fenced_lanes:',
    '  - .sdd/**',
    '  - .claude/**',
    '  - .github/workflows/**',
    '  - scripts/guard-checker-readonly.mjs',
    '  - scripts/check-bounds.mjs',
    '  - .gitignore',
    '  - CLAUDE.md',
    '  - AGENTS.md',
    '',
    'hotfix_barred_paths:',
    '  - services/core/src/security/**',
    '  - services/core/src/graph-query/**',
    '  - services/core/src/webhooks/**',
    '  - packages/graph-schema/**',
    // The five entries security round FND-b731f500c5b8 added to the real .sdd/bounds.yml — mirrored
    // here (this fixture is deliberately independent of the real file, per this suite's own header
    // comment) so the barred-union tests below exercise the same widened set the real lite lane does.
    '  - services/core/src/services/**',
    '  - services/core/src/routes/**',
    '  - services/core/src/mcp/**',
    '  - services/workers/**',
    '  - services/gateway/**',
    liteBlock,
  ].join('\n');
}

/** The in-memory equivalent of the fixture above, for the pure `evaluateLiteEligibility` /
 * `liteBarredPaths` tests that take a `bounds` object directly instead of reading a file. */
function boundsObject({ liteEligibility = { maxFiles: 5, maxChangedLines: 150, maxLineLength: 100000 } } = {}) {
  return {
    lanes: { frontend: ['apps/web/**', 'docs/**'], full: ['**'] },
    denyForFenced: ['.sdd/**', '.claude/**', '.github/workflows/**', 'scripts/check-bounds.mjs', 'CLAUDE.md'],
    hotfixBarredPaths: ['services/core/src/security/**', 'services/core/src/graph-query/**', 'packages/graph-schema/**'],
    liteEligibility,
  };
}

/** A throwaway git fixture repo carrying copies of the script under test and check-bounds.mjs, a
 * synthetic .sdd/bounds.yml, and any caller-supplied committed baseline files. */
function fixtureRepo({ bounds = boundsYml(), files = {} } = {}) {
  const root = mkdtempSync(resolve(tmpdir(), 'sayre-lite-eligible-'));
  roots.push(root);

  mkdirSync(join(root, 'scripts'), { recursive: true });
  const liteSource = sourceIfPresent(CHECK_LITE_ELIGIBLE);
  if (liteSource !== null) writeFileSync(join(root, 'scripts', 'check-lite-eligible.mjs'), liteSource, 'utf8');
  writeFileSync(join(root, 'scripts', 'check-bounds.mjs'), checkBoundsSource, 'utf8');

  mkdirSync(join(root, '.sdd'), { recursive: true });
  writeFileSync(join(root, '.sdd', 'bounds.yml'), bounds, 'utf8');

  for (const [relPath, contents] of Object.entries(files)) {
    const dest = join(root, relPath);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, contents);
  }

  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'lite-eligible-test@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Lite Eligible Test'], { cwd: root });
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: root });
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n', 'utf8');
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '--quiet', '-m', 'baseline'], { cwd: root });
  return root;
}

function write(root, relPath, contents) {
  const dest = join(root, relPath);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, contents);
}

function commitAll(root, message) {
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '--quiet', '-m', message], { cwd: root });
}

/** Runs the CLI inside a fixture repo.
 *
 * The guard matters: when scripts/check-lite-eligible.mjs does not exist (or is later renamed/
 * deleted), node itself exits 1 — the SAME code this CLI uses for "ineligible". Without this check
 * every `assert.equal(code, INELIGIBLE)` below would read as a pass while nothing was actually
 * checked, which is precisely the "a broken gate reads as a passing one" failure the 1/2 exit split
 * exists to prevent. */
function run(root, args = []) {
  const result = spawnSync(process.execPath, [join(root, 'scripts', 'check-lite-eligible.mjs'), ...args], {
    cwd: root,
    encoding: 'utf8',
  });
  const stderr = result.stderr ?? '';
  assert.ok(
    !/ERR_MODULE_NOT_FOUND|Cannot find module/.test(stderr),
    `scripts/check-lite-eligible.mjs could not be loaded at all — that is node's own module-not-found exit, not an eligibility verdict:\n${stderr}`,
  );
  return { code: result.status, stdout: result.stdout ?? '', stderr };
}

function runJson(root, args = []) {
  // `--json` goes FIRST, never appended: `--files` consumes every remaining argument and must be
  // last (the convention check-bounds.mjs and ledger-append.mjs --hotfix already use), so a trailing
  // `--json` would be swallowed as one more file path.
  const result = run(root, ['--json', ...args]);
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    assert.fail(`--json must emit parseable JSON on stdout; got:\n${result.stdout}\n${result.stderr}\n(${error})`);
  }
  return { ...result, json: parsed };
}

/** Dynamic import (not a static one) for the same reason `run()` guards on ERR_MODULE_NOT_FOUND: at
 * red time the module does not exist, and a static import would fail this whole file at link time
 * with one error instead of failing each test for its own, readable reason. */
async function loadModule() {
  return import(pathToFileURL(CHECK_LITE_ELIGIBLE).href);
}

const violationKinds = (json) => (json.violations ?? []).map((violation) => violation.kind);

// --- AC-6: the script exists, computes the verdict mechanically, and exits 0/1/2 -----------------

// @spec AC-6
test('a small, unbarred working-tree change is eligible: exit 0, with the counts and the bounds it was measured against', () => {
  // A tracked one-line edit: `git diff --numstat` reports it as 1 added + 1 deleted, so "added +
  // deleted across files" is exactly 2 with no dependence on how a trailing newline is counted.
  const root = fixtureRepo({ files: { 'app/small-fix.ts': 'export const a = 1;\n' } });
  writeFileSync(join(root, 'app', 'small-fix.ts'), 'export const a = 2;\n', 'utf8');

  const { code, json } = runJson(root);
  assert.equal(code, ELIGIBLE);
  assert.equal(json.eligible, true);
  assert.equal(json.fileCount, 1);
  assert.equal(json.changedLines, 2);
  assert.equal(json.changedLinesChecked, true);
  assert.equal(json.maxFiles, 5);
  assert.equal(json.maxChangedLines, 150);
  assert.deepEqual(json.violations, []);
});

// @spec AC-6
test('an untracked file contributes its own lines to the total — a brand-new file is not invisible to the size bound', () => {
  // Asserted as a lower bound rather than an exact total on purpose: `git diff --numstat` never sees
  // an untracked path at all, so the script counts the file itself, and whether a newline-terminated
  // 3-line file counts as 3 is a convention this spec does not pin. What it does pin is that those
  // lines are counted at all — the direction that matters, since the failure worth catching is a
  // large new file sliding under the bound as "0 changed lines".
  const root = fixtureRepo({ files: { 'app/small-fix.ts': 'export const a = 1;\n' } });
  writeFileSync(join(root, 'app', 'small-fix.ts'), 'export const a = 2;\n', 'utf8');
  const trackedOnly = runJson(root).json.changedLines;

  write(root, 'app/brand-new.ts', 'const one = 1;\nconst two = 2;\nconst three = 3;\n');
  const withUntracked = runJson(root).json;
  assert.equal(withUntracked.fileCount, 2);
  assert.ok(
    withUntracked.changedLines >= trackedOnly + 3,
    `an untracked 3-line file must add at least 3 to the total (was ${trackedOnly}, now ${withUntracked.changedLines})`,
  );
});

// @spec AC-6
test('exports evaluateLiteEligibility / countChangedLines / resolveWorktreeFiles / liteBarredPaths and LITE_VIOLATION_KINDS for in-process reuse, and importing it does not run its CLI', async () => {
  const module = await loadModule();
  for (const name of ['evaluateLiteEligibility', 'countChangedLines', 'resolveWorktreeFiles', 'liteBarredPaths']) {
    assert.equal(typeof module[name], 'function', `scripts/check-lite-eligible.mjs must export ${name} — ledger-append.mjs --lite reuses it in-process rather than shelling out`);
  }
  assert.deepEqual(module.LITE_VIOLATION_KINDS, ['barred-path', 'file-count', 'changed-lines', 'unsizable', 'line-length']);
  // Reaching this line at all proves the `process.argv[1] === import.meta.url` guard held: an
  // unguarded main() would have called process.exit() against this test process's own argv.
});

// @spec AC-6
test('reuses scripts/check-bounds.mjs\'s readBounds/matchesAny rather than re-implementing globbing or the bounds read', () => {
  const source = readFileSync(CHECK_LITE_ELIGIBLE, 'utf8');
  assert.match(source, /import\s*\{[^}]*\breadBounds\b[^}]*\}\s*from\s*'\.\/check-bounds\.mjs'/s);
  assert.match(source, /import\s*\{[^}]*\bmatchesAny\b[^}]*\}\s*from\s*'\.\/check-bounds\.mjs'/s);
  // A second, independently-written glob matcher or YAML reader is exactly the drift .sdd/README.md
  // says this directory exists to prevent (and the one check-bounds.mjs's own fuzz suite covers).
  assert.doesNotMatch(source, /function\s+(globMatches|segmentMatches)\b/);
  assert.doesNotMatch(source, /function\s+readBounds\b/);
});

// @spec AC-6 EC-1
test('an unrecognized argument fails loudly by name with exit 2 — a typo\'d flag must never read as an eligible change', () => {
  const root = fixtureRepo();
  const { code, stderr } = run(root, ['--jsno']);
  assert.equal(code, CANNOT_RUN);
  assert.match(stderr, /unrecognized argument "--jsno"/);
});

// @spec AC-6
test('--files checks paths and count only: changedLines is null and changedLinesChecked is false, which is not by itself ineligible', () => {
  const root = fixtureRepo();
  const { code, json } = runJson(root, ['--files', 'app/one.ts', 'app/two.ts']);
  assert.equal(code, ELIGIBLE);
  assert.equal(json.eligible, true);
  assert.equal(json.fileCount, 2);
  assert.equal(json.changedLines, null, '"not measured" must be null, never 0 — 0 would claim a measurement that never happened');
  assert.equal(json.changedLinesChecked, false);
  assert.deepEqual(json.violations, []);
});

// @spec AC-6
test('--base <ref> measures the merge-base..HEAD diff instead of the live working tree', () => {
  const root = fixtureRepo();
  write(root, 'app/committed-change.ts', 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
  commitAll(root, 'the change under review');

  const { code, json } = runJson(root, ['--base', 'HEAD~1']);
  assert.equal(code, ELIGIBLE, 'a committed 1-file/3-line change is eligible when measured against its base');
  assert.equal(json.fileCount, 1);
  assert.equal(json.changedLines, 3);
  assert.equal(json.changedLinesChecked, true);
});

// --- EC-2: too many files, or too many changed lines ---------------------------------------------

// @spec EC-2
test('more files than max_files is ineligible (exit 1), naming the count and the bound it exceeded', () => {
  const root = fixtureRepo();
  for (let i = 0; i < 6; i++) write(root, `app/file-${i}.ts`, 'export const x = 1;\n');

  const { code, stdout, json } = runJson(root);
  assert.equal(code, INELIGIBLE);
  assert.equal(json.eligible, false);
  assert.equal(json.fileCount, 6);
  assert.ok(violationKinds(json).includes('file-count'));
  assert.match(`${stdout}${JSON.stringify(json)}`, /6/);
  assert.match(`${stdout}${JSON.stringify(json)}`, /5/);
});

// @spec EC-2
test('more changed lines than max_changed_lines is ineligible (exit 1), naming the count and the bound', () => {
  const root = fixtureRepo();
  write(root, 'app/big-but-single-file.ts', 'const x = 1;\n'.repeat(200));

  const { code, json } = runJson(root);
  assert.equal(code, INELIGIBLE);
  assert.equal(json.eligible, false);
  assert.equal(json.fileCount, 1, 'one file — this must fail on the line bound, not the file bound');
  assert.ok(json.changedLines > 150, `expected a measured count above the bound, got ${json.changedLines}`);
  assert.ok(violationKinds(json).includes('changed-lines'));
  const detail = (json.violations ?? []).find((v) => v.kind === 'changed-lines')?.detail ?? '';
  assert.match(detail, new RegExp(String(json.changedLines)), 'the refusal must name the actual count');
  assert.match(detail, /150/, 'the refusal must name the bound it exceeded');
});

// --- EC-2 (secondary bound): a diff shaped as very few, very long lines — security FND-22ef4b5c746e --

// @spec EC-2
test('a diff shaped as very few, very long lines is ineligible via max_line_length, even though max_changed_lines alone would not catch it', () => {
  const root = fixtureRepo({
    bounds: boundsYml({ lite: { max_files: 5, max_changed_lines: 150, max_line_length: 500 } }),
    files: { 'app/shaped.ts': 'export const shaped = 1;\n' },
  });
  // A single line grown to ~20,000 characters: `git diff --numstat` reports this as 1 added + 1
  // deleted = 2 changed lines — trivially under max_changed_lines (150) — the exact shape security
  // reproduced (a ~44KB single-line replacement measuring changedLines: 2 and reading ELIGIBLE).
  writeFileSync(join(root, 'app', 'shaped.ts'), `export const shaped = "${'x'.repeat(20000)}";\n`, 'utf8');

  const { code, json } = runJson(root);
  assert.equal(code, INELIGIBLE);
  assert.equal(json.fileCount, 1);
  assert.ok(json.changedLines <= 10, `expected the LINE COUNT to stay tiny (was ${json.changedLines}) — that is the whole point of the exploit shape max_changed_lines alone cannot catch`);
  assert.ok(violationKinds(json).includes('line-length'));
  const detail = (json.violations ?? []).find((v) => v.kind === 'line-length')?.detail ?? '';
  assert.match(detail, /500/, 'the refusal must name the bound it exceeded');
});

// @spec EC-2
test('a changed line under max_line_length does not trip the new bound', () => {
  const root = fixtureRepo({
    bounds: boundsYml({ lite: { max_files: 5, max_changed_lines: 150, max_line_length: 500 } }),
    files: { 'app/ok.ts': 'export const a = 1;\n' },
  });
  writeFileSync(join(root, 'app', 'ok.ts'), `export const a = "${'y'.repeat(100)}";\n`, 'utf8');

  const { code, json } = runJson(root);
  assert.equal(code, ELIGIBLE);
  assert.deepEqual(json.violations, []);
});

// @spec EC-2 AC-6
test('evaluateLiteEligibility treats an over-long single line as ineligible via the line-length violation kind, independent of changedLines staying under max_changed_lines', async () => {
  const { evaluateLiteEligibility } = await loadModule();
  const bounds = boundsObject({ liteEligibility: { maxFiles: 5, maxChangedLines: 150, maxLineLength: 500 } });
  const result = evaluateLiteEligibility({
    files: ['app/shaped.ts'],
    changedLines: 2,
    lineLength: 20000,
    bounds,
  });
  assert.equal(result.eligible, false);
  assert.ok(result.violations.some((v) => v.kind === 'line-length'));
  assert.equal(result.lineLength, 20000);
  assert.equal(result.lineLengthChecked, true);
  assert.equal(result.maxLineLength, 500);
  const detail = result.violations.find((v) => v.kind === 'line-length')?.detail ?? '';
  assert.match(detail, /20000/);
  assert.match(detail, /500/);
});

// @spec EC-2 AC-6
test('evaluateLiteEligibility treats lineLength: null as "not measured" — not, by itself, ineligible', async () => {
  const { evaluateLiteEligibility } = await loadModule();
  const result = evaluateLiteEligibility({
    files: ['app/a.ts'],
    changedLines: null,
    lineLength: null,
    bounds: boundsObject({ liteEligibility: { maxFiles: 5, maxChangedLines: 150, maxLineLength: 500 } }),
  });
  assert.equal(result.lineLength, null);
  assert.equal(result.lineLengthChecked, false);
  assert.equal(result.eligible, true);
});

// --- EC-3: the barred union (hotfix_barred_paths + deny_for_fenced_lanes), no third list ----------

// @spec EC-3
test('a path in the barred union is ineligible, naming the path and which of the two lists barred it', () => {
  const root = fixtureRepo();
  for (const { path, list } of [
    { path: 'services/core/src/security/tokens.ts', list: /hotfix_barred_paths/ },
    { path: '.sdd/pipeline.md', list: /deny_for_fenced_lanes/ },
  ]) {
    const { code, json } = runJson(root, ['--files', path]);
    assert.equal(code, INELIGIBLE, path);
    assert.ok(violationKinds(json).includes('barred-path'), path);
    const violation = (json.violations ?? []).find((v) => v.kind === 'barred-path');
    assert.equal(violation.path, path);
    assert.match(violation.detail, list, `${path}: the refusal must name which list barred it, not merely that something did`);
  }
});

// @spec EC-3 (widened — security round FND-b731f500c5b8, HIGH)
test('the widened hotfix_barred_paths union also bars the service layer, routes, MCP handlers, the worker fleet, and the gateway', () => {
  // Security reproduced a ~44KB single-line replacement of a services/core/src/services/** file
  // reading ELIGIBLE before this fix — these five globs were the coverage gap.
  const root = fixtureRepo();
  for (const path of [
    'services/core/src/services/technicalTreeService.ts',
    'services/core/src/routes/graph.ts',
    'services/core/src/mcp/tools.ts',
    'services/workers/ingest.py',
    'services/gateway/socket.ts',
  ]) {
    const { code, json } = runJson(root, ['--files', path]);
    assert.equal(code, INELIGIBLE, path);
    assert.ok(violationKinds(json).includes('barred-path'), path);
    const violation = (json.violations ?? []).find((v) => v.kind === 'barred-path');
    assert.equal(violation.path, path);
    assert.match(violation.detail, /hotfix_barred_paths/, `${path}: must be barred via hotfix_barred_paths specifically, the list this fix widened`);
  }
});

// @spec EC-3 AC-6
test('liteBarredPaths is the deduped, sorted union of hotfixBarredPaths and denyForFenced — never a third list read from bounds.yml', async () => {
  const { liteBarredPaths } = await loadModule();
  const bounds = {
    lanes: { full: ['**'] },
    denyForFenced: ['.sdd/**', 'CLAUDE.md', 'shared/**'],
    hotfixBarredPaths: ['services/core/src/security/**', 'shared/**'],
    liteEligibility: { maxFiles: 5, maxChangedLines: 150 },
  };
  assert.deepEqual(liteBarredPaths(bounds), ['.sdd/**', 'CLAUDE.md', 'services/core/src/security/**', 'shared/**']);
});

// --- EC-4: a change that cannot be measured is never measured as small ---------------------------

// @spec EC-4
test('a binary file (git diff --numstat reports -/-) lands in unsizable and makes the change ineligible', () => {
  const root = fixtureRepo({ files: { 'assets/blob.bin': Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff]) } });
  writeFileSync(join(root, 'assets', 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff, 0x00, 0x7f, 0x00]));

  const { code, json } = runJson(root);
  assert.equal(code, INELIGIBLE);
  assert.equal(json.eligible, false);
  assert.ok(violationKinds(json).includes('unsizable'));
  const violation = (json.violations ?? []).find((v) => v.kind === 'unsizable');
  assert.equal(violation.path, 'assets/blob.bin');
});

// @spec EC-4 AC-6
test('countChangedLines reports a binary path in `unsizable` rather than silently counting it as zero', async () => {
  const { countChangedLines } = await loadModule();
  const root = fixtureRepo({
    files: { 'assets/blob.bin': Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff]), 'app/text.ts': 'const a = 1;\n' },
  });
  writeFileSync(join(root, 'assets', 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff, 0x00, 0x7f, 0x00]));
  writeFileSync(join(root, 'app', 'text.ts'), 'const a = 2;\n', 'utf8');

  const result = countChangedLines(['assets/blob.bin', 'app/text.ts'], { cwd: root });
  assert.deepEqual(result.unsizable, ['assets/blob.bin']);
  assert.equal(result.changedLines, 2, 'the sizable half is still counted (1 added + 1 deleted); the unsizable path is disclosed rather than folded into the total as 0');
});

// @spec AC-6
test('resolveWorktreeFiles returns both tracked modifications and untracked additions', async () => {
  const { resolveWorktreeFiles } = await loadModule();
  const root = fixtureRepo({ files: { 'app/tracked.ts': 'export const tracked = 1;\n' } });
  writeFileSync(join(root, 'app', 'tracked.ts'), 'export const tracked = 2;\n', 'utf8');
  write(root, 'app/untracked.ts', 'export const fresh = 1;\n');

  const files = resolveWorktreeFiles(root);
  assert.ok(files.includes('app/tracked.ts'), 'a modified tracked file is part of the live change set');
  assert.ok(files.includes('app/untracked.ts'), 'an untracked new file is part of the live change set — `git diff` alone would miss it');
});

// --- EC-16: a missing bound is never read as "no bound" ------------------------------------------

// @spec EC-16 EC-1
test('a bounds.yml with no lite_eligibility block at all exits 2 (could not run) — never 0', () => {
  const root = fixtureRepo({ bounds: boundsYml({ lite: null }) });
  write(root, 'app/tiny.ts', 'export const x = 1;\n');

  const { code, stderr } = run(root);
  assert.equal(code, CANNOT_RUN, 'an absent bound must fail the check, not be read as an unbounded pass');
  assert.match(stderr, /lite_eligibility/);
});

// @spec EC-16
test('a malformed lite_eligibility block exits 2 rather than guessing a bound', () => {
  const root = fixtureRepo({ bounds: boundsYml({ lite: '  max_files: banana\n  max_changed_lines: 150\n  max_line_length: 500' }) });
  write(root, 'app/tiny.ts', 'export const x = 1;\n');
  assert.equal(run(root).code, CANNOT_RUN);

  const missingKey = fixtureRepo({ bounds: boundsYml({ lite: '  max_files: 5' }) });
  write(missingKey, 'app/tiny.ts', 'export const x = 1;\n');
  assert.equal(run(missingKey).code, CANNOT_RUN, 'a half-specified block is as unusable as an absent one');

  // @spec EC-16 (security round FND-22ef4b5c746e): max_files/max_changed_lines alone, valid but
  // WITHOUT the new max_line_length key, must be just as unusable as any other half-specified block —
  // a missing bound is never read as "no bound," and that now applies to all three keys, not two.
  const missingLineLength = fixtureRepo({ bounds: boundsYml({ lite: '  max_files: 5\n  max_changed_lines: 150' }) });
  write(missingLineLength, 'app/tiny.ts', 'export const x = 1;\n');
  assert.equal(run(missingLineLength).code, CANNOT_RUN, 'max_files and max_changed_lines alone, without max_line_length, must not be treated as a complete bound');
});

// @spec EC-16
test('evaluateLiteEligibility throws when bounds.liteEligibility is null — a null bound is never silently treated as permissive', async () => {
  const { evaluateLiteEligibility } = await loadModule();
  assert.throws(() => evaluateLiteEligibility({
    files: ['app/tiny.ts'],
    changedLines: 1,
    bounds: boundsObject({ liteEligibility: null }),
  }));
});

// @spec AC-6
test('evaluateLiteEligibility is pure: the same input yields the same verdict, with the bounds it used echoed back', async () => {
  const { evaluateLiteEligibility } = await loadModule();
  const input = { files: ['app/a.ts', 'app/b.ts'], changedLines: 12, bounds: boundsObject() };
  const first = evaluateLiteEligibility(input);
  const second = evaluateLiteEligibility(input);
  assert.deepEqual(first, second);
  assert.equal(first.eligible, true);
  assert.equal(first.fileCount, 2);
  assert.equal(first.changedLines, 12);
  assert.equal(first.changedLinesChecked, true);
  assert.equal(first.maxFiles, 5);
  assert.equal(first.maxChangedLines, 150);
});

// --- EC-1 / EC-17: ambiguity is ineligibility, never a provisional pass --------------------------

// @spec EC-1
test('a --base that cannot be resolved exits 2 (could not run), never 0', () => {
  const root = fixtureRepo();
  write(root, 'app/tiny.ts', 'export const x = 1;\n');
  const { code } = run(root, ['--base', 'no-such-ref-anywhere']);
  assert.equal(code, CANNOT_RUN, 'a diff base that cannot be resolved is a finding about the tooling, not a clean change');
});

// @spec EC-17 EC-1
test('a clean working tree with nothing to size does not report "eligible" — an unmeasured change is never measured as small', () => {
  const root = fixtureRepo();
  const { code } = run(root);
  assert.notEqual(code, ELIGIBLE, 'nothing was sized, so nothing can be certified small; the lane must not be entered on an empty measurement');
});
