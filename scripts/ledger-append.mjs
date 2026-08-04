// Writes a durable ledger entry from the current .pipeline/ artifacts, once a run has reached
// terminal PASS (.sdd/pipeline.md's Stage sequence, step 7) — PL-03c.
//
// Usage:
//   node scripts/ledger-append.mjs
//
// Preconditions (all re-verified here, never assumed from the caller): .pipeline/review.md and
// .pipeline/security-report.md both show a `PASS` Verdict, and there is exactly one COMPLETE,
// PASS-verdict run under .pipeline/security-history/ that security-report.md actually references.
// That run's own id becomes the ledger directory name — see .sdd/ledger/README.md for why reusing
// it (rather than minting a new id) is what makes a ledger entry and its security run trivially
// correlatable, and why it is deterministic/collision-safe for free: security-checker already
// refuses to reuse or overwrite a run id, so this script inherits that guarantee rather than
// re-implementing timestamp+nonce collision-avoidance a second time.
//
// Writes .sdd/ledger/<run-id>/spec.md (a verbatim copy of .pipeline/spec.md),
// .sdd/ledger/<run-id>/entry.md (run metadata), and .sdd/ledger/<run-id>/security/
// (a *copy*, never a move, of .pipeline/security-history/<run-id>/{manifest.json,results.json,
// report.md} — PL-03c round 3), then regenerates .sdd/ledger/index.json via
// build-ledger-index.mjs's exported writeIndex() — imported and called directly, not spawned as a
// subprocess, so there is exactly one implementation of "how the index is built."

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractSection, writeIndex } from './build-ledger-index.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');
const pipelineDir = join(repoRoot, '.pipeline');
const securityHistoryDir = join(pipelineDir, 'security-history');
const ledgerDir = join(repoRoot, '.sdd', 'ledger');

function fail(message) {
  process.stderr.write(`ledger-append: ${message}\n`);
  process.exit(1);
}

function readPipelineFile(name, { required = true } = {}) {
  const path = join(pipelineDir, name);
  if (!existsSync(path)) {
    if (required) fail(`.pipeline/${name} does not exist. Run the pipeline through to a terminal PASS before appending a ledger entry.`);
    return null;
  }
  return readFileSync(path, 'utf8');
}

function extractVerdict(markdown, label) {
  const section = extractSection(markdown, 'Verdict');
  if (!section) fail(`${label} has no "## Verdict" section to read.`);
  const verdict = section.split(/\r?\n/)[0].replace(/\*/g, '').trim();
  // No second "is the section empty" check here: extractSection already .trim()s, so a
  // whitespace-only section is already the empty string and the `if (!section)` check above has
  // already caught it — a second `fail()` for "empty" could never be reached. Confirmed by
  // tester (test-results.md, Priority 1) and review (Warning 4); removed as dead code.
  return verdict;
}

/** Reads the run id security-report.md itself cites, from its "## Run and baseline" section's
 * "Run ID:" line — the exact format .sdd/stages/security.md's Required artifacts section already
 * requires every report to carry, and the format ledger-append.test.mjs's own fixture already
 * emits. Returns null (not a failure) if that structured line is absent, so the caller can fall
 * back to the older substring scan for a report that predates this convention. */
