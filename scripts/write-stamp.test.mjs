// Tests scripts/write-stamp.mjs — the PL-04 review-pass-1 fix for Blocker 1 (C1): the `stamp`
// contract (scripts/pipeline-contracts.mjs's buildStamp/stampFreshness) had a reader and a documented
// consumption policy but no producer anywhere in the repo. This is that producer.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';
import { attachStamp } from './write-stamp.mjs';
import { computeTreeHash } from './pipeline-contracts.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const scriptPath = resolve(scriptsDir, 'write-stamp.mjs');

const roots = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

function scratchDir() {
  const root = mkdtempSync(resolve(tmpdir(), 'sayre-write-stamp-'));
  roots.push(root);
  return root;
}

/** Mirrors pipeline-contracts.test.mjs's own gitFixtureRepo() — a throwaway git repo with one
 * committed, tracked file, so tests can assert this script's stamp reflects a *specific*, known tree
 * rather than whatever the real repo's working tree happens to look like at test time. Duplicated
 * locally rather than imported, matching that file's own stated reasoning (a different test file, and
 * a small enough helper that duplicating it is cheaper than coupling the two files).
 *
 * Also gitignores `.pipeline/` (`.gitignore`'s own real rule — ".pipeline/** except its own
 * README.md" — see the real repo's `.gitignore` and `.sdd/ledger/README.md`), and every test below
 * writes its sidecar under a `.pipeline/` subdirectory of this fixture, matching real usage: a
 * sidecar's own on-disk bytes must never enter `computeTreeHash`'s untracked-file component (via
 * `git ls-files --others --exclude-standard`), or attaching a stamp would change the very file the
 * stamp was just computed against, making a stamp read as stale the instant it was written. That only
 * holds because `.pipeline/` is gitignored in every real checkout — this fixture reproduces that
 * property deliberately, not by accident. */
function gitFixtureRepo() {
  const root = scratchDir();
  writeFileSync(join(root, 'tracked.txt'), 'original content\n', 'utf8');
  writeFileSync(join(root, '.gitignore'), '.pipeline/**\n', 'utf8');
  mkdirSync(join(root, '.pipeline'), { recursive: true });
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'write-stamp-test@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Write Stamp Test'], { cwd: root });
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

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [scriptPath, ...args], { encoding: 'utf8', ...options });
}

// --- attachStamp() (the exported, directly-callable half) ------------------------------------------

test('attachStamp writes the exact { treeHash, headSha, dirty, writtenAt } shape onto the sidecar, preserving every other field', () => {
  const dir = scratchDir();
  const path = join(dir, 'review.json');
  writeFileSync(path, JSON.stringify({ verdict: 'PASS' }), 'utf8');

  const stamp = attachStamp(path);
  assert.equal(typeof stamp.treeHash, 'string');
  assert.match(stamp.treeHash, /^[0-9a-f]{64}$/);
  assert.equal(typeof stamp.headSha, 'string');
  assert.equal(typeof stamp.dirty, 'boolean');
  assert.equal(typeof stamp.writtenAt, 'string');

  const onDisk = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(onDisk.verdict, 'PASS');
  assert.deepEqual(onDisk.stamp, stamp);
});

test('attachStamp fully replaces a pre-existing stamp rather than merging it', () => {
  const dir = scratchDir();
  const path = join(dir, 'security.json');
  writeFileSync(path, JSON.stringify({
    verdict: 'BLOCKED',
    runId: 'stale-run',
    stamp: { treeHash: '0'.repeat(64), headSha: 'deadbeef', dirty: true, writtenAt: '2000-01-01T00:00:00.000Z', extraStaleField: 'should not survive' },
  }), 'utf8');

  const stamp = attachStamp(path);
  const onDisk = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(onDisk.stamp, stamp);
  assert.equal(onDisk.stamp.treeHash, stamp.treeHash);
  assert.equal('extraStaleField' in onDisk.stamp, false);
  assert.notEqual(onDisk.stamp.treeHash, '0'.repeat(64));
});

test('attachStamp against a specific git fixture computes a treeHash matching computeTreeHash(cwd) independently', () => {
  const root = gitFixtureRepo();
  const path = join(pipelineDirIn(root), 'sidecar.json');
  writeFileSync(path, JSON.stringify({ ticket: 'PL-99z' }), 'utf8');

  const stamp = attachStamp(path, { cwd: root });
  assert.equal(stamp.treeHash, computeTreeHash(root));

  writeFileSync(join(root, 'tracked.txt'), 'edited content\n', 'utf8');
  const stampAfterEdit = attachStamp(path, { cwd: root });
  assert.notEqual(stampAfterEdit.treeHash, stamp.treeHash);
  assert.equal(stampAfterEdit.treeHash, computeTreeHash(root));
});

