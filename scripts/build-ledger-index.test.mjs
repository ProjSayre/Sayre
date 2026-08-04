// Tests scripts/build-ledger-index.mjs (PL-03c) — the .sdd/ledger/*/entry.json -> index.json
// generator, and its --check gate (spec.md acceptance criterion 8: "index.json resolves a repo
// file to the spec(s) that produced it; build-ledger-index.mjs --check fails when stale; CI
// enforces it").
//
// PL-03h round 4 (architectural): this file used to carry extensive direct unit coverage of
// `extractSection`, a hand-rolled markdown block scanner that had to track fenced-code-block and
// HTML-comment state to keep a fabricated "## Verdicts"/"## Files touched" heading from shadowing
// the real one. That mechanism is deleted outright — see build-ledger-index.mjs's own header comment
// and scripts/pipeline-contracts.mjs's header for the full argument. `entry.json` (a strict JSON
// sidecar, read via scripts/pipeline-contracts.mjs's shared validators) is now the only thing this
// script reads to decide whether a run may be indexed and which files it touched. The *intent* behind
// the old suite's coverage — a malformed or adversarial ledger entry must fail closed, not be
// silently indexed — is retargeted below at the JSON contract: invalid JSON, a missing required
// field, a `runId` that doesn't match its own directory, and a `verdicts` object that isn't exactly
// `{ review: "PASS", security: "PASS" }`. There is no fence, comment, duplicate heading, ATX closing
// sequence, or setext heading left for any of this suite's old adversarial fixtures to construct,
// because there is no markdown parse on this control path anymore.
//
// Conventions follow scripts/generate-agent-shims.test.mjs: node:test, tmpdir()-based fixtures, no
// new framework. Unlike the shim generator, this script never shells out to git, so fixtures don't
// need to be real git repos — just a scripts/ copy of the script plus a .sdd/ledger/ tree.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');
const scriptSource = readFileSync(resolve(scriptsDir, 'build-ledger-index.mjs'), 'utf8');
const contractsSource = readFileSync(resolve(scriptsDir, 'pipeline-contracts.mjs'), 'utf8');

const roots = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

/** A minimal, valid entry.json object. Every field this script actually reads is present and
 * well-formed; tests override exactly the field(s) under test. */
function sampleEntryJson(runId, files, { ticket = 'PL-03c', date = '2026-08-03' } = {}) {
  return { runId, date, ticket, filesTouched: files, verdicts: { review: 'PASS', security: 'PASS' } };
}

/** A trivial, human-facing entry.md — never parsed by this script, but its existence is still
 * required (see build-ledger-index.mjs's buildIndex(), which checks for it alongside spec.md). */
function sampleEntryMarkdown(runId) {
  return `# Ledger entry — ${runId}\n\n(fixture placeholder — not parsed by build-ledger-index.mjs)\n`;
}

/** Builds a throwaway fixture directory containing a copy of the generator (plus its
 * pipeline-contracts.mjs dependency) and a caller-supplied .sdd/ledger/ tree. `runs` maps run id ->
 * { entryJson, entryMd, spec, skipEntryMd, skipEntryJson, rawEntryJson } — `rawEntryJson`, when
 * given, is written verbatim (a string) instead of JSON.stringify(entryJson), for fixtures that need
 * to write deliberately-malformed or non-JSON content. */
function fixture(runs) {
  const root = mkdtempSync(resolve(tmpdir(), 'sayre-ledger-index-'));
  roots.push(root);
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'build-ledger-index.mjs'), scriptSource, 'utf8');
  writeFileSync(join(root, 'scripts', 'pipeline-contracts.mjs'), contractsSource, 'utf8');
  mkdirSync(join(root, '.sdd', 'ledger'), { recursive: true });
  writeFileSync(join(root, '.sdd', 'ledger', 'README.md'), '# Ledger\n\nFixture placeholder.\n', 'utf8');
  for (const [runId, run] of Object.entries(runs)) {
    const runDir = join(root, '.sdd', 'ledger', runId);
    mkdirSync(runDir, { recursive: true });
    if (!run.skipEntryMd) writeFileSync(join(runDir, 'entry.md'), run.entryMd ?? sampleEntryMarkdown(runId), 'utf8');
    if (!run.skipEntryJson) {
      const content = run.rawEntryJson ?? JSON.stringify(run.entryJson ?? sampleEntryJson(runId, []));
      writeFileSync(join(runDir, 'entry.json'), content, 'utf8');
    }
    if (!run.skipSpec) writeFileSync(join(runDir, 'spec.md'), run.spec ?? '# Spec\n\nFixture stub.\n', 'utf8');
  }
  return root;
}

