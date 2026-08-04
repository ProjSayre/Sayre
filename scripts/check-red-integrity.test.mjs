// Tests scripts/check-red-integrity.mjs (PL-03c review Critical 3) — the mechanical half of
// .sdd/stages/review.md's "Red-test integrity" and "Spec trace" checks: rehashing every file
// red.json lists and resolving every @spec marker against spec.json's AC-*/EC-* items.
//
// PL-03h round 4 (architectural): this file used to build markdown fixtures (`specMarkdown`,
// `redMarkdown`, `changesMarkdown`) and probe the script's old fence/comment-aware, `extractSection`-
// based parsing directly — a fenced "## Content hashes" shadow, a genuine duplicate "## Red-test
// changes" heading, a fenced-example laundering a bullet-list declaration, and so on. That parsing
// mechanism is deleted outright (see check-red-integrity.mjs's and scripts/pipeline-contracts.mjs's
// own header comments); every markdown fixture below has been replaced by a JSON one. Several of the
// old adversarial tests (a genuine duplicate "## Content hashes (SHA-256)"/"## Red-test changes"
// heading laundering a tampered file's hash or a fake declaration) have no equivalent to construct
// anymore — there is no heading, no section, and no `Map.set` for a later, illustrative entry to
// silently overwrite, since `red.json`'s `tests` array bundles path/sha256/specIds into one object
// per test and `changes.json`'s `redTestChanges` is checked by exact array membership. Their *intent*
// (a malformed or adversarial sidecar must fail closed) is retargeted at scripts/pipeline-
// contracts.test.mjs's strict-validation coverage instead (duplicate test paths, invalid
// classification literals, malformed hashes, ...) — see that file.
//
// The script computes its own repoRoot as resolve(<its own directory>, '..') and imports its
// sibling pipeline-contracts.mjs by relative path, so exercising it in isolation means copying both
// files into a throwaway fixture repo and running it there — same approach as
// scripts/ledger-append.test.mjs, whose fixture-repo/afterEach-cleanup conventions this file
// follows. Unlike ledger-append.mjs's fixtures, several tests here also need real test files
// physically present on disk (the script hashes and greps them), not just JSON describing them.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const checkRedIntegritySource = readFileSync(resolve(scriptsDir, 'check-red-integrity.mjs'), 'utf8');
const contractsSource = readFileSync(resolve(scriptsDir, 'pipeline-contracts.mjs'), 'utf8');

const roots = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function specJson({ ticket = 'PL-99z — Sample ticket', acItems = ['AC-1'], ecItems = [] } = {}) {
  return {
    ticket,
    goal: 'Sample goal.',
    acceptanceCriteria: acItems.map((id) => ({ id, text: `Sample acceptance criterion ${id}.` })),
    edgeCases: ecItems.map((id) => ({ id, text: `Sample edge case ${id}.` })),
  };
}

/** `tests` is an array of { path, sha256, specIds, classification }; `content`/`hash` on each item
 * (from oneTestFixture()) are ignored by this function — only the four red.json fields are used. */
function redJson({ tests, impactMapPresent = false }) {
  return {
    impactMapPresent,
    tests: tests.map((t) => ({ path: t.path, sha256: t.hash, specIds: t.ids, classification: 'RED-CORRECT' })),
  };
}

function changesJson({ filesChanged = ['app/existing.ts'], redTestChanges = [] } = {}) {
  return { filesChanged, redTestChanges };
}

function initGit(dir) {
  execFileSync('git', ['init', '--quiet'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'check-red-integrity-test@example.invalid'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Check Red Integrity Test'], { cwd: dir });
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: dir });
}

/** Builds a throwaway fixture repo with the script + its sibling dependency, real test files on
 * disk at each of `tests[].path` (so hashing/grepping has something real to read), and
 * caller-supplied .pipeline/ JSON. `pipeline` maps a path relative to .pipeline/ to contents (an
 * object is JSON.stringify'd; a string is written verbatim, for deliberately-malformed JSON or for
 * writing a `.md` counterpart file whose mere *existence* some tests need); omit a key (e.g.
 * `red.json`, `changes.json`) to simulate that file's absence. */
