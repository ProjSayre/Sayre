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

// --- PL-04 / item 2 (the general defect): an unrecognized flag must fail loudly, naming itself -----

test('an unrecognized flag fails loudly, naming itself, and writes nothing — a typo (e.g. "--chek") must never silently fall through to the ordinary write path', () => {
  const root = fixture({ 'run-a': { entryJson: sampleEntryJson('run-a', ['x.ts']) } });
  const result = run(root, ['--chek']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unrecognized argument "--chek"/);
  assert.ok(!existsSync(join(root, '.sdd', 'ledger', 'index.json')), 'must not silently write index.json when the caller almost certainly meant --check');
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
//
// PL-04 / C2: table-driven. Every row builds a valid entry.json, breaks exactly one thing about it,
// and asserts a non-zero exit naming the problem — the shape that used to be seven separate tests.
// `checkNoIndex` matches exactly what each original standalone test asserted (three of the seven also
// checked index.json was never written; the other four did not).
//
// CORRECTED (round 5 / review Critical 1) applies to the "duplicate verdicts key" row: entry.json is
// parsed via pipeline-contracts.mjs's parseJsonOrThrow, same as every .pipeline/*.json sidecar — this
// pins the fix directly at the ledger's own entry point, the file review.md's round-4 report
// demonstrated the exploit against (a duplicate "verdicts" key laundering a false PASS into the
// durable ledger record).

const ENTRY_JSON_VALIDATION_CASES = [
  {
    name: 'invalid JSON in entry.json (truncated) rather than crashing with a raw parse-error stack trace',
    run: { 'run-a': { rawEntryJson: '{ "runId": "run-a", "ticket": ' } },
    stderrPattern: /entry\.json is not valid JSON/,
    checkNoIndex: true,
  },
  {
    name: 'a duplicate "verdicts" key in entry.json — the BLOCKED/NEEDS_FIXES -> PASS forgery relocated one layer down from the old markdown duplicate-heading exploit, now closed by parseJsonOrThrow',
    run: { 'run-a': { rawEntryJson:
      '{"runId":"run-a","date":"2026-08-03","ticket":"PL-03c","filesTouched":["x.ts"],' +
      '"verdicts":{"review":"NEEDS_FIXES","security":"NEEDS_FIXES"},' +
      '"verdicts":{"review":"PASS","security":"PASS"}}' } },
    stderrPattern: /duplicate key "verdicts"/,
    checkNoIndex: true,
  },
  {
    name: 'entry.json\'s "runId" field does not match its own directory name',
    run: { 'run-a': { entryJson: sampleEntryJson('some-other-run-id', ['x.ts']) } },
    stderrPattern: /must equal this entry's own directory name/,
    checkNoIndex: false,
  },
  {
    name: 'entry.json has no "ticket" field',
    run: { 'run-a': { entryJson: (() => { const e = sampleEntryJson('run-a', ['x.ts']); delete e.ticket; return e; })() } },
    stderrPattern: /field "ticket" must be a non-empty string/,
    checkNoIndex: false,
  },
  {
    name: 'entry.json\'s "filesTouched" is not an array (e.g. a single string)',
    run: { 'run-a': { entryJson: (() => { const e = sampleEntryJson('run-a', ['x.ts']); e.filesTouched = 'x.ts'; return e; })() } },
    stderrPattern: /field "filesTouched" must be an array/,
    checkNoIndex: false,
  },
  {
    // Regression (review Warning 1, carried forward at the JSON layer): a malformed/fabricated
    // "verdicts" object must refuse, not silently index a run that never really passed both gates.
    name: 'entry.json\'s "verdicts" does not read exactly { review: PASS, security: PASS }',
    run: { 'run-a': { entryJson: (() => { const e = sampleEntryJson('run-a', ['x.ts']); e.verdicts = { review: 'PASS', security: 'BLOCKED' }; return e; })() } },
    stderrPattern: /field "verdicts" must be exactly/,
    checkNoIndex: true,
  },
  {
    // Also covers "a non-bypass entry.json missing 'verdicts' is unaffected by the bypass check": the
    // assertion is identical either way — readEntryJson must only skip the verdicts check when bypass
    // is literally true, never merely because the field is absent.
    name: 'entry.json has no "verdicts" field at all (equally true whether or not "bypass" is set — the bypass check must only skip validation when bypass is literally true)',
    run: { 'run-a': { entryJson: (() => { const e = sampleEntryJson('run-a', ['x.ts']); delete e.verdicts; return e; })() } },
    stderrPattern: /verdicts.*must be a JSON object/,
    checkNoIndex: false,
  },
];

test('fails loudly for every adversarial entry.json in ENTRY_JSON_VALIDATION_CASES, never silently indexing', () => {
  for (const { name, run: runFixture, stderrPattern, checkNoIndex } of ENTRY_JSON_VALIDATION_CASES) {
    const root = fixture(runFixture);
    const result = run(root);
    assert.notEqual(result.status, 0, name);
    assert.match(result.stderr, stderrPattern, name);
    if (checkNoIndex) assert.ok(!existsSync(join(root, '.sdd', 'ledger', 'index.json')), `${name}: index.json must not be written`);
  }
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

// --- D-005 #3 / `/hotfix`: a bypass entry (entry.json's "bypass": true) is excluded, not gated -----
//
// A hotfix entry (scripts/ledger-append.mjs --hotfix) never ran review or security, so it has no
// "verdicts" to check and no spec.md at all — by design, see .sdd/hotfix.md. `bypass: true` tells
// this script to skip both requirements for that one run, and — the property that actually
// matters — to exclude its files from the index entirely rather than index them under some
// differently-labeled entry, so a query for "which spec governs this file" can never resolve to one.

test('a "bypass": true entry needs no spec.md and no "verdicts", and is excluded from the index entirely', () => {
  const entryJson = { runId: 'hotfix-a', date: '2026-08-04', ticket: 'FOLLOWUP-1', filesTouched: ['app/hotfixed.ts'], bypass: true };
  const root = fixture({ 'hotfix-a': { entryJson, skipSpec: true } });
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  const index = JSON.parse(readFileSync(join(root, '.sdd', 'ledger', 'index.json'), 'utf8'));
  assert.equal(index['app/hotfixed.ts'], undefined, 'a bypass entry\'s files must never appear in the index');
});

test('a bypass entry coexists with a normal entry: the normal one is indexed, the bypass one is not', () => {
  const bypassEntry = { runId: 'hotfix-a', date: '2026-08-04', ticket: 'FOLLOWUP-1', filesTouched: ['app/hotfixed.ts'], bypass: true };
  const root = fixture({
    'run-a': { entryJson: sampleEntryJson('run-a', ['app/normal.ts']) },
    'hotfix-a': { entryJson: bypassEntry, skipSpec: true },
  });
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  const index = JSON.parse(readFileSync(join(root, '.sdd', 'ledger', 'index.json'), 'utf8'));
  assert.ok(index['app/normal.ts']?.some((e) => e.runId === 'run-a'));
  assert.equal(index['app/hotfixed.ts'], undefined);
});

// PL-04 / B3: `bypass: true` is no longer written only by `ledger-append.mjs --hotfix` — the normal
// path now also sets it (derived from the recorded verdicts) whenever a run's real, final verdicts
// were not both literally PASS and a human recorded a reasoned `--override-review`/`--override-security`
// to write the entry anyway (see ledger-append.mjs's own `buildEntryJson`/"Sanctioned overrides"
// section). Unlike a hotfix, such an entry DOES have a real `verdicts` object (just not the required
// PASS/PASS) and a real `spec.md` (the pipeline genuinely ran) — this file needs no code change to
// handle that correctly, since `bypass: true` already means "exclude from the index" unconditionally,
// regardless of why a caller set it; these tests pin that this generalizes without modification.

test('[B3] a "bypass": true entry with a real (non-PASS) "verdicts" object and a real spec.md — the shape ledger-append.mjs writes for an overridden, non-hotfix run — is still excluded, and its verdicts are never even inspected', () => {
  const entryJson = {
    runId: 'override-a',
    date: '2026-08-04',
    ticket: 'PL-99z',
    filesTouched: ['app/from-overridden-run.ts'],
    verdicts: { review: 'NEEDS_FIXES', security: 'PASS' },
    overrides: [{ gate: 'review', verdict: 'NEEDS_FIXES', reason: 'Recording a real terminal failure.' }],
    bypass: true,
  };
  const root = fixture({ 'override-a': { entryJson } }); // spec.md IS present, unlike a hotfix fixture
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  const index = JSON.parse(readFileSync(join(root, '.sdd', 'ledger', 'index.json'), 'utf8'));
  assert.equal(index['app/from-overridden-run.ts'], undefined, 'an overridden, non-PASS run must never answer "which spec governs this file"');
});

test('[B3] an overridden bypass entry coexists with a normal PASS entry: the normal one is indexed, the overridden one is not', () => {
  const overriddenEntry = {
    runId: 'override-a',
    date: '2026-08-04',
    ticket: 'PL-99z',
    filesTouched: ['app/from-overridden-run.ts'],
    verdicts: { review: 'BLOCKED', security: 'BLOCKED' },
    overrides: [
      { gate: 'review', verdict: 'BLOCKED', reason: 'r1' },
      { gate: 'security', verdict: 'BLOCKED', reason: 'r2' },
    ],
    bypass: true,
  };
  const root = fixture({
    'run-a': { entryJson: sampleEntryJson('run-a', ['app/normal.ts']) },
    'override-a': { entryJson: overriddenEntry },
  });
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  const index = JSON.parse(readFileSync(join(root, '.sdd', 'ledger', 'index.json'), 'utf8'));
  assert.ok(index['app/normal.ts']?.some((e) => e.runId === 'run-a'));
  assert.equal(index['app/from-overridden-run.ts'], undefined);
});

test('"bypass": false (or omitted, the default) is held to the normal spec.md/verdicts requirements — bypass is opt-in, never a silent default', () => {
  const entryJson = sampleEntryJson('run-a', ['x.ts']);
  entryJson.bypass = false;
  const root = fixture({ 'run-a': { entryJson, skipSpec: true } });
  const result = run(root);
  assert.notEqual(result.status, 0, 'an explicit bypass:false entry must still require spec.md, exactly like an entry with no bypass field at all');
  assert.match(result.stderr, /no spec\.md/);
});

test('a genuinely clean entry.json (exact verdicts, valid shape) is indexed without incident — the positive control for every adversarial fixture above', () => {
  const root = fixture({ 'run-a': { entryJson: sampleEntryJson('run-a', ['scripts/real-file.mjs']) } });
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  const index = JSON.parse(readFileSync(join(root, '.sdd', 'ledger', 'index.json'), 'utf8'));
  assert.deepEqual(Object.keys(index), ['scripts/real-file.mjs']);
});

// --- PL-04 / item 3: a re-gate entry's index record carries the same disclosure marker -------------
//
// scripts/ledger-append.mjs writes a non-null `regate` object into entry.json for a `--re-gate` run
// (`{ testerRan, gatesOnly, note }` — see that file's buildEntryJson), and had, from the day that flag
// shipped, documented it as reaching index.json. It never did: buildIndex() below simply never read
// the field, so a re-gated file's index record was byte-identical to one from a run that passed
// through dev's own loop — the exact "clean-looking attribution" this fix closes. These tests are the
// direct regression coverage for that gap.

test('[PL-04 / item 3] an index record built from a re-gated entry surfaces the regate marker, including that tester ran', () => {
  const entryJson = {
    ...sampleEntryJson('run-a', ['app/hand-edited.ts']),
    regate: {
      testerRan: true,
      gatesOnly: false,
      note: 'code was changed in the working tree outside the pipeline\'s dev stage before this run; ' +
        'changes.md/changes.json describe the tree as it stood before that edit',
    },
  };
  const root = fixture({ 'run-a': { entryJson } });
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);

  const index = JSON.parse(readFileSync(join(root, '.sdd', 'ledger', 'index.json'), 'utf8'));
  assert.deepEqual(index['app/hand-edited.ts'], [
    { runId: 'run-a', ticket: 'PL-03c', date: '2026-08-03', spec: '.sdd/ledger/run-a/spec.md', regate: { testerRan: true } },
  ]);
});

test('[PL-04 / item 3] a re-gate entry with tester skipped (--gates-only) surfaces testerRan: false in the index record — never dropped or defaulted to true', () => {
  const entryJson = {
    ...sampleEntryJson('run-a', ['app/gates-only.ts']),
    regate: { testerRan: false, gatesOnly: true, note: '(irrelevant to the index — see build-ledger-index.mjs)' },
  };
  const root = fixture({ 'run-a': { entryJson } });
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);

  const index = JSON.parse(readFileSync(join(root, '.sdd', 'ledger', 'index.json'), 'utf8'));
  assert.deepEqual(index['app/gates-only.ts'][0].regate, { testerRan: false });
});

test('[PL-04 / item 3] an index record built from a normal (non-re-gate) entry carries no "regate" key at all', () => {
  const root = fixture({ 'run-a': { entryJson: sampleEntryJson('run-a', ['app/normal.ts']) } });
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);

  const index = JSON.parse(readFileSync(join(root, '.sdd', 'ledger', 'index.json'), 'utf8'));
  assert.ok(!('regate' in index['app/normal.ts'][0]), 'an ordinary run\'s index record must not carry a regate key');
});

test('[PL-04 / item 3] entry.json\'s explicit "regate": null (what ledger-append.mjs writes by default for every non-re-gate run) also carries no "regate" key into the index', () => {
  const entryJson = { ...sampleEntryJson('run-a', ['app/normal-explicit-null.ts']), regate: null };
  const root = fixture({ 'run-a': { entryJson } });
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);

  const index = JSON.parse(readFileSync(join(root, '.sdd', 'ledger', 'index.json'), 'utf8'));
  assert.ok(!('regate' in index['app/normal-explicit-null.ts'][0]));
});

