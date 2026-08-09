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
// Verdict"/"## Files changed" heading, a fenced/commented shadow) required a *markdown* document with
// more than one candidate heading location for the same fact. There is no heading, fence, or comment
// left in `review.json`/`security.json`/`changes.json` for that specific attack shape to occupy.
//
// CORRECTED (round 5 / review Critical 1) — this is the part that matters most: an earlier version of
// this comment went on to claim "`review.json`/`security.json`/`changes.json` each hold exactly one
// value for the fact in question... there is no second position in the JSON for an appended block to
// occupy, so there is nothing left for those tests to construct." That premise was believed rather
// than tested, and was false: a *duplicate JSON key* — `{"verdict":"NEEDS_FIXES","verdict":"PASS"}` —
// is exactly a second position for the same fact, one layer down from a duplicate markdown heading,
// and it reproduced the identical target outcome (a durable `review: PASS` / `security: PASS` ledger
// entry for a run whose real, first-written verdict was `NEEDS_FIXES` / `BLOCKED`) end to end against
// this real script. The "C1 regression" tests below restore exactly that coverage, retargeted at the
// JSON contract's own remaining ambiguity (a duplicate object key, closed by
// scripts/pipeline-contracts.mjs's `parseJsonOrThrow`) rather than at the markdown mechanism that used
// to carry it. The broader intent — "a run whose real verdict is not PASS must never be read as
// PASS" — is covered by both: the enum-validation tests below (a near-miss literal, a missing field,
// a sentence containing the word PASS) for the shape-of-value class, and the C1-regression tests for
// the duplicate-key class. `findCompletedSecurityRun`'s old substring-scan fallback (for recovering a
// run id when the structured "Run ID:" line was absent or malformed) has no equivalent either: there
// is no fallback path once the field is a required, strictly-typed JSON string — see the "run id
// resolution" section below for what replaces that suite.
//
// CORRECTED (round 6 / security SEC-10) — the same shape as the round-5 correction directly above,
// one layer down: "closed by scripts/pipeline-contracts.mjs's parseJsonOrThrow" was true of
// `review.json`/`security.json`/`changes.json` themselves, but was read as "closed, full stop," which
// was false. `findCompletedSecurityRun` reads `security-history/<run-id>/manifest.json` and
// `results.json` directly (not through `readSecurityJson` or any of the five sidecar readers
// `parseJsonOrThrow` was wired into that round), and kept using plain `JSON.parse` — so the identical
// duplicate-key forgery still worked end to end, one layer under `security.json`, surviving the round
// this comment claimed had closed it. The "SEC-10 regression" tests below (in the same section as the
// C1-regression ones, immediately following) are that restored coverage — for `results.json`'s
// `verdict` and `manifest.json`'s `status` — now that `findCompletedSecurityRun` also reads through
// `pipeline-contracts.mjs`'s `readJsonFile`. The lesson generalizes: "closed by parseJsonOrThrow" is a
// claim about whichever call sites actually call it, never about "this class of bug, everywhere,"
// and needs re-checking against the actual call graph every time a new reader of the same kind of file
// is added — the "audit every JSON.parse call site" step this round adds is exactly that re-check.
//
// The script computes its own repoRoot as resolve(<its own directory>, '..') and imports its sibling
// build-ledger-index.mjs/pipeline-contracts.mjs/check-bounds.mjs by relative path, so exercising it in
// isolation means copying all four files (plus .sdd/bounds.yml, which check-bounds.mjs's `readBounds`
// reads — see GAP-01) into a throwaway fixture repo and running it there — same approach as
// scripts/generate-agent-shims.test.mjs, whose fixture-repo/afterEach-cleanup conventions this file
// follows.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';
import { buildEntryJson, buildEntryMarkdown, buildHotfixEntryJson, buildHotfixEntryMarkdown, generateHotfixRunId } from './ledger-append.mjs';
// buildStamp (scripts/pipeline-contracts.mjs) is imported directly, unlike contractsSource below (a raw
// string embedded into each fixture repo) — the [freshness] tests need to compute a REAL stamp against
// a fixture root from this test process itself (see realGitignoreFixtureRepo's own doc comment for why
// that specifically requires a fixture with the project's actual .gitignore in place).
import { buildStamp } from './pipeline-contracts.mjs';
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
// GAP-01: --hotfix now imports scripts/check-bounds.mjs directly (readBounds/matchesAny) to enforce
// its lane and barred-path gates, so the fixture repo below must carry a copy of it, and of the real
// .sdd/bounds.yml it reads, the same way it already carries build-ledger-index.mjs/pipeline-contracts.mjs.
const checkBoundsSource = readFileSync(resolve(scriptsDir, 'check-bounds.mjs'), 'utf8');
// PL-11: ledger-append.mjs's --lite branch imports evaluateLiteEligibility/countChangedLines from
// scripts/check-lite-eligible.mjs in-process (see that file's own test suite, which documents this
// exact reuse: "ledger-append.mjs --lite reuses it in-process rather than shelling out") — so a
// fixture repo running ledger-append.mjs's real source must carry a copy of it too, the same way it
// already carries build-ledger-index.mjs/pipeline-contracts.mjs/check-bounds.mjs.
const checkLiteEligibleSource = readFileSync(resolve(scriptsDir, 'check-lite-eligible.mjs'), 'utf8');
const boundsYmlSource = readFileSync(resolve(repoRoot, '.sdd', 'bounds.yml'), 'utf8');

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

/** PL-04 review pass 2 / Critical 1: a syntactically-valid but semantically-arbitrary `stamp` object —
 * every field `pipeline-contracts.mjs`'s `readStamp()` validates is present and correctly typed.
 * `--re-gate`'s stamp check is presence-only (see `ledger-append.mjs`'s own header comment for why
 * literal freshness against the fixture's live tree is deliberately not required — spec.json is
 * documented elsewhere as trusted-fresh/non-refusing precisely because it routinely reads "stale" in a
 * fully legitimate run), so the exact treeHash/headSha values here are never compared to anything. */
const DUMMY_SPEC_STAMP = { treeHash: 'a'.repeat(64), headSha: 'b'.repeat(40), dirty: false, writtenAt: '2026-08-04T00:00:00.000Z' };

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
  writeFileSync(join(root, 'scripts', 'check-bounds.mjs'), checkBoundsSource, 'utf8');
  writeFileSync(join(root, 'scripts', 'check-lite-eligible.mjs'), checkLiteEligibleSource, 'utf8');

  mkdirSync(join(root, '.sdd', 'ledger'), { recursive: true });
  writeFileSync(join(root, '.sdd', 'ledger', 'README.md'), '# Ledger\n\nFixture placeholder.\n', 'utf8');
  writeFileSync(join(root, '.sdd', 'bounds.yml'), boundsYmlSource, 'utf8');

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

/** Like `fixtureRepo`, but applies the REAL project `.gitignore` before the first commit — the same
 * technique the `AC10` test below already uses, extracted here because the `[freshness]` tests need it
 * for a load-bearing reason, not merely to match the real repo's tracking boundary: `computeTreeHash`
 * (scripts/pipeline-contracts.mjs) excludes any gitignored path from BOTH its tracked-diff scan and its
 * untracked-file scan, and `.pipeline/**` (except README.md) is exactly what the real `.gitignore`
 * excludes. `fixtureRepo`'s own minimal `.gitignore` (`node_modules/\n` — see `initGit`) does NOT
 * exclude `.pipeline/*`, so under it `review.json`/`security.json` are ordinary tracked source as far
 * as `computeTreeHash` is concerned — writing a stamp INTO one of them after the initial commit would
 * itself change the tracked diff, making the very act of embedding a "fresh" stamp read back as stale
 * one line later (a stamp cannot describe a tree that includes its own just-added bytes). Under the
 * real `.gitignore`, `.pipeline/*` is invisible to `computeTreeHash` entirely, so a stamp can be
 * computed once (`buildStamp(root)`), embedded into a `.pipeline/*.json` file, and stay accurate
 * indefinitely until something OUTSIDE `.pipeline/` actually changes — which is also exactly how the
 * real `write-stamp.mjs` avoids the same self-reference in production. See the `[freshness]` tests
 * below for the fresh/stale scenarios this makes possible to construct at all. */
function realGitignoreFixtureRepo({ pipeline = {} } = {}) {
  const root = mkdtempSync(resolve(tmpdir(), 'sayre-ledger-append-freshness-'));
  roots.push(root);

  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'ledger-append.mjs'), ledgerAppendSource, 'utf8');
  writeFileSync(join(root, 'scripts', 'build-ledger-index.mjs'), buildIndexSource, 'utf8');
  writeFileSync(join(root, 'scripts', 'pipeline-contracts.mjs'), contractsSource, 'utf8');
  writeFileSync(join(root, 'scripts', 'check-bounds.mjs'), checkBoundsSource, 'utf8');
  writeFileSync(join(root, 'scripts', 'check-lite-eligible.mjs'), checkLiteEligibleSource, 'utf8');

  mkdirSync(join(root, '.sdd', 'ledger'), { recursive: true });
  writeFileSync(join(root, '.sdd', 'ledger', 'README.md'), '# Ledger\n\nFixture placeholder.\n', 'utf8');
  writeFileSync(join(root, '.sdd', 'bounds.yml'), boundsYmlSource, 'utf8');

  for (const [relPath, contents] of Object.entries(pipeline)) {
    const dest = join(root, '.pipeline', relPath);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, typeof contents === 'string' ? contents : JSON.stringify(contents, null, 2), 'utf8');
  }

  // initGit() writes its own minimal .gitignore ('node_modules/\n') as part of setup — overwrite it
  // with the real repo's .gitignore BEFORE the first commit (git does not retroactively ignore an
  // already-tracked path), same ordering AC10 below already relies on.
  initGit(root);
  writeFileSync(join(root, '.gitignore'), readFileSync(resolve(repoRoot, '.gitignore'), 'utf8'), 'utf8');
  commitAll(root, 'initial fixture state, real .gitignore applied before the first commit');
  return root;
}

/** The standard "everything needed for a terminal PASS" pipeline fixture, as an object ready to
 * pass to fixtureRepo({ pipeline }) or to spread/override per test.
 *
 * @param {{ runId?: string, ticket?: string, redPaths?: string[], changesFiles?: string[],
 *   manifestOverrides?: object, includeChanges?: boolean, includeRed?: boolean, specStamp?: object }} [options]
 *   `redPaths`/`changesFiles`/`manifestOverrides`/`specStamp` are annotated explicitly (PL-04 / item 4)
 *   because none has a default value — plain JS parameter-shape inference from a destructuring default
 *   only sees properties that DO have one (`runId`, `ticket`, `includeChanges`, `includeRed`), so
 *   without this JSDoc `checkJs` infers a type omitting the other four, flagging every real call site
 *   that passes them as an unknown property. `specStamp` (PL-04 review pass 2 / Critical 1) attaches a
 *   `stamp` field onto the generated `spec.json` when given (see `DUMMY_SPEC_STAMP` above) — omitted by
 *   default, matching every real spec.json on disk before `write-stamp.mjs` existed; every `[re-gate]`
 *   test below that expects `--re-gate` to actually succeed must pass one, since that path now refuses
 *   an unstamped spec.json (see `ledger-append.mjs`'s own header comment).
 * @returns {Record<string, string | object>} keyed by path relative to `.pipeline/` — annotated
 *   because the two conditional `pipeline[...] = ...` assignments below add keys/value shapes beyond
 *   what the initial object literal's own inferred (closed) type would otherwise allow. */
