// Tests scripts/check-stamp-freshness.mjs — the mechanical consumer half of the PL-04 review-pass-1
// stamp fix (Blocker 1): the script `.sdd/stages/security.md`'s refusal, and every other stage's
// "flag a stale stamp" instruction, actually runs, so the freshness policy in .sdd/pipeline.md's
// "Staleness stamps" section is a real, testable code path rather than an assertion about wiring that
// was never built.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';
import { attachStamp } from './write-stamp.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const scriptPath = resolve(scriptsDir, 'check-stamp-freshness.mjs');

const roots = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

/** Mirrors write-stamp.test.mjs's / pipeline-contracts.test.mjs's own gitFixtureRepo() — duplicated
 * locally rather than shared, same reasoning as those files (small helper, different test file).
 *
 * Gitignores `.pipeline/` (the real repo's own `.gitignore` rule — ".pipeline/** except its own
 * README.md"), the same reason write-stamp.test.mjs's own gitFixtureRepo() does: a sidecar's own
 * on-disk bytes must never enter `computeTreeHash`'s untracked-file component, or attaching/reading a
 * stamp for a sidecar under `.pipeline/` would make freshness depend on that file's own last-written
 * content, which no real invocation of either script would see once it is actually ignored. */
function gitFixtureRepo() {
  const root = mkdtempSync(resolve(tmpdir(), 'sayre-check-stamp-freshness-'));
  roots.push(root);
  writeFileSync(join(root, 'tracked.txt'), 'original content\n', 'utf8');
  writeFileSync(join(root, '.gitignore'), '.pipeline/**\n', 'utf8');
  mkdirSync(join(root, '.pipeline'), { recursive: true });
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'check-stamp-freshness-test@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Check Stamp Freshness Test'], { cwd: root });
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: root });
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '--quiet', '-m', 'initial commit'], { cwd: root });
  return root;
}