function parseCitedRunId(reportMarkdown) {
  const section = extractSection(reportMarkdown, 'Run and baseline');
  if (!section) return null;
  const match = section.match(/^-[ \t]*Run ID:[ \t]*`([^`]+)`/im);
  return match ? match[1].trim() : null;
}

/** True if every line of `reportMarkdown` that mentions `name` is a "Baseline: ..." line (an
 * optional leading "-" bullet and optional bold `**Baseline**` both tolerated) — never any other
 * kind of line. Used solely by the substring-scan fallback below, so that a report legitimately
 * citing its own baseline (required by .sdd/stages/security.md from the second run onward) doesn't
 * make that baseline's directory name look like a second candidate for "the run this report is
 * about." Checked per-name against actual lines (not by extracting backtick-wrapped tokens) so it
 * doesn't depend on the baseline id happening to be backtick-quoted, the same way security.md's own
 * real report writes a plain "Baseline: none - ..." line. */
function isBaselineOnlyMention(reportMarkdown, name) {
  const matchingLines = reportMarkdown.split(/\r?\n/).filter((line) => line.includes(name));
  if (matchingLines.length === 0) return false;
  return matchingLines.every((line) => /^[ \t]*-?[ \t]*\*{0,2}Baseline\*{0,2}:/i.test(line));
}

/** Locates the one completed, PASS-verdict security run that .pipeline/security-report.md actually
 * references. Prefers the structured "## Run and baseline" / "Run ID:" line security.md's contract
 * already requires (parseCitedRunId) — reading a named field rather than scanning prose is what
 * makes this correct from the *second* security run onward, once a report legitimately also cites
 * its own baseline's run id in the same document (Critical 2: the report.includes(manifest.run_id)
 * substring-scan invariant scripts/validate-security-audit-run.mjs enforces is still true, but a
 * *reverse* scan — "which of these directory names appears in the report" — stops being unique the
 * moment two runs' ids both appear, one as Run ID and one as Baseline). Falls back to the substring
 * scan, excluding baseline-only mentions, only when the structured line is absent (an
 * older-format report). */
function findCompletedSecurityRun(reportMarkdown) {
  if (!existsSync(securityHistoryDir)) {
    fail('.pipeline/security-history/ does not exist — security has not produced a run yet.');
  }
  const dirNames = readdirSync(securityHistoryDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  const citedRunId = parseCitedRunId(reportMarkdown);
  let runId;
  if (citedRunId !== null) {
    if (!dirNames.includes(citedRunId)) {
      fail(`.pipeline/security-report.md's "## Run and baseline" section cites Run ID \`${citedRunId}\`, but .pipeline/security-history/${citedRunId}/ does not exist.`);
    }
    runId = citedRunId;
  } else {
    const candidates = dirNames.filter((name) => reportMarkdown.includes(name) && !isBaselineOnlyMention(reportMarkdown, name));
    if (candidates.length === 0) {
      fail('.pipeline/security-report.md does not reference any run directory under .pipeline/security-history/ (checked for a structured "## Run and baseline" / "Run ID:" line first, then fell back to a substring scan) — cannot determine which run to reuse as the ledger run id.');
    }
    if (candidates.length > 1) {
      fail(`.pipeline/security-report.md ambiguously matches more than one run under .pipeline/security-history/, even after excluding baseline-only mentions: ${candidates.join(', ')}`);
    }
    runId = candidates[0];
  }

  const runDir = join(securityHistoryDir, runId);
  const manifestPath = join(runDir, 'manifest.json');
  const resultsPath = join(runDir, 'results.json');
  if (!existsSync(manifestPath) || !existsSync(resultsPath)) {
    fail(`.pipeline/security-history/${runId}/ is missing manifest.json or results.json.`);
  }

  let manifest;
  let results;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    results = JSON.parse(readFileSync(resultsPath, 'utf8'));
  } catch (error) {
    fail(`.pipeline/security-history/${runId}/ has invalid JSON: ${error.message}`);
  }
  if (manifest.status !== 'COMPLETE') fail(`Security run ${runId} is not COMPLETE (status: ${manifest.status}).`);
  if (results.verdict !== 'PASS') fail(`Security run ${runId}'s verdict is ${results.verdict}, not PASS.`);
  if (manifest.run_id !== runId || results.run_id !== runId) {
    fail(`Security run ${runId}'s manifest/results run_id does not match its own directory name.`);
  }

  return { runId, manifest, results };
}

/** Copies (never moves — see the file header) .pipeline/security-history/<runId>/
 * {manifest.json,results.json,report.md} into .sdd/ledger/<runId>/security/, so the full audit
 * record survives a `.pipeline/` wipe alongside spec.md/entry.md rather than living only on the
 * machine that ran security-checker. Copy-only because .pipeline/security-history/ is itself
 * immutable and later runs use it as their own baseline lookup (findCompletedSecurityRun above,
 * and .sdd/stages/security.md's own progress-baseline contract) — moving or deleting the source
 * would break that. Refuses to overwrite an existing .sdd/ledger/<runId>/security/ directory, the
 * same guard main() already applies to the run directory as a whole, so a second append (or a
 * second backfill of the same run) can never clobber immutable audit history. Exported so the
 * one-time PL-03a backfill (see .sdd/ledger/README.md) reuses this exact logic rather than a
 * hand-copied duplicate. */