test('[PL-04 / item 3] a bypass entry\'s files still never appear in the index at all, even when the entry also carries a regate object (a re-gated run that also needed --override-* still excludes via bypass, not regate)', () => {
  const entryJson = {
    runId: 'override-regate-a',
    date: '2026-08-04',
    ticket: 'PL-99z',
    filesTouched: ['app/still-broken.ts'],
    verdicts: { review: 'NEEDS_FIXES', security: 'PASS' },
    overrides: [{ gate: 'review', verdict: 'NEEDS_FIXES', reason: 'Re-gated, but review still flags a style nit accepted on purpose.' }],
    bypass: true,
    regate: { testerRan: true, gatesOnly: false, note: 'irrelevant — excluded by bypass regardless' },
  };
  const root = fixture({ 'override-regate-a': { entryJson } });
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);

  const index = JSON.parse(readFileSync(join(root, '.sdd', 'ledger', 'index.json'), 'utf8'));
  assert.equal(index['app/still-broken.ts'], undefined, 'bypass excludes the run from the index regardless of an accompanying regate disclosure');
});

test('[PL-04 / item 3] a malformed regate object (testerRan not a boolean) fails loudly rather than silently indexing something', () => {
  const entryJson = { ...sampleEntryJson('run-a', ['x.ts']), regate: { testerRan: 'true' } };
  const root = fixture({ 'run-a': { entryJson } });
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /field "testerRan" must be a boolean/);
  assert.ok(!existsSync(join(root, '.sdd', 'ledger', 'index.json')));
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

// --- [lite] PL-11: a lite entry is INDEXED, and its index record carries the qualification --------
//
// The decision (spec.md's Open questions #2, and the argument .sdd/ledger/README.md already makes for
// a --re-gate entry): a lite run has a real, ratified spec that `review` genuinely passed against the
// final tree, so excluding it would answer "which spec governs this file" with silence when a real
// answer exists. What it does NOT have is a security pass — so the exclusion mechanism is not what
// carries that fact; the `lite` marker on the record itself is, exactly as `regate: { testerRan }`
// already does one row above. The verdicts gate has to widen by precisely one shape and no more:
// `{ review: "PASS", security: "SKIPPED_LITE" }` is acceptable ONLY from an entry that declares
// itself lite and lists `security` among its skipped stages. Anything else is a non-lite entry
// laundering a skipped gate into an indexed one (EC-15).

/** A lite entry.json in the exact shape scripts/ledger-append.mjs --lite writes. `note`/`eligibility`
 * are present because a real entry carries them — build-ledger-index.mjs deliberately reads only
 * `skippedStages`, the same narrowing readRegateField already applies. */
function sampleLiteEntryJson(runId, files, { skippedStages = ['red', 'security'], ticket = 'PL-11', date = '2026-08-08' } = {}) {
  return {
    runId,
    date,
    ticket,
    filesTouched: files,
    verdicts: { review: 'PASS', security: 'SKIPPED_LITE' },
    overrides: [],
    bypass: false,
    regate: null,
    lite: {
      skippedStages,
      note: '(the fixed lite disclosure note — not read by this script)',
      eligibility: { fileCount: files.length, changedLines: 12, maxFiles: 5, maxChangedLines: 150 },
    },
    redTestPaths: [],
    securityRunId: null,
  };
}

// @spec AC-11
test('[lite] a lite entry is indexed, and every record it produces carries lite: { skippedStages }', () => {
  const root = fixture({ 'run-lite': { entryJson: sampleLiteEntryJson('run-lite', ['scripts/typo-fix.mjs', 'docs/typo.md']) } });
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);

  const index = JSON.parse(readFileSync(join(root, '.sdd', 'ledger', 'index.json'), 'utf8'));
  assert.deepEqual(index['scripts/typo-fix.mjs'], [
    {
      runId: 'run-lite',
      ticket: 'PL-11',
      date: '2026-08-08',
      spec: '.sdd/ledger/run-lite/spec.md',
      lite: { skippedStages: ['red', 'security'] },
    },
  ]);
  assert.deepEqual(
    index['docs/typo.md'][0].lite,
    { skippedStages: ['red', 'security'] },
    'EVERY record the run produces carries the marker — a reader who happens to look up the second file must not get an unqualified attribution',
  );
});

