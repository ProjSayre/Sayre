// Writes a durable ledger entry from the current .pipeline/ artifacts, once a run has reached
// terminal PASS (.sdd/pipeline.md's Stage sequence, step 7) — PL-03c.
//
// Usage:
//   node scripts/ledger-append.mjs
//
// Preconditions (all re-verified here, never assumed from the caller): .pipeline/review.json and
// .pipeline/security.json both show a `verdict` of `PASS`, and the run security.json cites actually
// exists, is COMPLETE, and its own results.json independently confirms PASS under
// .pipeline/security-history/.
//
// PL-03h round 4 (architectural — see .pipeline/review.md's round-3 "On convergence" section and
// scripts/pipeline-contracts.mjs's own header): every field this script used to read by parsing
// `.pipeline/review.md`/`security-report.md`/`spec.md`/`changes.md`/`red.md` markdown — the two
// verdicts that gate whether a ledger entry may be written at all, the security run id, the ticket
// id/title, the spec goal, the files-touched list, and the red-test path list — now comes from that
// stage's JSON sidecar instead (`review.json`, `security.json`, `spec.json`, `changes.json`,
// `red.json`; see scripts/pipeline-contracts.mjs). The old `parseCitedRunId`/`isBaselineOnlyMention`/
// substring-scan fallback chain existed only to recover a run id from prose when a structured
// "## Run and baseline" field was absent or malformed; that problem cannot occur once the field
// (`security.json`'s `runId`) is a required, strictly-typed JSON string, so that whole chain is
// deleted, not merely simplified.
//
// Writes .sdd/ledger/<run-id>/spec.md (a verbatim copy of .pipeline/spec.md, unchanged — still
// human-facing, never parsed by anything downstream), .sdd/ledger/<run-id>/{spec.json,red.json,
// changes.json,review.json,security.json} (verbatim copies of the JSON sidecars that were actually
// read to write this entry — red.json/changes.json only if they existed for this run), the ledger's
// own entry.md (human) and entry.json (machine — see .sdd/ledger/README.md's "entry.json is
// authoritative"), and .sdd/ledger/<run-id>/security/ (a *copy*, never a move, of
// .pipeline/security-history/<run-id>/{manifest.json,results.json,report.md} — PL-03c round 3), then
// regenerates .sdd/ledger/index.json via build-ledger-index.mjs's exported writeIndex() — imported
// and called directly, not spawned as a subprocess, so there is exactly one implementation of "how
// the index is built."
//
// Honest limits (stated plainly, not overclaimed — see .pipeline/changes.md): this script still
// trusts each stage's own JSON at face value for facts a stage is simply asserting about itself
// (e.g. review.json's verdict). A stage that lies in its JSON still lies — that is the same trust
// already placed in every stage's markdown report, unchanged by this round. What this round removes
// is a THIRD PARTY's ability to inject a false reading through document formatting rather than
// through the stage's own say-so. Where an independent cross-check already existed (security.json's
// claimed run is re-verified against its own immutable manifest.json/results.json under
// .pipeline/security-history/, not merely trusted), that cross-check is preserved unchanged below.

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeIndex } from './build-ledger-index.mjs';
import { readChangesJson, readRedJson, readReviewJson, readSecurityJson, readSpecJson } from './pipeline-contracts.mjs';

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

/** Locates the one completed, PASS-verdict security run `.pipeline/security.json` cites via its
 * required `runId` field. Replaces the old `findCompletedSecurityRun`'s prose-scanning fallback
 * chain entirely — there is no "structured field absent or malformed" case left to fall back from,
 * since `readSecurityJson` (scripts/pipeline-contracts.mjs) already refuses to return a `security`
 * object missing that field. `manifest.json`/`results.json` were, and remain, already JSON — this
 * function's own re-verification of them (COMPLETE status, PASS verdict, run_id matching the
 * directory name) is unchanged and is not part of what this round retires: it is a second,
 * independent check against the immutable audit record, not a markdown parse, and stays exactly as
 * skeptical of security.json's own say-so as it was before (see this file's header "Honest limits"
 * note — a stage that lies in its own JSON still lies; this cross-check is what catches a
 * security.json that claims PASS while its own immutable run history disagrees). */
