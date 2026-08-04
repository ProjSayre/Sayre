// Tests scripts/ledger-append.mjs (PL-03c) — writes a durable ledger entry from .pipeline/
// artifacts once a run reaches terminal PASS (spec.md acceptance criteria 7, 9, 10, and the "run
// ids must be deterministic and collision-free" / "a run that never reaches PASS writes no ledger
// entry" edge cases).
//
// The script computes its own repoRoot as resolve(<its own directory>, '..') and imports its
// sibling build-ledger-index.mjs by relative path, so exercising it in isolation means copying
// both files into a throwaway fixture repo and running it there — same approach as
// scripts/generate-agent-shims.test.mjs, whose fixture-repo/afterEach-cleanup conventions this
// file follows.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';
import { buildEntryMarkdown } from './ledger-append.mjs';
// Note: copySecurityHistoryIntoLedger is deliberately NOT imported directly here (unlike
// buildEntryMarkdown, which is a pure string-building function) — it resolves repoRoot/ledgerDir/
// securityHistoryDir from this module's own import.meta.url at import time, so calling it directly
// from this test file would operate against the *real* repo's .pipeline/ and .sdd/ledger/, not a
// fixture. It's exercised exclusively through the subprocess-based fixture tests below instead,
// where the whole script (including its path resolution) runs against a throwaway fixture root.

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');
const ledgerAppendSource = readFileSync(resolve(scriptsDir, 'ledger-append.mjs'), 'utf8');
const buildIndexSource = readFileSync(resolve(scriptsDir, 'build-ledger-index.mjs'), 'utf8');

const roots = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

const RUN_ID = '20260803T120000000Z-abc123def456-PR_DELTA-f00baa';

function reviewMarkdown(verdict = 'PASS') {
  return `# Review\n\n## Verdict\n\n**${verdict}**\n\nSample review body.\n`;
}

function securityReportMarkdown(runId, verdict = 'PASS') {
  return `# Security Report\n\n## Verdict\n\n**${verdict}**\n\n## Run and baseline\n\n- Run ID: \`${runId}\`\n- Mode: \`PR_DELTA\`\n`;
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

function redMarkdown(paths = ['scripts/sample.test.mjs']) {
  return [
    '## Impact map',
    'Absent — PL-03b is unbuilt.',
    '',
    '## Test paths',
    ...paths.map((path) => `- ${path}`),
    '',
    '## @spec mapping',
    `- ${paths[0]}: AC-1`,
    '',
    '## Observed failure output',
    `### ${paths[0]}`,
    'AssertionError: expected behavior missing',
    '',
    '## Classification',
    `- ${paths[0]}: RED-CORRECT`,
    '',
    '## Content hashes (SHA-256)',
    `- ${paths[0]}: ${'d'.repeat(64)}`,
    '',
  ].join('\n');
}

function changesMarkdown(files = ['app/existing.ts']) {
  return `# Changes\n\n## Files changed\n${files.map((file) => `- \`${file}\` — sample reason`).join('\n')}\n\n## Decisions made\nNone.\n`;
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

/** Builds a throwaway fixture repo: the two scripts (ledger-append.mjs imports build-ledger-index.mjs
 * by relative path, so both must be present), a .sdd/ledger/ directory, and caller-supplied
 * .pipeline/ files. `pipeline` maps a path relative to .pipeline/ (or 'security-history/<id>/x.json')
 * to file contents. Commits everything as a baseline unless `git: false`. */
function fixtureRepo({ pipeline = {}, git = true } = {}) {
  const root = mkdtempSync(resolve(tmpdir(), 'sayre-ledger-append-'));
  roots.push(root);

  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'ledger-append.mjs'), ledgerAppendSource, 'utf8');
  writeFileSync(join(root, 'scripts', 'build-ledger-index.mjs'), buildIndexSource, 'utf8');

  mkdirSync(join(root, '.sdd', 'ledger'), { recursive: true });
  writeFileSync(join(root, '.sdd', 'ledger', 'README.md'), '# Ledger\n\nFixture placeholder.\n', 'utf8');

  for (const [relPath, contents] of Object.entries(pipeline)) {
    const dest = join(root, '.pipeline', relPath);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, contents, 'utf8');
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
    'review.md': reviewMarkdown('PASS'),
    'security-report.md': securityReportMarkdown(runId, 'PASS'),
    [`security-history/${runId}/manifest.json`]: manifestJson(runId, manifestOverrides),
    [`security-history/${runId}/results.json`]: resultsJson(runId, 'PASS'),
    [`security-history/${runId}/report.md`]: securityHistoryReportMarkdown(runId, 'PASS'),
  };
  if (includeChanges) pipeline['changes.md'] = changesMarkdown(changesFiles);
  if (includeRed) pipeline['red.md'] = redMarkdown(redPaths);
  return pipeline;
}