test('attachStamp does not perturb its own freshness: stamping a sidecar under the gitignored .pipeline/ directory changes nothing computeTreeHash can see', () => {
  const root = gitFixtureRepo();
  const path = join(pipelineDirIn(root), 'self-reference.json');
  writeFileSync(path, JSON.stringify({ ticket: 'PL-99z' }), 'utf8');

  const treeHashBeforeStamping = computeTreeHash(root);
  const stamp = attachStamp(path, { cwd: root });
  // The stamp just written describes the exact same tree state as immediately before it was
  // written — attaching it (which changes this file's own bytes) must not itself flip freshness.
  assert.equal(stamp.treeHash, treeHashBeforeStamping);
  assert.equal(computeTreeHash(root), stamp.treeHash);
});

test('attachStamp throws when the target file does not exist', () => {
  const dir = scratchDir();
  assert.throws(() => attachStamp(join(dir, 'nope.json')), /does not exist/);
});

test('attachStamp throws on invalid JSON — never silently treats it as an empty object', () => {
  const dir = scratchDir();
  const path = join(dir, 'broken.json');
  writeFileSync(path, '{ "verdict": ', 'utf8');
  assert.throws(() => attachStamp(path), /not valid JSON/);
});

test('attachStamp throws when the sidecar is not a JSON object at the top level (an array)', () => {
  const dir = scratchDir();
  const path = join(dir, 'array.json');
  writeFileSync(path, '[1, 2, 3]', 'utf8');
  assert.throws(() => attachStamp(path), /must be a JSON object/);
});

// --- CLI wiring --------------------------------------------------------------------------------------

test('[unknown-flag] CLI: no arguments exits 1, naming the missing argument', () => {
  const result = runCli([]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /write-stamp: missing required argument/);
});

test('[unknown-flag] CLI: an unrecognized flag exits 1, naming itself', () => {
  const dir = scratchDir();
  const path = join(dir, 'review.json');
  writeFileSync(path, '{}', 'utf8');
  const result = runCli(['--bogus', path]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /write-stamp: unrecognized argument "--bogus"/);
});

test('[unknown-flag] CLI: a second positional argument exits 1 rather than silently using the first', () => {
  const dir = scratchDir();
  const path = join(dir, 'review.json');
  writeFileSync(path, '{}', 'utf8');
  const result = runCli([path, 'extra.json']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unexpected extra argument "extra\.json"/);
});

test('[unknown-flag] CLI: --cwd with no value exits 1 rather than silently falling back to the default', () => {
  const dir = scratchDir();
  const path = join(dir, 'review.json');
  writeFileSync(path, '{}', 'utf8');
  const result = runCli([path, '--cwd']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--cwd requires a path value/);
});

test('[unknown-flag] CLI: --cwd followed by a flag-shaped token exits 1 rather than treating the flag as the value', () => {
  const dir = scratchDir();
  const path = join(dir, 'review.json');
  writeFileSync(path, '{}', 'utf8');
  const result = runCli([path, '--cwd', '--other']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--cwd requires a path value/);
});

test('CLI: a missing target file exits 1, naming the path', () => {
  const dir = scratchDir();
  const result = runCli([join(dir, 'nope.json')]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /write-stamp:.*does not exist/);
});

test('CLI: a successful run exits 0, prints a summary line, and leaves a stamp on disk', () => {
  const dir = scratchDir();
  const path = join(dir, 'spec.json');
  writeFileSync(path, JSON.stringify({ ticket: 'PL-99z', goal: 'g', acceptanceCriteria: [], edgeCases: [] }), 'utf8');

  const result = runCli([path]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /write-stamp: wrote stamp to/);

  const onDisk = JSON.parse(readFileSync(path, 'utf8'));
  assert.match(onDisk.stamp.treeHash, /^[0-9a-f]{64}$/);
});

test('CLI: --cwd points the treeHash at the given git working tree, not the real repo this script lives in', () => {
  const root = gitFixtureRepo();
  const path = join(pipelineDirIn(root), 'red.json');
  writeFileSync(path, JSON.stringify({ impactMapPresent: false, tests: [] }), 'utf8');

  const result = runCli([path, '--cwd', root]);
  assert.equal(result.status, 0, result.stderr);

  const onDisk = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(onDisk.stamp.treeHash, computeTreeHash(root));
});