// @spec AC-11
test('[lite] the widened verdicts gate accepts SKIPPED_LITE only from a declared lite entry, and still enforces PASS/PASS byte-for-byte on every other non-bypass entry', () => {
  // The one shape that widens...
  const declaredLite = fixture({ 'run-lite': { entryJson: sampleLiteEntryJson('run-lite', ['app/lite.ts']) } });
  assert.equal(run(declaredLite).status, 0, 'a declared lite entry, with security among its skipped stages, is the ONE shape this gate widens for');

  // ...the ordinary shape is unchanged...
  const ordinary = fixture({ 'run-a': { entryJson: sampleEntryJson('run-a', ['x.ts']) } });
  assert.equal(run(ordinary).status, 0, 'a normal PASS/PASS entry must still index exactly as before');

  // ...and a near-miss on the non-lite path is still refused, with no new escape hatch.
  const nearMiss = (() => {
    const entryJson = sampleEntryJson('run-a', ['x.ts']);
    entryJson.verdicts = { review: 'PASS', security: 'SKIPPED' };
    return fixture({ 'run-a': { entryJson } });
  })();
  const nearMissResult = run(nearMiss);
  assert.notEqual(nearMissResult.status, 0, 'only the exact SKIPPED_LITE literal, from a declared lite entry, widens this gate');
  assert.ok(!existsSync(join(nearMiss, '.sdd', 'ledger', 'index.json')));
});