function fixtureRepo({ tests = [], pipeline = {}, commit = true } = {}) {
  const root = mkdtempSync(resolve(tmpdir(), 'sayre-check-red-integrity-'));
  roots.push(root);

  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'check-red-integrity.mjs'), checkRedIntegritySource, 'utf8');
  writeFileSync(join(root, 'scripts', 'pipeline-contracts.mjs'), contractsSource, 'utf8');

  for (const t of tests) {
    const dest = join(root, t.path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, t.content, 'utf8');
  }

  for (const [relPath, contents] of Object.entries(pipeline)) {
    const dest = join(root, '.pipeline', relPath);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, typeof contents === 'string' ? contents : JSON.stringify(contents, null, 2), 'utf8');
  }

  initGit(root);
  if (commit) {
    execFileSync('git', ['add', '-A'], { cwd: root });
    execFileSync('git', ['commit', '--quiet', '-m', 'initial fixture state'], { cwd: root });
  }
  return root;
}

function runCheck(root, args = []) {
  return spawnSync(process.execPath, [join(root, 'scripts', 'check-red-integrity.mjs'), ...args], { cwd: root, encoding: 'utf8' });
}

/** A single well-formed test file's content: a real @spec marker in the file's own native comment
 * idiom, plus a trivial assertion body — enough for the script's own content-hashing/grepping to
 * have something realistic to read. */
function testFileContent(path, ids) {
  const marker = path.endsWith('.py') ? `# @spec ${ids.join(' ')}` : `// @spec ${ids.join(' ')}`;
  return `${marker}\ntest('sample', () => { /* body */ });\n`;
}

function oneTestFixture({ path = 'scripts/sample.test.mjs', ids = ['AC-1'], content } = {}) {
  const body = content ?? testFileContent(path, ids);
  return { path, content: body, hash: sha256(body), ids };
}

// --- Happy path: clean red.json, matching hashes, resolvable @spec IDs --------------------------

test('exits 0 with no violations on a clean, well-formed red.json', () => {
  const t = oneTestFixture();
  const root = fixtureRepo({
    tests: [t],
    pipeline: {
      'spec.json': specJson({ acItems: ['AC-1'] }),
      'red.json': redJson({ tests: [t] }),
    },
  });
  const result = runCheck(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no violations found/);
});

// --- Absence: no .pipeline/red.json (and no red.md) is a legitimate state, not a failure --------

test('exits 0 when neither .pipeline/red.json nor .pipeline/red.md exists for this run', () => {
  const root = fixtureRepo({ pipeline: { 'spec.json': specJson() } });
  const result = runCheck(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /nothing to check/);
});

// --- New under the JSON-first contract: a red.md with no matching red.json is NOT the same "no ---
// red stage ran" state — a red stage DID run and omitted the sidecar its own stage contract now
// requires. Free-passing this would silently reopen the exact bypass the JSON contract exists to
// close (a stage that simply never writes its sidecar would otherwise sail through as "nothing to
// check").

test('fails when .pipeline/red.md exists but .pipeline/red.json does not — this is an incomplete red-stage output, not "no red stage for this run"', () => {
  const root = fixtureRepo({
    pipeline: {
      'spec.json': specJson(),
      'red.md': '## Impact map\nAbsent.\n\n## Test paths\n- scripts/sample.test.mjs\n',
    },
  });
  const result = runCheck(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /red\.md exists but \.pipeline\/red\.json does not/);
});

// --- Red-test integrity: undeclared hash mismatch fails; declared hash mismatch does not --------