function terminalPassPipeline({ runId = RUN_ID, ticket = 'PL-99z', redPaths, changesFiles, manifestOverrides, includeChanges = true, includeRed = true, specStamp } = {}) {
  /** @type {Record<string, string | object>} */
  const pipeline = {
    'spec.md': specMarkdown(ticket),
    'spec.json': specStamp ? { ...specJson(ticket), stamp: specStamp } : specJson(ticket),
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

// Indices 0-9 (the five --flag/value pairs) are relied on positionally by several tests below
// (HOTFIX_ARGS[1], [3], [5], [7], [9]) — GAP-01's new `--lane full` is appended AFTER them,
// deliberately, so those existing indices stay valid. `full` is the real, unfenced lane
// .sdd/hotfix.md's "who may use it" gate requires; see the dedicated lane-gate tests below for the
// fenced/unknown/missing-lane cases this constant does not exercise.
const HOTFIX_ARGS = [
  '--what-broke', 'Prod 500s on GET /api/repos since the 14:02 deploy.',
  '--what-changed', 'Reverted the null org_id guard removed in the same deploy.',
  '--why-skipped', 'Incident in progress; full pipeline would have taken longer than the outage.',
  '--not-verified', 'No new automated test added; only manually re-checked the one endpoint.',
  '--follow-up-ticket', 'PL-99z-followup',
  '--lane', 'full',
];

function runLedgerAppendHotfix(root, args = HOTFIX_ARGS) {
  return spawnSync(process.execPath, [join(root, 'scripts', 'ledger-append.mjs'), '--hotfix', ...args], { cwd: root, encoding: 'utf8' });
}

/** A bare fixture repo with none of the normal .pipeline/ artifacts — --hotfix requires none of
 * them, so this is deliberately much smaller than fixtureRepo({ pipeline: terminalPassPipeline() }). */
function hotfixFixtureRepo() {
  return fixtureRepo({ pipeline: {} });
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

// --- Refusal: a required .pipeline/ file is missing entirely -------------------------------------
//
// PL-04 / C2 (test-sediment consolidation): table-driven. Each row deletes exactly one required key
// from the standard terminalPassPipeline() and asserts the same two things every one of these five
// tests used to separately: a non-zero exit naming the missing file, and (except for spec.md/
// spec.json, which the original tests never checked this for either) no ledger entry written.

const MISSING_REQUIRED_FILE_CASES = [
  { name: 'spec.md missing entirely (still required — copied verbatim into the ledger even though spec.json now supplies the ticket/goal data)', deleteKey: 'spec.md', stderrPattern: /spec\.md/, checkLedgerAbsent: false },
  { name: 'spec.json missing entirely', deleteKey: 'spec.json', stderrPattern: /spec\.json does not exist/, checkLedgerAbsent: false },
  { name: 'review.json missing entirely (distinct from a wrong verdict)', deleteKey: 'review.json', stderrPattern: /review\.json does not exist/, checkLedgerAbsent: true },
  { name: 'security.json missing entirely (distinct from a wrong verdict)', deleteKey: 'security.json', stderrPattern: /security\.json does not exist/, checkLedgerAbsent: true },
];

test('refuses, naming the file, for every missing-required-file case in MISSING_REQUIRED_FILE_CASES', () => {
  for (const { name, deleteKey, stderrPattern, checkLedgerAbsent } of MISSING_REQUIRED_FILE_CASES) {
    const pipeline = terminalPassPipeline();
    delete pipeline[deleteKey];
    const root = fixtureRepo({ pipeline });
    const result = runLedgerAppend(root);
    assert.notEqual(result.status, 0, name);
    assert.match(result.stderr, stderrPattern, name);
    if (checkLedgerAbsent) assert.ok(!existsSync(join(root, '.sdd', 'ledger', RUN_ID)), `${name}: must write no ledger entry`);
  }
});

// --- Refusal: not a terminal PASS, and strict verdict validation ---------------------------------
//
// PL-04 / C2: table-driven, same consolidation as above. Retired (PL-03h round 4): the markdown-era
// versions of the last three rows constructed a "## Verdict" section whose text merely *contained*
// the word PASS in a sentence, or had a heading/fence/comment shadow above the real section — none of
// that has an equivalent under the JSON contract, where `review.json`'s `verdict` is read once, as
// one literal value. The intent (a verdict is recognized only when it IS the verdict, never merely
// resembling one) is fully preserved as a direct enum-validation check.

const INVALID_VERDICT_CASES = [
  { name: 'review.json\'s verdict is NEEDS_FIXES', override: { 'review.json': reviewJson('NEEDS_FIXES') }, stderrPattern: /NEEDS_FIXES/ },
  { name: 'security.json\'s verdict is BLOCKED', override: { 'security.json': securityJson(RUN_ID, 'BLOCKED') }, stderrPattern: /BLOCKED/ },
  { name: 'review.json\'s verdict is a sentence merely containing the word PASS, rather than being exactly the literal "PASS"', override: { 'review.json': { verdict: 'This run should probably PASS once minor things are fixed.' } }, stderrPattern: /field "verdict" must be exactly one of/ },
  { name: 'review.json has no "verdict" field at all, rather than defaulting to a pass', override: { 'review.json': {} }, stderrPattern: /field "verdict" must be exactly one of/ },
  { name: 'security.json\'s verdict is a near-miss string ("PASSED") rather than exactly PASS', override: { 'security.json': { verdict: 'PASSED', runId: RUN_ID } }, stderrPattern: /field "verdict" must be exactly one of/ },
];

test('refuses, and writes no ledger entry, for every invalid-verdict case in INVALID_VERDICT_CASES', () => {
  for (const { name, override, stderrPattern } of INVALID_VERDICT_CASES) {
    const pipeline = { ...terminalPassPipeline(), ...override };
    const root = fixtureRepo({ pipeline });
    const result = runLedgerAppend(root);
    assert.notEqual(result.status, 0, name);
    assert.match(result.stderr, stderrPattern, name);
    assert.ok(!existsSync(join(root, '.sdd', 'ledger', RUN_ID)), `${name}: must write no ledger entry`);
  }
});

// --- C1 / SEC-10 regression: a duplicate JSON key is a real, end-to-end exploitable forgery, not a --
// hypothetical. C1 (review round 4) covers review.json/security.json/changes.json; SEC-10 (security
// round 6) is the one call site (findCompletedSecurityRun's OWN reads of security-history/<run-id>/
// manifest.json and results.json — the immutable audit-trail files security.json's runId points at)
// that C1's fix never reached, so the identical forgery still worked end to end one layer under
// security.json, surviving the round-5 fix entirely (see .pipeline/security-history/ SEC-10 and the
// file-header comment above). PL-04 / C2: table-driven, same shape every row — override one pipeline
// file with a string containing a duplicate JSON key, run, and assert the refusal names that key.
// Restored, never deleted, per review's explicit instruction never to drop a regression class on an
// untested premise.

const DUPLICATE_KEY_CASES = [
  {
    name: '[C1] review.json duplicate "verdict" key whose LAST occurrence is PASS but whose real, first-written verdict was NEEDS_FIXES — the exact forgery review.md\'s round-4 report demonstrated end to end',
    override: { 'review.json': '{"verdict":"NEEDS_FIXES","verdict":"PASS"}' },
    duplicateKeyName: 'verdict',
  },
  {
    name: '[C1] security.json duplicate "verdict" key whose LAST occurrence is PASS but whose real, first-written verdict was BLOCKED',
    override: { 'security.json': `{"verdict":"BLOCKED","runId":"${RUN_ID}","verdict":"PASS"}` },
    duplicateKeyName: 'verdict',
  },
  {
    name: '[C1] changes.json duplicate "filesChanged" key, even though the working tree is otherwise clean (the fallback path this forgery would have to go through)',
    baseOverrides: { includeChanges: false },
    override: { 'changes.json': '{"filesChanged":["app/real.ts"],"redTestChanges":[],"filesChanged":["app/laundered.ts"]}' },
    duplicateKeyName: 'filesChanged',
  },
  {
    name: '[SEC-10] security-history/<run-id>/results.json duplicate "verdict" key whose LAST occurrence is PASS but whose real, first-written verdict was BLOCKED — the one call site review round 5\'s parseJsonOrThrow fix never reached',
    override: { [`security-history/${RUN_ID}/results.json`]: `{"schema_version":"1.0.0","run_id":"${RUN_ID}","verdict":"BLOCKED","verdict":"PASS"}` },
    duplicateKeyName: 'verdict',
  },
  {
    name: '[SEC-10] security-history/<run-id>/manifest.json duplicate "status" key whose LAST occurrence is COMPLETE but whose real, first-written status was not',
    override: {
      [`security-history/${RUN_ID}/manifest.json`]:
        `{"schema_version":"1.0.0","run_id":"${RUN_ID}","status":"IN_PROGRESS","status":"COMPLETE",` +
        `"completed_at":"2026-08-03T12:05:00.000Z","target":{"commit_sha":"${'a'.repeat(40)}","dirty":false}}`,
    },
    duplicateKeyName: 'status',
  },
];

test('refuses, naming the duplicate key, for every forgery in DUPLICATE_KEY_CASES — must write no ledger entry', () => {
  for (const { name, baseOverrides, override, duplicateKeyName } of DUPLICATE_KEY_CASES) {
    const pipeline = { ...terminalPassPipeline(baseOverrides), ...override };
    const root = fixtureRepo({ pipeline });
    const result = runLedgerAppend(root);
    assert.notEqual(result.status, 0, name);
    assert.match(result.stderr, new RegExp(`duplicate key "${duplicateKeyName}"`), name);
    assert.ok(!existsSync(join(root, '.sdd', 'ledger', RUN_ID)), `${name}: must write no ledger entry`);
  }
});

// --- [freshness] (security-precondition fix round, this branch — advisory finding 1): review.json's --
// and security.json's own `stamp` must not be STALE against the tree right now. Before this fix,
// nothing in this script ever called `stampFreshness`/`computeTreeHash` — every check here was about
// WHICH TICKET or WHICH VERDICT, never whether the verdict being cited was still current for the code
// actually being attributed to it. Security rated this the more severe finding of the round: a
// stale-but-PASS review.json/security.json pair, left over from before a later, never-reviewed edit,
// could be cited by an ordinary (non-`--re-gate`) run just as easily as a `--re-gate` one, producing a
// durable entry whose live-diff `filesTouched` includes code neither gate ever saw. All fixtures below
// use `realGitignoreFixtureRepo` (not the ordinary `fixtureRepo`) — see that helper's own doc comment
// for why the real .gitignore is load-bearing here, not cosmetic.

test('[freshness] refuses when review.json\'s stamp is STALE — the tree has moved on since it was written', () => {
  const root = realGitignoreFixtureRepo({ pipeline: terminalPassPipeline() });
  const staleStamp = buildStamp(root); // accurate at this instant — the clean tree right after the initial commit
  writeFileSync(join(root, '.pipeline', 'review.json'), JSON.stringify({ verdict: 'PASS', stamp: staleStamp }, null, 2), 'utf8');

  // A later, never-reviewed edit lands on the tree — exactly the laundering this fix closes.
  mkdirSync(join(root, 'app'), { recursive: true });
  writeFileSync(join(root, 'app', 'never-reviewed.ts'), 'export const x = 1;\n', 'utf8');

  const result = runLedgerAppend(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /review\.json's stamp is STALE/);
  assert.ok(!existsSync(join(root, '.sdd', 'ledger', RUN_ID)), 'must write no ledger entry');
});

test('[freshness] refuses when security.json\'s stamp is STALE — the tree has moved on since it was written', () => {
  const root = realGitignoreFixtureRepo({ pipeline: terminalPassPipeline() });
  const staleStamp = buildStamp(root);
  writeFileSync(join(root, '.pipeline', 'security.json'), JSON.stringify({ verdict: 'PASS', runId: RUN_ID, stamp: staleStamp }, null, 2), 'utf8');

  mkdirSync(join(root, 'app'), { recursive: true });
  writeFileSync(join(root, 'app', 'never-reviewed.ts'), 'export const x = 1;\n', 'utf8');

  const result = runLedgerAppend(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /security\.json's stamp is STALE/);
  assert.ok(!existsSync(join(root, '.sdd', 'ledger', RUN_ID)), 'must write no ledger entry');
});

test('[freshness] a FRESH stamp on both review.json and security.json does not block an otherwise-valid run', () => {
  const root = realGitignoreFixtureRepo({ pipeline: terminalPassPipeline() });
  const freshStamp = buildStamp(root);
  writeFileSync(join(root, '.pipeline', 'review.json'), JSON.stringify({ verdict: 'PASS', stamp: freshStamp }, null, 2), 'utf8');
  writeFileSync(join(root, '.pipeline', 'security.json'), JSON.stringify({ verdict: 'PASS', runId: RUN_ID, stamp: freshStamp }, null, 2), 'utf8');
  // No further tree changes — the stamp still matches "right now."

  const result = runLedgerAppend(root);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(root, '.sdd', 'ledger', RUN_ID)));
});

test('[freshness] an UNSTAMPED review.json/security.json (stampFreshness reads "unknown", never "stale") is not refused — back-compat with every artifact written before this contract existed', () => {
  // terminalPassPipeline()'s default reviewJson()/securityJson() attach no "stamp" field at all — the
  // exact shape of every sidecar on disk before this fix. Deliberately using realGitignoreFixtureRepo
  // here too (not the ordinary fixtureRepo) so this test exercises the identical fixture shape as the
  // stale/fresh cases above, isolating "no stamp" as the one variable that differs.
  const root = realGitignoreFixtureRepo({ pipeline: terminalPassPipeline() });
  const result = runLedgerAppend(root);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(root, '.sdd', 'ledger', RUN_ID)));
});

test('[freshness] a STALE review.json still refuses even with --override-review supplied — an override accepts a gate\'s real non-PASS verdict, never a verdict computed against a tree that has since moved on', () => {
  const root = realGitignoreFixtureRepo({ pipeline: terminalPassPipeline() });
  const staleStamp = buildStamp(root);
  writeFileSync(join(root, '.pipeline', 'review.json'), JSON.stringify({ verdict: 'NEEDS_FIXES', stamp: staleStamp }, null, 2), 'utf8');

  mkdirSync(join(root, 'app'), { recursive: true });
  writeFileSync(join(root, 'app', 'never-reviewed.ts'), 'export const x = 1;\n', 'utf8');

  const result = runLedgerAppendWithArgs(root, ['--override-review', 'Attempting to override a stale verdict.']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /review\.json's stamp is STALE/);
  assert.ok(!existsSync(join(root, '.sdd', 'ledger', RUN_ID)));
});

test('[freshness] a STALE review.json still refuses under --re-gate too — /re-gate\'s whole point is re-running the gates against the current tree; a stale verdict was never run against it', () => {
  const root = realGitignoreFixtureRepo({ pipeline: terminalPassPipeline({ specStamp: DUMMY_SPEC_STAMP }) });
  const staleStamp = buildStamp(root);
  writeFileSync(join(root, '.pipeline', 'review.json'), JSON.stringify({ verdict: 'PASS', stamp: staleStamp }, null, 2), 'utf8');

  mkdirSync(join(root, 'app'), { recursive: true });
  writeFileSync(join(root, 'app', 'never-reviewed.ts'), 'export const x = 1;\n', 'utf8');

  const result = runLedgerAppendWithArgs(root, ['--re-gate', '--tester-ran', 'true', '--ticket', 'PL-99z']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /review\.json's stamp is STALE/);
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
  writeFileSync(join(root, 'scripts', 'check-bounds.mjs'), checkBoundsSource, 'utf8');
  writeFileSync(join(root, 'scripts', 'check-lite-eligible.mjs'), checkLiteEligibleSource, 'utf8');
  mkdirSync(join(root, '.sdd', 'ledger'), { recursive: true });
  writeFileSync(join(root, '.sdd', 'ledger', 'README.md'), '# Ledger\n\nFixture placeholder.\n', 'utf8');
  writeFileSync(join(root, '.sdd', 'bounds.yml'), boundsYmlSource, 'utf8');

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

// --- PL-04 / B2, B3: sanctioned overrides (--override-review / --override-security) --------------
//
// B2 (observed): there was no sanctioned way to record a run whose review.json (or security.json)
// verdict was not PASS, disclosed, with a reason — so an override happened by hand-editing a subagent
// prompt instead, and left no artifact, no ledger entry, nothing a future reader could find. This is a
// disclosure mechanism, not an authorization one — nothing checks who invokes either flag; see
// ledger-append.mjs's own "Sanctioned overrides" section. B3 (observed, same root cause approached
// from the other side): ledger-append
// only ever wrote an entry on a genuine terminal PASS, so a run that reached a real, final
// NEEDS_FIXES/BLOCKED verdict (PL-03a's three rounds among them) left nothing durable at all, even
// though "the runs that fail are the informative ones." `--override-review`/`--override-security`
// are the one mechanism this fix adds that answers both at once.

function runLedgerAppendWithArgs(root, args) {
  return spawnSync(process.execPath, [join(root, 'scripts', 'ledger-append.mjs'), ...args], { cwd: root, encoding: 'utf8' });
}

test('[B2] --override-review lets a NEEDS_FIXES review.json be recorded, with the required reason reaching both entry.md and entry.json', () => {
  const pipeline = { ...terminalPassPipeline(), 'review.json': reviewJson('NEEDS_FIXES') };
  const root = fixtureRepo({ pipeline });
  const result = runLedgerAppendWithArgs(root, ['--override-review', 'Incident in progress; recording the real state to unblock the next step.']);
  assert.equal(result.status, 0, result.stderr);

  const runDir = join(root, '.sdd', 'ledger', RUN_ID);
  assert.ok(existsSync(runDir), 'an override must still write a ledger entry, not merely permit one to be considered');

  const entry = readFileSync(join(runDir, 'entry.md'), 'utf8');
  // [finding 3] the title must not read as a bare, clean-looking "# Ledger entry — <runId>" — that was
  // indistinguishable at a glance from a genuine PASS run before this fix, even though the body's own
  // "## Overrides" section was always honest.
  assert.match(entry, /^# Ledger entry — .+\(OVERRIDE\)/m);
  assert.match(entry, /## Verdicts\r?\n- review: NEEDS_FIXES\r?\n- security: PASS/);
  assert.ok(entry.includes('## Overrides'));
  assert.ok(entry.includes('review: actual verdict was NEEDS_FIXES, accepted anyway.'));
  assert.ok(entry.includes('Incident in progress; recording the real state to unblock the next step.'));

  const entryJson = JSON.parse(readFileSync(join(runDir, 'entry.json'), 'utf8'));
  assert.deepEqual(entryJson.verdicts, { review: 'NEEDS_FIXES', security: 'PASS' });
  assert.equal(entryJson.bypass, true, 'a run that did not pass both gates on its own must be excluded from the index the same way a hotfix is');
  assert.deepEqual(entryJson.overrides, [
    { gate: 'review', verdict: 'NEEDS_FIXES', reason: 'Incident in progress; recording the real state to unblock the next step.' },
  ]);
});

test('[B2] --override-review with no value at all fails closed, names the flag, and writes nothing — refusing to provide a reason means the override does not happen', () => {
  const pipeline = { ...terminalPassPipeline(), 'review.json': reviewJson('NEEDS_FIXES') };
  const root = fixtureRepo({ pipeline });
  const result = runLedgerAppendWithArgs(root, ['--override-review']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--override-review requires a non-empty reason string/);
  assert.ok(!existsSync(join(root, '.sdd', 'ledger', RUN_ID)));
});

test('[B2] --override-review with an empty/whitespace-only reason fails closed the same way as an entirely missing one', () => {
  const pipeline = { ...terminalPassPipeline(), 'review.json': reviewJson('NEEDS_FIXES') };
  const root = fixtureRepo({ pipeline });
  const result = runLedgerAppendWithArgs(root, ['--override-review', '   ']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--override-review requires a non-empty reason string/);
  assert.ok(!existsSync(join(root, '.sdd', 'ledger', RUN_ID)));
});

test('[B2] with no --override-review supplied at all, a NEEDS_FIXES review.json still refuses exactly as before, and the refusal now also names --override-review as the sanctioned alternative', () => {
  const pipeline = { ...terminalPassPipeline(), 'review.json': reviewJson('NEEDS_FIXES') };
  const root = fixtureRepo({ pipeline });
  const result = runLedgerAppend(root); // no override flags at all
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /NEEDS_FIXES/);
  assert.match(result.stderr, /--override-review/);
  assert.ok(!existsSync(join(root, '.sdd', 'ledger', RUN_ID)));
});

test('[B2] --override-security lets a BLOCKED security.json be recorded, once its own results.json independently confirms the same BLOCKED verdict', () => {
  const pipeline = terminalPassPipeline();
  pipeline['security.json'] = securityJson(RUN_ID, 'BLOCKED');
  pipeline[`security-history/${RUN_ID}/results.json`] = resultsJson(RUN_ID, 'BLOCKED');
  const root = fixtureRepo({ pipeline });
  const result = runLedgerAppendWithArgs(root, ['--override-security', 'Rolling forward on a known, accepted risk.']);
  assert.equal(result.status, 0, result.stderr);

  const runDir = join(root, '.sdd', 'ledger', RUN_ID);
  const entryJson = JSON.parse(readFileSync(join(runDir, 'entry.json'), 'utf8'));
  assert.deepEqual(entryJson.verdicts, { review: 'PASS', security: 'BLOCKED' });
  assert.equal(entryJson.bypass, true);
  assert.deepEqual(entryJson.overrides, [{ gate: 'security', verdict: 'BLOCKED', reason: 'Rolling forward on a known, accepted risk.' }]);
});

test('[B2] --override-security still refuses when security.json\'s claimed verdict does not match its own results.json — an override changes which verdict is acceptable, never whether the two files must agree with each other', () => {
  const pipeline = terminalPassPipeline();
  pipeline['security.json'] = securityJson(RUN_ID, 'BLOCKED');
  pipeline[`security-history/${RUN_ID}/results.json`] = resultsJson(RUN_ID, 'PARTIAL'); // disagrees with security.json's own claim
  const root = fixtureRepo({ pipeline });
  const result = runLedgerAppendWithArgs(root, ['--override-security', 'Attempting to override anyway.']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not match \.pipeline\/security\.json's claimed verdict/);
  assert.ok(!existsSync(join(root, '.sdd', 'ledger', RUN_ID)));
});

test('[B2] both --override-review and --override-security may be supplied together, recording both independently', () => {
  const pipeline = terminalPassPipeline();
  pipeline['review.json'] = reviewJson('NEEDS_FIXES');
  pipeline['security.json'] = securityJson(RUN_ID, 'BLOCKED');
  pipeline[`security-history/${RUN_ID}/results.json`] = resultsJson(RUN_ID, 'BLOCKED');
  const root = fixtureRepo({ pipeline });
  const result = runLedgerAppendWithArgs(root, [
    '--override-review', 'Review reason.',
    '--override-security', 'Security reason.',
  ]);
  assert.equal(result.status, 0, result.stderr);
  const entryJson = JSON.parse(readFileSync(join(root, '.sdd', 'ledger', RUN_ID, 'entry.json'), 'utf8'));
  assert.equal(entryJson.overrides.length, 2);
  assert.deepEqual(entryJson.overrides.map((o) => o.gate).sort(), ['review', 'security']);
});

test('[B2] a superfluous --override-review is inert when review.json already says PASS — nothing to override, so it is not recorded as one and the run is not excluded', () => {
  const root = fixtureRepo({ pipeline: terminalPassPipeline() }); // default changesJson files: ['app/existing.ts']
  const result = runLedgerAppendWithArgs(root, ['--override-review', 'Not actually needed.']);
  assert.equal(result.status, 0, result.stderr);
  const entryJson = JSON.parse(readFileSync(join(root, '.sdd', 'ledger', RUN_ID, 'entry.json'), 'utf8'));
  assert.deepEqual(entryJson.overrides, []);
  assert.equal(entryJson.bypass, false);
  const index = JSON.parse(readFileSync(join(root, '.sdd', 'ledger', 'index.json'), 'utf8'));
  assert.ok(index['app/existing.ts']?.some((e) => e.runId === RUN_ID), 'a genuinely clean run must still be indexed, override flag or not');
  // [finding 3]: a superfluous, inert override must not put an "(OVERRIDE)" marker on a run that was
  // never actually overridden — the marker tracks the (empty) `overrides` array, not the flag's presence.
  const entry = readFileSync(join(root, '.sdd', 'ledger', RUN_ID, 'entry.md'), 'utf8');
  assert.ok(!entry.includes('(OVERRIDE)'));
});

test('a normal, non-overridden PASS run\'s entry.md explicitly states that nothing was overridden, rather than omitting the section entirely', () => {
  const root = fixtureRepo({ pipeline: terminalPassPipeline() });
  const result = runLedgerAppend(root);
  assert.equal(result.status, 0, result.stderr);
  const entry = readFileSync(join(root, '.sdd', 'ledger', RUN_ID, 'entry.md'), 'utf8');
  assert.ok(entry.includes('## Overrides'));
  assert.ok(entry.includes('(none — both gates passed on their own; nothing here was overridden)'));
  // [finding 3]: a clean pass must not carry the "(OVERRIDE)" title marker either.
  assert.ok(!entry.includes('(OVERRIDE)'));
});

test('[B3] an overridden (non-PASS) entry\'s files are excluded from index.json\'s file->spec map, the same way a --hotfix bypass entry already is — reusing the existing mechanism, not a parallel one', () => {
  const pipeline = { ...terminalPassPipeline({ changesFiles: ['app/from-failed-run.ts'] }), 'review.json': reviewJson('NEEDS_FIXES') };
  const root = fixtureRepo({ pipeline });
  const result = runLedgerAppendWithArgs(root, ['--override-review', 'Recording a real terminal failure per B3.']);
  assert.equal(result.status, 0, result.stderr);

  const index = JSON.parse(readFileSync(join(root, '.sdd', 'ledger', 'index.json'), 'utf8'));
  assert.equal(index['app/from-failed-run.ts'], undefined, 'a run whose real verdict was not PASS must never answer "which spec governs this file" — no spec was ratified');
});

test('[B3] unlike a --hotfix entry, an overridden entry still gets spec.md/spec.json/review.json/security.json copied into the ledger — the pipeline really did run, it just did not pass', () => {
  const pipeline = { ...terminalPassPipeline(), 'review.json': reviewJson('NEEDS_FIXES') };
  const root = fixtureRepo({ pipeline });
  const result = runLedgerAppendWithArgs(root, ['--override-review', 'Recording a real terminal failure.']);
  assert.equal(result.status, 0, result.stderr);

  const runDir = join(root, '.sdd', 'ledger', RUN_ID);
  assert.ok(existsSync(join(runDir, 'spec.md')));
  assert.ok(existsSync(join(runDir, 'spec.json')));
  assert.ok(existsSync(join(runDir, 'review.json')));
  assert.ok(existsSync(join(runDir, 'security.json')));
});

test('[B3] build-ledger-index --check stays clean (no crash, no drift) after an overridden entry is written — the exclusion mechanism must not merely avoid indexing the run, it must not break regeneration for every other run either', () => {
  const pipeline = { ...terminalPassPipeline({ changesFiles: ['app/normal.ts'] }), 'review.json': reviewJson('NEEDS_FIXES') };
  const root = fixtureRepo({ pipeline });
  const result = runLedgerAppendWithArgs(root, ['--override-review', 'Recording a real terminal failure.']);
  assert.equal(result.status, 0, result.stderr);

  const check = spawnSync(process.execPath, [join(root, 'scripts', 'build-ledger-index.mjs'), '--check'], { cwd: root, encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
});

// --- PL-04 / item 1: `/re-gate` — `--re-gate --tester-ran <true|false> --ticket <id>` -------------
//
// `.sdd/pipeline.md`'s `/re-gate` step 5 named this exact command, but the flag did not exist on this
// script at all: every argv token this file didn't recognize was silently skipped (the general defect
// PL-04 / item 2 fixes — see the unknown-flag tests further below), so running the documented command
// against a PASS review.json used to write an ORDINARY ledger entry, indistinguishable from a run that
// actually passed through dev's own loop. That is precisely the laundering `/re-gate` exists to make
// impossible. These tests prove the real implementation: additive metadata on the normal path, same
// PASS/PASS precondition as any other run, never excluded from index.json's file->spec map.
//
// PL-04 review pass 2 / Critical 1: `--ticket <id>` is new — every test below that expects `--re-gate`
// to actually succeed now passes a matching `--ticket` AND a `specStamp` (via `terminalPassPipeline`),
// since main() refuses a re-gate run whose spec.json doesn't (a) match the asserted ticket or (b) carry
// a stamp at all — see `ledger-append.mjs`'s own header for the full reasoning, and the dedicated
// `[re-gate / spec integrity]` tests further below for the two refusal paths themselves.

test('[re-gate] --re-gate --tester-ran true --ticket <id> records a RE-GATE entry, still indexed by file (unlike a hotfix/override entry)', () => {
  const root = fixtureRepo({ pipeline: terminalPassPipeline({ changesFiles: ['app/hand-edited.ts'], specStamp: DUMMY_SPEC_STAMP }) });
  const result = runLedgerAppendWithArgs(root, ['--re-gate', '--tester-ran', 'true', '--ticket', 'PL-99z']);
  assert.equal(result.status, 0, result.stderr);

  const runDir = join(root, '.sdd', 'ledger', RUN_ID);
  const entry = readFileSync(join(runDir, 'entry.md'), 'utf8');
  assert.match(entry, /^# Ledger entry — .+\(RE-GATE\)/m);
  assert.ok(entry.includes('## Re-gate'));
  assert.ok(entry.includes('was re-run against the hand-edited tree on this pass'));

  const entryJson = JSON.parse(readFileSync(join(runDir, 'entry.json'), 'utf8'));
  assert.deepEqual(entryJson.regate, {
    testerRan: true,
    gatesOnly: false,
    note: 'code was changed in the working tree outside the pipeline\'s dev stage before this run; changes.md/changes.json describe the tree as it stood before that edit',
  });
  assert.equal(entryJson.bypass, false, 'a re-gate run really did pass both gates — it must not be treated as a bypass');

  const index = JSON.parse(readFileSync(join(root, '.sdd', 'ledger', 'index.json'), 'utf8'));
  const indexRecord = index['app/hand-edited.ts']?.find((e) => e.runId === RUN_ID);
  assert.ok(indexRecord, 'a re-gate entry must still answer "which spec governs this file" — the spec really was ratified');
  // PL-04 / item 3: the qualification itself must reach index.json, not only entry.json — otherwise
  // the fast query path (buggy file -> index.json -> spec) surfaces a clean-looking attribution with
  // nothing indicating the tree was hand-edited outside the pipeline before this run's gates re-ran.
  assert.deepEqual(indexRecord.regate, { testerRan: true }, 'index.json\'s own record must disclose the re-gate and whether tester ran, without requiring a second lookup into entry.json');
});

test('[re-gate] --re-gate --tester-ran false --ticket <id> (a --gates-only re-gate) records the inverse pair and states tester was skipped', () => {
  const root = fixtureRepo({ pipeline: terminalPassPipeline({ changesFiles: ['app/gates-only.ts'], specStamp: DUMMY_SPEC_STAMP }) });
  const result = runLedgerAppendWithArgs(root, ['--re-gate', '--tester-ran', 'false', '--ticket', 'PL-99z']);
  assert.equal(result.status, 0, result.stderr);

  const runDir = join(root, '.sdd', 'ledger', RUN_ID);
  const entry = readFileSync(join(runDir, 'entry.md'), 'utf8');
  assert.ok(entry.includes('was skipped on this pass (`/re-gate --gates-only`)'));

  const entryJson = JSON.parse(readFileSync(join(runDir, 'entry.json'), 'utf8'));
  assert.deepEqual(entryJson.regate, {
    testerRan: false,
    gatesOnly: true,
    note: entryJson.regate.note,
  });

  // PL-04 / item 3: testerRan: false must reach index.json exactly as written — never dropped or
  // silently flipped — so a reader can tell a fast re-gate apart from a full one without opening
  // entry.json.
  const index = JSON.parse(readFileSync(join(root, '.sdd', 'ledger', 'index.json'), 'utf8'));
  const indexRecord = index['app/gates-only.ts']?.find((e) => e.runId === RUN_ID);
  assert.deepEqual(indexRecord.regate, { testerRan: false });
});

test('[re-gate] an ordinary run (no --re-gate) has no "(RE-GATE)" title suffix, no "## Re-gate" section, and entry.json\'s "regate" is null', () => {
  const root = fixtureRepo({ pipeline: terminalPassPipeline() });
  const result = runLedgerAppend(root);
  assert.equal(result.status, 0, result.stderr);

  const runDir = join(root, '.sdd', 'ledger', RUN_ID);
  const entry = readFileSync(join(runDir, 'entry.md'), 'utf8');
  assert.ok(!entry.includes('(RE-GATE)'));
  assert.ok(!entry.includes('## Re-gate'));

  const entryJson = JSON.parse(readFileSync(join(runDir, 'entry.json'), 'utf8'));
  assert.equal(entryJson.regate, null);

  // PL-04 / item 3: an ordinary run's own index.json record(s) must carry no "regate" key at all —
  // the marker's absence is what tells a reader this attribution is unqualified.
  const index = JSON.parse(readFileSync(join(root, '.sdd', 'ledger', 'index.json'), 'utf8'));
  const indexRecord = index['app/existing.ts']?.find((e) => e.runId === RUN_ID);
  assert.ok(indexRecord, 'expected the default changes.json file to be indexed');
  assert.ok(!('regate' in indexRecord), 'an ordinary run\'s index record must not carry a regate key');
});

test('[re-gate] --re-gate without --tester-ran fails closed and writes nothing', () => {
  const root = fixtureRepo({ pipeline: terminalPassPipeline() });
  const result = runLedgerAppendWithArgs(root, ['--re-gate']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--re-gate requires --tester-ran/);
  assert.ok(!existsSync(join(root, '.sdd', 'ledger', RUN_ID)));
});

test('[re-gate] --tester-ran without --re-gate fails closed, naming the pairing requirement', () => {
  const root = fixtureRepo({ pipeline: terminalPassPipeline() });
  const result = runLedgerAppendWithArgs(root, ['--tester-ran', 'true']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--tester-ran was given without --re-gate/);
  assert.ok(!existsSync(join(root, '.sdd', 'ledger', RUN_ID)));
});

test('[re-gate] --tester-ran with a value other than exactly "true"/"false" fails closed rather than guessing', () => {
  const root = fixtureRepo({ pipeline: terminalPassPipeline() });
  const result = runLedgerAppendWithArgs(root, ['--re-gate', '--tester-ran', 'yes']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--tester-ran requires exactly "true" or "false"/);
  assert.ok(!existsSync(join(root, '.sdd', 'ledger', RUN_ID)));
});

test('[re-gate] --re-gate without --ticket fails closed and writes nothing', () => {
  const root = fixtureRepo({ pipeline: terminalPassPipeline({ specStamp: DUMMY_SPEC_STAMP }) });
  const result = runLedgerAppendWithArgs(root, ['--re-gate', '--tester-ran', 'true']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--re-gate requires --ticket/);
  assert.ok(!existsSync(join(root, '.sdd', 'ledger', RUN_ID)));
});

test('[re-gate] --ticket without --re-gate fails closed, naming the pairing requirement', () => {
  const root = fixtureRepo({ pipeline: terminalPassPipeline() });
  const result = runLedgerAppendWithArgs(root, ['--ticket', 'PL-99z']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--ticket was given without --re-gate/);
  assert.ok(!existsSync(join(root, '.sdd', 'ledger', RUN_ID)));
});

test('[re-gate] --ticket with no value (or a flag-shaped one) fails closed rather than guessing', () => {
  const root = fixtureRepo({ pipeline: terminalPassPipeline({ specStamp: DUMMY_SPEC_STAMP }) });
  const result = runLedgerAppendWithArgs(root, ['--re-gate', '--tester-ran', 'true', '--ticket']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--ticket requires a non-empty ticket id/);
  assert.ok(!existsSync(join(root, '.sdd', 'ledger', RUN_ID)));
});

// --- PL-04 review pass 2 / Critical 1 (widened by review pass 3 / Warning 2): `/re-gate`'s ledger ---
// step must not attribute a run to a spec that isn't its own. `/re-gate` is the one entry point that
// reaches the ledger without ever running planner, so nothing else guarantees `.pipeline/spec.json` (or
// `spec.md`) on disk describes the run being gated — concretely reproduced this round: PL-03h's leftover
// spec.json was still on disk during a PL-04 re-gate, and a stamp-freshness check alone would not have
// caught it (it predates the stamp contract entirely and reads "unknown", not "stale"). Three
// independent checks below, matching main()'s own three refusal paths (--ticket vs. spec.json's ticket;
// --ticket vs. spec.md's own first-heading ticket, added by review pass 3 once it found a matching
// spec.json could still sit beside a leftover spec.md; and spec.json's stamp presence).

test('[re-gate / spec integrity] --ticket that does not match spec.json\'s own ticket fails closed, naming both, before writing anything', () => {
  const root = fixtureRepo({ pipeline: terminalPassPipeline({ specStamp: DUMMY_SPEC_STAMP }) }); // spec.json's own ticket is PL-99z
  const result = runLedgerAppendWithArgs(root, ['--re-gate', '--tester-ran', 'true', '--ticket', 'PL-05']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--re-gate --ticket "PL-05" does not match \.pipeline\/spec\.json's own ticket \("PL-99z"/);
  assert.ok(!existsSync(join(root, '.sdd', 'ledger', RUN_ID)), 'must not attribute this run\'s files to a spec that says it isn\'t about them');
});

test('[re-gate / spec integrity] a matching --ticket against an UNSTAMPED spec.json still fails closed — presence of a stamp is its own, separate precondition', () => {
  // Deliberately no specStamp: this is exactly the PL-03h-leftover shape the round found on disk.
  const root = fixtureRepo({ pipeline: terminalPassPipeline() });
  const result = runLedgerAppendWithArgs(root, ['--re-gate', '--tester-ran', 'true', '--ticket', 'PL-99z']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires \.pipeline\/spec\.json to carry a "stamp" field/);
  assert.ok(!existsSync(join(root, '.sdd', 'ledger', RUN_ID)));
});

test('[re-gate / spec integrity] a matching --ticket against a STAMPED spec.json succeeds — the two checks compose, neither alone is enough', () => {
  const root = fixtureRepo({ pipeline: terminalPassPipeline({ changesFiles: ['app/verified.ts'], specStamp: DUMMY_SPEC_STAMP }) });
  const result = runLedgerAppendWithArgs(root, ['--re-gate', '--tester-ran', 'true', '--ticket', 'PL-99z']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(root, '.sdd', 'ledger', RUN_ID)));

  const entryJson = JSON.parse(readFileSync(join(root, '.sdd', 'ledger', RUN_ID, 'entry.json'), 'utf8'));
  assert.equal(entryJson.ticket, 'PL-99z', 'a regression writing the WRONG ticket into an otherwise-successful entry must fail this test, not just "status === 0"');
  assert.match(entryJson.ticketTitle, /^PL-99z —/);
});

test('[re-gate / spec integrity] a matching, stamped spec.json still fails closed when spec.md\'s own first-heading ticket disagrees — spec.md, not spec.json, is what gets copied verbatim into the ledger and what index.json\'s "spec" pointer resolves to', () => {
  // spec.json says PL-99z (and is stamped, and matches --ticket below); spec.md is left over from a
  // different ticket entirely — the exact "half-done" shape review pass 3 found: every JSON-facing
  // field would agree on PL-99z while the spec body itself is PL-03h's. SEC-10 v2 fix round: the
  // check that now fires first here is the UNCONDITIONAL spec.json/spec.md agreement check (it runs
  // before the --re-gate-specific --ticket cross-check reaches spec.md at all, and would fire
  // identically with --re-gate omitted entirely — see the "[plain path / spec integrity]" tests
  // below for that same fixture run without --re-gate) — no longer the --re-gate-specific
  // `specMdTicketId !== regate.ticket` check, which this fix removed as unreachable dead code once
  // the agreement check already holds whenever spec.json matches --ticket (see ledger-append.mjs's
  // own comment on this exact point).
  const pipeline = { ...terminalPassPipeline({ changesFiles: ['app/verified.ts'], specStamp: DUMMY_SPEC_STAMP }), 'spec.md': specMarkdown('PL-03h') };
  const root = fixtureRepo({ pipeline });
  const result = runLedgerAppendWithArgs(root, ['--re-gate', '--tester-ran', 'true', '--ticket', 'PL-99z']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /\.pipeline\/spec\.json's ticket \("PL-99z".*does not agree with \.pipeline\/spec\.md's own first-heading ticket \("PL-03h"\)/);
  assert.ok(!existsSync(join(root, '.sdd', 'ledger', RUN_ID)), 'must not file a spec.md from a different ticket under a right-looking ticket name');
});

// --- SEC-10 v2 (security round) / FND-bd78355b6ae7: the agreement check is now unconditional ---------
//
// Security's own reproduction: .pipeline/spec.json naming one ticket beside .pipeline/spec.md headed
// with a different one, both review.json/security.json genuinely PASS and stamped fresh, run through
// the PLAIN command (no --re-gate, no --ticket, no --override-*) — until this fix, exit 0, entry.json
// reading as an entirely ordinary, clean-pass entry, with .sdd/ledger/<runId>/spec.md silently carrying
// the WRONG ticket's body under the right-looking ticket name in index.json. These tests reproduce that
// exact scenario end to end against the current script and confirm it now refuses.

test('[plain path / spec integrity] spec.json/spec.md ticket mismatch fails closed even with NO --re-gate flag at all — this is the exact scenario security reproduced (FND-bd78355b6ae7)', () => {
  // spec.json names "PL-04"; spec.md is headed "# PL-03h" — the exact leftover shape this fix round's
  // own real .pipeline/ carried. No --re-gate, no --ticket: the plain, documented happy-path command.
  const pipeline = { ...terminalPassPipeline({ ticket: 'PL-04', changesFiles: ['app/verified.ts'] }), 'spec.md': specMarkdown('PL-03h') };
  const root = fixtureRepo({ pipeline });
  const result = runLedgerAppendWithArgs(root, []);
  assert.notEqual(result.status, 0, 'the plain path must refuse, not silently file PL-03h\'s spec body under PL-04\'s ticket name');
  assert.match(result.stderr, /\.pipeline\/spec\.json's ticket \("PL-04".*does not agree with \.pipeline\/spec\.md's own first-heading ticket \("PL-03h"\)/);
  assert.ok(!existsSync(join(root, '.sdd', 'ledger', RUN_ID)), 'must not write any ledger entry for a mismatched spec.json/spec.md pair');
});

test('[plain path / spec integrity] a plain run whose spec.json and spec.md genuinely agree still succeeds — the new check adds no friction to an ordinary clean pass', () => {
  const pipeline = terminalPassPipeline({ ticket: 'PL-06', changesFiles: ['app/verified.ts'] });
  const root = fixtureRepo({ pipeline });
  const result = runLedgerAppendWithArgs(root, []);
  assert.equal(result.status, 0, result.stderr);
  const entryJson = JSON.parse(readFileSync(join(root, '.sdd', 'ledger', RUN_ID, 'entry.json'), 'utf8'));
  assert.equal(entryJson.ticket, 'PL-06');
});

test('[re-gate] --re-gate still requires review.json/security.json to both show PASS — it is a disclosure, not a bypass of the normal gate', () => {
  // No specStamp needed: main() checks review.json/security.json's PASS/PASS verdict before it ever
  // reads spec.json, so this must fail on the verdict, not on spec integrity — proving the two checks
  // are ordered as documented, not merely both present.
  const pipeline = { ...terminalPassPipeline(), 'review.json': reviewJson('NEEDS_FIXES') };
  const root = fixtureRepo({ pipeline });
  const result = runLedgerAppendWithArgs(root, ['--re-gate', '--tester-ran', 'true', '--ticket', 'PL-99z']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /NEEDS_FIXES/);
  assert.ok(!existsSync(join(root, '.sdd', 'ledger', RUN_ID)));
});

test('[re-gate] --re-gate composes with --override-review: a re-gated run that still didn\'t fully resolve a finding can layer a reasoned override on top, and is then excluded from the index like any other override', () => {
  const pipeline = { ...terminalPassPipeline({ changesFiles: ['app/still-broken.ts'], specStamp: DUMMY_SPEC_STAMP }), 'review.json': reviewJson('NEEDS_FIXES') };
  const root = fixtureRepo({ pipeline });
  const result = runLedgerAppendWithArgs(root, [
    '--re-gate', '--tester-ran', 'true', '--ticket', 'PL-99z',
    '--override-review', 'Re-gated, tester ran clean, but review still flags a style nit accepted on purpose.',
  ]);
  assert.equal(result.status, 0, result.stderr);

  const entryJson = JSON.parse(readFileSync(join(root, '.sdd', 'ledger', RUN_ID, 'entry.json'), 'utf8'));
  assert.equal(entryJson.bypass, true, 'the override, not the re-gate, is what drives bypass here');
  assert.deepEqual(entryJson.regate, { testerRan: true, gatesOnly: false, note: entryJson.regate.note });
  assert.equal(entryJson.overrides.length, 1);

  const index = JSON.parse(readFileSync(join(root, '.sdd', 'ledger', 'index.json'), 'utf8'));
  assert.equal(index['app/still-broken.ts'], undefined, 'an override still excludes the run from the index, regardless of the re-gate disclosure alongside it');

  // [finding 3]: both markers compose on the title line, in the same order the body sections
  // ("## Re-gate" then "## Overrides") already use.
  const entry = readFileSync(join(root, '.sdd', 'ledger', RUN_ID, 'entry.md'), 'utf8');
  assert.match(entry, /^# Ledger entry — .+\(RE-GATE\) \(OVERRIDE\)/m);
});

// --- PL-04 / item 2 (the general defect): an unrecognized flag must fail loudly, naming itself, ----
// never be silently skipped. This is the concrete failure item 1 above found: before --re-gate
// existed, `--re-gate --tester-ran true` matched nothing this file's argv-scanning code looked for
// and was silently ignored, falling through to the ordinary path — indistinguishable from a clean run.

test('[unknown-flag] a typo\'d/unsupported flag on the normal (non-hotfix) path fails loudly, naming itself, and writes nothing', () => {
  const root = fixtureRepo({ pipeline: terminalPassPipeline() });
  const result = runLedgerAppendWithArgs(root, ['--re-gaet', '--tester-ran', 'true']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unrecognized argument "--re-gaet"/);
  assert.ok(!existsSync(join(root, '.sdd', 'ledger', RUN_ID)), 'a typo must never look like it worked');
});

test('[unknown-flag] an unrecognized flag on the --hotfix path fails loudly, naming itself, and writes nothing', () => {
  const root = hotfixFixtureRepo();
  const result = runLedgerAppendHotfix(root, [...HOTFIX_ARGS, '--files', 'app/x.ts', '--not-a-real-flag']);
  // --files consumes every remaining token (documented, pre-existing convention), so an unrecognized
  // flag placed AFTER --files is just another file path, not a validation target — this proves the
  // unknown-flag check runs BEFORE --files starts consuming, not that it can catch something after it.
  assert.equal(result.status, 0, result.stderr);

  const badFlagBefore = runLedgerAppendHotfix(root, ['--not-a-real-flag', ...HOTFIX_ARGS]);
  assert.notEqual(badFlagBefore.status, 0);
  assert.match(badFlagBefore.stderr, /unrecognized argument "--not-a-real-flag"/);
});

// --- D-005 #3 / `/hotfix`: the sanctioned bypass entry -------------------------------------------
//
// .sdd/hotfix.md's "non-negotiable" requirements: a ledger entry recording what broke, what
// changed, why the pipeline was skipped, and what was not verified; a follow-up ticket; and the
// entry marked as a bypass, never confusable with a run that passed both gates. This section proves
// the mechanical half of all three, plus the specific property .sdd/hotfix.md and
// .sdd/ledger/README.md both call out by name: a hotfix entry must never satisfy a query asking
// which spec governs a file, because no spec does.

test('--hotfix requires none of the normal .pipeline/ artifacts and writes only entry.md/entry.json', () => {
  const root = hotfixFixtureRepo();
  mkdirSync(join(root, 'app'), { recursive: true });
  writeFileSync(join(root, 'app', 'hotfixed.ts'), 'export const patched = true;\n', 'utf8');

  const result = runLedgerAppendHotfix(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /bypass entry/);

  // Find the one run directory --hotfix created (its id is generated fresh each run, unlike the
  // fixed RUN_ID the terminal-PASS tests use).
  const ledgerDir = join(root, '.sdd', 'ledger');
  const runIds = readdirSync(ledgerDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  assert.equal(runIds.length, 1, 'expected exactly one run directory to be written');
  const runDir = join(ledgerDir, runIds[0]);

  assert.ok(existsSync(join(runDir, 'entry.md')));
  assert.ok(existsSync(join(runDir, 'entry.json')));
  assert.ok(!existsSync(join(runDir, 'spec.md')), 'a hotfix entry must never have a spec.md — there is no spec');
  assert.ok(!existsSync(join(runDir, 'spec.json')));
  assert.ok(!existsSync(join(runDir, 'security')), 'a hotfix entry must never have a security/ copy — no security run occurred');

  const entryJson = JSON.parse(readFileSync(join(runDir, 'entry.json'), 'utf8'));
  assert.equal(entryJson.bypass, true);
  assert.equal(entryJson.whatBroke, HOTFIX_ARGS[1]);
  assert.equal(entryJson.whatChanged, HOTFIX_ARGS[3]);
  assert.equal(entryJson.whyPipelineSkipped, HOTFIX_ARGS[5]);
  assert.equal(entryJson.notVerified, HOTFIX_ARGS[7]);
  assert.equal(entryJson.followUpTicket, HOTFIX_ARGS[9]);
  assert.equal(entryJson.ticket, HOTFIX_ARGS[9], 'the generic "ticket" field should carry the follow-up ticket reference for a hotfix');
  assert.ok(entryJson.filesTouched.includes('app/hotfixed.ts'));
  assert.equal(entryJson.verdicts, undefined, 'a hotfix entry must not claim a verdicts object it never earned');

  const entry = readFileSync(join(runDir, 'entry.md'), 'utf8');
  assert.match(entry, /HOTFIX BYPASS/);
  assert.match(entry, /## Bypass/);
  assert.ok(!entry.includes('review: PASS') && !entry.includes('security: PASS'), 'a hotfix entry.md must never resemble a passed run');
  for (const text of [HOTFIX_ARGS[1], HOTFIX_ARGS[3], HOTFIX_ARGS[5], HOTFIX_ARGS[7], HOTFIX_ARGS[9]]) {
    assert.ok(entry.includes(text), `entry.md must include the disclosed text: ${text}`);
  }
});

test('--hotfix fails closed and writes nothing when a required field is missing, naming which flag', () => {
  const root = hotfixFixtureRepo();
  // Drop exactly the --follow-up-ticket/value pair, by flag name rather than position — HOTFIX_ARGS
  // now also carries a trailing --lane full (GAP-01), so a positional slice from the end would drop
  // the wrong pair.
  const ticketFlagIndex = HOTFIX_ARGS.indexOf('--follow-up-ticket');
  const incomplete = [...HOTFIX_ARGS.slice(0, ticketFlagIndex), ...HOTFIX_ARGS.slice(ticketFlagIndex + 2)];
  const result = runLedgerAppendHotfix(root, incomplete);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--follow-up-ticket/);
  const ledgerDir = join(root, '.sdd', 'ledger');
  const runIds = existsSync(ledgerDir) ? readdirSync(ledgerDir, { withFileTypes: true }).filter((e) => e.isDirectory()) : [];
  assert.equal(runIds.length, 0, 'must write no run directory when a required field is missing');
});

test('--hotfix fails closed when a required field is present but empty', () => {
  const root = hotfixFixtureRepo();
  const args = HOTFIX_ARGS.map((value) => (value === HOTFIX_ARGS[1] ? '   ' : value));
  const result = runLedgerAppendHotfix(root, args);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--what-broke/);
});

// --- GAP-01 (security round 6): the two mechanically-checkable eligibility gates from .sdd/hotfix.md
// are now enforced — "who may use it" (an unfenced "full" lane) and the "Honest limits" barred-path
// list (org_id/RBAC/secrets/webhook/Graph Query Service). "Is production actually broken" and "is
// rollback better" remain human judgment, documented in .sdd/hotfix.md and not asserted here — there
// is nothing on disk those two gates could be mechanically checked against.

function hotfixArgsWithLane(lane) {
  const laneFlagIndex = HOTFIX_ARGS.indexOf('--lane');
  return [...HOTFIX_ARGS.slice(0, laneFlagIndex), '--lane', lane];
}

function hotfixArgsWithoutLane() {
  const laneFlagIndex = HOTFIX_ARGS.indexOf('--lane');
  return HOTFIX_ARGS.slice(0, laneFlagIndex);
}

// PL-04 / C2: table-driven — each row refuses --hotfix on a different lane-eligibility violation.
// `checkLedgerAbsent` matches exactly what each original standalone test asserted (the "unknown lane"
// case never checked this; the other two did).
const HOTFIX_LANE_REFUSAL_CASES = [
  { name: '--hotfix requires --lane, and writes nothing without it', args: () => hotfixArgsWithoutLane(), setup: null, stderrPattern: /--lane/, checkLedgerAbsent: true },
  { name: '--hotfix refuses an unknown lane name, rather than silently granting eligibility', args: () => hotfixArgsWithLane('nonexistent-lane'), setup: null, stderrPattern: /unknown lane/, checkLedgerAbsent: false },
  {
    name: '--hotfix refuses a fenced lane — .sdd/hotfix.md\'s "who may use it" gate',
    args: () => hotfixArgsWithLane('frontend'),
    setup: (root) => {
      mkdirSync(join(root, 'apps', 'web'), { recursive: true });
      writeFileSync(join(root, 'apps', 'web', 'page.tsx'), 'export default function Page() { return null; }\n', 'utf8');
    },
    stderrPattern: /not available to a fenced lane/,
    checkLedgerAbsent: true,
  },
];

test('[GAP-01] refuses --hotfix for every lane-eligibility violation in HOTFIX_LANE_REFUSAL_CASES', () => {
  for (const { name, args, setup, stderrPattern, checkLedgerAbsent } of HOTFIX_LANE_REFUSAL_CASES) {
    const root = hotfixFixtureRepo();
    if (setup) setup(root);
    const result = runLedgerAppendHotfix(root, args());
    assert.notEqual(result.status, 0, name);
    assert.match(result.stderr, stderrPattern, name);
    if (checkLedgerAbsent) {
      const ledgerDir = join(root, '.sdd', 'ledger');
      const runIds = existsSync(ledgerDir) ? readdirSync(ledgerDir, { withFileTypes: true }).filter((e) => e.isDirectory()) : [];
      assert.equal(runIds.length, 0, `${name}: must write no run directory`);
    }
  }
});

test('[GAP-01] --hotfix on the unfenced "full" lane still succeeds — the lane gate does not block the legitimate case', () => {
  const root = hotfixFixtureRepo();
  const result = runLedgerAppendHotfix(root, [...HOTFIX_ARGS, '--files', 'app/legit-hotfix.ts']);
  assert.equal(result.status, 0, result.stderr);
});

test('[GAP-01] --hotfix refuses when a touched file matches .sdd/bounds.yml\'s hotfix_barred_paths list — .sdd/hotfix.md\'s "Honest limits" gate (org_id/RBAC/secrets/webhook/Graph Query Service)', () => {
  const root = hotfixFixtureRepo();
  const args = [...HOTFIX_ARGS, '--files', 'services/core/src/security/graphOrgGuard.ts'];
  const result = runLedgerAppendHotfix(root, args);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Honest limits/);
  assert.match(result.stderr, /services\/core\/src\/security\/graphOrgGuard\.ts/);
  const ledgerDir = join(root, '.sdd', 'ledger');
  const runIds = existsSync(ledgerDir) ? readdirSync(ledgerDir, { withFileTypes: true }).filter((e) => e.isDirectory()) : [];
  assert.equal(runIds.length, 0, 'must write no run directory when a barred path is touched');
});

test('[GAP-01] --hotfix refuses when a barred path is detected via the live git diff, not only via explicit --files', () => {
  const root = hotfixFixtureRepo();
  mkdirSync(join(root, 'services', 'core', 'src', 'webhooks'), { recursive: true });
  writeFileSync(join(root, 'services', 'core', 'src', 'webhooks', 'githubSignature.ts'), '// hotfix attempt\n', 'utf8');
  const result = runLedgerAppendHotfix(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Honest limits/);
  assert.match(result.stderr, /services\/core\/src\/webhooks\/githubSignature\.ts/);
});

test('a hotfix entry\'s files are excluded from index.json\'s file->spec map entirely — the core safety property', () => {
  const root = hotfixFixtureRepo();
  mkdirSync(join(root, 'app'), { recursive: true });
  writeFileSync(join(root, 'app', 'hotfixed.ts'), 'export const patched = true;\n', 'utf8');

  const result = runLedgerAppendHotfix(root);
  assert.equal(result.status, 0, result.stderr);

  const index = JSON.parse(readFileSync(join(root, '.sdd', 'ledger', 'index.json'), 'utf8'));
  assert.equal(index['app/hotfixed.ts'], undefined, 'a file touched only by a hotfix must not appear in index.json at all');
});

test('a hotfix entry coexists with a normal terminal-PASS entry: both are written, only the normal one is indexed by file', () => {
  const root = fixtureRepo({ pipeline: terminalPassPipeline({ changesFiles: ['app/normal-run.ts'] }) });
  const normalResult = runLedgerAppend(root);
  assert.equal(normalResult.status, 0, normalResult.stderr);

  mkdirSync(join(root, 'app'), { recursive: true });
  writeFileSync(join(root, 'app', 'hotfixed.ts'), 'export const patched = true;\n', 'utf8');
  const hotfixResult = runLedgerAppendHotfix(root);
  assert.equal(hotfixResult.status, 0, hotfixResult.stderr);

  const index = JSON.parse(readFileSync(join(root, '.sdd', 'ledger', 'index.json'), 'utf8'));
  assert.ok(index['app/normal-run.ts']?.some((e) => e.runId === RUN_ID), 'the normal run must still be indexed');
  assert.equal(index['app/hotfixed.ts'], undefined, 'the hotfix must not be indexed');

  const ledgerDir = join(root, '.sdd', 'ledger');
  const runDirs = readdirSync(ledgerDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  assert.equal(runDirs.length, 2, 'both the normal run and the hotfix must have their own directory on disk');
});

test('refuses to overwrite an existing hotfix run directory (defensive — ids are randomized, but the guard exists)', () => {
  const root = hotfixFixtureRepo();
  // An uncommitted file, so this run's own files-touched detection has something to find under the
  // W1 fail-loud fix below (a clean tree with no --files now fails loudly, which is not what this
  // test exists to check — see the "fails loudly" test for that).
  mkdirSync(join(root, 'app'), { recursive: true });
  writeFileSync(join(root, 'app', 'collision-test.ts'), 'export const x = 1;\n', 'utf8');
  const runId = generateHotfixRunId({ cwd: root });
  // Pre-seed a COMPLETE, valid (if unrelated) prior hotfix entry at the guessed id — a partial one
  // (e.g. entry.md with no entry.json) would make the *next* run's own writeIndex() call fail
  // closed on this stray, malformed directory, which is a real and correct guarantee elsewhere
  // (readEntryJson fails closed on anything malformed) but is not what this test exists to check.
  const priorEntryJson = buildHotfixEntryJson({
    runId, date: '2026-08-01', whatBroke: 'PRIOR', whatChanged: 'PRIOR', whyPipelineSkipped: 'PRIOR',
    notVerified: 'PRIOR', followUpTicket: 'PRIOR-TICKET', files: [], commit: { sha: 'a'.repeat(40), dirty: false },
  });
  mkdirSync(join(root, '.sdd', 'ledger', runId), { recursive: true });
  writeFileSync(join(root, '.sdd', 'ledger', runId, 'entry.md'), 'PRE-EXISTING\n', 'utf8');
  writeFileSync(join(root, '.sdd', 'ledger', runId, 'entry.json'), JSON.stringify(priorEntryJson, null, 2) + '\n', 'utf8');

  // Can't force the CLI to reuse this exact id (it's randomized per invocation), so this test
  // exercises the guard's existence via a second, real invocation instead — a collision is
  // astronomically unlikely, so this just proves a normal run still succeeds and does not touch the
  // pre-seeded directory, which remains as a general "an existing directory is never silently
  // reused" regression guard rather than a true collision test.
  const result = runLedgerAppendHotfix(root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(root, '.sdd', 'ledger', runId, 'entry.md'), 'utf8'), 'PRE-EXISTING\n');
});

// --- W1 (review): a hotfix run must never silently record an empty file list -------------------
//
// The realistic incident flow commits the fix *before* running --hotfix, leaving the working tree
// clean (no git diff, no untracked files) and no changes.json to fall back on — filesTouched(null)
// then returns [] and the old code silently wrote "(none could be determined automatically)." Fixed:
// fail loudly, naming --files, unless the caller explicitly supplies one.

test('[W1] --hotfix fails loudly, and writes nothing, when the working tree is already clean and no --files was supplied — the realistic "fix already committed" incident flow', () => {
  const root = hotfixFixtureRepo(); // fixtureRepo() commits everything — the tree starts clean
  const result = runLedgerAppendHotfix(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--files/);
  const ledgerDir = join(root, '.sdd', 'ledger');
  const runIds = existsSync(ledgerDir) ? readdirSync(ledgerDir, { withFileTypes: true }).filter((e) => e.isDirectory()) : [];
  assert.equal(runIds.length, 0, 'must write no run directory when no files-touched data could be determined at all');
});

test('[W1] --hotfix records an explicit --files list even when the working tree is already clean', () => {
  const root = hotfixFixtureRepo();
  const args = [...HOTFIX_ARGS, '--files', 'app/already-committed-fix.ts', 'infra/config.yml'];
  const result = runLedgerAppendHotfix(root, args);
  assert.equal(result.status, 0, result.stderr);

  const ledgerDir = join(root, '.sdd', 'ledger');
  const runIds = readdirSync(ledgerDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  assert.equal(runIds.length, 1);
  const entryJson = JSON.parse(readFileSync(join(ledgerDir, runIds[0], 'entry.json'), 'utf8'));
  assert.deepEqual(entryJson.filesTouched, ['app/already-committed-fix.ts', 'infra/config.yml']);
});

test('generateHotfixRunId produces a sortable, HOTFIX-tagged, collision-resistant id', () => {
  const a = generateHotfixRunId({ cwd: repoRoot });
  const b = generateHotfixRunId({ cwd: repoRoot });
  assert.match(a, /^\d{8}T\d{9}Z-[0-9a-f]{12}-HOTFIX-[0-9a-f]{6}$/);
  assert.notEqual(a, b, 'two calls must not collide');
});

test('buildHotfixEntryMarkdown and buildHotfixEntryJson thread their arguments through, not a hardcoded literal', () => {
  const markdown = buildHotfixEntryMarkdown({
    runId: 'sample-hotfix-run',
    date: '2026-08-04',
    whatBroke: 'SAMPLE_WHAT_BROKE',
    whatChanged: 'SAMPLE_WHAT_CHANGED',
    whyPipelineSkipped: 'SAMPLE_WHY_SKIPPED',
    notVerified: 'SAMPLE_NOT_VERIFIED',
    followUpTicket: 'SAMPLE_FOLLOWUP',
    files: ['app/a.ts'],
    commitLine: 'deadbeef',
  });
  for (const text of ['SAMPLE_WHAT_BROKE', 'SAMPLE_WHAT_CHANGED', 'SAMPLE_WHY_SKIPPED', 'SAMPLE_NOT_VERIFIED', 'SAMPLE_FOLLOWUP', 'app/a.ts', 'deadbeef']) {
    assert.ok(markdown.includes(text), `expected buildHotfixEntryMarkdown output to include ${text}`);
  }

  const entry = buildHotfixEntryJson({
    runId: 'sample-hotfix-run',
    date: '2026-08-04',
    whatBroke: 'SAMPLE_WHAT_BROKE',
    whatChanged: 'SAMPLE_WHAT_CHANGED',
    whyPipelineSkipped: 'SAMPLE_WHY_SKIPPED',
    notVerified: 'SAMPLE_NOT_VERIFIED',
    followUpTicket: 'SAMPLE_FOLLOWUP',
    files: ['app/a.ts'],
    commit: { sha: 'deadbeef', dirty: false },
  });
  assert.equal(entry.bypass, true);
  assert.equal(entry.ticket, 'SAMPLE_FOLLOWUP');
  assert.deepEqual(entry.filesTouched, ['app/a.ts']);
  assert.equal(entry.verdicts, undefined);
});

// =================================================================================================
// [lite] PL-11 — `node scripts/ledger-append.mjs --lite`, the ledger step of the /pipeline-lite lane
// =================================================================================================
//
// Authored by the `red` stage from .pipeline/spec.md alone, before the `--lite` branch exists. The
// lane runs planner -> dev -> tester -> review -> ledger and deliberately skips `red` and `security`;
// this is the step that has to make that skip permanently legible rather than merely absent. Two
// properties carry most of the weight here, and both are asserted below rather than assumed:
//
//  1. A lite entry is INDEXED (bypass: false) — it has a real, ratified spec that `review` really did
//     pass against the final tree — while still carrying, in the entry itself and in index.json's own
//     record, the qualification that no `red` suite preceded the diff and no security pass happened
//     at all. That is the same trade .sdd/ledger/README.md already documents for a `--re-gate` entry.
//  2. Every precondition is checked BEFORE anything is written. A refusal that leaves a partial run
//     directory behind is a corrupt ledger, not a refusal.
//
// `--lite` is a branch inside main(), not a parallel runLite(): it shares review.json's verdict gate,
// the unconditional spec.json/spec.md agreement check, filesTouched, and the run-directory overwrite
// guard. The tests below deliberately re-assert several of those shared checks ON the lite path
// (EC-14, EC-18) precisely because "shared" is a claim about the implementation that only a test
// exercising the new branch can actually hold to.

/** tester still runs on this lane, so test-results.md is a required input — this is a stand-in for
 * whatever that stage really writes; --lite only checks that it exists. */
const LITE_TEST_RESULTS_MD = '# Test results — lite lane fixture\n\n' +
  '## Red suite result\n\nNo red suite exists for this run: the lite lane skips `red`.\n';

/** The lite lane's .pipeline/ inputs: spec.md + a STAMPED spec.json that agrees with it, a PASS
 * review.json, test-results.md — and, deliberately, NO security.json and NO red.json (neither stage
 * ran). Individual tests add one of those back to exercise EC-9/EC-10/EC-11.
 *
 * @param {{ ticket?: string, specStamp?: object | null, includeTestResults?: boolean,
 *   includeChanges?: boolean, changesFiles?: string[], extra?: Record<string, string | object> }} [options]
 * @returns {Record<string, string | object>} keyed by path relative to `.pipeline/` */
function litePipeline({ ticket = 'PL-99z', specStamp = DUMMY_SPEC_STAMP, includeTestResults = true, includeChanges = true, changesFiles, extra = {} } = {}) {
  /** @type {Record<string, string | object>} */
  const pipeline = {
    'spec.md': specMarkdown(ticket),
    'spec.json': specStamp ? { ...specJson(ticket), stamp: specStamp } : specJson(ticket),
    'review.md': reviewMarkdownPlaceholder('PASS'),
    'review.json': reviewJson('PASS'),
  };
  if (includeTestResults) pipeline['test-results.md'] = LITE_TEST_RESULTS_MD;
  if (includeChanges) pipeline['changes.json'] = changesJson(changesFiles);
  return { ...pipeline, ...extra };
}

/** Strips a `lite_eligibility:` block out of the real .sdd/bounds.yml — the EC-16 fixture. Written
 * as a removal from the real file rather than as a synthetic bounds.yml so this stays a test of "the
 * block is missing," not of "some other bounds file parses differently." */
function boundsYmlWithoutLiteBlock() {
  // \r?\n, not a literal \n: the real .sdd/bounds.yml is CRLF in this working tree (same fact
  // scripts/sdd-completeness.test.mjs's own header documents for every .sdd/** doc) — a literal `\n`
  // never matches immediately after "lite_eligibility:" when a `\r` sits between it and the newline,
  // which silently left this fixture a no-op (the block was never actually removed) before this fix.
  const stripped = boundsYmlSource.replace(/^lite_eligibility:\r?\n(?:[ \t]*(?:#.*)?\r?\n|[ \t]+\S.*\r?\n)*/m, '');
  assert.ok(
    !/^lite_eligibility:/m.test(stripped),
    'this fixture failed to remove the lite_eligibility block from the real .sdd/bounds.yml — fix the fixture rather than the assertion it feeds, or the EC-16 test below silently stops testing anything',
  );
  return stripped;
}

/** Like fixtureRepo(), but lets a test replace .sdd/bounds.yml BEFORE the initial commit. Doing it
 * afterwards would leave bounds.yml modified in the working tree — a `.sdd/**` path in the barred
 * union — so the run would refuse for EC-19's reason instead of the one under test.
 *
 * @param {{ pipeline?: Record<string, string | object>, bounds?: string | null }} [options] */
function liteFixtureRepo({ pipeline = litePipeline(), bounds = null } = {}) {
  const root = fixtureRepo({ pipeline, git: false });
  if (bounds !== null) writeFileSync(join(root, '.sdd', 'bounds.yml'), bounds, 'utf8');
  initGit(root);
  commitAll(root, 'initial lite fixture state');
  return root;
}

function runLite(root, args = []) {
  return runLedgerAppendWithArgs(root, ['--lite', ...args]);
}

/** An uncommitted, unbarred, comfortably-small change for the lite run to measure. */
function smallUncommittedChange(root, relPath = 'app/lite-change.ts', lines = 3) {
  const dest = join(root, relPath);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, `export const lite = ${lines};\n`.repeat(lines), 'utf8');
  return relPath;
}

function ledgerRunIds(root) {
  const ledgerDir = join(root, '.sdd', 'ledger');
  return existsSync(ledgerDir)
    ? readdirSync(ledgerDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    : [];
}

function theOneLiteRunDir(root) {
  const runIds = ledgerRunIds(root);
  assert.equal(runIds.length, 1, `expected exactly one ledger run directory, got: ${runIds.join(', ') || '(none)'}`);
  assert.match(runIds[0], /-LITE-/, 'a lite run id must be visibly tagged LITE in the id itself, the way HOTFIX already is');
  return join(root, '.sdd', 'ledger', runIds[0]);
}

function assertNothingWritten(root, why) {
  assert.deepEqual(ledgerRunIds(root), [], `${why}: a refusal must leave no run directory at all, not even a partial one`);
}

/** Asserts a refusal that could ONLY have come from the case under test.
 *
 * Load-bearing, and found the hard way while authoring this suite: before `--lite` exists at all,
 * main()'s existing `assertKnownFlags` already refuses `--lite` as an unrecognized flag — non-zero
 * exit, nothing written — so a bare "exited non-zero and wrote no run directory" pair PASSES today,
 * for a reason with nothing to do with the precondition it claims to check. That is a false green in
 * exactly the direction this ticket is about: a gate that reads as working while checking nothing.
 * Requiring `--lite` to be a RECOGNIZED flag is what keeps each refusal test tied to its own case. */
function assertLiteRefusal(result, root, why) {
  assert.notEqual(result.status, 0, why);
  assert.doesNotMatch(
    result.stderr,
    /unrecognized argument "--lite"/,
    `${why}: --lite must itself be a recognized flag — a refusal that happened only because the flag does not exist is not the refusal this case is about`,
  );
  assertNothingWritten(root, why);
}

/** A complete, valid, unrelated prior ledger entry — used to distinguish "an existing directory is
 * never overwritten" (EC-18) from "a partial directory breaks index regeneration", which is a
 * different, already-covered guarantee. */
function seedPriorEntry(root, runId, files = ['app/prior.ts']) {
  const runDir = join(root, '.sdd', 'ledger', runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'spec.md'), '# PRIOR-1 — a previous run\n\n## Goal\n\nPrior.\n', 'utf8');
  writeFileSync(join(runDir, 'entry.md'), `# Ledger entry — ${runId}\n\nPRE-EXISTING\n`, 'utf8');
  writeFileSync(
    join(runDir, 'entry.json'),
    `${JSON.stringify({ runId, date: '2026-08-01', ticket: 'PRIOR-1', filesTouched: files, verdicts: { review: 'PASS', security: 'PASS' } }, null, 2)}\n`,
    'utf8',
  );
  return runDir;
}

// --- AC-7 / AC-8 / AC-9 / AC-10: the happy path, end to end --------------------------------------

// @spec AC-7 AC-8 AC-10
test('[lite] --lite writes a LITE-tagged entry.json declaring the skipped stages, the SKIPPED_LITE security verdict, and bypass: false', () => {
  const root = liteFixtureRepo();
  smallUncommittedChange(root);

  const result = runLite(root);
  assert.equal(result.status, 0, result.stderr);

  const runDir = theOneLiteRunDir(root);
  const entryJson = JSON.parse(readFileSync(join(runDir, 'entry.json'), 'utf8'));

  assert.deepEqual(entryJson.verdicts, { review: 'PASS', security: 'SKIPPED_LITE' },
    'the security verdict must be a distinct literal, never "PASS" — a stage that did not run cannot have passed');
  assert.deepEqual(entryJson.lite.skippedStages, ['red', 'security']);
  assert.equal(typeof entryJson.lite.note, 'string');
  assert.ok(entryJson.lite.note.length > 0);
  assert.deepEqual(Object.keys(entryJson.lite.eligibility).sort(), ['changedLines', 'fileCount', 'maxChangedLines', 'maxFiles']);
  assert.equal(entryJson.lite.eligibility.fileCount, 1);
  assert.equal(entryJson.lite.eligibility.maxFiles, 5, 'the bounds this run was measured against are recorded, not just the verdict');
  assert.equal(entryJson.lite.eligibility.maxChangedLines, 150);
  assert.ok(entryJson.lite.eligibility.changedLines > 0, 'an unmeasured change must never be recorded as a measured-small one');

  assert.equal(entryJson.securityRunId, null, 'there is no security-history run to point at');
  assert.deepEqual(entryJson.redTestPaths, []);
  assert.equal(entryJson.regate, null);
  assert.deepEqual(entryJson.overrides, []);
  assert.equal(entryJson.bypass, false, 'an ordinary lite run really did pass its surviving gate — it is a disclosure, not a bypass');
  assert.ok(entryJson.filesTouched.includes('app/lite-change.ts'));

  assert.ok(!existsSync(join(runDir, 'security')), 'a lite entry must have no security/ audit copy — no security run happened');
  assert.ok(!existsSync(join(runDir, 'security.json')), 'a lite entry must have no security.json');
  assert.ok(!existsSync(join(runDir, 'red.json')), 'a lite entry must have no red.json');
  assert.ok(existsSync(join(runDir, 'spec.md')) && existsSync(join(runDir, 'spec.json')) && existsSync(join(runDir, 'review.json')),
    'the stages that DID run still have their artifacts filed');
});

// @spec AC-8 EC-11
test('[lite] the lite disclosure note says what was therefore not verified, and redAbsenceNote says red was deliberately skipped — not that this ticket predates the stage', () => {
  const root = liteFixtureRepo();
  smallUncommittedChange(root);
  assert.equal(runLite(root).status, 0);

  const entryJson = JSON.parse(readFileSync(join(theOneLiteRunDir(root), 'entry.json'), 'utf8'));
  const note = entryJson.lite.note;
  assert.match(note, /\bred\b/, 'the note must name the red stage');
  assert.match(note, /\bsecurity\b/, 'the note must name the security stage');
  assert.ok(
    /attacker/i.test(note) || /audit/i.test(note),
    'the note must say what the skipped security stage would have produced (an attacker-brief sweep / an immutable audit record), not merely that it was skipped',
  );
  assert.match(note, /best[- ]effort|curated/i,
    'the note must concede that the barred-path list is a curated, best-effort list rather than a complete classifier');

  assert.match(entryJson.redAbsenceNote, /lite/i);
  assert.ok(
    !/predates/i.test(entryJson.redAbsenceNote),
    'the pre-existing "this ticket predates the red stage" wording would be a different, and false, claim about a lite run',
  );
});

// @spec AC-9
test('[lite] entry.md is titled "(LITE)" and carries a "## Lite lane" section immediately after "## Verdicts"', () => {
  const root = liteFixtureRepo();
  smallUncommittedChange(root);
  assert.equal(runLite(root).status, 0);

  const runDir = theOneLiteRunDir(root);
  const entry = readFileSync(join(runDir, 'entry.md'), 'utf8');
  const entryJson = JSON.parse(readFileSync(join(runDir, 'entry.json'), 'utf8'));

  assert.match(entry, /^# Ledger entry — .+\(LITE\)/m);

  const verdictsIdx = entry.indexOf('## Verdicts');
  const liteIdx = entry.indexOf('## Lite lane');
  assert.ok(verdictsIdx !== -1, 'entry.md must still carry ## Verdicts');
  assert.ok(liteIdx > verdictsIdx, 'entry.md must carry a ## Lite lane section after ## Verdicts');
  const between = entry.slice(verdictsIdx + '## Verdicts'.length, liteIdx);
  assert.ok(!/^## /m.test(between), '## Lite lane must sit IMMEDIATELY after ## Verdicts — a reader must not have to scroll past other sections to learn two stages never ran');

  const liteSection = entry.slice(liteIdx);
  assert.match(liteSection, /\bred\b/);
  assert.match(liteSection, /\bsecurity\b/);
  assert.ok(liteSection.includes(entryJson.lite.note),
    'entry.md must carry the same fixed disclosure note entry.json records, verbatim — two renderings of one fact cannot be allowed to drift');
  assert.ok(liteSection.includes('5') && liteSection.includes('150'),
    'the eligibility numbers this run was measured against belong in the human-facing entry too');

  assert.match(entry, /## Security run ID[\s\S]{0,200}(did not run|none)/i,
    'the security-run-id section must state plainly that the stage did not run, rather than sitting blank');
});

// @spec AC-8
test('[lite] skippedStages and the disclosure note are derived by the script — there is no flag to supply either', () => {
  const root = liteFixtureRepo();
  smallUncommittedChange(root);
  for (const args of [['--skipped-stages', 'red'], ['--lite-note', 'nothing to see here']]) {
    const result = runLite(root, args);
    assertLiteRefusal(result, root, `${args[0]} must not be accepted`);
    assert.match(result.stderr, new RegExp(`unrecognized argument "${args[0]}"`));
  }
});

// @spec AC-3
test('[lite] the surviving gate reads .pipeline/review.json, never review.md — a PASS-looking markdown file cannot rescue a NEEDS_FIXES verdict', () => {
  const pipeline = { ...litePipeline(), 'review.json': reviewJson('NEEDS_FIXES'), 'review.md': reviewMarkdownPlaceholder('PASS') };
  const root = liteFixtureRepo({ pipeline });
  smallUncommittedChange(root);

  const result = runLite(root);
  assertLiteRefusal(result, root, 'a NEEDS_FIXES review.json');
  assert.match(result.stderr, /NEEDS_FIXES/);
});

// --- AC-7's precondition list: each one refuses with exit 1 and writes nothing --------------------

// @spec AC-7 EC-7
test('[lite] --lite --override-security is refused, naming why — there is no security verdict on this lane to override', () => {
  const root = liteFixtureRepo();
  smallUncommittedChange(root);
  const result = runLite(root, ['--override-security', 'There is nothing here to override.']);
  assertLiteRefusal(result, root, '--lite --override-security');
  assert.match(result.stderr, /--override-security/);
  assert.match(result.stderr, /--lite/);
});

// @spec AC-7 EC-8
test('[lite] --lite --re-gate is refused in this ticket, naming the route out', () => {
  const root = liteFixtureRepo();
  smallUncommittedChange(root);
  const result = runLite(root, ['--re-gate', '--tester-ran', 'true', '--ticket', 'PL-99z']);
  assertLiteRefusal(result, root, '--lite --re-gate');
  assert.match(result.stderr, /--re-gate/);
  assert.match(result.stderr, /--lite/);
});

// @spec AC-7 EC-12
test('[lite] a missing .pipeline/test-results.md is refused — tester still runs on this lane', () => {
  const root = liteFixtureRepo({ pipeline: litePipeline({ includeTestResults: false }) });
  smallUncommittedChange(root);
  const result = runLite(root);
  assertLiteRefusal(result, root, 'a missing test-results.md');
  assert.match(result.stderr, /test-results\.md/);
  assert.match(result.stderr, /tester/i, 'the refusal must name which stage has to run first, not merely which file is absent');
});

// @spec AC-7 EC-13
test('[lite] an unstamped .pipeline/spec.json is refused — the same hygiene check --re-gate applies, and for a stated reason', () => {
  const root = liteFixtureRepo({ pipeline: litePipeline({ specStamp: null }) });
  smallUncommittedChange(root);
  const result = runLite(root);
  assertLiteRefusal(result, root, 'an unstamped spec.json');
  assert.match(result.stderr, /stamp/);
  assert.match(result.stderr, /spec\.json/);
});

// @spec AC-7 EC-14
test('[lite] a spec.json/spec.md ticket disagreement is refused on the --lite path exactly as on every other — the check stays unconditional', () => {
  const pipeline = { ...litePipeline({ ticket: 'PL-11' }), 'spec.md': specMarkdown('PL-03h') };
  const root = liteFixtureRepo({ pipeline });
  smallUncommittedChange(root);
  const result = runLite(root);
  assertLiteRefusal(result, root, 'a spec.json/spec.md ticket mismatch');
  assert.match(result.stderr, /does not agree with .*spec\.md/);
});

// @spec AC-7 EC-2
test('[lite] a realized diff over max_files or max_changed_lines is refused, naming the counts, the bounds, and the sanctioned escalation', () => {
  const tooManyFiles = liteFixtureRepo();
  for (let i = 0; i < 6; i++) smallUncommittedChange(tooManyFiles, `app/change-${i}.ts`);
  const filesResult = runLite(tooManyFiles);
  assertLiteRefusal(filesResult, tooManyFiles, 'a change over max_files');
  assert.match(filesResult.stderr, /6/, 'the refusal must name the actual file count');
  assert.match(filesResult.stderr, /5/, 'the refusal must name the bound it exceeded');
  assert.match(filesResult.stderr, /ledger-append\.mjs/, 'the refusal must name the sanctioned escalation: run /security, then the plain ledger-append');
  assert.match(filesResult.stderr, /security/i);

  const tooManyLines = liteFixtureRepo();
  const dest = join(tooManyLines, 'app', 'big.ts');
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, 'export const x = 1;\n'.repeat(200), 'utf8');
  const linesResult = runLite(tooManyLines);
  assertLiteRefusal(linesResult, tooManyLines, 'a change over max_changed_lines');
  assert.match(linesResult.stderr, /150/, 'the refusal must name the changed-line bound it exceeded');
});

// @spec AC-7 EC-2 (secondary bound — security round FND-22ef4b5c746e, MEDIUM)
test('[lite] a realized diff shaped as very few, very long lines is refused via max_line_length, even though max_changed_lines alone would not catch it', () => {
  const root = liteFixtureRepo();
  const dest = join(root, 'app', 'shaped.ts');
  mkdirSync(dirname(dest), { recursive: true });
  // One untracked line, ~20,000 characters — 1 file, 1 "changed line" (the file's own line count),
  // trivially under max_files (5) and max_changed_lines (150). This is the exact exploit shape
  // security reproduced live: a diff that measures as deceptively few changed lines while carrying
  // tens of KB of real content, which `max_changed_lines` alone cannot catch.
  writeFileSync(dest, `export const shaped = "${'x'.repeat(20000)}";\n`, 'utf8');

  const result = runLite(root);
  assertLiteRefusal(result, root, 'a diff shaped as very few, very long lines');
  assert.match(result.stderr, /line-length|max_line_length/i, 'the refusal must name the secondary size bound that caught this');
  assert.match(result.stderr, /500/, 'the refusal must name the bound it exceeded');
});

// @spec AC-7 EC-3
test('[lite] a realized diff touching the barred union is refused, naming every matching path and which list barred it', () => {
  const root = liteFixtureRepo();
  smallUncommittedChange(root, 'services/core/src/security/token-check.ts');
  const result = runLite(root);
  assertLiteRefusal(result, root, 'a barred path in the realized diff');
  assert.match(result.stderr, /services\/core\/src\/security\/token-check\.ts/);
  assert.match(result.stderr, /hotfix_barred_paths|deny_for_fenced_lanes/,
    'the refusal must say which of the two lists barred the path — the union is computed, so "barred" alone does not say where to look');
});

// @spec AC-7 EC-3 (widened — security round FND-b731f500c5b8, HIGH)
test('[lite] a realized diff touching one of the five widened hotfix_barred_paths directories (service layer, routes, MCP, workers, gateway) is refused', () => {
  for (const path of [
    'services/core/src/services/technicalTreeService.ts',
    'services/core/src/routes/graph.ts',
    'services/core/src/mcp/tools.ts',
    'services/workers/ingest.py',
    'services/gateway/socket.ts',
  ]) {
    const root = liteFixtureRepo();
    smallUncommittedChange(root, path);
    const result = runLite(root);
    assertLiteRefusal(result, root, `a barred path in the realized diff: ${path}`);
    assert.match(result.stderr, new RegExp(path.replace(/[/]/g, '\\/')), path);
    assert.match(result.stderr, /hotfix_barred_paths/, `${path}: must be barred via the widened hotfix_barred_paths list`);
  }
});

// @spec AC-7 EC-16
test('[lite] a .sdd/bounds.yml with no lite_eligibility block refuses the run — a missing bound is never read as "no bound"', () => {
  const root = liteFixtureRepo({ bounds: boundsYmlWithoutLiteBlock() });
  smallUncommittedChange(root);
  const result = runLite(root);
  assertLiteRefusal(result, root, 'an absent lite_eligibility block');
  assert.match(result.stderr, /lite_eligibility|bounds/);
});

// @spec AC-7 EC-18
test('[lite] an existing .sdd/ledger/<runId>/ is never overwritten — the guard main() already applies is reached on the lite path too', () => {
  const root = liteFixtureRepo();
  // Committed, so the prior entry is NOT part of this run's working-tree diff — that separate,
  // deliberate interaction is EC-19's test below, not this one.
  const priorRunId = '20260801T000000000Z-aaaaaaaaaaaa-LITE-aaaaaa';
  seedPriorEntry(root, priorRunId);
  commitAll(root, 'a previous ledger entry, committed');
  smallUncommittedChange(root);

  const result = runLite(root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    readFileSync(join(root, '.sdd', 'ledger', priorRunId, 'entry.md'), 'utf8'),
    `# Ledger entry — ${priorRunId}\n\nPRE-EXISTING\n`,
    'a prior run directory must never be reused or rewritten',
  );
  assert.equal(ledgerRunIds(root).length, 2, 'the new run gets its own directory alongside the old one');
});

// @spec EC-19
test('[lite] an uncommitted previous ledger entry is itself a barred .sdd/** path — the run refuses and says to commit it first', () => {
  const root = liteFixtureRepo();
  smallUncommittedChange(root);
  const priorRunId = '20260801T000000000Z-bbbbbbbbbbbb-LITE-bbbbbb';
  seedPriorEntry(root, priorRunId); // deliberately NOT committed

  const result = runLite(root);
  assert.notEqual(result.status, 0, 'a lite run cannot be measured as small while a previous run\'s ledger output is still loose in the tree');
  assert.doesNotMatch(result.stderr, /unrecognized argument "--lite"/,
    '--lite must itself be a recognized flag — otherwise this refusal says nothing about the barred path');
  assert.match(result.stderr, /\.sdd\//);
  assert.match(result.stderr, /commit/i, 'the refusal has to tell the caller what to do about it — this is an accepted cost, not a carve-out');
  assert.deepEqual(ledgerRunIds(root), [priorRunId], 'the pre-seeded directory is the only one — no new entry is written');
});

// @spec EC-17
test('[lite] a clean tree with no changes.json fails loudly rather than recording an unmeasured change as small', () => {
  const root = liteFixtureRepo({ pipeline: litePipeline({ includeChanges: false }) });
  // No uncommitted change at all: fixtureRepo committed everything.
  assertLiteRefusal(runLite(root), root, 'a clean tree with no changes.json');
});

// @spec EC-17
test('[lite] a clean tree whose changes.json names files that cannot be sized refuses rather than certifying them small', () => {
  const root = liteFixtureRepo({ pipeline: litePipeline({ changesFiles: ['app/deleted-since.ts', 'app/also-gone.ts'] }) });
  // The tree is clean and neither named path exists on disk, so there is nothing to measure at all.
  assertLiteRefusal(runLite(root), root, 'an unsizable changes.json file list — a change that cannot be measured is never measured as small');
});

// --- EC-6: a real non-PASS verdict, accepted with a reason, is still an override ------------------

// @spec EC-6 AC-10
test('[lite] --lite --override-review records the entry with bypass: true and excludes it from index.json, exactly like any other override', () => {
  const pipeline = { ...litePipeline(), 'review.json': reviewJson('NEEDS_FIXES') };
  const root = liteFixtureRepo({ pipeline });
  smallUncommittedChange(root, 'app/still-nitty.ts');

  const result = runLite(root, ['--override-review', 'A style nit accepted on purpose; the fix itself is one line.']);
  assert.equal(result.status, 0, result.stderr);

  const runDir = theOneLiteRunDir(root);
  const entryJson = JSON.parse(readFileSync(join(runDir, 'entry.json'), 'utf8'));
  assert.equal(entryJson.bypass, true, 'the override, not the lite lane, is what drives bypass here');
  assert.equal(entryJson.overrides.length, 1);
  assert.deepEqual(entryJson.lite.skippedStages, ['red', 'security'], 'the lite disclosure survives alongside the override');
  assert.deepEqual(entryJson.verdicts, { review: 'NEEDS_FIXES', security: 'SKIPPED_LITE' });

  const index = JSON.parse(readFileSync(join(root, '.sdd', 'ledger', 'index.json'), 'utf8'));
  assert.equal(index['app/still-nitty.ts'], undefined, 'an overridden run must never answer "which spec governs this file"');

  const entry = readFileSync(join(runDir, 'entry.md'), 'utf8');
  assert.match(entry, /^# Ledger entry — .+\(LITE\) \(OVERRIDE\)/m, 'the markers compose in the documented order');
});

// --- EC-5 / EC-9 / EC-10: stamped sidecars ------------------------------------------------------
//
// These use realGitignoreFixtureRepo (not the ordinary fixtureRepo) for the reason that helper's own
// doc comment gives: only under the real .gitignore is `.pipeline/**` invisible to computeTreeHash,
// which is what makes a deliberately-FRESH or deliberately-STALE stamp constructible at all.

// @spec EC-5
test('[lite] a STALE review.json is refused — and is still refused when --override-review is supplied', () => {
  for (const extraArgs of [[], ['--override-review', 'Accepting the finding, but not the staleness.']]) {
    const root = realGitignoreFixtureRepo({ pipeline: litePipeline() });
    const staleStamp = buildStamp(root); // accurate for the clean tree, one moment before it moves on
    writeFileSync(join(root, '.pipeline', 'review.json'), JSON.stringify({ verdict: 'PASS', stamp: staleStamp }, null, 2), 'utf8');
    mkdirSync(join(root, 'app'), { recursive: true });
    writeFileSync(join(root, 'app', 'never-reviewed.ts'), 'export const x = 1;\n', 'utf8');

    const result = runLite(root, extraArgs);
    assertLiteRefusal(result, root, `a STALE review.json (--lite ${extraArgs.join(' ')})`);
    assert.match(result.stderr, /review\.json's stamp is STALE/);
  }
});

// @spec EC-9
test('[lite] a FRESH-stamped security.json refuses the lite lane and points at the plain ledger-append', () => {
  const root = realGitignoreFixtureRepo({ pipeline: litePipeline() });
  const freshStamp = buildStamp(root); // .pipeline/** is gitignored here, so writing into it keeps this accurate
  writeFileSync(
    join(root, '.pipeline', 'security.json'),
    JSON.stringify({ verdict: 'PASS', runId: RUN_ID, stamp: freshStamp }, null, 2),
    'utf8',
  );

  const result = runLite(root);
  assertLiteRefusal(result, root, 'a FRESH security.json — a security run that genuinely happened against this tree must never be recorded as SKIPPED_LITE');
  assert.match(result.stderr, /security\.json/);
  assert.match(result.stderr, /ledger-append\.mjs/, 'the refusal must point at the plain command that records the run honestly');
});

// @spec EC-10
test('[lite] an unstamped (leftover) security.json is ignored with an explicit printed note, and is never copied into the lite entry', () => {
  const pipeline = { ...litePipeline(), 'security.json': securityJson(RUN_ID, 'PASS') }; // no stamp -> "unknown"
  const root = liteFixtureRepo({ pipeline });
  smallUncommittedChange(root);

  const result = runLite(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(`${result.stdout}${result.stderr}`, /security\.json/,
    'silently ignoring a leftover verdict file is exactly the kind of quiet decision this pipeline records instead');
  assert.match(`${result.stdout}${result.stderr}`, /ignor/i);

  const runDir = theOneLiteRunDir(root);
  assert.ok(!existsSync(join(runDir, 'security.json')), 'a leftover security.json must never be filed as this run\'s own');
  const entryJson = JSON.parse(readFileSync(join(runDir, 'entry.json'), 'utf8'));
  assert.equal(entryJson.verdicts.security, 'SKIPPED_LITE');
  assert.equal(entryJson.securityRunId, null);
});

// @spec EC-11
test('[lite] a leftover red.json is never copied and never listed as this run\'s red-test paths', () => {
  const pipeline = { ...litePipeline(), 'red.json': redJson(['scripts/left-over-from-another-ticket.test.mjs']) };
  const root = liteFixtureRepo({ pipeline });
  smallUncommittedChange(root);

  const result = runLite(root);
  assert.equal(result.status, 0, result.stderr);

  const runDir = theOneLiteRunDir(root);
  assert.ok(!existsSync(join(runDir, 'red.json')), 'the lite lane ran no red stage — copying a leftover sidecar would manufacture evidence of one');

  const entryJson = JSON.parse(readFileSync(join(runDir, 'entry.json'), 'utf8'));
  assert.deepEqual(entryJson.redTestPaths, []);
  const entry = readFileSync(join(runDir, 'entry.md'), 'utf8');
  assert.ok(!entry.includes('scripts/left-over-from-another-ticket.test.mjs'));
});