export function copySecurityHistoryIntoLedger(runId) {
  const sourceDir = join(securityHistoryDir, runId);
  const destDir = join(ledgerDir, runId, 'security');
  if (existsSync(destDir)) {
    fail(`.sdd/ledger/${runId}/security/ already exists — refusing to overwrite an existing copy of the security audit history. (security-history/ is immutable and used as later runs' baseline; the ledger's copy must never overwrite it either.)`);
  }
  mkdirSync(destDir, { recursive: true });
  for (const fileName of ['manifest.json', 'results.json', 'report.md']) {
    const sourcePath = join(sourceDir, fileName);
    if (!existsSync(sourcePath)) {
      fail(`.pipeline/security-history/${runId}/${fileName} does not exist — cannot copy a complete security audit record into the ledger.`);
    }
    copyFileSync(sourcePath, join(destDir, fileName));
  }
  return destDir;
}

/** Prefers the live working-tree diff (staged + unstaged + untracked), since ledger-append.mjs
 * typically runs before the human commits this run's own work — falls back to parsing
 * changes.md's "Files changed" section only if the tree is already clean (e.g. this run's commit
 * already landed) or git isn't available at all. Never silently returns nothing without saying so
 * — the caller records an explicit note when both sources come up empty. */
function filesTouched() {
  const fromGit = new Set();
  try {
    const diffOutput = execFileSync('git', ['diff', '--name-only', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
    for (const line of diffOutput.split(/\r?\n/)) if (line.trim()) fromGit.add(line.trim());
  } catch {
    // Not a git repo, no HEAD yet, or git unavailable — fall through to the changes.md fallback.
  }
  try {
    const untrackedOutput = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: repoRoot, encoding: 'utf8' });
    for (const line of untrackedOutput.split(/\r?\n/)) if (line.trim()) fromGit.add(line.trim());
  } catch {
    // Same fallback reasoning as above.
  }
  if (fromGit.size > 0) return [...fromGit].sort();

  const changes = readPipelineFile('changes.md', { required: false });
  if (!changes) return [];
  const section = extractSection(changes, 'Files changed') ?? extractSection(changes, 'Files [Cc]hanged');
  if (!section) return [];
  const paths = new Set();
  for (const match of section.matchAll(/`([^`\s]+\.[A-Za-z0-9]+)`/g)) paths.add(match[1]);
  return [...paths].sort();
}

function extractTicketId(specMarkdown) {
  const titleMatch = specMarkdown.match(/^#[ \t]+(.+)$/m);
  if (!titleMatch) return '(unknown ticket)';
  const title = titleMatch[1].trim();
  const idMatch = title.match(/\b[A-Z]{1,6}[0-9]*-[0-9]+[a-z]?\b/);
  return idMatch ? idMatch[0] : title;
}

function specTitle(specMarkdown) {
  const titleMatch = specMarkdown.match(/^#[ \t]+(.+)$/m);
  return titleMatch ? titleMatch[1].trim() : '(untitled spec)';
}

function parseRedTestPaths(redMarkdown) {
  const section = extractSection(redMarkdown, 'Test paths');
  if (!section) return [];
  return [...section.matchAll(/^-[ \t]+(\S.*)$/gm)].map((match) => match[1].trim());
}

function formatBulletList(items) {
  return items.map((item) => `- ${item}`).join('\n');
}

/** `redTestPaths` is the list `red.md`'s own "## Test paths" section reported; `redAbsenceNote` is
 * only used when there is no such list to report (either `red.md` doesn't exist at all, or it
 * exists but lists no tests) — the section always says something, never sits blank. */
export function buildEntryMarkdown({ runId, date, ticketId, ticketTitle, goal, files, redTestPaths, redAbsenceNote, securityRunId, commitLine, reviewVerdict, securityVerdict }) {
  const lines = [];
  lines.push(`# Ledger entry — ${runId}`);
  lines.push('');
  lines.push('## Date');
  lines.push(date);
  lines.push('');
  lines.push('## Ticket');
  lines.push(ticketId);
  lines.push('');
  lines.push(ticketTitle);
  lines.push('');
  lines.push('## Spec Goal');
  lines.push(goal || '(spec.md has no "## Goal" section)');
  lines.push('');
  lines.push('## Files touched');
  lines.push(files.length > 0 ? formatBulletList(files) : '(none could be determined automatically — see this run\'s own changes.md, not preserved here)');
  lines.push('');
  lines.push('## Verdicts');
  // Echoes the strings extractVerdict actually read from review.md/security-report.md — never a
  // hardcoded literal. By the time this runs, main() has already exited unless both equal exactly
  // 'PASS' (see the two checks in main()), so this can never write a value main() didn't itself
  // verify — Critical 1's second half: a hardcoded literal here meant a bug in extractSection could
  // make the check pass on a bad input while the *entry* still asserted PASS/PASS regardless.
  lines.push(`- review: ${reviewVerdict}`);
  lines.push(`- security: ${securityVerdict}`);
  lines.push('');
  lines.push('## Red-test paths');
  lines.push(redTestPaths.length > 0 ? formatBulletList(redTestPaths) : redAbsenceNote);
  lines.push('');
  lines.push('## Security run ID');
  lines.push(`.pipeline/security-history/${securityRunId}/`);
  lines.push('');
  lines.push('## Commit');
  lines.push(commitLine);
  lines.push('');
  return lines.join('\n');
}