// @spec EC-15
test('[lite] an entry claiming security: SKIPPED_LITE with no lite object, or one omitting "security" from skippedStages, is refused — while the honestly-declared one beside it is indexed', () => {
  // The positive control is what makes this an asymmetry test rather than a "SKIPPED_LITE is
  // unknown, so everything containing it is refused" test — which is what it would degenerate into
  // (and silently pass as) if only the two negative cases were asserted.
  const declared = fixture({ 'run-lite': { entryJson: sampleLiteEntryJson('run-lite', ['app/honest.ts']) } });
  assert.equal(run(declared).status, 0, 'the honestly-declared lite entry is indexed');

  const laundered = (() => {
    const entryJson = sampleEntryJson('run-a', ['app/laundered.ts']);
    entryJson.verdicts = { review: 'PASS', security: 'SKIPPED_LITE' };
    return entryJson; // no `lite` object at all
  })();
  const noLiteObject = fixture({ 'run-a': { entryJson: laundered } });
  const noLiteResult = run(noLiteObject);
  assert.notEqual(noLiteResult.status, 0, 'a non-lite entry must never be able to launder a skipped gate into an indexed one');
  assert.ok(!existsSync(join(noLiteObject, '.sdd', 'ledger', 'index.json')), 'and it must write nothing while refusing');

  const wrongStages = fixture({
    'run-a': { entryJson: sampleLiteEntryJson('run-a', ['app/half-declared.ts'], { skippedStages: ['red'] }) },
  });
  const wrongStagesResult = run(wrongStages);
  assert.notEqual(wrongStagesResult.status, 0, 'claiming SKIPPED_LITE while not listing security among the skipped stages is self-contradictory, and refused');
  assert.ok(!existsSync(join(wrongStages, '.sdd', 'ledger', 'index.json')));
});