test('fails when a listed test file\'s content changed and changes.json does not declare it', () => {
  const t = oneTestFixture();
  const root = fixtureRepo({
    tests: [t],
    pipeline: {
      'spec.json': specJson({ acItems: ['AC-1'] }),
      'red.json': redJson({ tests: [t] }),
    },
  });
  // Mutate the file on disk after the fixture (and its hash) were committed — the real-world
  // scenario this check exists to catch.
  writeFileSync(join(root, t.path), t.content + '// a quiet, undeclared edit\n', 'utf8');

  const result = runCheck(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /1 violation/);
  assert.match(result.stdout, /does not declare this change/);
});

test('does not fail (but does report) when a hash mismatch is declared in changes.json\'s redTestChanges', () => {
  const t = oneTestFixture();
  const root = fixtureRepo({
    tests: [t],
    pipeline: {
      'spec.json': specJson({ acItems: ['AC-1'] }),
      'red.json': redJson({ tests: [t] }),
      'changes.json': changesJson({ redTestChanges: [{ path: t.path, reason: "the spec's signature was wrong; amended and the test updated to match." }] }),
    },
  });
  writeFileSync(join(root, t.path), t.content + '// a declared, legitimate edit\n', 'utf8');

  const result = runCheck(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /declared in changes\.json/);
});

// The old `isDeclaredInChanges` used to be a substring match against raw markdown section text, so a
// sentence merely *mentioning* the path (including one denying the change) counted as a declaration.
// The JSON contract has no such surface: `redTestChanges` is an array of `{path, reason}` objects and
// membership is exact-equality on `path`. This test documents the one thing that IS still true under
// the new contract by design: the schema does not judge the *reason* string's honesty (that stays
// review's job, per .sdd/stages/review.md's mechanical/judgment split) — only whether a declaration
// exists for the path at all.

test('a declaration whose own "reason" text denies the change is still counted as declared, BY DESIGN — the schema only has room for {path, reason}; judging whether the stated reason is honest is deliberately left to review, not this script', () => {
  const t = oneTestFixture();
  const root = fixtureRepo({
    tests: [t],
    pipeline: {
      'spec.json': specJson({ acItems: ['AC-1'] }),
      'red.json': redJson({ tests: [t] }),
      'changes.json': changesJson({ redTestChanges: [{ path: t.path, reason: 'NOT actually changed, this line is a lie' }] }),
    },
  });
  writeFileSync(join(root, t.path), t.content + '// a quiet edit\n', 'utf8');
  const result = runCheck(root);
  assert.equal(result.status, 0, result.stderr, 'this is the intentional mechanical/judgment split, not a bypass');
  assert.match(result.stdout, /declared in changes\.json/);
});

test('a path declared in changes.json under a different, similarly-named path (e.g. "foo.test.ts.bak") does not also satisfy a hash-mismatch check for "foo.test.ts" — exact string equality, no prefix matching', () => {
  const base = oneTestFixture({ path: 'scripts/foo.test.ts' });
  const backup = oneTestFixture({ path: 'scripts/foo.test.ts.bak', content: base.content });
  const root = fixtureRepo({
    tests: [base, backup],
    pipeline: {
      'spec.json': specJson({ acItems: ['AC-1'] }),
      'red.json': redJson({ tests: [base, backup] }),
      'changes.json': changesJson({ redTestChanges: [{ path: backup.path, reason: 'declared' }] }),
    },
  });
  writeFileSync(join(root, base.path), base.content + '// undeclared edit to the non-.bak file\n', 'utf8');
  const result = runCheck(root);
  assert.notEqual(result.status, 0, 'the declaration for the .bak path must not also cover the shorter, undeclared path');
  assert.match(result.stdout, /does not declare this change/);
});

test('fails when a listed test file no longer exists on disk at all', () => {
  const t = oneTestFixture();
  const root = fixtureRepo({
    tests: [t],
    pipeline: {
      'spec.json': specJson({ acItems: ['AC-1'] }),
      'red.json': redJson({ tests: [t] }),
    },
    commit: false,
  });
  rmSync(join(root, t.path));
  const result = runCheck(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /no longer exists on disk/);
});

