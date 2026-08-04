// Tests scripts/ledger-append.mjs (PL-03c) — writes a durable ledger entry from .pipeline/
// artifacts once a run reaches terminal PASS (spec.md acceptance criteria 7, 9, 10, and the "run
// ids must be deterministic and collision-free" / "a run that never reaches PASS writes no ledger
// entry" edge cases).
//
// PL-03h round 4 (architectural — see .pipeline/review.md's round-3 "On convergence" section and
// scripts/pipeline-contracts.mjs's own header): this file used to build markdown fixtures
// (`reviewMarkdown`, `securityReportMarkdown`, `specMarkdown`, `redMarkdown`, `changesMarkdown`) and
// probe the script's old `extractSection`/`scanBlockState`-based parsing directly — a `###`/`####`
// heading shadow, inline prose resembling a heading, a fenced-code-block shadow, an HTML-comment
// shadow, a genuine duplicate heading appended below the real one (the "false review: PASS ledger
// entry" attack that motivated this whole ticket), and a multi-candidate substring-scan fallback for
// recovering a security run id from prose. All of that is deleted outright — see ledger-append.mjs's
// and scripts/pipeline-contracts.mjs's own header comments. Every markdown fixture below has been
// replaced by a JSON one (`reviewJson`, `securityJson`, `specJson`, `redJson`, `changesJson`).
//
// What has NO equivalent to construct anymore, and why (the constraint this file's task explicitly
// asked to honor — migrate intent, state plainly when a premise is gone, never silently drop
// coverage): every "append a second, later block below the real one" attack (a duplicate "##
// Verdict"/"## Files changed" heading, a fenced/commented shadow) required a document with more than
// one candidate location for the same fact. `review.json`/`security.json`/`changes.json` each hold
// exactly one value for the fact in question (one `verdict` string, one `filesChanged` array) — there
// is no second position in the JSON for an appended block to occupy, so there is nothing left for
// those tests to construct. The intent — "a run whose real verdict is not PASS must never be read as
// PASS" — is retargeted at direct enum-validation tests below (a near-miss literal, a missing field,
// a sentence containing the word PASS) and is the exact same assertion, minus the markdown-shaped
// attack vector. `findCompletedSecurityRun`'s old substring-scan fallback (for recovering a run id
// when the structured "Run ID:" line was absent or malformed) has no equivalent either: there is no
// fallback path once the field is a required, strictly-typed JSON string — see the "run id
// resolution" section below for what replaces that suite.
//
// The script computes its own repoRoot as resolve(<its own directory>, '..') and imports its
// sibling build-ledger-index.mjs/pipeline-contracts.mjs by relative path, so exercising it in
// isolation means copying all three files into a throwaway fixture repo and running it there — same
// approach as scripts/generate-agent-shims.test.mjs, whose fixture-repo/afterEach-cleanup
// conventions this file follows.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';
import { buildEntryJson, buildEntryMarkdown } from './ledger-append.mjs';
// Note: copySecurityHistoryIntoLedger is deliberately NOT imported directly here (unlike
// buildEntryMarkdown/buildEntryJson, which are pure value-building functions) — it resolves
// repoRoot/ledgerDir/securityHistoryDir from this module's own import.meta.url at import time, so
// calling it directly from this test file would operate against the *real* repo's .pipeline/ and
// .sdd/ledger/, not a fixture. It's exercised exclusively through the subprocess-based fixture tests
// below instead, where the whole script (including its path resolution) runs against a throwaway
// fixture root.

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');
const ledgerAppendSource = readFileSync(resolve(scriptsDir, 'ledger-append.mjs'), 'utf8');
const buildIndexSource = readFileSync(resolve(scriptsDir, 'build-ledger-index.mjs'), 'utf8');
const contractsSource = readFileSync(resolve(scriptsDir, 'pipeline-contracts.mjs'), 'utf8');

const roots = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

const RUN_ID = '20260803T120000000Z-abc123def456-PR_DELTA-f00baa';

function reviewJson(verdict = 'PASS') {
  return { verdict };
}

function securityJson(runId, verdict = 'PASS') {
  return { verdict, runId };
}

function manifestJson(runId, { commitSha = 'a'.repeat(40), dirty = false, status = 'COMPLETE', completedAt = '2026-08-03T12:05:00.000Z' } = {}) {
  return JSON.stringify(
    { schema_version: '1.0.0', run_id: runId, status, completed_at: completedAt, target: { commit_sha: commitSha, dirty } },
    null,
    2,
  );
}

function resultsJson(runId, verdict = 'PASS') {
  return JSON.stringify({ schema_version: '1.0.0', run_id: runId, verdict }, null, 2);
}

/** security-checker's own human-facing report — the third file (alongside manifest.json/
 * results.json) that a real .pipeline/security-history/<run-id>/ directory always carries (see
 * .pipeline/README.md's artifact table), and, as of PL-03c round 3, the third file
 * copySecurityHistoryIntoLedger copies into .sdd/ledger/<run-id>/security/. Content is a trivial
 * placeholder — ledger-append.mjs only ever copies this file byte-for-byte, never parses it. */
function securityHistoryReportMarkdown(runId, verdict = 'PASS') {
  return `# Security Report — ${runId}\n\n## Verdict\n\n**${verdict}**\n\nSample security-history report body for fixture testing.\n`;
}

function specMarkdown(ticket = 'PL-99z') {
  return `# ${ticket} — Sample ticket for ledger-append tests\n\n## Goal\n\nDo the sample thing this fixture exists to verify.\n\n## Scope\n\nIn: sample. Out: everything else.\n`;
}