function main() {
  const reviewMarkdown = readPipelineFile('review.md');
  const securityReportMarkdown = readPipelineFile('security-report.md');
  const specMarkdown = readPipelineFile('spec.md');
  const redMarkdown = readPipelineFile('red.md', { required: false });

  const reviewVerdict = extractVerdict(reviewMarkdown, '.pipeline/review.md');
  if (reviewVerdict !== 'PASS') {
    fail(`.pipeline/review.md's verdict is ${reviewVerdict}, not PASS — this is not a terminal PASS. Route back to dev instead of appending a ledger entry.`);
  }
  const securityVerdict = extractVerdict(securityReportMarkdown, '.pipeline/security-report.md');
  if (securityVerdict !== 'PASS') {
    fail(`.pipeline/security-report.md's verdict is ${securityVerdict}, not PASS — this is not a terminal PASS. Route back to dev instead of appending a ledger entry.`);
  }

  const { runId, manifest } = findCompletedSecurityRun(securityReportMarkdown);

  const runDir = join(ledgerDir, runId);
  if (existsSync(runDir)) {
    fail(`.sdd/ledger/${runId}/ already exists — refusing to overwrite an existing ledger entry. (A run id is only ever reused if security-checker's own run-id collision guard is violated, which it refuses to do.)`);
  }

  const ticketId = extractTicketId(specMarkdown);
  const ticketTitle = specTitle(specMarkdown);
  const goal = extractSection(specMarkdown, 'Goal');
  const touchedFiles = filesTouched();
  const redTestPaths = redMarkdown ? parseRedTestPaths(redMarkdown) : [];

  const date = typeof manifest.completed_at === 'string' && manifest.completed_at.length >= 10
    ? manifest.completed_at.slice(0, 10)
    : new Date().toISOString().slice(0, 10);

  const commitSha = manifest.target?.commit_sha ?? '(unknown)';
  const commitLine = manifest.target?.dirty
    ? `${commitSha} (worktree was dirty when the security run audited it — the commit that actually lands this work may differ once it's committed)`
    : commitSha;

  const redAbsenceNote = redMarkdown
    ? '(`red.md` exists for this run but its "## Test paths" section lists no tests)'
    : 'No `red.md` present for this run — either it predates the `red` stage (introduced in PL-03c) or this run genuinely produced no ledger-relevant tests. Stated explicitly rather than left blank.';

  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'spec.md'), specMarkdown, 'utf8');

  const entryMarkdown = buildEntryMarkdown({
    runId,
    date,
    ticketId,
    ticketTitle,
    goal,
    files: touchedFiles,
    redTestPaths,
    redAbsenceNote,
    securityRunId: runId,
    commitLine,
    reviewVerdict,
    securityVerdict,
  });
  writeFileSync(join(runDir, 'entry.md'), entryMarkdown, 'utf8');
  copySecurityHistoryIntoLedger(runId);

  const index = writeIndex();

  console.log(`ledger-append: wrote .sdd/ledger/${runId}/{spec.md,entry.md,security/}`);
  console.log(`ledger-append: regenerated .sdd/ledger/index.json (${Object.keys(index).length} file(s) indexed)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    // extractSection (via extractVerdict/parseCitedRunId/filesTouched's changes.md fallback) throws
    // rather than exiting directly when a heading is ambiguous (see its own comment in
    // build-ledger-index.mjs) — catch it here so the CLI still prints one clean, prefixed message
    // and exits 1, instead of a raw Node stack trace.
    fail(error.message);
  }
}