// @spec EC-15
test('[lite] --check fails loudly on a laundered SKIPPED_LITE entry rather than reporting the index as up to date', () => {
  // Seeded with a real lite entry, so this test cannot pass merely because SKIPPED_LITE is unknown
  // to the gate: the first run below has to succeed before the laundered entry is even added.
  const root = fixture({ 'run-lite': { entryJson: sampleLiteEntryJson('run-lite', ['app/ok.ts']) } });
  assert.equal(run(root).status, 0, 'the baseline lite index must build before this test can say anything about --check');

  const runBDir = join(root, '.sdd', 'ledger', 'run-b');
  mkdirSync(runBDir, { recursive: true });
  const laundered = sampleEntryJson('run-b', ['app/laundered.ts']);
  laundered.verdicts = { review: 'PASS', security: 'SKIPPED_LITE' };
  writeFileSync(join(runBDir, 'entry.json'), JSON.stringify(laundered), 'utf8');
  writeFileSync(join(runBDir, 'entry.md'), sampleEntryMarkdown('run-b'), 'utf8');
  writeFileSync(join(runBDir, 'spec.md'), '# Spec\n', 'utf8');

  const check = run(root, ['--check']);
  assert.notEqual(check.status, 0, '--check must fail loudly — an unindexable entry read as "no drift" is the silent half of this failure');
});

// @spec AC-11
test('[lite] a non-lite entry\'s index record still carries no "lite" key at all — the marker\'s absence is what says the attribution is unqualified', () => {
  const root = fixture({ 'run-a': { entryJson: sampleEntryJson('run-a', ['app/normal.ts']) } });
  assert.equal(run(root).status, 0);
  const index = JSON.parse(readFileSync(join(root, '.sdd', 'ledger', 'index.json'), 'utf8'));
  assert.ok(!('lite' in index['app/normal.ts'][0]));

  const explicitNull = fixture({
    'run-a': { entryJson: { ...sampleEntryJson('run-a', ['app/explicit-null.ts']), lite: null } },
  });
  assert.equal(run(explicitNull).status, 0);
  const explicitNullIndex = JSON.parse(readFileSync(join(explicitNull, '.sdd', 'ledger', 'index.json'), 'utf8'));
  assert.ok(
    !('lite' in explicitNullIndex['app/explicit-null.ts'][0]),
    'an explicit "lite": null (what ledger-append.mjs writes for every non-lite run) must be omitted from the record, not carried through as null',
  );
});