test('fails when a test path is listed in red.json but the file was never created on disk at all (not merely deleted after being recorded)', () => {
  const phantomPath = 'scripts/phantom-never-existed.test.mjs';
  const root = fixtureRepo({
    tests: [], // nothing is ever written to disk at phantomPath
    pipeline: {
      'spec.json': specJson({ acItems: ['AC-1'] }),
      'red.json': { impactMapPresent: false, tests: [{ path: phantomPath, sha256: 'b'.repeat(64), specIds: ['AC-1'], classification: 'RED-CORRECT' }] },
    },
  });
  const result = runCheck(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /no longer exists on disk/);
});

// --- Fixed (PL-03h, finding 5): a hash recorded for a path that later becomes a directory --------
// carried forward unchanged by this round's architectural change — this is about a real file on
// disk becoming a directory, unrelated to the markdown-vs-JSON question.

test('a hash recorded for a path that has since become a directory reports a controlled violation, not an uncaught EISDIR exception', () => {
  const path = 'scripts/became-a-dir.test.mjs';
  const root = fixtureRepo({
    tests: [],
    pipeline: {
      'spec.json': specJson({ acItems: ['AC-1'] }),
      'red.json': { impactMapPresent: false, tests: [{ path, sha256: 'a'.repeat(64), specIds: ['AC-1'], classification: 'RED-CORRECT' }] },
    },
    commit: false,
  });
  mkdirSync(join(root, path), { recursive: true }); // the recorded path is now a directory, not a file
  const result = runCheck(root);
  assert.notEqual(result.status, 0, 'must not exit 0 when a recorded path is actually a directory');
  assert.match(result.stderr, /is a directory, not a file/i);
});

test('the printed JSON report (not only stderr) carries the directory violation for a hash-listed path that has become a directory', () => {
  const path = 'scripts/became-a-dir-2.test.mjs';
  const root = fixtureRepo({
    tests: [],
    pipeline: {
      'spec.json': specJson({ acItems: ['AC-1'] }),
      'red.json': { impactMapPresent: false, tests: [{ path, sha256: 'a'.repeat(64), specIds: ['AC-1'], classification: 'RED-CORRECT' }] },
    },
    commit: false,
  });
  mkdirSync(join(root, path), { recursive: true });
  const result = runCheck(root);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, 'violations-found');
  assert.ok(
    report.violations.some((v) => v.includes(path) && /is a directory, not a file/i.test(v)),
    'the printed JSON report itself must carry the directory violation',
  );
});

// --- Spec trace: missing or unresolvable @spec markers -------------------------------------------

test('fails when a listed test cites no "@spec" marker at all (neither red.json\'s specIds nor file content)', () => {
  const t = oneTestFixture({ content: "test('sample', () => {});\n" }); // no @spec marker in the file
  const root = fixtureRepo({
    tests: [t],
    pipeline: {
      'spec.json': specJson({ acItems: ['AC-1'] }),
      'red.json': { impactMapPresent: false, tests: [{ path: t.path, sha256: t.hash, specIds: [], classification: 'RED-CORRECT' }] },
    },
  });
  const result = runCheck(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cites no "@spec" marker at all/);
});

test('fails when a cited @spec ID does not resolve to a real AC-*/EC-* item in spec.json', () => {
  const t = oneTestFixture({ ids: ['AC-99'] });
  const root = fixtureRepo({
    tests: [t],
    pipeline: {
      'spec.json': specJson({ acItems: ['AC-1'] }), // AC-99 is not a real item
      'red.json': redJson({ tests: [t] }),
    },
  });
  const result = runCheck(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cites "@spec AC-99", which does not resolve/);
});