function findCompletedSecurityRun(runId) {
  if (!existsSync(securityHistoryDir)) {
    fail('.pipeline/security-history/ does not exist — security has not produced a run yet.');
  }
  const runDir = join(securityHistoryDir, runId);
  if (!existsSync(runDir)) {
    fail(`.pipeline/security.json cites runId "${runId}", but .pipeline/security-history/${runId}/ does not exist.`);
  }
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

/** Copies whichever of the five `.pipeline/*.json` sidecars exist for this run into
 * `.sdd/ledger/<runId>/`, verbatim (byte-for-byte, like spec.md's own copy) — not re-serialized from
 * the already-validated in-memory object, so the ledger's copy is provably identical to what the
 * owning stage actually wrote, not a reconstruction of it. `red.json`/`changes.json` are optional
 * (a ticket that predates `red`, or one implemented directly without a separate `dev` sidecar this
 * run); `spec.json`/`review.json`/`security.json` are always present by the time this function runs,
 * since main() already required all three to compute the entry itself. */
function copySidecarsIntoLedger(runId) {
  const destDir = join(ledgerDir, runId);
  for (const name of ['spec.json', 'red.json', 'changes.json', 'review.json', 'security.json']) {
    const sourcePath = join(pipelineDir, name);
    if (!existsSync(sourcePath)) continue; // red.json/changes.json only — see doc comment above
    copyFileSync(sourcePath, join(destDir, name));
  }
}

/** Prefers the live working-tree diff (staged + unstaged + untracked), since ledger-append.mjs
 * typically runs before the human commits this run's own work — falls back to `changes.json`'s
 * `filesChanged` array only if the tree is already clean (e.g. this run's commit already landed) or
 * git isn't available at all. Never silently returns nothing without saying so — the caller records
 * an explicit note when both sources come up empty.
 *
 * PL-03h round 4: the markdown-fallback version of this function used to regex backtick-quoted paths
 * out of changes.md's raw "## Files changed" section text (a markdown table in some real runs, a
 * bullet list in others) — the "path list" category scripts/pipeline-contracts.mjs's own header
 * calls out as one of the things that must never come from prose. `changes.json`'s `filesChanged` is
 * already a plain array of strings; there is no shape left to regex out of it. The "changes.json
 * exists but has an empty filesChanged array, and the working tree is already clean" case still fails
 * loudly rather than silently recording an empty list — the same reasoning as before (dev.md's
 * changes.json output contract always includes this field with real content when there is a real
 * change to report), just checked against an array's length instead of a section's presence/emptiness. */
function filesTouched(changesJson) {
  const fromGit = new Set();
  try {
    const diffOutput = execFileSync('git', ['diff', '--name-only', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
    for (const line of diffOutput.split(/\r?\n/)) if (line.trim()) fromGit.add(line.trim());
  } catch {
    // Not a git repo, no HEAD yet, or git unavailable — fall through to the changes.json fallback.
  }
  try {
    const untrackedOutput = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: repoRoot, encoding: 'utf8' });
    for (const line of untrackedOutput.split(/\r?\n/)) if (line.trim()) fromGit.add(line.trim());
  } catch {
    // Same fallback reasoning as above.
  }
  if (fromGit.size > 0) return [...fromGit].sort();

  if (!changesJson) return [];
  if (changesJson.filesChanged.length === 0) {
    fail('.pipeline/changes.json exists but "filesChanged" is empty, and the working tree is already clean — dev.md\'s changes.json output contract always includes this field with real content when there is a real change to report. Refusing to silently record an empty list.');
  }
  return [...new Set(changesJson.filesChanged)].sort();
}

/** Regexes the short ticket id (e.g. "W3-10") out of `specJson.ticket` — an already-authoritative
 * plain string field `planner` writes directly into spec.json, not derived by parsing spec.md's raw
 * title line at read time (see scripts/pipeline-contracts.mjs's readSpecJson doc comment). This is
 * plain string manipulation on one already-validated field, not a markdown-structure parse: there is
 * no heading, fence, or comment for an adversarial value to hide behind, and a garbled or unusual
 * ticket string simply falls back to the full string, exactly as before. */
function extractTicketId(ticket) {
  const match = ticket.match(/\b[A-Z]{1,6}[0-9]*-[0-9]+[a-z]?\b/);
  return match ? match[0] : ticket;
}

function formatBulletList(items) {
  return items.map((item) => `- ${item}`).join('\n');
}

/** `redTestPaths` is the list `red.json`'s own `tests` array reported; `redAbsenceNote` is only used
 * when there is no such list to report (either `red.json` doesn't exist at all, or it exists but
 * lists no tests) — the section always says something, never sits blank. */
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
  lines.push(goal || '(spec.json has no "goal" field)');
  lines.push('');
  lines.push('## Files touched');
  lines.push(files.length > 0 ? formatBulletList(files) : '(none could be determined automatically — see this run\'s own changes.json, not preserved here)');
  lines.push('');
  lines.push('## Verdicts');
  // Echoes the strings readReviewJson/readSecurityJson actually read — never a hardcoded literal. By
  // the time this runs, main() has already exited unless both equal exactly 'PASS' (see the two
  // checks in main()), so this can never write a value main() didn't itself verify.
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

/** The machine-facing twin of buildEntryMarkdown, built from the exact same already-computed values
 * — see .sdd/ledger/README.md's "entry.json is authoritative": scripts/build-ledger-index.mjs reads
 * only this shape, never entry.md's prose. Building both from one shared set of values (rather than
 * one deriving from the other, or each being independently assembled) is what makes them
 * structurally unable to disagree on the facts, even though they are two separate files on disk. */
export function buildEntryJson({ runId, date, ticketId, ticketTitle, goal, files, redTestPaths, redAbsenceNote, securityRunId, commit, reviewVerdict, securityVerdict }) {
  return {
    runId,
    date,
    ticket: ticketId,
    ticketTitle,
    goal: goal || null,
    filesTouched: files,
    verdicts: { review: reviewVerdict, security: securityVerdict },
    redTestPaths,
    redAbsenceNote: redTestPaths.length > 0 ? null : redAbsenceNote,
    securityRunId,
    commit,
  };
}

function main() {
  const reviewJson = readReviewJson(pipelineDir);
  if (reviewJson.verdict !== 'PASS') {
    fail(`.pipeline/review.json's verdict is ${reviewJson.verdict}, not PASS — this is not a terminal PASS. Route back to dev instead of appending a ledger entry.`);
  }
  const securityJson = readSecurityJson(pipelineDir);
  if (securityJson.verdict !== 'PASS') {
    fail(`.pipeline/security.json's verdict is ${securityJson.verdict}, not PASS — this is not a terminal PASS. Route back to dev instead of appending a ledger entry.`);
  }

  const specJson = readSpecJson(pipelineDir);
  const specMarkdown = readPipelineFile('spec.md'); // still copied verbatim into the ledger — never parsed
  const redJson = readRedJson(pipelineDir, { required: false });
  const changesJson = readChangesJson(pipelineDir, { required: false });

  const { runId, manifest } = findCompletedSecurityRun(securityJson.runId);

  const runDir = join(ledgerDir, runId);
  if (existsSync(runDir)) {
    fail(`.sdd/ledger/${runId}/ already exists — refusing to overwrite an existing ledger entry. (A run id is only ever reused if security-checker's own run-id collision guard is violated, which it refuses to do.)`);
  }

  const ticketId = extractTicketId(specJson.ticket);
  const ticketTitle = specJson.ticket;
  const goal = specJson.goal;
  const touchedFiles = filesTouched(changesJson);
  const redTestPaths = redJson ? redJson.tests.map((test) => test.path) : [];

  const date = typeof manifest.completed_at === 'string' && manifest.completed_at.length >= 10
    ? manifest.completed_at.slice(0, 10)
    : new Date().toISOString().slice(0, 10);

  const commitSha = manifest.target?.commit_sha ?? '(unknown)';
  const dirty = Boolean(manifest.target?.dirty);
  const commitLine = dirty
    ? `${commitSha} (worktree was dirty when the security run audited it — the commit that actually lands this work may differ once it's committed)`
    : commitSha;

  const redAbsenceNote = redJson
    ? '(`red.json` exists for this run but its "tests" list is empty)'
    : 'No `red.json` present for this run — either it predates the `red` stage (introduced in PL-03c) or this run genuinely produced no ledger-relevant tests. Stated explicitly rather than left blank.';

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
    reviewVerdict: reviewJson.verdict,
    securityVerdict: securityJson.verdict,
  });
  writeFileSync(join(runDir, 'entry.md'), entryMarkdown, 'utf8');

  const entryJson = buildEntryJson({
    runId,
    date,
    ticketId,
    ticketTitle,
    goal,
    files: touchedFiles,
    redTestPaths,
    redAbsenceNote,
    securityRunId: runId,
    commit: { sha: commitSha, dirty },
    reviewVerdict: reviewJson.verdict,
    securityVerdict: securityJson.verdict,
  });
  writeFileSync(join(runDir, 'entry.json'), JSON.stringify(entryJson, null, 2) + '\n', 'utf8');

  copySidecarsIntoLedger(runId);
  copySecurityHistoryIntoLedger(runId);

  const index = writeIndex();

  console.log(`ledger-append: wrote .sdd/ledger/${runId}/{spec.md,spec.json,entry.md,entry.json,security/}`);
  console.log(`ledger-append: regenerated .sdd/ledger/index.json (${Object.keys(index).length} file(s) indexed)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    // readReviewJson/readSecurityJson/readSpecJson/readRedJson/readChangesJson throw SidecarError on
    // malformed JSON or a failed strict-shape check (see scripts/pipeline-contracts.mjs); this catch
    // turns that (and any other unexpected error) into one clean, prefixed message and exit 1,
    // instead of a raw Node stack trace.
    fail(error.message);
  }
}