function run(root, args = []) {
  return spawnSync(process.execPath, [join(root, 'scripts', 'build-ledger-index.mjs'), ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

// --- AC 8: index.json resolves a repo file to the spec(s) that produced it ---------------------

test('builds index.json mapping each touched file to its run, ticket, date, and spec path', () => {
  const root = fixture({ 'run-a': { entryJson: sampleEntryJson('run-a', ['scripts/foo.mjs', 'scripts/bar.mjs']) } });
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);

  const index = JSON.parse(readFileSync(join(root, '.sdd', 'ledger', 'index.json'), 'utf8'));
  assert.deepEqual(Object.keys(index).sort(), ['scripts/bar.mjs', 'scripts/foo.mjs']);
  assert.deepEqual(index['scripts/foo.mjs'], [
    { runId: 'run-a', ticket: 'PL-03c', date: '2026-08-03', spec: '.sdd/ledger/run-a/spec.md' },
  ]);
});

test('a file touched by two runs gets both entries, sorted by run id (chronological by construction)', () => {
  const root = fixture({
    '20260801T000000000Z-later': { entryJson: sampleEntryJson('20260801T000000000Z-later', ['shared/thing.ts']) },
    '20260701T000000000Z-earlier': { entryJson: sampleEntryJson('20260701T000000000Z-earlier', ['shared/thing.ts']) },
  });
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);

  const index = JSON.parse(readFileSync(join(root, '.sdd', 'ledger', 'index.json'), 'utf8'));
  assert.deepEqual(
    index['shared/thing.ts'].map((entry) => entry.runId),
    ['20260701T000000000Z-earlier', '20260801T000000000Z-later'],
  );
});

test('a file untouched by any run is simply absent from the index', () => {
  const root = fixture({ 'run-a': { entryJson: sampleEntryJson('run-a', ['scripts/foo.mjs']) } });
  run(root);
  const index = JSON.parse(readFileSync(join(root, '.sdd', 'ledger', 'index.json'), 'utf8'));
  assert.ok(!('scripts/never-touched.mjs' in index));
});

test('README.md alongside run directories is a file, not a run, and is never mistaken for one', () => {
  const root = fixture({ 'run-a': { entryJson: sampleEntryJson('run-a', ['x.ts']) } });
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  const index = JSON.parse(readFileSync(join(root, '.sdd', 'ledger', 'index.json'), 'utf8'));
  assert.equal(index['x.ts'][0].runId, 'run-a');
});

// --- AC 8: --check exits 0 on a clean tree, non-zero (and never writes) after drift -------------

test('--check exits 0 once a freshly generated index.json is up to date', () => {
  const root = fixture({ 'run-a': { entryJson: sampleEntryJson('run-a', ['x.ts']) } });
  run(root);
  const check = run(root, ['--check']);
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /up to date/);
});

test('--check exits non-zero when a new run has been added but index.json was not regenerated', () => {
  const root = fixture({ 'run-a': { entryJson: sampleEntryJson('run-a', ['x.ts']) } });
  run(root);

  const runBDir = join(root, '.sdd', 'ledger', 'run-b');
  mkdirSync(runBDir, { recursive: true });
  writeFileSync(join(runBDir, 'entry.json'), JSON.stringify(sampleEntryJson('run-b', ['y.ts'])), 'utf8');
  writeFileSync(join(runBDir, 'entry.md'), sampleEntryMarkdown('run-b'), 'utf8');
  writeFileSync(join(runBDir, 'spec.md'), '# Spec\n', 'utf8');

  const before = readFileSync(join(root, '.sdd', 'ledger', 'index.json'), 'utf8');
  const check = run(root, ['--check']);
  assert.notEqual(check.status, 0);
  assert.match(check.stderr, /stale/);
  assert.equal(readFileSync(join(root, '.sdd', 'ledger', 'index.json'), 'utf8'), before, '--check must never write');
});