// @spec AC-11
test('[lite] a malformed lite object (skippedStages not an array of strings) fails loudly rather than silently indexing something', () => {
  // Positive control first, for the same reason as the EC-15 test above: without it this passes
  // today for a reason unrelated to the shape of `lite`.
  const wellFormed = fixture({ 'run-a': { entryJson: sampleLiteEntryJson('run-a', ['x.ts']) } });
  assert.equal(run(wellFormed).status, 0, 'the well-formed lite object indexes — so the refusals below are about the malformation, not about lite entries generally');

  for (const badLite of [{ skippedStages: 'red,security' }, { skippedStages: [1, 2] }, {}]) {
    const entryJson = { ...sampleLiteEntryJson('run-a', ['x.ts']), lite: badLite };
    const root = fixture({ 'run-a': { entryJson } });
    const result = run(root);
    assert.notEqual(result.status, 0, JSON.stringify(badLite));
    assert.ok(!existsSync(join(root, '.sdd', 'ledger', 'index.json')), JSON.stringify(badLite));
  }
});

// @spec EC-20
test('[lite] when a lite run and a full run both touch one file, index.json holds both records and only the lite one is qualified', () => {
  const root = fixture({
    '20260801T000000000Z-full': { entryJson: sampleEntryJson('20260801T000000000Z-full', ['shared/thing.ts']) },
    '20260808T000000000Z-lite': { entryJson: sampleLiteEntryJson('20260808T000000000Z-lite', ['shared/thing.ts']) },
  });
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);

  const index = JSON.parse(readFileSync(join(root, '.sdd', 'ledger', 'index.json'), 'utf8'));
  const records = index['shared/thing.ts'];
  assert.equal(records.length, 2, 'both runs really did touch this file — neither is dropped');
  assert.deepEqual(records.map((record) => record.runId), ['20260801T000000000Z-full', '20260808T000000000Z-lite']);
  assert.ok(!('lite' in records[0]), 'the full run\'s attribution is unqualified');
  assert.deepEqual(
    records[1].lite,
    { skippedStages: ['red', 'security'] },
    'a reader following the fast path (buggy file -> index.json) must see the qualification without a second hop into entry.json',
  );
});

// @spec AC-11
test('[lite] a bypass: true lite entry (a lite run that also needed --override-review) is excluded via bypass, exactly like any other override', () => {
  const entryJson = {
    ...sampleLiteEntryJson('run-lite-override', ['app/still-broken.ts']),
    verdicts: { review: 'NEEDS_FIXES', security: 'SKIPPED_LITE' },
    overrides: [{ gate: 'review', verdict: 'NEEDS_FIXES', reason: 'A style nit accepted on purpose.' }],
    bypass: true,
  };
  const root = fixture({ 'run-lite-override': { entryJson } });
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);

  const index = JSON.parse(readFileSync(join(root, '.sdd', 'ledger', 'index.json'), 'utf8'));
  assert.equal(index['app/still-broken.ts'], undefined, 'bypass excludes the run regardless of the lite disclosure alongside it');
});

// --- [inline] PL-12: an inline entry is INDEXED, decorated, and NOT a widening case ---------------
//
// Authored by the `red` stage from .pipeline/spec.md alone. (The `@spec` IDs below are PL-12's; the
// `[lite]` block above carries PL-11's own, and the two specs reuse several of the same numbers —
// the `[inline]` prefix on each test name is what disambiguates them.)
//
// The decision, and the one place it differs from `lite`: an inline entry is indexed for the same
// reason a re-gate or lite entry is — a real, ratified spec that `review` genuinely passed against
// the final tree — but here `security` genuinely ran too, so its `verdicts` is the ordinary
// byte-for-byte `{ review: "PASS", security: "PASS" }`. `inline` is therefore emphatically NOT a
// widening case the way `lite`'s `SKIPPED_LITE` is: it decorates records, and nothing else. A test
// that only asserted "the decoration appears" would pass just as happily against an implementation
// that also loosened the gate, so the gate is re-asserted here from both directions.

/** An inline entry.json in the exact shape scripts/ledger-append.mjs --inline writes. `reason`/`note`/
 * `size` are present because a real entry carries them — build-ledger-index.mjs deliberately reads
 * only `skippedStages`, the same narrowing readRegateField/readLiteField already apply. */
function sampleInlineEntryJson(runId, files, { skippedStages = ['red', 'dev'], ticket = 'PL-12', date = '2026-08-09' } = {}) {
  return {
    runId,
    date,
    ticket,
    filesTouched: files,
    verdicts: { review: 'PASS', security: 'PASS' },
    overrides: [],
    bypass: false,
    regate: null,
    lite: null,
    inline: {
      skippedStages,
      reason: 'A one-line fix made directly in-session; a spec was ratified first.',
      note: '(the fixed inline disclosure note — not read by this script)',
      size: { fileCount: files.length, changedLines: 84, maxLineLength: 118, unsizable: [] },
    },
    redTestPaths: [],
    securityRunId: runId,
  };
}