function specJson(ticket = 'PL-99z') {
  return {
    ticket: `${ticket} — Sample ticket for ledger-append tests`,
    goal: 'Do the sample thing this fixture exists to verify.',
    acceptanceCriteria: [{ id: 'AC-1', text: 'Sample acceptance criterion.' }],
    edgeCases: [],
  };
}

function redJson(paths = ['scripts/sample.test.mjs']) {
  return {
    impactMapPresent: false,
    tests: paths.map((path) => ({ path, sha256: 'd'.repeat(64), specIds: ['AC-1'], classification: 'RED-CORRECT' })),
  };
}

function changesJson(files = ['app/existing.ts']) {
  return { filesChanged: files, redTestChanges: [] };
}

/** Trivial, human-facing placeholders for the markdown counterparts real stages also write
 * (review.md/security-report.md) — main() never reads either for a control decision anymore (only
 * review.json/security.json), but they still exist in a real run, and the AC10 gitignore-boundary
 * test below needs *something* on disk at those paths to assert stays ignored. */
function reviewMarkdownPlaceholder(verdict = 'PASS') {
  return `# Review\n\n## Verdict\n\n**${verdict}**\n\n(fixture placeholder — ledger-append.mjs reads review.json, not this file)\n`;
}

function securityReportMarkdownPlaceholder(verdict = 'PASS') {
  return `# Security Report\n\n## Verdict\n\n**${verdict}**\n\n(fixture placeholder — ledger-append.mjs reads security.json, not this file)\n`;
}

function initGit(dir) {
  execFileSync('git', ['init', '--quiet'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'ledger-append-test@example.invalid'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Ledger Append Test'], { cwd: dir });
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: dir });
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n', 'utf8');
}

function commitAll(dir, message) {
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '--quiet', '-m', message], { cwd: dir });
}

/** Builds a throwaway fixture repo: the three scripts (ledger-append.mjs imports
 * build-ledger-index.mjs and pipeline-contracts.mjs by relative path, so all three must be present),
 * a .sdd/ledger/ directory, and caller-supplied .pipeline/ files. `pipeline` maps a path relative to
 * .pipeline/ (or 'security-history/<id>/x.json') to file contents — an object is JSON.stringify'd, a
 * string is written verbatim. Commits everything as a baseline unless `git: false`. */
function fixtureRepo({ pipeline = {}, git = true } = {}) {
  const root = mkdtempSync(resolve(tmpdir(), 'sayre-ledger-append-'));
  roots.push(root);

  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'ledger-append.mjs'), ledgerAppendSource, 'utf8');
  writeFileSync(join(root, 'scripts', 'build-ledger-index.mjs'), buildIndexSource, 'utf8');
  writeFileSync(join(root, 'scripts', 'pipeline-contracts.mjs'), contractsSource, 'utf8');

  mkdirSync(join(root, '.sdd', 'ledger'), { recursive: true });
  writeFileSync(join(root, '.sdd', 'ledger', 'README.md'), '# Ledger\n\nFixture placeholder.\n', 'utf8');

  for (const [relPath, contents] of Object.entries(pipeline)) {
    const dest = join(root, '.pipeline', relPath);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, typeof contents === 'string' ? contents : JSON.stringify(contents, null, 2), 'utf8');
  }

  if (git) {
    initGit(root);
    commitAll(root, 'initial fixture state');
  }
  return root;
}

/** The standard "everything needed for a terminal PASS" pipeline fixture, as an object ready to
 * pass to fixtureRepo({ pipeline }) or to spread/override per test. */
function terminalPassPipeline({ runId = RUN_ID, ticket = 'PL-99z', redPaths, changesFiles, manifestOverrides, includeChanges = true, includeRed = true } = {}) {
  const pipeline = {
    'spec.md': specMarkdown(ticket),
    'spec.json': specJson(ticket),
    'review.md': reviewMarkdownPlaceholder('PASS'),
    'review.json': reviewJson('PASS'),
    'security-report.md': securityReportMarkdownPlaceholder('PASS'),
    'security.json': securityJson(runId, 'PASS'),
    [`security-history/${runId}/manifest.json`]: manifestJson(runId, manifestOverrides),
    [`security-history/${runId}/results.json`]: resultsJson(runId, 'PASS'),
    [`security-history/${runId}/report.md`]: securityHistoryReportMarkdown(runId, 'PASS'),
  };
  if (includeChanges) pipeline['changes.json'] = changesJson(changesFiles);
  if (includeRed) pipeline['red.json'] = redJson(redPaths);
  return pipeline;
}

function runLedgerAppend(root) {
  return spawnSync(process.execPath, [join(root, 'scripts', 'ledger-append.mjs')], { cwd: root, encoding: 'utf8' });
}

// --- AC 7, 9: writes .sdd/ledger/<run-id>/{spec.md,spec.json,entry.md,entry.json} on a terminal PASS