test('resolves an @spec marker against an Edge case ID, not only Acceptance criteria', () => {
  const t = oneTestFixture({ ids: ['EC-3'] });
  const root = fixtureRepo({
    tests: [t],
    pipeline: {
      'spec.json': specJson({ acItems: ['AC-1'], ecItems: ['EC-1', 'EC-2', 'EC-3'] }),
      'red.json': redJson({ tests: [t] }),
    },
  });
  const result = runCheck(root);
  assert.equal(result.status, 0, result.stderr);
});

// Replaces the old "@spec ID appears only inside a fenced code example in spec.md" exploit test: the
// JSON contract has no equivalent surface to construct, because spec.json's acceptanceCriteria/
// edgeCases arrays only ever contain declared {id,text} items — an id-shaped token mentioned inside a
// `goal` or `text` string's prose is not, and cannot become, a declared item. See
// scripts/pipeline-contracts.test.mjs's "readSpecJson never launders an id-shaped token that only
// appears in prose" for the direct unit coverage of this; the test below confirms the same property
// end-to-end through the real script, using a `text` field that mentions the marker format in prose.

test('an @spec-shaped token appearing only inside an acceptance-criterion\'s prose text (illustrating the marker format, not declaring a new item) is correctly NOT resolvable', () => {
  const t = oneTestFixture({ path: 'scripts/laundered.test.mjs', ids: ['AC-77'] });
  const spec = specJson({ acItems: ['AC-1'] });
  spec.acceptanceCriteria[0].text = 'Sample acceptance criterion AC-1. Example marker format: // @spec AC-77';
  const root = fixtureRepo({
    tests: [t],
    pipeline: { 'spec.json': spec, 'red.json': redJson({ tests: [t] }) },
  });
  const result = runCheck(root);
  assert.notEqual(result.status, 0, 'AC-77 only appears inside another item\'s prose text, not as its own declared id, and must not resolve');
  assert.match(result.stderr, /cites "@spec AC-77", which does not resolve/);

  // A real, adjacent AC-1 item still resolves correctly for a different citing test, proving the
  // laundering-illustration text doesn't disturb resolution of the genuine id it sits next to.
  const legitimate = oneTestFixture({ path: 'scripts/legitimate.test.mjs', ids: ['AC-1'] });
  const legitimateResult = runCheck(fixtureRepo({
    tests: [legitimate],
    pipeline: { 'spec.json': spec, 'red.json': redJson({ tests: [legitimate] }) },
  }));
  assert.equal(legitimateResult.status, 0, legitimateResult.stderr);
});

// PL-03h round 4: case variance in a *declared* (red.json specIds) @spec id used to resolve as a
// runtime "cites an id that does not resolve" violation, because the old parseSpecMapping accepted
// any string as an id with no shape check of its own, deferring entirely to the resolution step.
// scripts/pipeline-contracts.mjs's readRedJson validates each specIds entry against the same
// AC-n/EC-n shape (uppercase-only) at JSON-read time, so a lowercase "ac-1" now fails closed one step
// earlier — a malformed sidecar, not a resolvable-but-wrong id. This is a strictly stronger
// guarantee, not a narrower one: the invalid shape can no longer even be represented in a
// syntactically "valid" red.json, so there is no runtime code path left to reach for this input.
test('fails closed on case variance in a DECLARED @spec id (red.json\'s specIds) — a lowercase "ac-1" fails red.json\'s own shape validation at JSON-read time, before any per-test resolution check runs', () => {
  const t = oneTestFixture({ ids: ['AC-1'] }); // file content itself is irrelevant to this test
  const raw = redJson({ tests: [t] });
  raw.tests[0].specIds = ['ac-1'];
  const root = fixtureRepo({
    tests: [t],
    pipeline: { 'spec.json': specJson({ acItems: ['AC-1'] }), 'red.json': raw },
  });
  const result = runCheck(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not match the required AC-n \/ EC-n shape/);
});

