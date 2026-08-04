// Writes a durable ledger entry from the current .pipeline/ artifacts, once a run has reached
// terminal PASS (.sdd/pipeline.md's Stage sequence, step 7) — PL-03c.
//
// Usage:
//   node scripts/ledger-append.mjs
//   node scripts/ledger-append.mjs --hotfix --what-broke <text> --what-changed <text> \
//     --why-skipped <text> --not-verified <text> --follow-up-ticket <text> \
//     [--files <path...>]
//
// `--files` is optional and, when given, must be the LAST flag (it consumes every remaining
// argument, the same convention scripts/check-bounds.mjs's own `--files` uses) — see "D-005 #3 /
// `/hotfix`" below for why it exists: the realistic incident flow commits the fix *before* running
// this command, which leaves the working tree clean and no changes.json to fall back on, so the
// git-diff-based detection this script otherwise prefers finds nothing to report.
//
// Preconditions (all re-verified here, never assumed from the caller): .pipeline/review.json and
// .pipeline/security.json both show a `verdict` of `PASS`, and the run security.json cites actually
// exists, is COMPLETE, and its own results.json independently confirms PASS under
// .pipeline/security-history/.
//
// `--hotfix` (D-005 #3, see .sdd/hotfix.md) is the one exception to all of the above: it writes a
// bypass ledger entry that requires neither review.json nor security.json — see the "D-005 #3 /
// `/hotfix`" section below for the full reasoning, and .sdd/hotfix.md for the eligibility gates a
// human must check before ever reaching for this flag.
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
//
// CORRECTED (round 6 / SEC-10): that cross-check was, in fact, changed once, silently — the round-5
// duplicate-key fix (parseJsonOrThrow) never reached findCompletedSecurityRun's own manifest.json/
// results.json reads below, which kept using plain JSON.parse. Fixed; see that function's own
// comment. GAP-01 (same round): --hotfix now also enforces its own two mechanically-checkable
// eligibility gates from .sdd/hotfix.md (an unfenced "full" lane, and no touched file under a
// curated sensitive-path list) — see the "D-005 #3 / `/hotfix`" section below for what is, and is
// not, enforced.

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeIndex } from './build-ledger-index.mjs';
import { readChangesJson, readJsonFile, readRedJson, readReviewJson, readSecurityJson, readSpecJson } from './pipeline-contracts.mjs';
import { matchesAny, readBounds } from './check-bounds.mjs';

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
 * security.json that claims PASS while its own immutable run history disagrees).
 *
 * CORRECTED (round 6 / security SEC-10): until this fix, the two lines below read manifest.json/
 * results.json with plain `JSON.parse`, not `pipeline-contracts.mjs`'s strict, duplicate-key-
 * rejecting `parseJsonOrThrow` — the one call site the round-5 fix (which retargeted
 * `readReviewJson`/`readSecurityJson`/`readChangesJson`/etc. at that parser) never reached, because
 * this function reads the *security-history* copy directly rather than through one of those five
 * `.pipeline/*.json` readers. Security reproduced the exact round-4 duplicate-key forgery here, one
 * layer under `security.json`: a `results.json` whose real verdict was BLOCKED with a duplicate,
 * appended `"verdict":"PASS"` key made this function (and therefore a durable ledger entry) read
 * `PASS`. Fixed by routing both reads through `readJsonFile` (scripts/pipeline-contracts.mjs), the
 * same size-capped, strict-parsing primitive `readJsonSidecar` uses — see that file's own comment. */
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
    manifest = readJsonFile(manifestPath, `.pipeline/security-history/${runId}/manifest.json`);
    results = readJsonFile(resultsPath, `.pipeline/security-history/${runId}/results.json`);
  } catch (error) {
    fail(error.message);
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

// --- D-005 #3 / `/hotfix`: the sanctioned bypass ----------------------------------------------------
//
// `.sdd/hotfix.md` is explicit that a hotfix "does not require review.md or security-report.md" —
// there is no planner/red/dev/tester/review/security run behind it at all, by design (production was
// broken and the fix was small and obvious; see that file for the eligibility gates). So this path
// reads none of the five .pipeline/*.json sidecars main() below requires, and writes no spec.md/
// spec.json/security/ copy — there is no spec and no security run to copy. What it must still record,
// per .sdd/hotfix.md's "non-negotiable" list, is what broke, what changed, why the pipeline was
// skipped, what was not verified, and a follow-up ticket — and it must be "stamped so
// build-ledger-index.mjs can distinguish it" (this file's own header comment, echoing .sdd/hotfix.md):
// entry.json's `bypass: true` field is that stamp, and buildIndex() (scripts/build-ledger-index.mjs)
// reads it to exclude a hotfix's files from the file->spec index entirely — see that file's own
// comment for why exclusion, not a differently-labeled inclusion, is what "must never satisfy a query
// asking which spec governs a file" actually requires.
//
// GAP-01 (security round 6): .sdd/hotfix.md lists four eligibility gates ("is production actually
// broken and the fix small and obvious," "who may use it" [unfenced/`full` lane only], the "Honest
// limits" barred-path list [org_id/RBAC/secrets/webhook/Graph-Query-Service], and "is rollback
// better"), and until this fix this script enforced none of them — only that the five text fields
// below were non-empty. Two of the four are irreducibly human judgment ("is production actually
// broken," "is rollback better than a fast follow-up") and stay exactly that: documented in
// .sdd/hotfix.md, never mechanically checked here, because there is no artifact on disk that could
// answer them. The other two ARE mechanically checkable from a lane name and a file list, and are now
// enforced in runHotfix() below: `--lane` is required and must resolve to the unfenced (`full`) lane
// (scripts/check-bounds.mjs's own `readBounds()`, imported directly rather than re-parsed a second,
// independent way), and none of the resolved touched-files may match `.sdd/bounds.yml`'s
// `hotfix_barred_paths` list. Enforcing exactly the checkable half, and saying so here, is the point —
// silently claiming this covers all four gates would recreate the same "documented but unenforced" gap
// this round closes.

const HOTFIX_REQUIRED_FLAGS = {
  whatBroke: '--what-broke',
  whatChanged: '--what-changed',
  whyPipelineSkipped: '--why-skipped',
  notVerified: '--not-verified',
  followUpTicket: '--follow-up-ticket',
};

function parseHotfixArgs(argv) {
  const flagToKey = new Map(Object.entries(HOTFIX_REQUIRED_FLAGS).map(([key, flag]) => [flag, key]));
  const args = { files: null, lane: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--files') { args.files = argv.slice(i + 1); break; } // consumes the rest of argv, same convention as check-bounds.mjs's own --files
    if (argv[i] === '--lane') { args.lane = argv[++i]; continue; }
    const key = flagToKey.get(argv[i]);
    if (key) args[key] = argv[++i];
  }
  return args;
}

/** W1 (review): the realistic incident flow commits the fix *before* running `--hotfix` (production
 * was broken, the fix landed, and the ledger entry documents it afterward), which leaves
 * `filesTouched(null)` with an empty git diff and no `changes.json` to fall back on — so it silently
 * returned `[]` and `entry.md` read "(none could be determined automatically)". Since a bypass
 * entry's entire value is "an unspecced change, and here is what it touched," a hotfix entry with no
 * file list is close to worthless. Fixed the same way the normal path already fails loudly on the
 * analogous "changes.json exists but reports nothing" case (see filesTouched() above): prefer an
 * explicit `--files` list when the caller supplies one, otherwise fall back to git detection, and
 * fail loudly — naming `--files` as the fix — rather than writing an entry with an empty list. */
function resolveHotfixFilesTouched(explicitFiles) {
  if (explicitFiles && explicitFiles.length > 0) return [...new Set(explicitFiles)].sort();
  const detected = filesTouched(null);
  if (detected.length > 0) return detected;
  fail(
    '--hotfix could not determine any files touched: the working tree is already clean (the fix is ' +
    'already committed — the realistic incident flow) and no --files was supplied. A hotfix entry ' +
    'with no file list is close to worthless — its entire value is "an unspecced change, and here is ' +
    'what it touched." Pass --files <path...> as the LAST flag (it consumes every remaining ' +
    'argument), e.g. the output of `git show --stat --name-only HEAD`. Refusing to silently write an ' +
    'entry with an empty file list.',
  );
}

/** A fresh, sortable, collision-safe run id for a hotfix entry — there is no security run to reuse
 * one from (buildEntryMarkdown's normal path reuses security-checker's run id; a hotfix never runs
 * security at all). Same shape family as a normal run id (`<timestamp>-<shortsha>-<mode>-<random>`,
 * see security-checker's own id convention) so it still sorts chronologically alongside normal
 * entries in `.sdd/ledger/`'s directory listing — `HOTFIX` in the mode position is what makes a
 * bypass entry visually distinct from a `PR_DELTA`/`REMEDIATION_RECHECK` one at a glance, on top of
 * the structural `bypass: true` stamp buildIndex() actually reads. */
export function generateHotfixRunId({ cwd = repoRoot } = {}) {
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace('.', '');
  let shortSha = 'nogit0000000';
  try {
    shortSha = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd, encoding: 'utf8' }).trim() || shortSha;
  } catch {
    // No git, no HEAD yet, or git unavailable — a hotfix must still be writable in a degraded
    // environment (see .sdd/hotfix.md's whole reason for existing), so fall back rather than fail.
  }
  const random = randomBytes(3).toString('hex');
  return `${timestamp}-${shortSha}-HOTFIX-${random}`;
}