// @spec AC-20
test('[inline] an inline entry is indexed, and every record it produces carries inline: { skippedStages }', () => {
  const root = fixture({ 'run-inline': { entryJson: sampleInlineEntryJson('run-inline', ['scripts/typo-fix.mjs', 'docs/typo.md']) } });
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);

  const index = JSON.parse(readFileSync(join(root, '.sdd', 'ledger', 'index.json'), 'utf8'));
  assert.deepEqual(index['scripts/typo-fix.mjs'], [
    {
      runId: 'run-inline',
      ticket: 'PL-12',
      date: '2026-08-09',
      spec: '.sdd/ledger/run-inline/spec.md',
      inline: { skippedStages: ['red', 'dev'] },
    },
  ]);
  assert.deepEqual(
    index['docs/typo.md'][0].inline,
    { skippedStages: ['red', 'dev'] },
    'EVERY record the run produces carries the marker — a reader who happens to look up the second file must not get an unqualified attribution',
  );
  assert.ok(
    !('reason' in index['scripts/typo-fix.mjs'][0].inline) && !('note' in index['scripts/typo-fix.mjs'][0].inline),
    'only skippedStages is carried into this query index — reason/note/size stay entry.json-only detail, the same narrowing regate/lite already apply',
  );
});

// @spec AC-20
test('[inline] the verdicts gate is unchanged: an inline entry is held to PASS/PASS byte-for-byte, and inline is not a second widening case', () => {
  // Positive control: the ordinary inline shape indexes.
  const honest = fixture({ 'run-inline': { entryJson: sampleInlineEntryJson('run-inline', ['app/inline.ts']) } });
  assert.equal(run(honest).status, 0, 'an inline entry\'s verdicts are the ordinary PASS/PASS — security genuinely ran on that lane');
  assert.deepEqual(
    JSON.parse(readFileSync(join(honest, '.sdd', 'ledger', 'index.json'), 'utf8'))['app/inline.ts'][0].inline,
    { skippedStages: ['red', 'dev'] },
    'and it is indexed AS an inline entry: clearing the unchanged gate is only half the claim — without the decoration, "indexed" here is indistinguishable from "the field was ignored entirely"',
  );

  // ...and declaring itself inline buys no widening at all: SKIPPED_LITE from an inline entry is
  // still refused, because `lite` (not `inline`) is the one shape that gate widens for.
  const laundered = (() => {
    const entryJson = sampleInlineEntryJson('run-a', ['app/laundered.ts']);
    entryJson.verdicts = { review: 'PASS', security: 'SKIPPED_LITE' };
    return fixture({ 'run-a': { entryJson } });
  })();
  const launderedResult = run(laundered);
  assert.notEqual(launderedResult.status, 0,
    'an inline entry claiming a skipped security verdict is self-contradictory — the whole basis for indexing it is that security genuinely ran');
  assert.ok(!existsSync(join(laundered, '.sdd', 'ledger', 'index.json')), 'and it must write nothing while refusing');

  const nearMiss = (() => {
    const entryJson = sampleInlineEntryJson('run-a', ['app/near-miss.ts']);
    entryJson.verdicts = { review: 'PASS', security: 'SKIPPED_INLINE' };
    return fixture({ 'run-a': { entryJson } });
  })();
  assert.notEqual(run(nearMiss).status, 0, 'and no new SKIPPED_* literal may be invented for this lane either');
});

// @spec AC-20
test('[inline] a non-inline entry\'s index record carries no "inline" key at all, including when entry.json writes it as an explicit null', () => {
  const root = fixture({ 'run-a': { entryJson: sampleEntryJson('run-a', ['app/normal.ts']) } });
  assert.equal(run(root).status, 0);
  const index = JSON.parse(readFileSync(join(root, '.sdd', 'ledger', 'index.json'), 'utf8'));
  assert.ok(!('inline' in index['app/normal.ts'][0]), 'the marker\'s absence is what says the attribution is unqualified');

  const explicitNull = fixture({
    'run-a': { entryJson: { ...sampleEntryJson('run-a', ['app/explicit-null.ts']), inline: null } },
  });
  assert.equal(run(explicitNull).status, 0);
  const explicitNullIndex = JSON.parse(readFileSync(join(explicitNull, '.sdd', 'ledger', 'index.json'), 'utf8'));
  assert.ok(
    !('inline' in explicitNullIndex['app/explicit-null.ts'][0]),
    'an explicit "inline": null (what ledger-append.mjs writes for every non-inline run) must be omitted from the record, not carried through as null',
  );

  // A lite entry beside it keeps its own marker and gains no inline one — the two are independent.
  const mixed = fixture({
    '20260808T000000000Z-lite': { entryJson: sampleLiteEntryJson('20260808T000000000Z-lite', ['shared/thing.ts']) },
    '20260809T000000000Z-inline': { entryJson: sampleInlineEntryJson('20260809T000000000Z-inline', ['shared/thing.ts']) },
  });
  assert.equal(run(mixed).status, 0);
  const records = JSON.parse(readFileSync(join(mixed, '.sdd', 'ledger', 'index.json'), 'utf8'))['shared/thing.ts'];
  assert.equal(records.length, 2, 'both runs really did touch this file — neither is dropped');
  assert.deepEqual(records[0].lite, { skippedStages: ['red', 'security'] });
  assert.ok(!('inline' in records[0]));
  assert.deepEqual(records[1].inline, { skippedStages: ['red', 'dev'] });
  assert.ok(!('lite' in records[1]));
});