// The file-content marker regex (extractSpecMarkersFromContent) is, and always was, case-sensitive
// on the AC/EC token itself (matching .sdd/stages/red.md's own documented comment idiom) — a
// lowercase "ac-1" in a file's own `// @spec ac-1` comment was never extracted as a marker at all,
// on either side of this ticket's architectural change. The observable outcome is therefore "cites no
// @spec marker at all" (the file's only marker doesn't match the extraction regex), not "cites an
// unresolvable id" — this test confirms that end-to-end through the real script.
test('fails closed on case variance in a FILE-CONTENT @spec marker (lowercase "ac-1") — the extraction regex is case-sensitive, so this resolves to "no marker found," not "an unresolvable id"', () => {
  const path = 'scripts/case-variance.test.mjs';
  const content = "// @spec ac-1\ntest('sample', () => {});\n";
  const t = { path, content, hash: sha256(content), ids: [] };
  const root = fixtureRepo({
    tests: [t],
    pipeline: {
      'spec.json': specJson({ acItems: ['AC-1'] }),
      'red.json': redJson({ tests: [t] }),
    },
  });
  const result = runCheck(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cites no "@spec" marker at all/);
});

test('a test citing two @spec IDs where only one is valid is flagged precisely for the invalid one, and the valid one is never also flagged', () => {
  const path = 'scripts/mixed-ids.test.mjs';
  const content = '// @spec AC-1 AC-99\n' + "test('sample', () => {});\n";
  const t = { path, content, hash: sha256(content), ids: ['AC-1', 'AC-99'] };
  const root = fixtureRepo({
    tests: [t],
    pipeline: {
      'spec.json': specJson({ acItems: ['AC-1'] }),
      'red.json': redJson({ tests: [t] }),
    },
  });
  const result = runCheck(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cites "@spec AC-99", which does not resolve/);
  assert.ok(!result.stderr.includes('"@spec AC-1"'), 'the valid AC-1 citation must never also be flagged as a violation');
});

test('a test citing two @spec IDs (one per source) resolves both — from red.json\'s specIds and from the file\'s own marker', () => {
  // The file itself only carries "@spec AC-1"; red.json's own specIds additionally claims "EC-2" for
  // this path — the union of both sources must be checked, not either one alone.
  const path = 'scripts/two-ids.test.mjs';
  const content = testFileContent(path, ['AC-1']);
  const t = { path, content, hash: sha256(content), ids: ['AC-1', 'EC-2'] };
  const root = fixtureRepo({
    tests: [t],
    pipeline: {
      'spec.json': specJson({ acItems: ['AC-1'], ecItems: ['EC-2'] }),
      'red.json': redJson({ tests: [t] }),
    },
  });
  const result = runCheck(root);
  assert.equal(result.status, 0, result.stderr);
});

// --- red.json's own internal integrity: no separate check needed for "impact map stated" or -----
// "RED-BROKEN absent" anymore — both are now enforced by readRedJson's strict shape validation
// (a required boolean field; an enum that simply does not include "RED-BROKEN") rather than by a
// second, independent check in this script. These two tests confirm that end-to-end, through the
// real script, rather than only at the unit level (scripts/pipeline-contracts.test.mjs already
// covers readRedJson directly).

test('fails (via the top-level JSON-validation catch, not a "violations" report) when red.json has no "impactMapPresent" field at all', () => {
  const t = oneTestFixture();
  const raw = redJson({ tests: [t] });
  delete raw.impactMapPresent;
  const root = fixtureRepo({
    tests: [t],
    pipeline: { 'spec.json': specJson({ acItems: ['AC-1'] }), 'red.json': raw },
  });
  const result = runCheck(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /field "impactMapPresent" must be a boolean/);
});

test('fails (via the top-level JSON-validation catch) when a test entry\'s classification is "RED-BROKEN" — there is no separate "scan the whole document" check left to write, because the enum itself does not include this literal', () => {
  const t = oneTestFixture();
  const raw = redJson({ tests: [t] });
  raw.tests[0].classification = 'RED-BROKEN';
  const root = fixtureRepo({
    tests: [t],
    pipeline: { 'spec.json': specJson({ acItems: ['AC-1'] }), 'red.json': raw },
  });
  const result = runCheck(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /field "classification" must be exactly one of/);
});