function currentCommitInfo() {
  let sha = '(unknown)';
  let dirty = false;
  try {
    sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim() || sha;
  } catch {
    // Not a git repo, or no HEAD yet.
  }
  try {
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' });
    dirty = status.trim().length > 0;
  } catch {
    // git unavailable — leave dirty as its default (false) rather than guessing.
  }
  return { sha, dirty };
}

/** The hotfix twin of buildEntryMarkdown — same "one shared set of values, two renderings" shape,
 * deliberately different headings (no "## Verdicts", no "## Spec Goal") so a bypass entry can never
 * be skimmed as if it were a normal, passed run. */
export function buildHotfixEntryMarkdown({ runId, date, whatBroke, whatChanged, whyPipelineSkipped, notVerified, followUpTicket, files, commitLine }) {
  const lines = [];
  lines.push(`# Ledger entry — ${runId} (HOTFIX BYPASS)`);
  lines.push('');
  lines.push('## Bypass');
  lines.push(
    '**This is a hotfix bypass entry, not a completed pipeline run.** It did not pass through ' +
    'planner, red, dev, tester, review, or security — see `.sdd/hotfix.md`. No spec governs the ' +
    'files this entry touched; this entry is deliberately excluded from `.sdd/ledger/index.json`\'s ' +
    'file->spec map so a later query for "which spec governs this file" can never resolve to it.',
  );
  lines.push('');
  lines.push('## Date');
  lines.push(date);
  lines.push('');
  lines.push('## What broke');
  lines.push(whatBroke);
  lines.push('');
  lines.push('## What changed');
  lines.push(whatChanged);
  lines.push('');
  lines.push('## Why the pipeline was skipped');
  lines.push(whyPipelineSkipped);
  lines.push('');
  lines.push('## What was not verified');
  lines.push(notVerified);
  lines.push('');
  lines.push('## Follow-up ticket');
  lines.push(followUpTicket);
  lines.push('');
  lines.push('## Files touched');
  lines.push(files.length > 0 ? formatBulletList(files) : '(none could be determined automatically)');
  lines.push('');
  lines.push('## Commit');
  lines.push(commitLine);
  lines.push('');
  return lines.join('\n');
}