// @spec EC-16
test('[inline] a malformed inline object fails closed, and --check fails loudly rather than reporting the index as up to date', () => {
  // Positive control first: without it, every refusal below would pass today for a reason unrelated
  // to the shape of `inline` (the field is simply ignored by a script that never reads it).
  const wellFormed = fixture({ 'run-a': { entryJson: sampleInlineEntryJson('run-a', ['x.ts']) } });
  assert.equal(run(wellFormed).status, 0, 'the well-formed inline object indexes — so the refusals below are about the malformation, not about inline entries generally');

  for (const badInline of ['red,dev', { skippedStages: 'red,dev' }, { skippedStages: [1, 2] }, {}, []]) {
    const entryJson = { ...sampleInlineEntryJson('run-a', ['x.ts']), inline: badInline };
    const root = fixture({ 'run-a': { entryJson } });
    const result = run(root);
    assert.notEqual(result.status, 0, JSON.stringify(badInline));
    assert.ok(!existsSync(join(root, '.sdd', 'ledger', 'index.json')), JSON.stringify(badInline));
  }

  // --check must fail loudly on a malformed entry, not report "no drift" — an unindexable entry read
  // as up-to-date is the silent half of this failure.
  const root = fixture({ 'run-inline': { entryJson: sampleInlineEntryJson('run-inline', ['app/ok.ts']) } });
  assert.equal(run(root).status, 0, 'the baseline index must build before this test can say anything about --check');

  const runBDir = join(root, '.sdd', 'ledger', 'run-b');
  mkdirSync(runBDir, { recursive: true });
  writeFileSync(join(runBDir, 'entry.json'), JSON.stringify({ ...sampleInlineEntryJson('run-b', ['app/bad.ts']), inline: { skippedStages: 'red' } }), 'utf8');
  writeFileSync(join(runBDir, 'entry.md'), sampleEntryMarkdown('run-b'), 'utf8');
  writeFileSync(join(runBDir, 'spec.md'), '# Spec\n', 'utf8');

  assert.notEqual(run(root, ['--check']).status, 0, '--check must fail loudly on a malformed inline field');
});

// @spec EC-17
test('[inline] back-compat: an entry written before PL-12 (no "inline" key at all) still indexes cleanly beside an inline one, and the real repo\'s existing entries are untouched', () => {
  // An absent key is never a validation failure — every ledger entry on disk today has none.
  const root = fixture({
    '20260731T000000000Z-legacy': { entryJson: sampleEntryJson('20260731T000000000Z-legacy', ['shared/thing.ts']) },
    '20260809T000000000Z-inline': { entryJson: sampleInlineEntryJson('20260809T000000000Z-inline', ['shared/thing.ts']) },
  });
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  const records = JSON.parse(readFileSync(join(root, '.sdd', 'ledger', 'index.json'), 'utf8'))['shared/thing.ts'];
  assert.equal(records.length, 2);
  assert.ok(!('inline' in records[0]), 'a pre-PL-12 entry must index exactly as it did before — an absent key reads as null, never as malformed');
  assert.deepEqual(records[1].inline, { skippedStages: ['red', 'dev'] });

  // ...and the real ledger on disk, which is the actual back-compat surface: every entry written
  // before this ticket must still regenerate byte-identically.
  const realCheck = spawnSync(process.execPath, [resolve(scriptsDir, 'build-ledger-index.mjs'), '--check'], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(realCheck.status, 0, `the real repo's ledger index must still be up to date against the pre-existing entries: ${realCheck.stderr}`);

  const changedLedgerFiles = spawnSync('git', ['diff', '--name-only', 'HEAD', '--', '.sdd/ledger'], { cwd: repoRoot, encoding: 'utf8' })
    .stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const file of changedLedgerFiles) {
    assert.ok(
      !/entry\.(?:md|json)$/.test(file),
      `${file} was modified — PL-12 must not rewrite a single existing ledger entry; the ledger is append-only, and back-compat here means "untouched", not "migrated"`,
    );
  }
});