// --- Report-only: new test files in the diff not covered by red.json's tests ---------------------

test('reports (but does not fail on) a new, marker-less test file in the diff that red.json does not list', () => {
  const t = oneTestFixture();
  const root = fixtureRepo({
    tests: [t],
    pipeline: {
      'spec.json': specJson({ acItems: ['AC-1'] }),
      'red.json': redJson({ tests: [t] }),
    },
    commit: true,
  });
  // A second test file, added to the working tree *after* the commit (so `git ls-files --others`
  // picks it up as untracked/new), with no @spec marker and not listed in red.json at all — the
  // tester-authored-non-behavioral-coverage case this check must only report, never fail on.
  writeFileSync(join(root, 'scripts', 'harness.test.mjs'), "test('harness setup', () => {});\n", 'utf8');

  const result = runCheck(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"scripts\/harness.test.mjs" is a new test file in the diff/);
});

test('does not report a new test file that already carries its own "@spec" marker', () => {
  const t = oneTestFixture();
  const root = fixtureRepo({
    tests: [t],
    pipeline: {
      'spec.json': specJson({ acItems: ['AC-1'] }),
      'red.json': redJson({ tests: [t] }),
    },
    commit: true,
  });
  writeFileSync(join(root, 'scripts', 'another.test.mjs'), "// @spec AC-1\ntest('covered', () => {});\n", 'utf8');

  const result = runCheck(root);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(
    !result.stdout.includes('scripts/another.test.mjs" is a new test file in the diff'),
    'a new test file that already carries its own @spec marker must not be reported as a marker-less candidate',
  );
});

// --- Priority 4: regression against the real, current repository (not only synthetic fixtures) ---

test('[integration] check-red-integrity.mjs, run against the real, current .pipeline/, exits cleanly via the legitimate "no red.json for this run" path', () => {
  const result = spawnSync(process.execPath, [resolve(scriptsDir, 'check-red-integrity.mjs')], {
    cwd: resolve(scriptsDir, '..'),
    encoding: 'utf8',
  });
  // The real repo currently has no .pipeline/red.json (nor .pipeline/red.md, since .pipeline/** is
  // gitignored except README.md — see .gitignore) — assert dynamically against whatever is
  // actually on disk right now rather than hardcoding one specific transient state, so this test
  // does not become the exact brittleness review round 3's Warning 2 flagged in the prior version
  // (a hardcoded expectation that breaks the moment a developer runs the pipeline locally and leaves
  // .pipeline/red.md — or now, red.json — present).
  const redJsonPath = resolve(scriptsDir, '..', '.pipeline', 'red.json');
  const redMdPath = resolve(scriptsDir, '..', '.pipeline', 'red.md');
  if (!existsSync(redJsonPath) && !existsSync(redMdPath)) {
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /nothing to check/);
  } else if (existsSync(redJsonPath)) {
    // A red.json is present locally (e.g. a live pipeline run) — this script must at least run to
    // completion and print a well-formed report, whichever way it resolves.
    assert.ok(result.status === 0 || result.status === 1, 'must exit 0 (clean) or 1 (violations found), never crash uncontrolled');
  } else {
    // red.md present without red.json — the new "incomplete red-stage output" violation.
    assert.notEqual(result.status, 0);
  }
});

// Converted to a frozen fixture (review round 4, Critical 2): the equivalent test used to
// `readFileSync` the live, gitignored `.pipeline/spec.md` directly — ENOENT on any fresh checkout
// (`.pipeline/**` is gitignored except README.md, and CI never has it; reproduced with `git archive
// HEAD`). This round converts it to a frozen, committed real spec.json snapshot instead — see
// scripts/fixtures/pl-03h/real-spec.json's own leading `_comment` field.