test('writes spec.md, spec.json, entry.md, and entry.json, and regenerates index.json, on a terminal PASS', () => {
  const root = fixtureRepo({ pipeline: terminalPassPipeline() });
  // Simulate dev's actual (uncommitted) change so the git-diff path has something to find.
  mkdirSync(join(root, 'app'), { recursive: true });
  writeFileSync(join(root, 'app', 'newThing.ts'), 'export const x = 1;\n', 'utf8');

  const result = runLedgerAppend(root);
  assert.equal(result.status, 0, result.stderr);

  const runDir = join(root, '.sdd', 'ledger', RUN_ID);
  assert.ok(existsSync(join(runDir, 'spec.md')));
  assert.ok(existsSync(join(runDir, 'spec.json')));
  assert.ok(existsSync(join(runDir, 'entry.md')));
  assert.ok(existsSync(join(runDir, 'entry.json')));

  const specCopy = readFileSync(join(runDir, 'spec.md'), 'utf8');
  assert.equal(specCopy, specMarkdown('PL-99z'));
  assert.deepEqual(JSON.parse(readFileSync(join(runDir, 'spec.json'), 'utf8')), specJson('PL-99z'));

  const entry = readFileSync(join(runDir, 'entry.md'), 'utf8');
  assert.match(entry, /## Ticket\r?\nPL-99z/);
  assert.match(entry, /## Verdicts\r?\n- review: PASS\r?\n- security: PASS/);
  assert.match(entry, /## Security run ID\r?\n\.pipeline\/security-history\/20260803T120000000Z-abc123def456-PR_DELTA-f00baa\//);
  assert.match(entry, /app\/newThing\.ts/);

  const entryJson = JSON.parse(readFileSync(join(runDir, 'entry.json'), 'utf8'));
  assert.equal(entryJson.runId, RUN_ID);
  assert.equal(entryJson.ticket, 'PL-99z');
  assert.deepEqual(entryJson.verdicts, { review: 'PASS', security: 'PASS' });
  assert.ok(entryJson.filesTouched.includes('app/newThing.ts'));

  const index = JSON.parse(readFileSync(join(root, '.sdd', 'ledger', 'index.json'), 'utf8'));
  assert.ok(index['app/newThing.ts']?.some((e) => e.runId === RUN_ID));
});

test('copies review.json and security.json into .sdd/ledger/<run-id>/, verbatim, alongside spec.json', () => {
  const root = fixtureRepo({ pipeline: terminalPassPipeline() });
  const result = runLedgerAppend(root);
  assert.equal(result.status, 0, result.stderr);

  const runDir = join(root, '.sdd', 'ledger', RUN_ID);
  assert.deepEqual(JSON.parse(readFileSync(join(runDir, 'review.json'), 'utf8')), reviewJson('PASS'));
  assert.deepEqual(JSON.parse(readFileSync(join(runDir, 'security.json'), 'utf8')), securityJson(RUN_ID, 'PASS'));
});

test('records the @spec test paths red.json lists', () => {
  const root = fixtureRepo({ pipeline: terminalPassPipeline({ redPaths: ['scripts/one.test.mjs', 'scripts/two.test.mjs'] }) });
  const result = runLedgerAppend(root);
  assert.equal(result.status, 0, result.stderr);
  const entry = readFileSync(join(root, '.sdd', 'ledger', RUN_ID, 'entry.md'), 'utf8');
  assert.match(entry, /## Red-test paths\r?\n- scripts\/one\.test\.mjs\r?\n- scripts\/two\.test\.mjs/);
  const runDir = join(root, '.sdd', 'ledger', RUN_ID);
  assert.ok(existsSync(join(runDir, 'red.json')), 'red.json must also be copied into the ledger when present for this run');
});

// --- Edge case (D-006 discipline): no red.json is stated explicitly, never silently blank -------

test('states explicitly, rather than silently, when no red.json is present for this run', () => {
  const root = fixtureRepo({ pipeline: terminalPassPipeline({ includeRed: false }) });
  const result = runLedgerAppend(root);
  assert.equal(result.status, 0, result.stderr);
  const entry = readFileSync(join(root, '.sdd', 'ledger', RUN_ID, 'entry.md'), 'utf8');
  assert.match(entry, /## Red-test paths\r?\nNo `red\.json` present for this run/);
  assert.ok(!existsSync(join(root, '.sdd', 'ledger', RUN_ID, 'red.json')), 'no red.json to copy when this run had none');
});

// --- Files touched: prefers a live git diff, falls back to changes.json on a clean tree ---------

test('prefers the live working-tree diff over changes.json when the tree is dirty', () => {
  const root = fixtureRepo({ pipeline: terminalPassPipeline({ changesFiles: ['app/from-changes-json.ts'] }) });
  mkdirSync(join(root, 'app'), { recursive: true });
  writeFileSync(join(root, 'app', 'from-git-diff.ts'), 'export const y = 2;\n', 'utf8'); // uncommitted

  const result = runLedgerAppend(root);
  assert.equal(result.status, 0, result.stderr);
  const entry = readFileSync(join(root, '.sdd', 'ledger', RUN_ID, 'entry.md'), 'utf8');
  assert.match(entry, /app\/from-git-diff\.ts/);
});

test('falls back to changes.json\'s "filesChanged" array when the working tree is already clean', () => {
  const root = fixtureRepo({ pipeline: terminalPassPipeline({ changesFiles: ['app/from-changes-json.ts', 'scripts/other.mjs'] }) });
  // fixtureRepo already committed everything, including changes.json itself, so `git diff
  // --name-only HEAD` and `git ls-files --others` both come up empty here — this is the fallback path.
  const result = runLedgerAppend(root);
  assert.equal(result.status, 0, result.stderr);
  const entry = readFileSync(join(root, '.sdd', 'ledger', RUN_ID, 'entry.md'), 'utf8');
  assert.match(entry, /app\/from-changes-json\.ts/);
  assert.match(entry, /scripts\/other\.mjs/);
});

test('states explicitly when no files touched could be determined at all', () => {
  const root = fixtureRepo({ pipeline: terminalPassPipeline({ includeChanges: false }) });
  // Clean tree (everything committed) and no changes.json to fall back on.
  const result = runLedgerAppend(root);
  assert.equal(result.status, 0, result.stderr);
  const entry = readFileSync(join(root, '.sdd', 'ledger', RUN_ID, 'entry.md'), 'utf8');
  assert.match(entry, /## Files touched\r?\n\(none could be determined automatically/);
});

// Retired (PL-03h round 4): the three markdown-heading-shape tests that used to live here — a
// title-case "## Files Changed" heading producing no data via a dead case-insensitive fallback
// (finding A), a changes.md with no "## Files changed" heading at all, and one where the heading was
// present but empty — all had the same premise: a markdown heading can be mis-cased, absent, or
// present-but-empty, three states a regex-based section extractor has to distinguish. `changes.json`
// has no heading to mis-case, omit, or leave empty in that sense; the equivalent state is
// `filesChanged` being an empty array while the working tree is clean, which is exactly what the
// test below asserts. The *intent* (a changes artifact that exists but reports no data, on a clean
// tree, must fail loudly rather than silently record "[]") is fully preserved.

test('fails loudly (does not silently record an empty list) when changes.json exists on a clean tree with an empty "filesChanged" array', () => {
  const pipeline = terminalPassPipeline({ includeChanges: false });
  pipeline['changes.json'] = { filesChanged: [], redTestChanges: [] };
  const root = fixtureRepo({ pipeline });
  const result = runLedgerAppend(root);
  assert.notEqual(result.status, 0, 'must not exit 0 by silently treating an empty filesChanged array as "no data"');
  assert.match(result.stderr, /"filesChanged" is empty/);
  assert.ok(!existsSync(join(root, '.sdd', 'ledger', RUN_ID)), 'must write no ledger entry when files-touched data could not actually be determined');
});

// --- Refusal: not a terminal PASS ---------------------------------------------------------------

test('refuses when review.json\'s verdict is NEEDS_FIXES, and writes nothing', () => {
  const root = fixtureRepo({ pipeline: { ...terminalPassPipeline(), 'review.json': reviewJson('NEEDS_FIXES') } });
  const result = runLedgerAppend(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /NEEDS_FIXES/);
  assert.ok(!existsSync(join(root, '.sdd', 'ledger', RUN_ID)));
});

test('refuses when security.json\'s verdict is BLOCKED, and writes nothing', () => {
  const root = fixtureRepo({ pipeline: { ...terminalPassPipeline(), 'security.json': securityJson(RUN_ID, 'BLOCKED') } });
  const result = runLedgerAppend(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /BLOCKED/);
  assert.ok(!existsSync(join(root, '.sdd', 'ledger', RUN_ID)));
});

test('refuses when spec.md is missing entirely (still required — it is copied verbatim into the ledger even though spec.json now supplies the ticket/goal data)', () => {
  const pipeline = terminalPassPipeline();
  delete pipeline['spec.md'];
  const root = fixtureRepo({ pipeline });
  const result = runLedgerAppend(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /spec\.md/);
});

test('refuses when spec.json is missing entirely', () => {
  const pipeline = terminalPassPipeline();
  delete pipeline['spec.json'];
  const root = fixtureRepo({ pipeline });
  const result = runLedgerAppend(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /spec\.json does not exist/);
});

test('refuses when review.json is missing entirely (distinct from a wrong verdict)', () => {
  const pipeline = terminalPassPipeline();
  delete pipeline['review.json'];
  const root = fixtureRepo({ pipeline });
  const result = runLedgerAppend(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /review\.json does not exist/);
  assert.ok(!existsSync(join(root, '.sdd', 'ledger', RUN_ID)));
});

test('refuses when security.json is missing entirely (distinct from a wrong verdict)', () => {
  const pipeline = terminalPassPipeline();
  delete pipeline['security.json'];
  const root = fixtureRepo({ pipeline });
  const result = runLedgerAppend(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /security\.json does not exist/);
  assert.ok(!existsSync(join(root, '.sdd', 'ledger', RUN_ID)));
});

// --- Strict verdict validation: a near-miss or malformed verdict fails closed --------------------
//
// Retired (PL-03h round 4): the markdown-era versions of this section constructed a "## Verdict"
// section whose text merely *contained* the word PASS in a sentence ("This run should probably PASS
// once minor things are fixed"), or that had a "###"/"####" heading shadow, or a fenced/commented
// shadow, sitting above the real section. None of that has an equivalent under the JSON contract —
// `review.json`'s `verdict` field is read once, as one literal value; there is no sentence for the
// word "PASS" to appear inside, and no heading depth or fence/comment state to get confused about.
// The intent (a verdict must be recognized only when it IS the verdict, never merely resembling one)
// is fully preserved below, now as a direct enum-validation check.

test('refuses when review.json\'s verdict is a sentence merely containing the word PASS, rather than being exactly the literal "PASS"', () => {
  const pipeline = terminalPassPipeline();
  pipeline['review.json'] = { verdict: 'This run should probably PASS once minor things are fixed.' };
  const root = fixtureRepo({ pipeline });
  const result = runLedgerAppend(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /field "verdict" must be exactly one of/);
  assert.ok(!existsSync(join(root, '.sdd', 'ledger', RUN_ID)));
});

test('refuses when review.json has no "verdict" field at all, rather than defaulting to a pass', () => {
  const pipeline = terminalPassPipeline();
  pipeline['review.json'] = {};
  const root = fixtureRepo({ pipeline });
  const result = runLedgerAppend(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /field "verdict" must be exactly one of/);
  assert.ok(!existsSync(join(root, '.sdd', 'ledger', RUN_ID)));
});

test('refuses when security.json\'s verdict is a near-miss string ("PASSED") rather than exactly PASS', () => {
  const pipeline = terminalPassPipeline();
  pipeline['security.json'] = { verdict: 'PASSED', runId: RUN_ID };
  const root = fixtureRepo({ pipeline });
  const result = runLedgerAppend(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /field "verdict" must be exactly one of/);
  assert.ok(!existsSync(join(root, '.sdd', 'ledger', RUN_ID)));
});

// Retired in full (PL-03h round 4): every test in this file's prior "Regression (review Critical 1)"
// and "Fixed (PL-03h)" sections — a ###/#### heading shadow above the real "## Verdict", inline prose
// resembling a heading, a "## Verdict" line fabricated inside a fenced code block or an HTML comment,
// and (the headline finding this whole ticket was opened to fix) a GENUINE, non-shadowed duplicate
// "## Verdict"/"## Files changed" heading appended below the real one, laundering a false PASS or
// hiding which files a run actually touched. Every one of those was a markdown *document-formatting*
// attack: each needed a second candidate location in the text (a different heading depth, a
// fenced/commented block, a second real heading later in the file) for the parser to be tricked into
// reading instead of, or in addition to, the real one. `review.json`/`security.json`/`changes.json`
// each hold exactly one JSON value for the fact in question — there is no second position for a
// second, later "block" to occupy, appended or otherwise, so there is no exploit left to construct
// for any of them. This is not a narrower fix that happens to also block these cases; it removes the
// entire class by removing the surface (parsing a natural-language document for a control decision)
// those attacks depended on — see .pipeline/review.md's round-3 "On convergence" section for the
// argument this implements, and .pipeline/changes.md for where this reasoning is restated in full.
// The specific outcome those tests protected — "a run whose real, final verdict is not PASS must
// never produce a ledger entry" — remains covered above ("refuses when review.json's verdict is
// NEEDS_FIXES", "refuses when security.json's verdict is BLOCKED", and the near-miss/missing-field
// tests immediately above this comment).

// --- Regression: entry.md/entry.json echo whatever verdict was actually read, never a hardcoded --
// literal — verified by calling the exported buildEntryMarkdown/buildEntryJson directly with values a
// real run could never actually reach main() with (main() only calls them once both verdicts are
// already confirmed 'PASS'), to prove the fields are genuinely parameterized and not silently ignored
// in favor of a literal.

test('buildEntryMarkdown writes whatever reviewVerdict/securityVerdict it is given, not a hardcoded literal', () => {
  const markdown = buildEntryMarkdown({
    runId: 'sample-run',
    date: '2026-08-03',
    ticketId: 'PL-99z',
    ticketTitle: 'PL-99z — sample',
    goal: 'Sample goal.',
    files: [],
    redTestPaths: [],
    redAbsenceNote: 'No red.json.',
    securityRunId: 'sample-run',
    commitLine: 'deadbeef',
    reviewVerdict: 'PASS',
    securityVerdict: 'PASS',
  });
  assert.match(markdown, /## Verdicts\n- review: PASS\n- security: PASS/);

  // main() can never reach this function with anything but 'PASS'/'PASS' (both checks fail() first
  // otherwise) — this second call proves the parameter is genuinely threaded through the template,
  // not shadowed by a literal 'PASS' the function ignores its own arguments in favor of.
  const hypothetical = buildEntryMarkdown({
    runId: 'sample-run',
    date: '2026-08-03',
    ticketId: 'PL-99z',
    ticketTitle: 'PL-99z — sample',
    goal: 'Sample goal.',
    files: [],
    redTestPaths: [],
    redAbsenceNote: 'No red.json.',
    securityRunId: 'sample-run',
    commitLine: 'deadbeef',
    reviewVerdict: 'HYPOTHETICAL_REVIEW_VALUE',
    securityVerdict: 'HYPOTHETICAL_SECURITY_VALUE',
  });
  assert.match(hypothetical, /## Verdicts\n- review: HYPOTHETICAL_REVIEW_VALUE\n- security: HYPOTHETICAL_SECURITY_VALUE/);
});

test('buildEntryJson writes whatever reviewVerdict/securityVerdict it is given, not a hardcoded literal — the machine-facing twin of the buildEntryMarkdown regression above', () => {
  const entry = buildEntryJson({
    runId: 'sample-run',
    date: '2026-08-03',
    ticketId: 'PL-99z',
    ticketTitle: 'PL-99z — sample',
    goal: 'Sample goal.',
    files: [],
    redTestPaths: [],
    redAbsenceNote: 'No red.json.',
    securityRunId: 'sample-run',
    commit: { sha: 'deadbeef', dirty: false },
    reviewVerdict: 'PASS',
    securityVerdict: 'PASS',
  });
  assert.deepEqual(entry.verdicts, { review: 'PASS', security: 'PASS' });

  const hypothetical = buildEntryJson({
    runId: 'sample-run',
    date: '2026-08-03',
    ticketId: 'PL-99z',
    ticketTitle: 'PL-99z — sample',
    goal: 'Sample goal.',
    files: [],
    redTestPaths: [],
    redAbsenceNote: 'No red.json.',
    securityRunId: 'sample-run',
    commit: { sha: 'deadbeef', dirty: false },
    reviewVerdict: 'HYPOTHETICAL_REVIEW_VALUE',
    securityVerdict: 'HYPOTHETICAL_SECURITY_VALUE',
  });
  assert.deepEqual(hypothetical.verdicts, { review: 'HYPOTHETICAL_REVIEW_VALUE', security: 'HYPOTHETICAL_SECURITY_VALUE' });
});

// --- Run id resolution: security.json's "runId" field is the sole, required source --------------
//
// Retired (PL-03h round 4): the markdown-era `findCompletedSecurityRun` had to recover a run id from
// security-report.md's prose when a structured "## Run and baseline" / "Run ID:" line was absent
// (an older-format report) or present-but-malformed (missing backticks) — a substring-scan fallback
// that had to exclude a report's own cited baseline from looking like a second candidate, and that
// could still be genuinely ambiguous if two ids both appeared as unprefixed prose. Six tests here
// used to cover that fallback chain and its edge cases. None of it has an equivalent anymore:
// `security.json`'s `runId` field is required and strictly typed (scripts/pipeline-contracts.mjs's
// readSecurityJson) — there is no "the structured field is absent or malformed" state left to fall
// back from, so there is no fallback chain to test. The two tests below cover what actually replaced
// it: the cited run id is looked up directly, and an unrelated second run directory on disk (e.g. a
// legitimate prior baseline) is simply irrelevant, never a source of ambiguity.

test('resolves directly to the runId security.json cites, even when an unrelated second run directory (e.g. a legitimate prior baseline) also exists on disk', () => {
  const baselineRunId = '20260731T230940936Z-90330fb19231-PR_DELTA-bf73ea';
  const pipeline = terminalPassPipeline();
  pipeline[`security-history/${baselineRunId}/manifest.json`] = manifestJson(baselineRunId, { commitSha: 'e'.repeat(40) });
  pipeline[`security-history/${baselineRunId}/results.json`] = resultsJson(baselineRunId, 'PASS');
  const root = fixtureRepo({ pipeline });
  const result = runLedgerAppend(root);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(root, '.sdd', 'ledger', RUN_ID)), 'must resolve to security.json\'s own cited runId');
  assert.ok(!existsSync(join(root, '.sdd', 'ledger', baselineRunId)), 'must not mistake an unrelated directory on disk for the current run — there is no scanning left to confuse');
});

test('refuses when security.json cites a runId with no matching security-history directory on disk', () => {
  const pipeline = terminalPassPipeline();
  pipeline['security.json'] = securityJson('some-other-run-id-not-on-disk', 'PASS');
  const root = fixtureRepo({ pipeline });
  const result = runLedgerAppend(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cites runId "some-other-run-id-not-on-disk", but/);
});

// --- Refusal: security-history run doesn't back up security.json's claim ------------------------

test('refuses when the matching security-history run is not COMPLETE', () => {
  const root = fixtureRepo({
    pipeline: terminalPassPipeline({ manifestOverrides: { status: 'INCOMPLETE' } }),
  });
  const result = runLedgerAppend(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not COMPLETE/);
});

test('refuses when the matching security-history run\'s own results verdict is not PASS — an independent cross-check against the immutable audit record, not merely trusting security.json\'s own say-so', () => {
  const pipeline = terminalPassPipeline();
  pipeline[`security-history/${RUN_ID}/results.json`] = resultsJson(RUN_ID, 'BLOCKED');
  const root = fixtureRepo({ pipeline });
  const result = runLedgerAppend(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not PASS/);
});

// --- Refusal / collision-safety: never overwrite an existing ledger entry -----------------------

test('refuses to overwrite an existing .sdd/ledger/<run-id>/ directory', () => {
  const root = fixtureRepo({ pipeline: terminalPassPipeline() });
  const runDir = join(root, '.sdd', 'ledger', RUN_ID);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'entry.md'), 'PRE-EXISTING, MUST NOT BE OVERWRITTEN\n', 'utf8');

  const result = runLedgerAppend(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /already exists/);
  assert.equal(readFileSync(join(runDir, 'entry.md'), 'utf8'), 'PRE-EXISTING, MUST NOT BE OVERWRITTEN\n');
});

// --- Ticket id extraction -------------------------------------------------------------------------

test('extracts a short ticket id from spec.json\'s "ticket" field for index.json, keeping the full title in entry.md', () => {
  const pipeline = terminalPassPipeline({ ticket: 'W3-10' });
  const root = fixtureRepo({ pipeline });
  const result = runLedgerAppend(root);
  assert.equal(result.status, 0, result.stderr);
  const entry = readFileSync(join(root, '.sdd', 'ledger', RUN_ID, 'entry.md'), 'utf8');
  assert.match(entry, /## Ticket\r?\nW3-10\r?\n\r?\nW3-10 — Sample ticket for ledger-append tests/);
});

// --- Commit / dirty-worktree disclosure -----------------------------------------------------------

test('records the audited commit and a dirty-worktree note when the security manifest says dirty', () => {
  const root = fixtureRepo({
    pipeline: terminalPassPipeline({ manifestOverrides: { commitSha: 'b'.repeat(40), dirty: true } }),
  });
  const result = runLedgerAppend(root);
  assert.equal(result.status, 0, result.stderr);
  const entry = readFileSync(join(root, '.sdd', 'ledger', RUN_ID, 'entry.md'), 'utf8');
  assert.match(entry, new RegExp(`## Commit\\r?\\n${'b'.repeat(40)} \\(worktree was dirty`));
  const entryJson = JSON.parse(readFileSync(join(root, '.sdd', 'ledger', RUN_ID, 'entry.json'), 'utf8'));
  assert.deepEqual(entryJson.commit, { sha: 'b'.repeat(40), dirty: true });
});

test('records a bare commit sha with no dirty caveat when the security manifest says clean', () => {
  const root = fixtureRepo({
    pipeline: terminalPassPipeline({ manifestOverrides: { commitSha: 'c'.repeat(40), dirty: false } }),
  });
  const result = runLedgerAppend(root);
  assert.equal(result.status, 0, result.stderr);
  const entry = readFileSync(join(root, '.sdd', 'ledger', RUN_ID, 'entry.md'), 'utf8');
  assert.match(entry, new RegExp(`## Commit\\r?\\n${'c'.repeat(40)}\\r?\\n`));
  const entryJson = JSON.parse(readFileSync(join(root, '.sdd', 'ledger', RUN_ID, 'entry.json'), 'utf8'));
  assert.deepEqual(entryJson.commit, { sha: 'c'.repeat(40), dirty: false });
});

// --- Fix 2 (PL-03c round 3): copies .pipeline/security-history/<run-id>/ into ----------------------
// .sdd/ledger/<run-id>/security/ on a terminal PASS — a *copy*, never a move (security-history/ is
// immutable and later runs use it as their own progress baseline via findCompletedSecurityRun), and
// never overwrites an existing .sdd/ledger/<run-id>/security/ directory, the same guard the run
// directory as a whole already has. Unaffected by the JSON-sidecar migration — these three files were
// already JSON/plain-copy, never parsed.

test('copies manifest.json, results.json, and report.md into .sdd/ledger/<run-id>/security/ on a terminal PASS', () => {
  const root = fixtureRepo({ pipeline: terminalPassPipeline() });
  const result = runLedgerAppend(root);
  assert.equal(result.status, 0, result.stderr);

  const sourceDir = join(root, '.pipeline', 'security-history', RUN_ID);
  const destDir = join(root, '.sdd', 'ledger', RUN_ID, 'security');
  for (const fileName of ['manifest.json', 'results.json', 'report.md']) {
    assert.ok(existsSync(join(destDir, fileName)), `expected .sdd/ledger/${RUN_ID}/security/${fileName} to exist`);
    assert.equal(
      readFileSync(join(destDir, fileName), 'utf8'),
      readFileSync(join(sourceDir, fileName), 'utf8'),
      `${fileName} must be copied byte-for-byte`,
    );
  }
});

test('never moves the source — .pipeline/security-history/<run-id>/ still exists, unchanged, after the copy', () => {
  const root = fixtureRepo({ pipeline: terminalPassPipeline() });
  const sourceDir = join(root, '.pipeline', 'security-history', RUN_ID);
  const beforeManifest = readFileSync(join(sourceDir, 'manifest.json'), 'utf8');

  const result = runLedgerAppend(root);
  assert.equal(result.status, 0, result.stderr);

  assert.ok(existsSync(sourceDir), '.pipeline/security-history/<run-id>/ must still exist after the copy — copy, never move');
  assert.equal(readFileSync(join(sourceDir, 'manifest.json'), 'utf8'), beforeManifest, 'the source manifest.json must be byte-unchanged');
  assert.ok(existsSync(join(sourceDir, 'results.json')));
  assert.ok(existsSync(join(sourceDir, 'report.md')));
});

/** Exercises the exported copySecurityHistoryIntoLedger directly, bypassing ledger-append.mjs's
 * main() entirely — the scenario this specific guard exists for (an existing .sdd/ledger/<run-id>/
 * that already has a security/ subdirectory, e.g. left behind by a prior backfill) can never be
 * reached through main()'s own flow, since main()'s top-level `existsSync(runDir)` check already
 * refuses before reaching this code whenever *any* part of runDir exists (see copySecurityHistory-
 * IntoLedger's own doc comment) — that top-level guard is covered separately below. Writes a tiny
 * throwaway wrapper script into the fixture's own scripts/ directory that imports the fixture's copy
 * of ledger-append.mjs, so path resolution (repoRoot/ledgerDir/securityHistoryDir) is anchored to
 * the fixture root, not the real repo. */
function runCopySecurityHistory(root, runId) {
  const wrapperPath = join(root, 'scripts', 'run-copy-security-history.mjs');
  writeFileSync(
    wrapperPath,
    "import { copySecurityHistoryIntoLedger } from './ledger-append.mjs';\ncopySecurityHistoryIntoLedger(process.argv[2]);\n",
    'utf8',
  );
  return spawnSync(process.execPath, [wrapperPath, runId], { cwd: root, encoding: 'utf8' });
}

test('copySecurityHistoryIntoLedger refuses to overwrite an existing .sdd/ledger/<run-id>/security/ directory (the same guard the PL-03a backfill relies on)', () => {
  const root = fixtureRepo({ pipeline: terminalPassPipeline() });
  const securityDir = join(root, '.sdd', 'ledger', RUN_ID, 'security');
  mkdirSync(securityDir, { recursive: true });
  writeFileSync(join(securityDir, 'manifest.json'), 'PRE-EXISTING, MUST NOT BE OVERWRITTEN\n', 'utf8');

  const result = runCopySecurityHistory(root, RUN_ID);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /security\/ already exists/);
  assert.equal(readFileSync(join(securityDir, 'manifest.json'), 'utf8'), 'PRE-EXISTING, MUST NOT BE OVERWRITTEN\n');
});

test('a full ledger-append.mjs run refuses at the top-level run-directory guard when .sdd/ledger/<run-id>/ already has only a security/ subdirectory (partial backfill state)', () => {
  const root = fixtureRepo({ pipeline: terminalPassPipeline() });
  const securityDir = join(root, '.sdd', 'ledger', RUN_ID, 'security');
  mkdirSync(securityDir, { recursive: true });
  writeFileSync(join(securityDir, 'manifest.json'), 'PRE-EXISTING\n', 'utf8');

  const result = runLedgerAppend(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /already exists — refusing to overwrite an existing ledger entry/);
  assert.equal(readFileSync(join(securityDir, 'manifest.json'), 'utf8'), 'PRE-EXISTING\n');
});

// --- AC 10 (tracking boundary), verified mechanically against the real .gitignore, in isolation ---
//
// fixtureRepo()'s own .gitignore (just `node_modules/\n`, see initGit()) doesn't replicate the real
// project's .pipeline/**-vs-.sdd/ledger/ boundary, so it can't be reused unmodified for this test.
// This builds its own throwaway repo instead of calling fixtureRepo(), specifically so the real
// .gitignore is in place *before* the first commit — `git check-ignore` reports an already-tracked
// path as not ignored regardless of matching patterns (git does not retroactively ignore tracked
// files), so committing .pipeline/* under a permissive gitignore first, then swapping gitignores
// after, would silently produce a false pass here. Writing the real rules before the first `git add
// -A` mirrors the real repository's actual history, where .pipeline/** has never been tracked.
test('AC10: the real .gitignore keeps freshly-written ledger content trackable (including the new JSON sidecars) while .pipeline/ working files (markdown AND their JSON sidecars alike) stay ignored', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'sayre-ledger-ac10-'));
  roots.push(root);
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'ledger-append.mjs'), ledgerAppendSource, 'utf8');
  writeFileSync(join(root, 'scripts', 'build-ledger-index.mjs'), buildIndexSource, 'utf8');
  writeFileSync(join(root, 'scripts', 'pipeline-contracts.mjs'), contractsSource, 'utf8');
  mkdirSync(join(root, '.sdd', 'ledger'), { recursive: true });
  writeFileSync(join(root, '.sdd', 'ledger', 'README.md'), '# Ledger\n\nFixture placeholder.\n', 'utf8');

  for (const [relPath, contents] of Object.entries(terminalPassPipeline())) {
    const dest = join(root, '.pipeline', relPath);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, typeof contents === 'string' ? contents : JSON.stringify(contents, null, 2), 'utf8');
  }

  // initGit() writes its own minimal .gitignore ('node_modules/\n') as part of setup — call it
  // first, then overwrite with the real repo's .gitignore, so the real content survives into the
  // first commit rather than being clobbered by (or clobbering) initGit()'s own file.
  initGit(root);
  writeFileSync(join(root, '.gitignore'), readFileSync(resolve(repoRoot, '.gitignore'), 'utf8'), 'utf8');
  commitAll(root, 'initial fixture state, real .gitignore applied before the first commit');

  const result = runLedgerAppend(root);
  assert.equal(result.status, 0, result.stderr);

  function isIgnored(relativePath) {
    const check = spawnSync('git', ['check-ignore', '-q', relativePath], { cwd: root });
    assert.ok(check.status === 0 || check.status === 1, `git check-ignore on ${relativePath} exited unexpectedly: ${check.status}`);
    return check.status === 0;
  }

  assert.equal(isIgnored(`.sdd/ledger/${RUN_ID}/spec.md`), false, 'newly-written ledger spec.md must not be gitignored');
  assert.equal(isIgnored(`.sdd/ledger/${RUN_ID}/spec.json`), false, 'newly-written ledger spec.json must not be gitignored');
  assert.equal(isIgnored(`.sdd/ledger/${RUN_ID}/entry.md`), false, 'newly-written ledger entry.md must not be gitignored');
  assert.equal(isIgnored(`.sdd/ledger/${RUN_ID}/entry.json`), false, 'newly-written ledger entry.json must not be gitignored');
  assert.equal(isIgnored(`.sdd/ledger/${RUN_ID}/review.json`), false, 'the copied review.json must not be gitignored');
  assert.equal(isIgnored(`.sdd/ledger/${RUN_ID}/security.json`), false, 'the copied security.json must not be gitignored');
  assert.equal(isIgnored(`.sdd/ledger/${RUN_ID}/red.json`), false, 'the copied red.json must not be gitignored');
  assert.equal(isIgnored(`.sdd/ledger/${RUN_ID}/changes.json`), false, 'the copied changes.json must not be gitignored');
  assert.equal(isIgnored(`.sdd/ledger/${RUN_ID}/security/manifest.json`), false, 'the copied security/manifest.json must not be gitignored');
  assert.equal(isIgnored(`.sdd/ledger/${RUN_ID}/security/results.json`), false, 'the copied security/results.json must not be gitignored');
  assert.equal(isIgnored(`.sdd/ledger/${RUN_ID}/security/report.md`), false, 'the copied security/report.md must not be gitignored');
  assert.equal(isIgnored('.sdd/ledger/index.json'), false, 'regenerated index.json must not be gitignored');

  assert.equal(isIgnored('.pipeline/spec.md'), true, '.pipeline/spec.md must stay gitignored');
  assert.equal(isIgnored('.pipeline/spec.json'), true, '.pipeline/spec.json must stay gitignored — only the ledger\'s COPY of it becomes trackable');
  assert.equal(isIgnored('.pipeline/review.json'), true, '.pipeline/review.json must stay gitignored');
  assert.equal(isIgnored('.pipeline/security.json'), true, '.pipeline/security.json must stay gitignored');
  assert.equal(isIgnored('.pipeline/README.md'), false, '.pipeline/README.md is the one documented carve-out and must stay trackable');
});