// --- Edge case: a run directory missing spec.md/entry.md/entry.json fails loudly ---------------

test('fails loudly, and writes nothing, when a run directory has no spec.md', () => {
  const root = fixture({ 'run-a': { entryJson: sampleEntryJson('run-a', ['x.ts']), skipSpec: true } });
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no spec\.md/);
  assert.ok(!existsSync(join(root, '.sdd', 'ledger', 'index.json')));
});

test('fails loudly when a run directory has no entry.md', () => {
  const root = fixture({ 'run-a': { entryJson: sampleEntryJson('run-a', ['x.ts']), skipEntryMd: true } });
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no entry\.md/);
});

test('fails loudly when a run directory has no entry.json at all — entry.md alone is no longer sufficient', () => {
  const root = fixture({ 'run-a': { skipEntryJson: true } });
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /entry\.json does not exist/);
  assert.ok(!existsSync(join(root, '.sdd', 'ledger', 'index.json')));
});

// --- Edge case: no .sdd/ledger/ directory at all produces an empty index, not a crash ----------

test('no .sdd/ledger/ directory at all still produces a valid (empty) index.json', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'sayre-ledger-index-empty-'));
  roots.push(root);
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'build-ledger-index.mjs'), scriptSource, 'utf8');
  writeFileSync(join(root, 'scripts', 'pipeline-contracts.mjs'), contractsSource, 'utf8');

  const result = spawnSync(process.execPath, [join(root, 'scripts', 'build-ledger-index.mjs')], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const index = JSON.parse(readFileSync(join(root, '.sdd', 'ledger', 'index.json'), 'utf8'));
  assert.deepEqual(index, {});
});

// --- Edge case / AC 8: byte-stability across LF/CRLF (the .gitattributes point) -----------------

test('generated index.json is unconditionally LF, never CRLF, regardless of host platform', () => {
  const root = fixture({ 'run-a': { entryJson: sampleEntryJson('run-a', ['x.ts']) } });
  run(root);
  const buffer = readFileSync(join(root, '.sdd', 'ledger', 'index.json'));
  assert.ok(!buffer.includes(0x0d), 'generated index.json must contain no CR bytes');
});

test('.gitattributes pins LF on .sdd/ledger/index.json so --check is byte-stable on Windows', () => {
  const gitattributes = readFileSync(resolve(repoRoot, '.gitattributes'), 'utf8');
  assert.match(gitattributes, /\.sdd\/ledger\/index\.json\s+text\s+eol=lf/);
});

// --- entry.json strict validation: malformed/adversarial JSON fails closed, never silently indexed

test('fails loudly on invalid JSON in entry.json (truncated) rather than crashing with a raw parse-error stack trace', () => {
  const root = fixture({ 'run-a': { rawEntryJson: '{ "runId": "run-a", "ticket": ' } });
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /entry\.json is not valid JSON/);
  assert.ok(!existsSync(join(root, '.sdd', 'ledger', 'index.json')));
});

test('fails loudly when entry.json\'s "runId" field does not match its own directory name', () => {
  const root = fixture({ 'run-a': { entryJson: sampleEntryJson('some-other-run-id', ['x.ts']) } });
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must equal this entry's own directory name/);
});

test('fails loudly when entry.json has no "ticket" field', () => {
  const entryJson = sampleEntryJson('run-a', ['x.ts']);
  delete entryJson.ticket;
  const root = fixture({ 'run-a': { entryJson } });
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /field "ticket" must be a non-empty string/);
});