test('[integration, frozen fixture] a real (frozen, committed) spec.json\'s actual Acceptance-criteria IDs resolve correctly (real, complex LLM-authored content, not a synthetic fixture)', () => {
  const realSpecJson = JSON.parse(readFileSync(resolve(scriptsDir, 'fixtures', 'pl-03h', 'real-spec.json'), 'utf8'));
  const t = oneTestFixture({ path: 'scripts/real-spec-trace.test.mjs', ids: ['AC-1'] });
  const root = fixtureRepo({
    tests: [t],
    pipeline: {
      'spec.json': realSpecJson,
      'red.json': redJson({ tests: [t] }),
    },
  });
  const result = runCheck(root);
  assert.equal(result.status, 0, result.stderr);
});

// --- --dir override (review Critical 3): pr-review's ledger fallback --------------------------------
//
// pr-review runs on a fresh PR checkout, where .pipeline/ — gitignored, per-run scratch — never
// existed. Without an alternate source, this script always hits the "no red.json — nothing to check"
// path there, which pr-review would otherwise report as a clean lens; a lens that always reports
// clean is worse than no lens. `--dir` lets a caller point this same script at a durable, committed
// copy instead (e.g. `.sdd/ledger/<run-id>/`, which scripts/ledger-append.mjs already populates with
// the same red.json/spec.json/changes.json shape .pipeline/ has).

test('--dir reads red.json/spec.json/changes.json from an alternate directory instead of .pipeline/', () => {
  const t = oneTestFixture();
  const root = fixtureRepo({ tests: [t] }); // no .pipeline/ directory at all
  const ledgerRunDir = join(root, '.sdd', 'ledger', 'sample-run');
  mkdirSync(ledgerRunDir, { recursive: true });
  writeFileSync(join(ledgerRunDir, 'spec.json'), JSON.stringify(specJson({ acItems: ['AC-1'] })), 'utf8');
  writeFileSync(join(ledgerRunDir, 'red.json'), JSON.stringify(redJson({ tests: [t] })), 'utf8');

  // Without --dir, there is nothing under .pipeline/ to find — the exact structural no-op review
  // found: reachable, but reports "nothing to check," never "clean."
  const withoutDir = runCheck(root);
  assert.equal(withoutDir.status, 0, withoutDir.stderr);
  assert.match(withoutDir.stdout, /nothing to check/);

  const withDir = runCheck(root, ['--dir', '.sdd/ledger/sample-run']);
  assert.equal(withDir.status, 0, withDir.stderr);
  assert.match(withDir.stdout, /no violations found/);
});

test('--dir\'s messages name the directory actually checked, not a hardcoded ".pipeline" — so a caller can tell "checked, nothing found" apart from "the wrong location was checked"', () => {
  const root = fixtureRepo({});
  const result = runCheck(root, ['--dir', '.sdd/ledger/nonexistent-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No \.sdd\/ledger\/nonexistent-run\/red\.json for this run/);
});

test('--dir still fails closed when spec.json is missing at the alternate location — the same required-input guarantee as the default .pipeline/ path', () => {
  const t = oneTestFixture();
  const root = fixtureRepo({ tests: [t] });
  const ledgerRunDir = join(root, '.sdd', 'ledger', 'sample-run');
  mkdirSync(ledgerRunDir, { recursive: true });
  writeFileSync(join(ledgerRunDir, 'red.json'), JSON.stringify(redJson({ tests: [t] })), 'utf8');
  const result = runCheck(root, ['--dir', '.sdd/ledger/sample-run']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /spec\.json does not exist/);
});

// --- Required input: spec.json must exist ----------------------------------------------------------

test('fails loudly when .pipeline/spec.json is missing', () => {
  const t = oneTestFixture();
  const root = fixtureRepo({
    tests: [t],
    pipeline: { 'red.json': redJson({ tests: [t] }) },
  });
  const result = runCheck(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /spec\.json does not exist/);
});