function pipelineDirIn(root) {
  const dir = join(root, '.pipeline');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function runCli(args) {
  return spawnSync(process.execPath, [scriptPath, ...args], { encoding: 'utf8' });
}

/** The script prints its JSON report first (JSON.stringify(..., null, 2), so the closing `}` of that
 * top-level, single-level object always sits alone at the start of a line), then one or more plain
 * `check-stamp-freshness: ...` summary lines — same convention check-red-integrity.mjs uses. Slicing
 * up to the first "\n}" isolates exactly that JSON block for JSON.parse, without depending on the
 * plain-line text that follows it. */
function parseReport(stdout) {
  return JSON.parse(stdout.slice(0, stdout.indexOf('\n}') + 2));
}

// --- status: absent ------------------------------------------------------------------------------

test('reports "absent" and exits 0 when the named sidecar does not exist in --dir', () => {
  const root = gitFixtureRepo();
  const dir = pipelineDirIn(root);
  const result = runCli(['review.json', '--dir', dir, '--cwd', root]);
  assert.equal(result.status, 0, result.stderr);
  const parsed = parseReport(result.stdout);
  assert.equal(parsed.status, 'absent');
  assert.equal(parsed.file, 'review.json');
});

// --- status: unknown -------------------------------------------------------------------------------

test('reports "unknown" and exits 0 when the sidecar exists but has no stamp field at all', () => {
  const root = gitFixtureRepo();
  const dir = pipelineDirIn(root);
  writeFileSync(join(dir, 'review.json'), JSON.stringify({ verdict: 'PASS' }), 'utf8');

  const result = runCli(['review.json', '--dir', dir, '--cwd', root]);
  assert.equal(result.status, 0, result.stderr);
  const parsed = parseReport(result.stdout);
  assert.equal(parsed.status, 'unknown');
});

// --- status: fresh / stale -------------------------------------------------------------------------

test('reports "fresh" and exits 0 immediately after write-stamp attaches a stamp against the same tree', () => {
  const root = gitFixtureRepo();
  const dir = pipelineDirIn(root);
  const path = join(dir, 'review.json');
  writeFileSync(path, JSON.stringify({ verdict: 'PASS' }), 'utf8');
  attachStamp(path, { cwd: root });

  const result = runCli(['review.json', '--dir', dir, '--cwd', root]);
  assert.equal(result.status, 0, result.stderr);
  const parsed = parseReport(result.stdout);
  assert.equal(parsed.status, 'fresh');
});

test('reports "stale" and exits 1 once the working tree changes after the stamp was written — this is the exit code security.md keys its refusal on', () => {
  const root = gitFixtureRepo();
  const dir = pipelineDirIn(root);
  const path = join(dir, 'review.json');
  writeFileSync(path, JSON.stringify({ verdict: 'PASS' }), 'utf8');
  attachStamp(path, { cwd: root });

  // The tree moves on: a hand-edit to a tracked file after review.json was stamped.
  writeFileSync(join(root, 'tracked.txt'), 'edited after the stamp was written\n', 'utf8');

  const result = runCli(['review.json', '--dir', dir, '--cwd', root]);
  assert.equal(result.status, 1);
  const parsed = parseReport(result.stdout);
  assert.equal(parsed.status, 'stale');
  assert.match(result.stderr, /STALE/);
});

test('a stale review.json returns to "fresh" once the tree is restored to the exact state the stamp describes', () => {
  const root = gitFixtureRepo();
  const dir = pipelineDirIn(root);
  const path = join(dir, 'review.json');
  writeFileSync(path, JSON.stringify({ verdict: 'PASS' }), 'utf8');
  attachStamp(path, { cwd: root });

  writeFileSync(join(root, 'tracked.txt'), 'temporarily edited\n', 'utf8');
  assert.equal(runCli(['review.json', '--dir', dir, '--cwd', root]).status, 1);

  writeFileSync(join(root, 'tracked.txt'), 'original content\n', 'utf8');
  const result = runCli(['review.json', '--dir', dir, '--cwd', root]);
  assert.equal(result.status, 0, result.stderr);
  const parsed = parseReport(result.stdout);
  assert.equal(parsed.status, 'fresh');
});

test('an untracked new file in the tree is enough to turn a stamp stale, matching computeTreeHash\'s own contract', () => {
  const root = gitFixtureRepo();
  const dir = pipelineDirIn(root);
  const path = join(dir, 'security.json');
  writeFileSync(path, JSON.stringify({ verdict: 'PASS', runId: 'r-1' }), 'utf8');
  attachStamp(path, { cwd: root });

  writeFileSync(join(root, 'new-untracked.txt'), 'surprise\n', 'utf8');

  const result = runCli(['security.json', '--dir', dir, '--cwd', root]);
  assert.equal(result.status, 1);
});

// --- malformed sidecar: exit 2, not 0 or 1 ----------------------------------------------------------

test('a sidecar that fails its own strict shape validation exits 2, distinct from both "fresh"/"unknown" (0) and "stale" (1)', () => {
  const root = gitFixtureRepo();
  const dir = pipelineDirIn(root);
  writeFileSync(join(dir, 'review.json'), JSON.stringify({ verdict: 'NOT-A-REAL-VERDICT' }), 'utf8');

  const result = runCli(['review.json', '--dir', dir, '--cwd', root]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /check-stamp-freshness:/);
});

// --- CLI argument validation: "a typo'd flag must never look like it worked" -----------------------

test('[unknown-flag] missing the required sidecar-name argument exits 2', () => {
  const result = runCli([]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /missing required argument/);
});

test('[unknown-flag] an unrecognized sidecar name exits 2, naming the known set, rather than silently reading nothing', () => {
  const result = runCli(['test-results.json']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unrecognized sidecar "test-results\.json"/);
});

test('[unknown-flag] an unrecognized flag exits 2, naming itself', () => {
  const result = runCli(['review.json', '--bogus']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unrecognized argument "--bogus"/);
});

test('[unknown-flag] --dir with no value exits 2 rather than silently defaulting to .pipeline/', () => {
  const result = runCli(['review.json', '--dir']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--dir requires a path value/);
});

test('[unknown-flag] --dir followed by a flag-shaped token exits 2 rather than treating the flag as the value', () => {
  const result = runCli(['review.json', '--dir', '--cwd']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--dir requires a path value/);
});

test('[unknown-flag] a second positional argument exits 2 rather than silently using the first', () => {
  const result = runCli(['review.json', 'security.json']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unexpected extra argument "security\.json"/);
});