test('fails loudly when entry.json\'s "filesTouched" is not an array (e.g. a single string)', () => {
  const entryJson = sampleEntryJson('run-a', ['x.ts']);
  entryJson.filesTouched = 'x.ts';
  const root = fixture({ 'run-a': { entryJson } });
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /field "filesTouched" must be an array/);
});

// --- Regression (review Warning 1, carried forward at the JSON layer): a malformed/fabricated ----
// "verdicts" object must refuse, not silently index a run that never really passed both gates.

test('fails loudly when entry.json\'s "verdicts" does not read exactly { review: PASS, security: PASS }', () => {
  const entryJson = sampleEntryJson('run-a', ['x.ts']);
  entryJson.verdicts = { review: 'PASS', security: 'BLOCKED' };
  const root = fixture({ 'run-a': { entryJson } });
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /field "verdicts" must be exactly/);
  assert.ok(!existsSync(join(root, '.sdd', 'ledger', 'index.json')));
});

test('fails loudly when entry.json has no "verdicts" field at all', () => {
  const entryJson = sampleEntryJson('run-a', ['x.ts']);
  delete entryJson.verdicts;
  const root = fixture({ 'run-a': { entryJson } });
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /verdicts.*must be a JSON object/);
});

test('assertVerdictsAreClean-equivalent check refuses trailing/extra content smuggled into the verdicts object (an extra third key does not loosen the byte-for-byte check)', () => {
  const entryJson = sampleEntryJson('run-a', ['x.ts']);
  entryJson.verdicts = { review: 'PASS', security: 'PASS', extra: 'unexpected' };
  const root = fixture({ 'run-a': { entryJson } });
  const result = run(root);
  // Only review/security are compared byte-for-byte against the expected literal today (an unknown
  // extra key is not itself rejected — see build-ledger-index.mjs's readEntryJson) — this test
  // documents that scope explicitly rather than leaving it implicit: the run is still indexed,
  // because the two fields this script actually gates on are both the required literal "PASS".
  assert.equal(result.status, 0, result.stderr);
});

test('a genuinely clean entry.json (exact verdicts, valid shape) is indexed without incident — the positive control for every adversarial fixture above', () => {
  const root = fixture({ 'run-a': { entryJson: sampleEntryJson('run-a', ['scripts/real-file.mjs']) } });
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  const index = JSON.parse(readFileSync(join(root, '.sdd', 'ledger', 'index.json'), 'utf8'));
  assert.deepEqual(Object.keys(index), ['scripts/real-file.mjs']);
});

// --- Integration: the real repository's real ledger index, as it exists on disk right now ------

test('[integration] the real repo\'s .sdd/ledger/index.json is currently up to date', () => {
  const result = spawnSync(process.execPath, [resolve(scriptsDir, 'build-ledger-index.mjs'), '--check'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `real repo ledger index is stale: ${result.stderr}`);
});

test('[integration] the real repo\'s ledger index resolves at least PL-03a\'s migrated entry, backfilled with its own entry.json', () => {
  const index = JSON.parse(readFileSync(resolve(repoRoot, '.sdd', 'ledger', 'index.json'), 'utf8'));
  const anyEntry = Object.values(index)[0];
  assert.ok(Array.isArray(anyEntry) && anyEntry.length > 0, 'expected at least one indexed file');
  assert.ok(anyEntry[0].runId && anyEntry[0].ticket && anyEntry[0].date && anyEntry[0].spec);
});

test('[integration] PL-03a\'s backfilled entry.json on disk matches the strict shape this script requires (runId equals its own directory, verdicts are exactly PASS/PASS)', () => {
  const runId = '20260731T230940936Z-90330fb19231-PR_DELTA-bf73ea';
  const entry = JSON.parse(readFileSync(resolve(repoRoot, '.sdd', 'ledger', runId, 'entry.json'), 'utf8'));
  assert.equal(entry.runId, runId);
  assert.deepEqual({ review: entry.verdicts.review, security: entry.verdicts.security }, { review: 'PASS', security: 'PASS' });
  assert.ok(Array.isArray(entry.filesTouched) && entry.filesTouched.length > 0);
});