/** The machine-facing twin of buildHotfixEntryMarkdown. `bypass: true` is the field
 * scripts/build-ledger-index.mjs reads to exclude this entry from the file->spec index; `ticket`
 * carries the follow-up ticket reference so readEntryJson's ordinary required-`ticket` check still
 * has something real to validate, without inventing a second, hotfix-only field for the same idea. */
export function buildHotfixEntryJson({ runId, date, whatBroke, whatChanged, whyPipelineSkipped, notVerified, followUpTicket, files, commit }) {
  return {
    runId,
    date,
    bypass: true,
    ticket: followUpTicket,
    whatBroke,
    whatChanged,
    whyPipelineSkipped,
    notVerified,
    followUpTicket,
    filesTouched: files,
    commit,
  };
}

function runHotfix(argv) {
  const args = parseHotfixArgs(argv);
  const missing = Object.keys(HOTFIX_REQUIRED_FLAGS).filter((key) => !args[key] || !args[key].trim());
  if (missing.length > 0) {
    fail(
      `--hotfix requires ${missing.map((key) => HOTFIX_REQUIRED_FLAGS[key]).join(', ')} — ` +
      '.sdd/hotfix.md\'s non-negotiable fields (what broke, what changed, why the pipeline was ' +
      'skipped, what was not verified) plus a follow-up ticket. None may be empty — a hotfix is ' +
      'defined by the checks it skipped, and a record that omits them is not a record of a hotfix.',
    );
  }

  // --- GAP-01: the one mechanically-checkable eligibility gate that does not depend on the file ----
  // list ("who may use it"). The other mechanically-checkable gate (the barred-path list) depends on
  // touchedFiles, computed further down, so it is checked there instead — see that check's own comment.
  if (!args.lane || !args.lane.trim()) {
    fail(
      '--hotfix requires --lane <name> — .sdd/hotfix.md restricts this bypass to an unfenced ("full") ' +
      'lane ("Who may use it": "Not available to a fenced contributor... escalates to someone with ' +
      '`full`"). See .sdd/bounds.yml for the lane vocabulary.',
    );
  }
  const { lanes, hotfixBarredPaths } = readBounds();
  if (!lanes[args.lane]) {
    fail(
      `--hotfix: unknown lane "${args.lane}". Known lanes: ${Object.keys(lanes).join(', ')}. Refusing ` +
      'rather than defaulting — a typo must not silently grant hotfix eligibility.',
    );
  }
  if (args.lane !== 'full') {
    fail(
      `--hotfix is not available to a fenced lane ("${args.lane}") — see .sdd/hotfix.md's "Who may use ` +
      'it": a fenced lane exists because someone\'s changes get a human check before they land, and a ' +
      'bypass that removes the check would make the fence decorative. A fenced contributor facing a ' +
      'genuine emergency escalates to someone on the unfenced ("full") lane instead of using this flag ' +
      'themselves.',
    );
  }

  const runId = generateHotfixRunId();
  const runDir = join(ledgerDir, runId);
  if (existsSync(runDir)) {
    fail(`.sdd/ledger/${runId}/ already exists — refusing to overwrite. Run this command again; a fresh id is generated each time.`);
  }

  const touchedFiles = resolveHotfixFilesTouched(args.files);

  // --- GAP-01: the second mechanically-checkable eligibility gate ("Honest limits") ----------------
  // .sdd/hotfix.md: "If the change touches org_id handling, RBAC filtering, secrets, webhook
  // validation, or the Graph Query Service, it is not eligible for hotfix." `hotfixBarredPaths`
  // (.sdd/bounds.yml, read above alongside the lane check) is a curated, best-effort glob list for
  // exactly those categories — not a complete classifier of "every security-sensitive line of code."
  // Checked against every touched file regardless of how it was determined (git diff or explicit
  // --files), because the eligibility gate applies to the change itself, not to how this script
  // happened to learn about it.
  const barredMatches = touchedFiles.filter((file) => matchesAny(file, hotfixBarredPaths));
  if (barredMatches.length > 0) {
    fail(
      '--hotfix touches path(s) .sdd/hotfix.md\'s "Honest limits" bars from this bypass (org_id ' +
      `handling, RBAC filtering, secrets, webhook validation, or the Graph Query Service): ` +
      `${barredMatches.join(', ')}. Fix forward through the normal pipeline, or roll back — see ` +
      '.sdd/hotfix.md.',
    );
  }

  const date = new Date().toISOString().slice(0, 10);
  const { sha: commitSha, dirty } = currentCommitInfo();
  const commitLine = dirty
    ? `${commitSha} (worktree was dirty when this hotfix entry was written — the commit that actually lands this fix may differ once it's committed)`
    : commitSha;

  mkdirSync(runDir, { recursive: true });

  const entryMarkdown = buildHotfixEntryMarkdown({
    runId,
    date,
    whatBroke: args.whatBroke,
    whatChanged: args.whatChanged,
    whyPipelineSkipped: args.whyPipelineSkipped,
    notVerified: args.notVerified,
    followUpTicket: args.followUpTicket,
    files: touchedFiles,
    commitLine,
  });
  writeFileSync(join(runDir, 'entry.md'), entryMarkdown, 'utf8');

  const entryJson = buildHotfixEntryJson({
    runId,
    date,
    whatBroke: args.whatBroke,
    whatChanged: args.whatChanged,
    whyPipelineSkipped: args.whyPipelineSkipped,
    notVerified: args.notVerified,
    followUpTicket: args.followUpTicket,
    files: touchedFiles,
    commit: { sha: commitSha, dirty },
  });
  writeFileSync(join(runDir, 'entry.json'), JSON.stringify(entryJson, null, 2) + '\n', 'utf8');

  const index = writeIndex();

  console.log(`ledger-append --hotfix: wrote .sdd/ledger/${runId}/{entry.md,entry.json} (bypass entry — no governing spec; see .sdd/hotfix.md)`);
  console.log(`ledger-append --hotfix: regenerated .sdd/ledger/index.json (${Object.keys(index).length} file(s) indexed; this run's files are deliberately excluded)`);
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
    if (process.argv.includes('--hotfix')) {
      runHotfix(process.argv.slice(2));
    } else {
      main();
    }
  } catch (error) {
    // readReviewJson/readSecurityJson/readSpecJson/readRedJson/readChangesJson throw SidecarError on
    // malformed JSON or a failed strict-shape check (see scripts/pipeline-contracts.mjs); this catch
    // turns that (and any other unexpected error) into one clean, prefixed message and exit 1,
    // instead of a raw Node stack trace.
    fail(error.message);
  }
}