function runLedgerAppend(root) {
  return spawnSync(process.execPath, [join(root, 'scripts', 'ledger-append.mjs')], { cwd: root, encoding: 'utf8' });
}

// --- AC 7, 9: writes .sdd/ledger/<run-id>/{spec.md,entry.md} on a terminal PASS -----------------

test('writes spec.md and entry.md, and regenerates index.json, on a terminal PASS', () => {
  const root = fixtureRepo({ pipeline: terminalPassPipeline() });
  // Simulate dev's actual (uncommitted) change so the git-diff path has something to find.
  mkdirSync(join(root, 'app'), { recursive: true });
  writeFileSync(join(root, 'app', 'newThing.ts'), 'export const x = 1;\n', 'utf8');

  const result = runLedgerAppend(root);
  assert.equal(result.status, 0, result.stderr);

  const runDir = join(root, '.sdd', 'ledger', RUN_ID);
  assert.ok(existsSync(join(runDir, 'spec.md')));
  assert.ok(existsSync(join(runDir, 'entry.md')));

  const specCopy = readFileSync(join(runDir, 'spec.md'), 'utf8');
  assert.equal(specCopy, specMarkdown('PL-99z'));

  const entry = readFileSync(join(runDir, 'entry.md'), 'utf8');
  assert.match(entry, /## Ticket\r?\nPL-99z/);
  assert.match(entry, /## Verdicts\r?\n- review: PASS\r?\n- security: PASS/);
  assert.match(entry, /## Security run ID\r?\n\.pipeline\/security-history\/20260803T120000000Z-abc123def456-PR_DELTA-f00baa\//);
  assert.match(entry, /app\/newThing\.ts/);

  const index = JSON.parse(readFileSync(join(root, '.sdd', 'ledger', 'index.json'), 'utf8'));
  assert.ok(index['app/newThing.ts']?.some((e) => e.runId === RUN_ID));
});

test('records the @spec test paths red.md lists', () => {
  const root = fixtureRepo({ pipeline: terminalPassPipeline({ redPaths: ['scripts/one.test.mjs', 'scripts/two.test.mjs'] }) });
  const result = runLedgerAppend(root);
  assert.equal(result.status, 0, result.stderr);
  const entry = readFileSync(join(root, '.sdd', 'ledger', RUN_ID, 'entry.md'), 'utf8');
  assert.match(entry, /## Red-test paths\r?\n- scripts\/one\.test\.mjs\r?\n- scripts\/two\.test\.mjs/);
});

// --- Edge case (D-006 discipline): no red.md is stated explicitly, never silently blank ---------

test('states explicitly, rather than silently, when no red.md is present for this run', () => {
  const root = fixtureRepo({ pipeline: terminalPassPipeline({ includeRed: false }) });
  const result = runLedgerAppend(root);
  assert.equal(result.status, 0, result.stderr);
  const entry = readFileSync(join(root, '.sdd', 'ledger', RUN_ID, 'entry.md'), 'utf8');
  assert.match(entry, /## Red-test paths\r?\nNo `red\.md` present for this run/);
});

// --- Files touched: prefers a live git diff, falls back to changes.md on a clean tree -----------

test('prefers the live working-tree diff over changes.md when the tree is dirty', () => {
  const root = fixtureRepo({ pipeline: terminalPassPipeline({ changesFiles: ['app/from-changes-md.ts'] }) });
  mkdirSync(join(root, 'app'), { recursive: true });
  writeFileSync(join(root, 'app', 'from-git-diff.ts'), 'export const y = 2;\n', 'utf8'); // uncommitted

  const result = runLedgerAppend(root);
  assert.equal(result.status, 0, result.stderr);
  const entry = readFileSync(join(root, '.sdd', 'ledger', RUN_ID, 'entry.md'), 'utf8');
  assert.match(entry, /app\/from-git-diff\.ts/);
});

test('falls back to parsing changes.md\'s Files changed section when the working tree is already clean', () => {
  const root = fixtureRepo({ pipeline: terminalPassPipeline({ changesFiles: ['app/from-changes-md.ts', 'scripts/other.mjs'] }) });
  // fixtureRepo already committed everything, including changes.md itself, so `git diff --name-only
  // HEAD` and `git ls-files --others` both come up empty here — this is the fallback path.
  const result = runLedgerAppend(root);
  assert.equal(result.status, 0, result.stderr);
  const entry = readFileSync(join(root, '.sdd', 'ledger', RUN_ID, 'entry.md'), 'utf8');
  assert.match(entry, /app\/from-changes-md\.ts/);
  assert.match(entry, /scripts\/other\.mjs/);
});

test('states explicitly when no files touched could be determined at all', () => {
  const root = fixtureRepo({ pipeline: terminalPassPipeline({ includeChanges: false }) });
  // Clean tree (everything committed) and no changes.md to fall back on.
  const result = runLedgerAppend(root);
  assert.equal(result.status, 0, result.stderr);
  const entry = readFileSync(join(root, '.sdd', 'ledger', RUN_ID, 'entry.md'), 'utf8');
  assert.match(entry, /## Files touched\r?\n\(none could be determined automatically/);
});

// --- Refusal: not a terminal PASS ---------------------------------------------------------------

test('refuses when review.md is NEEDS_FIXES, and writes nothing', () => {
  const root = fixtureRepo({ pipeline: { ...terminalPassPipeline(), 'review.md': reviewMarkdown('NEEDS_FIXES') } });
  const result = runLedgerAppend(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /NEEDS_FIXES/);
  assert.ok(!existsSync(join(root, '.sdd', 'ledger', RUN_ID)));
});

test('refuses when security-report.md is BLOCKED, and writes nothing', () => {
  const root = fixtureRepo({ pipeline: { ...terminalPassPipeline(), 'security-report.md': securityReportMarkdown(RUN_ID, 'BLOCKED') } });
  const result = runLedgerAppend(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /BLOCKED/);
  assert.ok(!existsSync(join(root, '.sdd', 'ledger', RUN_ID)));
});

test('refuses when spec.md is missing entirely', () => {
  const pipeline = terminalPassPipeline();
  delete pipeline['spec.md'];
  const root = fixtureRepo({ pipeline });
  const result = runLedgerAppend(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /spec\.md/);
});

test('refuses when review.md is missing entirely (distinct from a wrong verdict)', () => {
  const pipeline = terminalPassPipeline();
  delete pipeline['review.md'];
  const root = fixtureRepo({ pipeline });
  const result = runLedgerAppend(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /review\.md does not exist/);
  assert.ok(!existsSync(join(root, '.sdd', 'ledger', RUN_ID)));
});

test('refuses when security-report.md is missing entirely (distinct from a wrong verdict)', () => {
  const pipeline = terminalPassPipeline();
  delete pipeline['security-report.md'];
  const root = fixtureRepo({ pipeline });
  const result = runLedgerAppend(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /security-report\.md does not exist/);
  assert.ok(!existsSync(join(root, '.sdd', 'ledger', RUN_ID)));
});

// --- Hard negative case: a verdict word appearing in prose is not the same as being the verdict -

test('refuses when review.md\'s "## Verdict" section is prose containing the word PASS rather than stating it as the verdict', () => {
  const pipeline = terminalPassPipeline();
  // Deliberately adversarial: the literal substring "PASS" appears in the Verdict section, but as
  // part of a sentence, not as the verdict itself. A substring/regex search for "PASS" anywhere in
  // this section would wrongly accept this; only exact-match-after-trim is correct.
  pipeline['review.md'] = '# Review\n\n## Verdict\n\nThis run should probably PASS once minor things are fixed.\n\n## Critical\nNone.\n';
  const root = fixtureRepo({ pipeline });
  const result = runLedgerAppend(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not PASS/);
  assert.ok(!existsSync(join(root, '.sdd', 'ledger', RUN_ID)));
});

test('refuses when review.md has no "## Verdict" heading at all, rather than defaulting to a pass', () => {
  const pipeline = terminalPassPipeline();
  pipeline['review.md'] = '# Review\n\nLooks fine to me, ship it.\n';
  const root = fixtureRepo({ pipeline });
  const result = runLedgerAppend(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no "## Verdict" section/);
  assert.ok(!existsSync(join(root, '.sdd', 'ledger', RUN_ID)));
});

test('refuses when security-report.md\'s verdict is a near-miss string ("PASSED") rather than exactly PASS', () => {
  const pipeline = terminalPassPipeline();
  pipeline['security-report.md'] = securityReportMarkdown(RUN_ID, 'PASS').replace('**PASS**', 'PASSED');
  const root = fixtureRepo({ pipeline });
  const result = runLedgerAppend(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /PASSED, not PASS/);
  assert.ok(!existsSync(join(root, '.sdd', 'ledger', RUN_ID)));
});

// --- Regression (review Critical 1): a ###/#### heading shadow, or inline "## Verdict"-looking ---
// prose, must never be mistaken for the real "## Verdict" section. Every fixture above this point
// is well-formed ##-only markdown ("fixture monoculture") — these reproduce review's exact repro.

test('refuses on a terminal PASS attempt when review.md has a "### Verdict" (h3) shadow reporting PASS above the real "## Verdict" reporting NEEDS_FIXES', () => {
  const pipeline = terminalPassPipeline();
  pipeline['review.md'] = '# Review\n\n### Verdict\n\nPASS\n\n## Verdict\n\n**NEEDS_FIXES**\n';
  const root = fixtureRepo({ pipeline });
  const result = runLedgerAppend(root);
  assert.notEqual(result.status, 0, 'the real ## Verdict says NEEDS_FIXES; the h3 shadow reporting PASS must not be read instead');
  assert.match(result.stderr, /NEEDS_FIXES, not PASS/);
  assert.ok(!existsSync(join(root, '.sdd', 'ledger', RUN_ID)));
});

test('refuses on a terminal PASS attempt when review.md has a "#### Verdict" (h4) shadow reporting PASS above the real "## Verdict" reporting NEEDS_FIXES', () => {
  const pipeline = terminalPassPipeline();
  pipeline['review.md'] = '# Review\n\n#### Verdict\n\nPASS\n\n## Verdict\n\n**NEEDS_FIXES**\n';
  const root = fixtureRepo({ pipeline });
  const result = runLedgerAppend(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /NEEDS_FIXES, not PASS/);
  assert.ok(!existsSync(join(root, '.sdd', 'ledger', RUN_ID)));
});

test('refuses when review.md\'s only "## Verdict"-looking text is inline prose ("see ## Verdict" then "PASS" on the next line), with no real heading anywhere', () => {
  const pipeline = terminalPassPipeline();
  pipeline['review.md'] = '# Review\n\nSome analysis, see ## Verdict\nPASS\n\n## Critical\nNone found.\n';
  const root = fixtureRepo({ pipeline });
  const result = runLedgerAppend(root);
  assert.notEqual(result.status, 0, 'there is no real "## Verdict" heading in this document at all; the inline prose must not be read as one');
  assert.match(result.stderr, /no "## Verdict" section/);
  assert.ok(!existsSync(join(root, '.sdd', 'ledger', RUN_ID)));
});

// --- Adversarial sweep (tester round 2): vectors the Critical 1 anchor fix does NOT address --------
// The anchor (`^##[ \t]+`, `m` flag) rules out ###/#### depth and mid-line-prose shadowing. It has no
// awareness of markdown structure beyond "is this literally the first thing on its line" — so a
// heading-like line fabricated inside a fenced code block or an HTML comment still satisfies it, and
// two genuine, equally well-formed "## Verdict" headings are still resolved first-match-wins. All
// three reproduce Critical 1's exact failure mode (a ledger entry recording review: PASS for a run
// whose real verdict is NEEDS_FIXES) through vectors review's own repro did not exercise. These
// assert the SAFE outcome (refusal) and, as of this test run, FAIL against the current
// implementation — not a test bug. See test-results.md for the full writeup and severity.

test('OPEN GAP: refuses when a "## Verdict" line fabricated inside a fenced code block sits above the real "## Verdict" reporting NEEDS_FIXES', () => {
  const pipeline = terminalPassPipeline();
  pipeline['review.md'] = '# Review\n\n```\n## Verdict\n\nPASS\n```\n\nSome analysis of the failed run.\n\n## Verdict\n\n**NEEDS_FIXES**\n';
  const root = fixtureRepo({ pipeline });
  const result = runLedgerAppend(root);
  assert.notEqual(result.status, 0, 'a fenced-code-block "## Verdict" line must not be read as the real section');
  assert.ok(!existsSync(join(root, '.sdd', 'ledger', RUN_ID)));
});

test('OPEN GAP: refuses when a "## Verdict" line fabricated inside an HTML comment sits above the real "## Verdict" reporting NEEDS_FIXES', () => {
  const pipeline = terminalPassPipeline();
  pipeline['review.md'] = '# Review\n\n<!--\n## Verdict\n\nPASS\n-->\n\n## Verdict\n\n**NEEDS_FIXES**\n';
  const root = fixtureRepo({ pipeline });
  const result = runLedgerAppend(root);
  assert.notEqual(result.status, 0, 'a "## Verdict" line inside an HTML comment must not be read as the real section');
  assert.ok(!existsSync(join(root, '.sdd', 'ledger', RUN_ID)));
});

test('OPEN GAP: refuses when review.md has two genuine (non-shadowed) "## Verdict" headings, and the second (final) one reports NEEDS_FIXES', () => {
  const pipeline = terminalPassPipeline();
  pipeline['review.md'] = '# Review\n\n## Verdict\n\nPASS\n\n(stray leftover draft text from an earlier revision)\n\n## Verdict\n\n**NEEDS_FIXES**\n';
  const root = fixtureRepo({ pipeline });
  const result = runLedgerAppend(root);
  assert.notEqual(result.status, 0, 'the real, final "## Verdict" section says NEEDS_FIXES and must win over an earlier duplicate reporting PASS');
  assert.ok(!existsSync(join(root, '.sdd', 'ledger', RUN_ID)));
});

// --- Regression (review Critical 1, second half): entry.md's "## Verdicts" section must echo -----
// what extractVerdict actually read, not a hardcoded literal — verified by calling the exported
// buildEntryMarkdown directly with values a real run could never actually reach main() with (main()
// only calls it once both verdicts are already confirmed 'PASS'), to prove the field is genuinely
// parameterized and not silently ignored in favor of a literal.

test('buildEntryMarkdown writes whatever reviewVerdict/securityVerdict it is given, not a hardcoded literal', () => {
  const markdown = buildEntryMarkdown({
    runId: 'sample-run',
    date: '2026-08-03',
    ticketId: 'PL-99z',
    ticketTitle: 'PL-99z — sample',
    goal: 'Sample goal.',
    files: [],
    redTestPaths: [],
    redAbsenceNote: 'No red.md.',
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
    redAbsenceNote: 'No red.md.',
    securityRunId: 'sample-run',
    commitLine: 'deadbeef',
    reviewVerdict: 'HYPOTHETICAL_REVIEW_VALUE',
    securityVerdict: 'HYPOTHETICAL_SECURITY_VALUE',
  });
  assert.match(hypothetical, /## Verdicts\n- review: HYPOTHETICAL_REVIEW_VALUE\n- security: HYPOTHETICAL_SECURITY_VALUE/);
});

// --- Regression (review Critical 2): findCompletedSecurityRun must resolve correctly once a ------
// security report legitimately cites its own baseline (required by .sdd/stages/security.md from
// the second run onward) — the exact scenario that made this ticket's own security run (#2, with
// PL-03a as its baseline) unable to reach a terminal PASS as originally delivered.

test('resolves to the report\'s own cited run, not its baseline, when both runs exist on disk and both ids appear in the report', () => {
  const baselineRunId = '20260731T230940936Z-90330fb19231-PR_DELTA-bf73ea';
  const pipeline = terminalPassPipeline();
  // A second, real COMPLETE/PASS run for the baseline, so its directory genuinely exists on disk —
  // otherwise the old code's plain "does the directory exist" check would already exclude it.
  pipeline[`security-history/${baselineRunId}/manifest.json`] = manifestJson(baselineRunId, { commitSha: 'e'.repeat(40) });
  pipeline[`security-history/${baselineRunId}/results.json`] = resultsJson(baselineRunId, 'PASS');
  pipeline['security-report.md'] = [
    '# Security Report',
    '',
    '## Verdict',
    '',
    '**PASS**',
    '',
    '## Run and baseline',
    '',
    `- Run ID: \`${RUN_ID}\``,
    '- Mode: `PR_DELTA`',
    `- Baseline: \`${baselineRunId}\` (previous run)`,
    '',
  ].join('\n');
  const root = fixtureRepo({ pipeline });
  const result = runLedgerAppend(root);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(root, '.sdd', 'ledger', RUN_ID)), 'must resolve to the report\'s own Run ID, not refuse');
  assert.ok(!existsSync(join(root, '.sdd', 'ledger', baselineRunId)), 'must not mistake the baseline for the current run');
});

test('falls back to the substring scan, excluding baseline-only mentions, when the "## Run and baseline" section is absent (older-format report)', () => {
  const baselineRunId = '20260701T000000000Z-000000000000-PR_DELTA-000000';
  const pipeline = terminalPassPipeline();
  pipeline[`security-history/${baselineRunId}/manifest.json`] = manifestJson(baselineRunId, { commitSha: 'f'.repeat(40) });
  pipeline[`security-history/${baselineRunId}/results.json`] = resultsJson(baselineRunId, 'PASS');
  // No "## Run and baseline" heading at all — an older-format report, exercising the fallback path.
  // The two ids sit on separate lines, and only the baseline one is a "Baseline:"-prefixed line —
  // that distinction is exactly what the fallback's exclusion logic keys on.
  pipeline['security-report.md'] = `# Security Report\n\n## Verdict\n\n**PASS**\n\nCurrent run: ${RUN_ID}\nBaseline: ${baselineRunId}\n`;
  const root = fixtureRepo({ pipeline });
  const result = runLedgerAppend(root);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(root, '.sdd', 'ledger', RUN_ID)));
});

test('the fallback substring scan still refuses on genuine ambiguity (two matches, neither excludable as baseline-only)', () => {
  const secondRunId = '20260702T000000000Z-111111111111-PR_DELTA-111111';
  const pipeline = terminalPassPipeline();
  pipeline[`security-history/${secondRunId}/manifest.json`] = manifestJson(secondRunId, { commitSha: 'a'.repeat(40) });
  pipeline[`security-history/${secondRunId}/results.json`] = resultsJson(secondRunId, 'PASS');
  pipeline['security-report.md'] = `# Security Report\n\n## Verdict\n\n**PASS**\n\nBoth ${RUN_ID} and ${secondRunId} are mentioned here as plain prose, neither one as a Baseline.\n`;
  const root = fixtureRepo({ pipeline });
  const result = runLedgerAppend(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ambiguously matches more than one run/);
});

// --- Adversarial sweep (tester round 2): Critical 2's fallback path, specifically probed for -----
// whether a *malformed* (not absent) structured field can make the fallback silently pick the
// baseline instead of the report's own run — that would attribute a run's ledger entry to the wrong
// id, which is exactly what Critical 2 exists to prevent from the *report's own run id* being
// unresolvable. These are distinct from the "older-format report, section absent entirely" test
// above: here the "## Run and baseline" heading is present, but its "Run ID:" line doesn't match
// parseCitedRunId's regex (no backticks), so parseCitedRunId returns null and control reaches the
// same fallback path from a different cause.

test('the fallback correctly resolves to the report\'s own run (not the baseline) when "## Run and baseline" is present but malformed (no backticks around the Run ID value)', () => {
  const baselineRunId = '20260731T230940936Z-90330fb19231-PR_DELTA-bf73ea';
  const pipeline = terminalPassPipeline();
  pipeline[`security-history/${baselineRunId}/manifest.json`] = manifestJson(baselineRunId, { commitSha: 'e'.repeat(40) });
  pipeline[`security-history/${baselineRunId}/results.json`] = resultsJson(baselineRunId, 'PASS');
  pipeline['security-report.md'] = [
    '# Security Report', '', '## Verdict', '', '**PASS**', '',
    '## Run and baseline', '',
    `- Run ID: ${RUN_ID}`, // malformed: no backticks, so parseCitedRunId's regex does not match this line
    `- Baseline: \`${baselineRunId}\` (previous run)`,
    '',
  ].join('\n');
  const root = fixtureRepo({ pipeline });
  const result = runLedgerAppend(root);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(root, '.sdd', 'ledger', RUN_ID)), 'must fall back and resolve to the report\'s own run, not refuse');
  assert.ok(!existsSync(join(root, '.sdd', 'ledger', baselineRunId)), 'must not silently pick the baseline when the structured field is malformed rather than absent');
});

test('the fallback still refuses on ambiguity when "## Run and baseline" is present but malformed (no backticks) and both ids appear as unprefixed prose', () => {
  const secondRunId = '20260702T000000000Z-222222222222-PR_DELTA-222222';
  const pipeline = terminalPassPipeline();
  pipeline[`security-history/${secondRunId}/manifest.json`] = manifestJson(secondRunId, { commitSha: 'a'.repeat(40) });
  pipeline[`security-history/${secondRunId}/results.json`] = resultsJson(secondRunId, 'PASS');
  pipeline['security-report.md'] = `# Security Report\n\n## Verdict\n\n**PASS**\n\n## Run and baseline\n\nBoth ${RUN_ID} and ${secondRunId} are mentioned as plain text here, with no backtick-wrapped "Run ID:" line and neither one prefixed as Baseline.\n`;
  const root = fixtureRepo({ pipeline });
  const result = runLedgerAppend(root);
  assert.notEqual(result.status, 0, 'must refuse on genuine ambiguity rather than guess — including not silently picking the baseline');
  assert.match(result.stderr, /ambiguously matches more than one run/);
  assert.ok(!existsSync(join(root, '.sdd', 'ledger', RUN_ID)));
  assert.ok(!existsSync(join(root, '.sdd', 'ledger', secondRunId)));
});

test('a missing closing backtick around the cited Run ID produces a garbled (multi-line) capture and fails closed rather than resolving to anything, including the baseline', () => {
  const baselineRunId = '20260731T230940936Z-90330fb19231-PR_DELTA-bf73ea';
  const pipeline = terminalPassPipeline();
  pipeline[`security-history/${baselineRunId}/manifest.json`] = manifestJson(baselineRunId, { commitSha: 'e'.repeat(40) });
  pipeline[`security-history/${baselineRunId}/results.json`] = resultsJson(baselineRunId, 'PASS');
  // The opening backtick after "Run ID:" is never closed on its own line — [^`]+ (which allows
  // embedded newlines) greedily consumes through to the *next* backtick anywhere later in the
  // document, which is the one opening the Baseline line's own value, producing a garbled capture
  // that matches no real directory name.
  pipeline['security-report.md'] = `# Security Report\n\n## Verdict\n\n**PASS**\n\n## Run and baseline\n\n- Run ID: \`${RUN_ID}\n- Baseline: \`${baselineRunId}\` (previous run)\n`;
  const root = fixtureRepo({ pipeline });
  const result = runLedgerAppend(root);
  assert.notEqual(result.status, 0);
  assert.ok(!existsSync(join(root, '.sdd', 'ledger', RUN_ID)));
  assert.ok(!existsSync(join(root, '.sdd', 'ledger', baselineRunId)), 'must not resolve to the baseline even when the primary-path capture is garbled by a missing backtick');
});

// --- Refusal: security-history run doesn't back up the report's claim ---------------------------

test('refuses when the "## Run and baseline" section cites a Run ID with no matching security-history directory on disk', () => {
  // securityReportMarkdown() always emits the structured "## Run and baseline" / "Run ID:" line, so
  // this now resolves via the primary (Critical 2 fix) path, not the substring-scan fallback — the
  // fail message names the cited id explicitly rather than the older, vaguer "does not reference
  // any run directory" message (still used by the fallback path — see the fallback-specific tests
  // above).
  const pipeline = terminalPassPipeline();
  pipeline['security-report.md'] = securityReportMarkdown('some-other-run-id-not-on-disk', 'PASS');
  const root = fixtureRepo({ pipeline });
  const result = runLedgerAppend(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cites Run ID `some-other-run-id-not-on-disk`, but/);
});

test('refuses when the matching security-history run is not COMPLETE', () => {
  const root = fixtureRepo({
    pipeline: terminalPassPipeline({ manifestOverrides: { status: 'INCOMPLETE' } }),
  });
  const result = runLedgerAppend(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not COMPLETE/);
});

test('refuses when the matching security-history run\'s own results verdict is not PASS', () => {
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

test('extracts a short ticket id from spec.md\'s title for index.json, keeping the full title in entry.md', () => {
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
});

test('records a bare commit sha with no dirty caveat when the security manifest says clean', () => {
  const root = fixtureRepo({
    pipeline: terminalPassPipeline({ manifestOverrides: { commitSha: 'c'.repeat(40), dirty: false } }),
  });
  const result = runLedgerAppend(root);
  assert.equal(result.status, 0, result.stderr);
  const entry = readFileSync(join(root, '.sdd', 'ledger', RUN_ID, 'entry.md'), 'utf8');
  assert.match(entry, new RegExp(`## Commit\\r?\\n${'c'.repeat(40)}\\r?\\n`));
});

// --- Fix 2 (PL-03c round 3): copies .pipeline/security-history/<run-id>/ into ----------------------
// .sdd/ledger/<run-id>/security/ on a terminal PASS — a *copy*, never a move (security-history/ is
// immutable and later runs use it as their own progress baseline via findCompletedSecurityRun), and
// never overwrites an existing .sdd/ledger/<run-id>/security/ directory, the same guard the run
// directory as a whole already has.

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
test('AC10: the real .gitignore keeps freshly-written ledger content trackable while .pipeline/ working files stay ignored', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'sayre-ledger-ac10-'));
  roots.push(root);
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'ledger-append.mjs'), ledgerAppendSource, 'utf8');
  writeFileSync(join(root, 'scripts', 'build-ledger-index.mjs'), buildIndexSource, 'utf8');
  mkdirSync(join(root, '.sdd', 'ledger'), { recursive: true });
  writeFileSync(join(root, '.sdd', 'ledger', 'README.md'), '# Ledger\n\nFixture placeholder.\n', 'utf8');

  for (const [relPath, contents] of Object.entries(terminalPassPipeline())) {
    const dest = join(root, '.pipeline', relPath);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, contents, 'utf8');
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
  assert.equal(isIgnored(`.sdd/ledger/${RUN_ID}/entry.md`), false, 'newly-written ledger entry.md must not be gitignored');
  assert.equal(isIgnored(`.sdd/ledger/${RUN_ID}/security/manifest.json`), false, 'the copied security/manifest.json must not be gitignored');
  assert.equal(isIgnored(`.sdd/ledger/${RUN_ID}/security/results.json`), false, 'the copied security/results.json must not be gitignored');
  assert.equal(isIgnored(`.sdd/ledger/${RUN_ID}/security/report.md`), false, 'the copied security/report.md must not be gitignored');
  assert.equal(isIgnored('.sdd/ledger/index.json'), false, 'regenerated index.json must not be gitignored');

  assert.equal(isIgnored('.pipeline/spec.md'), true, '.pipeline/spec.md must stay gitignored');
  assert.equal(isIgnored('.pipeline/review.md'), true, '.pipeline/review.md must stay gitignored');
  assert.equal(isIgnored('.pipeline/security-report.md'), true, '.pipeline/security-report.md must stay gitignored');
  assert.equal(isIgnored('.pipeline/README.md'), false, '.pipeline/README.md is the one documented carve-out and must stay trackable');
});
