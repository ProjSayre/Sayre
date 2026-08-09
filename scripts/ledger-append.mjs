// Writes a durable ledger entry from the current .pipeline/ artifacts, once a run has reached
// terminal PASS (.sdd/pipeline.md's Stage sequence, step 7) — PL-03c.
//
// Usage:
//   node scripts/ledger-append.mjs
//   node scripts/ledger-append.mjs --override-review "<reason>" [--override-security "<reason>"]
//   node scripts/ledger-append.mjs --re-gate --tester-ran <true|false> --ticket <id>
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
// .pipeline/security.json both show a `verdict` of `PASS`, the run security.json cites actually
// exists, is COMPLETE, and its own results.json independently confirms PASS under
// .pipeline/security-history/, AND (security-precondition fix round, this branch) neither
// review.json's nor security.json's own `stamp` reads STALE against the tree right now — see
// `refuseIfStale` below for why a stale PASS is treated exactly like a non-PASS verdict here, never
// merely flagged.
//
// `--hotfix` (D-005 #3, see .sdd/hotfix.md) is the one exception to all of the above: it writes a
// bypass ledger entry that requires neither review.json nor security.json — see the "D-005 #3 /
// `/hotfix`" section below for the full reasoning, and .sdd/hotfix.md for the eligibility gates a
// human must check before ever reaching for this flag.
//
// `--override-review "<reason>"` / `--override-security "<reason>"` (PL-04 / B2, B3 — see the
// "Sanctioned overrides" section below) are the other exception, narrower than `--hotfix`: the
// normal pipeline DID run (there is a real review.json/security.json, from an actual review/security
// pass), but its final, terminal verdict was NEEDS_FIXES/BLOCKED and someone is choosing to record that
// outcome durably anyway, rather than let it vanish. Each flag requires its own non-empty reason string
// — no reason, no override, by design (B2) — and the reason becomes part of the durable ledger entry.
// This is a disclosure requirement, not an authorization check (see the "Sanctioned overrides" section
// below): nothing here verifies who invoked the flag. Because no spec was actually ratified by a
// non-PASS run, the resulting entry is excluded from index.json's file->spec map the exact same way a
// `--hotfix` bypass entry already is (B3 — reusing that mechanism, not a parallel one).
//
// `--re-gate --tester-ran <true|false> --ticket <id>` (PL-04 / item 1 — see .sdd/pipeline.md's
// `/re-gate` section and .sdd/ledger/README.md's "Re-gate entries" section, both of which this
// implements to the letter) is a third flag family, narrower than either of the above: unlike
// `--hotfix`, it is not a bypass — review.json/security.json must still both show PASS (or be accepted
// via `--override-review`/`--override-security`, exactly like any other run; the two mechanisms
// compose freely) before this script writes anything. Unlike `--override-*`, it changes no gate's
// acceptance criteria at all. It is a disclosure-only marker: the tree these PASS verdicts describe was
// hand-edited directly, outside `dev`'s own re-invocation loop, before this run, and `--tester-ran`
// records literally whether `tester` was re-run against that hand-edited tree on this pass (`/re-gate`'s
// default) or skipped (`/re-gate --gates-only`) — so a fast re-gate is visibly distinct from a full one
// in the durable record, not merely convenient in the moment it was chosen. `gatesOnly` is derived as
// the exact inverse of `testerRan`, not asked for separately, per README's own stated invariant ("both
// are recorded, rather than just one, so a reader never has to infer one from the absence of the other").
//
// CORRECTED (PL-04 review pass 2 / Critical 1): `--ticket <id>` did not exist until this fix, and its
// absence was a real hole, not a hypothetical one: `/re-gate` is the one entry point in this repo that
// reaches the ledger step without ever running `planner`, and every other path's own precondition —
// `.pipeline/spec.json` matches the run being gated — held only because `planner` had just written it.
// Nothing re-verified that assumption here. `main()` below re-derives `filesTouched` from the *live*
// git diff, but sourced `ticketId`/`ticketTitle`/`goal`, and copied `spec.md`/`spec.json` verbatim, from
// whatever happened to be sitting in `.pipeline/spec.json` — so a `/re-gate` run against a tree whose
// `spec.json` belongs to a stale or unrelated ticket would silently attribute this run's real files to
// that other ticket's spec, permanently (ledger entries are append-only). `--ticket` is the caller's own
// assertion of which ticket it believes it is re-gating; `main()` refuses unless `extractTicketId`'s
// read of `spec.json`'s own `ticket` field agrees with it (see the "`/re-gate`" section below). A stamp-
// freshness check ALONE would not have caught this: `spec.json` is documented elsewhere (this file's own
// "Staleness of required inputs" contract, `.sdd/stages/dev.md`) as trusted-fresh and non-refusing
// precisely because `dev`/`tester`/`review`'s own later edits routinely make it read "stale" against
// `computeTreeHash()`'s whole-tree hash in a fully legitimate run — the exact tree movement `/re-gate`
// exists for guarantees this. A stamp only proves *some* tree produced this file; it says nothing about
// *which ticket* the file is about, and "a `spec.json` from a different ticket against an unchanged tree
// reads fresh" is precisely the gap a pure freshness check leaves open. So this checks two different
// things, not one: `--ticket` verifies identity (content), and a required, present `stamp` of the
// correct shape (see "`/re-gate`" below) is a hygiene signal that the file went through the documented
// authoring path (`write-stamp.mjs`) at some point, rather than being hand-dropped or left over from
// something else entirely — NOT proof that it did. A stamp is four unauthenticated JSON fields; a
// hand-written one using the right shape (correct field names/types, hex strings of the right length)
// satisfies this check exactly as well as a genuine one. CORRECTED (PL-04 review pass 3 / Warning 1a):
// this comment, the refusal message below, and two other sites all previously described this check as
// verifying the file "was actually produced by this pipeline's own tooling," which overclaims what four
// unauthenticated fields can prove — see `pipeline-contracts.mjs`'s `readStamp` doc comment for the
// corrected, precise claim, and that function's own new hex-shape check for the one real (still
// non-authenticating) improvement this round makes.
//
// CORRECTED (PL-04 review pass 3 / Warning 2): a `--re-gate` run's `--ticket` was, until this fix, only
// cross-checked against `spec.json`'s own `ticket` field — but `spec.md`, not `spec.json`, is what gets
// copied verbatim into the ledger (see "Writes" below) and what `index.json`'s `spec` pointer resolves
// to (`.sdd/ledger/README.md`'s query path). A matching, correctly-stamped `spec.json` sitting beside a
// leftover `spec.md` from a different ticket passed every check that existed and filed the wrong spec
// body under the right-looking ticket name. `main()` now also runs `extractTicketId` over `spec.md`'s
// own first-line heading and refuses on a mismatch, the same way it already does for `spec.json` — see
// the "`/re-gate`" section below.
//
// CORRECTED (SEC-10 v2 fix round — FND-bd78355b6ae7, HIGH): every check named in the two paragraphs
// above was scoped inside `if (regate)` — the PLAIN (non-`--re-gate`) path applied none of them.
// Security reproduced end to end that a `spec.json` naming one ticket beside a `spec.md` headed with a
// different one, both `review.json`/`security.json` genuinely PASS and stamped fresh, produced exit 0
// on the plain path and filed the wrong spec body under the right-looking ticket name — the literal,
// documented next action `.claude/skills/security/SKILL.md` instructs on a PASS immediately following
// an already-PASS `review.json`, reachable with no `--re-gate` involved at all. Fixed by moving the
// spec.json/spec.md agreement check to run unconditionally in `main()` (it needs no `--ticket` — see
// that check's own comment for why this, and not a `--ticket` requirement on the plain path too, is
// the right scope for this fix); `--ticket`'s own cross-check and the stamp-presence check remain
// `--re-gate`-specific, since only `--re-gate` supplies an external ticket assertion at all. See the
// "`/re-gate`" section below for the full, current shape of all three checks.
//
// A re-gate entry is deliberately **not** excluded from `index.json`'s file->spec map the way a
// `--hotfix` or overridden (`bypass: true`) entry is: `review`/`security` genuinely ran against the
// current tree and produced a real `PASS`, so `.sdd/ledger/<run-id>/spec.md` genuinely is the spec
// that tree was reviewed against — a later "which spec governs this file" query should still be able
// to find it. What `regate` adds to `entry.json`/`entry.md` is disclosure (that this PASS came from a
// re-gate, and whether tester ran), never exclusion — see buildEntryJson's own comment for the exact
// shape. build-ledger-index.mjs's `readEntryJson` DOES read `regate` (PL-04 / item 3) — not to decide
// whether to index a run (that is still `bypass` alone), but to carry `{ testerRan }` forward into
// every index.json record a re-gated run produces, so a reader following the fast path (buggy file ->
// index.json) sees the attribution is qualified without a second hop into entry.json.
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
//
// CORRECTED (security-precondition fix round, this branch — advisory finding 1, rated "arguably the
// more severe version of exactly the problem `/re-gate` exists to solve"): every check this file has
// ever run against review.json/security.json asked WHICH TICKET or WHICH VERDICT — none asked whether
// the verdict being cited was still current for the tree actually being attributed to it. `/re-gate`'s
// entire documented procedure (`.sdd/pipeline.md`'s `/re-gate` section) is "re-run the gates against
// the hand-edited tree, THEN write the ledger entry" — but that ordering was enforced only by an agent
// following prose, never by this script. `node scripts/ledger-append.mjs`, `--re-gate` or the plain
// path alike, could be invoked against an old, stale-but-`PASS` review.json/security.json pair left
// over from before a later, never-reviewed edit landed, and would write a durable entry whose live-diff
// `filesTouched` (see `filesTouched()` below) includes that later edit anyway — exactly the laundering
// `/re-gate` exists to make impossible, reachable without ever touching `--re-gate` at all. Fixed:
// `refuseIfStale()` below runs `pipeline-contracts.mjs`'s `stampFreshness` against both review.json's
// and security.json's own `stamp` field, unconditionally, and refuses the same way
// `.sdd/stages/security.md` already refuses on a stale `review.json` — the one asymmetry to respect
// (per that same security finding) is that `spec.json` is documented elsewhere as trusted-fresh and
// legitimately reads "stale" mid-run (dev/tester/review's own later edits routinely move the tree out
// from under it) and must NOT be refused on that basis; `refuseIfStale` is therefore never called on
// `spec.json` — only on the two sidecars whose entire job is asserting "this tree passed."

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeIndex } from './build-ledger-index.mjs';
import {
  readChangesJson,
  readJsonFile,
  readRedJson,
  readReviewJson,
  readSecurityJson,
  readSpecJson,
  stampFreshness,
  STAMP_FRESH,
  STAMP_STALE,
} from './pipeline-contracts.mjs';
import { matchesAny, readBounds } from './check-bounds.mjs';
import { countChangedLines, evaluateLiteEligibility, maxChangedLineLength } from './check-lite-eligible.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');
const pipelineDir = join(repoRoot, '.pipeline');
const securityHistoryDir = join(pipelineDir, 'security-history');
const ledgerDir = join(repoRoot, '.sdd', 'ledger');

function fail(message) {
  process.stderr.write(`ledger-append: ${message}\n`);
  process.exit(1);
}

/** PL-04 / item 2 (the general defect): fails, naming the exact unrecognized token, if `argv`
 * contains anything other than the flags in `knownFlags`. This is the fix for the shape of bug this
 * round's item 1 found concretely — an argv loop that recognizes some tokens and silently skips
 * everything else, which is exactly what let `--re-gate --tester-ran true` do nothing at all,
 * silently, before this flag existed: the two tokens matched nothing this file's old argv-scanning
 * code looked for, so they were quietly ignored and this script fell through to its normal path,
 * writing an ordinary ledger entry indistinguishable from a real, unedited pass. A typo'd flag must
 * never look like it worked.
 *
 * `valueFlags` are flags that consume the following token as their value (skipped here, whatever it
 * is, so it is never itself flagged as unrecognized — the flag-specific reader downstream is what
 * validates the value itself). `stopAt`, if given, is a flag (e.g. `--files`) that consumes every
 * remaining token once seen, matching `parseHotfixArgs`'s own `--files` handling — validation stops
 * the instant it's reached, since nothing after it is a flag to validate.
 *
 * @param {string[]} argv
 * @param {{ knownFlags: Set<string>, valueFlags?: Set<string>, stopAt?: string | null }} options
 *   Required, with no default — every real call site passes it (annotated explicitly, PL-04 / item 4,
 *   because plain JS parameter-shape inference from a destructuring default only sees properties that
 *   HAVE a default value; without this JSDoc, `checkJs` infers an options type that silently omits
 *   `knownFlags` entirely, which then flags every real call site's `knownFlags: ...` as an unknown
 *   property — a false positive from missing type information, not a real defect). */
function assertKnownFlags(argv, { knownFlags, valueFlags = new Set(), stopAt = null }) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (stopAt && arg === stopAt) return;
    if (!knownFlags.has(arg)) {
      fail(`unrecognized argument "${arg}" — known flags: ${[...knownFlags].join(', ')}. A typo'd flag must never look like it worked.`);
    }
    if (valueFlags.has(arg)) i++;
  }
}

function readPipelineFile(name, { required = true } = {}) {
  const path = join(pipelineDir, name);
  if (!existsSync(path)) {
    if (required) fail(`.pipeline/${name} does not exist. Run the pipeline through to a terminal PASS before appending a ledger entry.`);
    return null;
  }
  return readFileSync(path, 'utf8');
}

/** Refuses, naming `sidecarName`, when `stamp`'s recorded `treeHash` no longer matches the tree right
 * now — see this file's own header ("CORRECTED (security-precondition fix round...)") for the finding
 * this closes: `/re-gate`'s documented procedure re-runs the gates before writing a ledger entry, but
 * nothing on this script ever verified that had actually happened, on `--re-gate` or the plain path
 * alike. Called on `review.json`'s and `security.json`'s own `stamp` — never on `spec.json`'s, which is
 * documented elsewhere (`.sdd/stages/dev.md`'s "Staleness of required inputs" section,
 * `.sdd/pipeline.md`'s "Staleness stamps" section) as trusted-fresh and legitimately reads "stale"
 * mid-run, since `dev`/`tester`/`review`'s own later edits routinely move the tree out from under it in
 * a fully legitimate run — the exact tree movement `/re-gate` exists for.
 *
 * Deliberately unconditional: this runs before, and independently of, `--override-review`/
 * `--override-security`'s own acceptance of a non-PASS verdict (see main()'s call sites, both before
 * the corresponding `*Overridden` check). An override records "I accept this gate's real, non-PASS
 * verdict, for a stated reason" — never "I accept a verdict computed against a tree that has since
 * moved on further still." Those are two independent axes (which verdict literal is acceptable; whether
 * the sidecar still describes the tree right now), and only the first one has a sanctioned override.
 *
 * `stampFreshness` returns `STAMP_UNKNOWN` (never `STAMP_STALE`) for a sidecar with no `stamp` field at
 * all — every artifact written before this contract existed, and every fixture in this file's own test
 * suite that doesn't attach one — and this function only refuses on `STAMP_STALE`, matching
 * `.sdd/stages/security.md`'s own stated posture toward its other consumer of this exact fact ("An
 * `\"unknown\"` result... is not the same as stale and does not trigger a refusal on its own"). */
function refuseIfStale(sidecarName, stamp) {
  if (stampFreshness(stamp) !== STAMP_STALE) return;
  fail(
    `.pipeline/${sidecarName}'s stamp is STALE — the tree has moved on since it was written (run ` +
    `\`node scripts/check-stamp-freshness.mjs ${sidecarName}\` to see this directly). A stale PASS is ` +
    'not a passed gate: this run\'s live-diff "Files touched" could include later, never-reviewed edits ' +
    `that ${sidecarName.replace(/\.json$/, '')} never actually saw — the same posture ` +
    '.sdd/stages/security.md already takes toward a stale review.json, applied here at the other place a ' +
    'stale verdict could otherwise be recorded durably. Re-run the gate against the current tree — or, ' +
    'for a tree that was hand-edited outside dev\'s own loop, go through `/re-gate`, which re-runs ' +
    'review/security before this step is ever reached — before appending a ledger entry.',
  );
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
 * same size-capped, strict-parsing primitive `readJsonSidecar` uses — see that file's own comment.
 *
 * PL-04 / B2, B3: `claimedVerdict` and `{ allowNonPassVerdict }` support `--override-security`'s
 * sanctioned-override path (see the "Sanctioned overrides" section below). By default (no override)
 * this function's own independent check is unchanged from every prior round: `results.json`'s verdict
 * must be exactly `PASS`, full stop, regardless of what `security.json` claims. When a caller has
 * already recorded a reasoned override for a non-PASS security verdict, this still refuses to accept
 * just anything — `results.json`'s own verdict must equal `claimedVerdict` (i.e. `security.json`'s own
 * cited verdict), so an override can record "security really did say BLOCKED, and here is why I am
 * recording that anyway," never "security.json says one thing and its own immutable audit trail says
 * another." The independent cross-check against the immutable record is preserved either way — an
 * override changes what verdict is *acceptable*, never whether the two files must agree with each
 * other. */
function findCompletedSecurityRun(runId, claimedVerdict, { allowNonPassVerdict = false } = {}) {
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
  if (allowNonPassVerdict) {
    if (results.verdict !== claimedVerdict) {
      fail(
        `Security run ${runId}'s own results.json verdict (${results.verdict}) does not match ` +
        `.pipeline/security.json's claimed verdict (${claimedVerdict}) — an override records the verdict ` +
        'the security run actually reached, not a mismatched one. Re-run security, or correct security.json.',
      );
    }
  } else if (results.verdict !== 'PASS') {
    fail(`Security run ${runId}'s verdict is ${results.verdict}, not PASS.`);
  }
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

/** Default sidecar set for an ordinary (non-lite) run — see doc comment below. */
const DEFAULT_SIDECAR_NAMES = ['spec.json', 'red.json', 'changes.json', 'review.json', 'security.json'];

/** PL-11: the `--lite` branch's own sidecar set — deliberately excludes `red.json`/`security.json`
 * even when a leftover copy of either exists on disk (EC-9/EC-10/EC-11): the lite lane ran neither
 * stage, so copying either sidecar into the ledger would manufacture evidence of a stage that never
 * ran this round. */
const LITE_SIDECAR_NAMES = ['spec.json', 'changes.json', 'review.json'];

/** Copies whichever of `names` exist for this run into `.sdd/ledger/<runId>/`, verbatim
 * (byte-for-byte, like spec.md's own copy) — not re-serialized from the already-validated in-memory
 * object, so the ledger's copy is provably identical to what the owning stage actually wrote, not a
 * reconstruction of it. `red.json`/`changes.json` are optional on the default (non-lite) set (a
 * ticket that predates `red`, or one implemented directly without a separate `dev` sidecar this run);
 * `spec.json`/`review.json`/`security.json` are always present by the time this function runs on that
 * path, since main() already required all three to compute the entry itself. `names` defaults to the
 * full five-sidecar set (PL-11 / Interfaces — `copySidecarsIntoLedger(runId, names?)`); the `--lite`
 * branch passes `LITE_SIDECAR_NAMES` explicitly instead. */
function copySidecarsIntoLedger(runId, names = DEFAULT_SIDECAR_NAMES) {
  const destDir = join(ledgerDir, runId);
  for (const name of names) {
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

/** PL-04 review pass 3 / Warning 2: extracts the ticket id from `spec.md`'s own first-line heading
 * (`# <ticket title>` — `.sdd/stages/planner.md`'s step 4 documents `spec.json`'s `ticket` field as
 * "the full title exactly as it appears on spec.md's '# ' line," so this reads the one line that field
 * is itself authored from). Used ONLY by `--re-gate`'s own spec-identity check below, never as a general
 * spec.md parser — this is deliberately narrow, unlike the markdown-structure parsing PL-03h round 4
 * removed everywhere else in this file (see this file's own header): there is exactly one line to read
 * (the first non-blank one), no heading/fence/comment ambiguity to resolve, and no shadowing surface for
 * an adversarial value to hide behind. If the first line isn't `#`-prefixed at all (a malformed or
 * hand-edited spec.md), `extractTicketId` simply fails to find its pattern in whatever text is there and
 * falls back to that raw text — which then visibly fails to match `--ticket`'s value, the same
 * self-checking behavior `extractTicketId` already has on `spec.json`'s own `ticket` field. */
function extractTicketIdFromSpecMarkdown(specMarkdown) {
  const firstLine = specMarkdown.split(/\r?\n/).find((line) => line.trim().length > 0) ?? '';
  return extractTicketId(firstLine.trim().replace(/^#\s*/, ''));
}

function formatBulletList(items) {
  return items.map((item) => `- ${item}`).join('\n');
}

/** The fixed disclosure sentence `entry.json`'s `regate.note` carries — see .sdd/ledger/README.md's
 * "Re-gate entries" section, which specifies this exact wording as part of the `regate` object's
 * documented shape. A fixed string, not reconstructed per call, so entry.json's `regate.note` can
 * never quietly drift from what README.md documents it as. */
const REGATE_NOTE = 'code was changed in the working tree outside the pipeline\'s dev stage before ' +
  'this run; changes.md/changes.json describe the tree as it stood before that edit';

/** `redTestPaths` is the list `red.json`'s own `tests` array reported; `redAbsenceNote` is only used
 * when there is no such list to report (either `red.json` doesn't exist at all, or it exists but
 * lists no tests) — the section always says something, never sits blank.
 *
 * `overrides` (PL-04 / B2, B3 — default `[]`) is `main()`'s own record of which gate(s), if any, were
 * accepted despite a non-PASS verdict via `--override-review`/`--override-security`, each with its
 * required reason (see the "Sanctioned overrides" section below) — rendered here so the override, and
 * why it happened, is legible directly in the human-facing entry, not only inferable from `## Verdicts`
 * showing something other than PASS. Always rendered (never omitted, matching this file's own "Red-test
 * paths"/"Files touched" convention of saying something explicit rather than leaving a section absent),
 * so its absence-of-content ("(none — both gates passed on their own)") is itself a positive, checkable
 * statement, not silence that could be mistaken for "nobody checked." CORRECTED (security-precondition
 * fix round, this branch — advisory finding 3): a non-empty `overrides` now also puts an `(OVERRIDE)`
 * marker on the title line (below), the same visible-at-a-glance treatment `(RE-GATE)`/
 * `(HOTFIX BYPASS)` already get. Before this fix, an overridden entry's title was the bare
 * `# Ledger entry — <runId>` — identical in shape to a genuine clean pass; the `## Overrides` section's
 * content was always honest, but a reader skimming `.sdd/ledger/` had to open the file to learn a gate
 * had been overridden at all.
 *
 * `regate` (PL-04 / item 1 — default `null`) is `main()`'s own record of a `--re-gate` run (see the
 * "Sanctioned overrides" section below, which this immediately follows in the file, for the fuller
 * reasoning) — `{ testerRan, gatesOnly }`, or `null` for an ordinary run. When present: the title
 * gains a `(RE-GATE)` suffix (visibly distinct at a glance, the same reasoning `(HOTFIX BYPASS)` uses
 * for buildHotfixEntryMarkdown below — though, unlike a hotfix, a re-gate entry really did pass both
 * gates), and a dedicated `## Re-gate` section is inserted immediately after `## Verdicts` stating
 * plainly that the gates were re-executed against a tree hand-edited after `changes.md` was written,
 * and whether `tester` ran on this pass. Omitted entirely (not merely rendered empty) for an ordinary
 * run, so a ledger entry from before this flag existed, and every entry this round doesn't touch,
 * renders byte-identically to before. `regate` and a non-empty `overrides` compose freely on the title
 * line too (`(RE-GATE)` before `(OVERRIDE)`, matching the same ordering `## Re-gate`/`## Overrides`
 * already use in the body — see "Entry format" in `.sdd/ledger/README.md`).
 *
 * `lite` (PL-11 — default `null`) is `main()`'s own record of a `--lite` run: `{ skippedStages, note,
 * eligibility: { fileCount, changedLines, maxFiles, maxChangedLines } }`, or `null` for every other
 * run. When present: the title gains a `(LITE)` marker (markers compose `(RE-GATE)(LITE)(OVERRIDE)`,
 * matching the order `.sdd/ledger/README.md`'s "Lite-lane entries" section documents), a `## Lite
 * lane` section is inserted immediately after `## Verdicts` naming the skipped stages, the fixed
 * disclosure note verbatim, and the eligibility numbers this run was measured against, and `## Security
 * run ID` states plainly that the stage did not run rather than pointing at a nonexistent directory. */
export function buildEntryMarkdown({ runId, date, ticketId, ticketTitle, goal, files, redTestPaths, redAbsenceNote, securityRunId, commitLine, reviewVerdict, securityVerdict, overrides = [], regate = null, lite = null }) {
  const lines = [];
  const titleMarkers = `${regate ? ' (RE-GATE)' : ''}${lite ? ' (LITE)' : ''}${overrides.length > 0 ? ' (OVERRIDE)' : ''}`;
  lines.push(`# Ledger entry — ${runId}${titleMarkers}`);
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
  // the time this runs, main() has already exited unless both equal exactly 'PASS' or the non-PASS
  // one(s) were accepted via a recorded --override-review/--override-security (see main()), so this
  // can never write a value main() didn't itself verify or an operator didn't explicitly override.
  lines.push(`- review: ${reviewVerdict}`);
  lines.push(`- security: ${securityVerdict}`);
  lines.push('');
  if (lite) {
    lines.push('## Lite lane');
    lines.push(lite.note);
    lines.push('');
    lines.push(`Skipped stages: ${lite.skippedStages.join(', ')}.`);
    lines.push(
      `Eligibility measured against this lane's bounds: max_files ${lite.eligibility.maxFiles}, ` +
      `max_changed_lines ${lite.eligibility.maxChangedLines} — this run measured ` +
      `${lite.eligibility.fileCount} file(s) and ${lite.eligibility.changedLines} changed line(s).`,
    );
    lines.push('');
  }
  if (regate) {
    lines.push('## Re-gate');
    lines.push(
      'This run\'s review/security verdicts were produced by re-running the gates against a tree ' +
      'that was hand-edited directly, outside `dev`\'s own re-invocation loop, after `changes.md`/' +
      '`changes.json` were written for this ticket — see `.sdd/pipeline.md`\'s `/re-gate` section. ' +
      '`changes.md`/`changes.json` describe the tree as it stood **before** that hand-edit, not as ' +
      'it stands now. `tester` ' +
      (regate.testerRan
        ? 'was re-run against the hand-edited tree on this pass.'
        : 'was skipped on this pass (`/re-gate --gates-only`).'),
    );
    lines.push('');
  }
  lines.push('## Overrides');
  lines.push(
    overrides.length > 0
      ? overrides.map((o) => `- ${o.gate}: actual verdict was ${o.verdict}, accepted anyway. Reason: ${o.reason}`).join('\n')
      : '(none — both gates passed on their own; nothing here was overridden)',
  );
  lines.push('');
  lines.push('## Red-test paths');
  lines.push(redTestPaths.length > 0 ? formatBulletList(redTestPaths) : redAbsenceNote);
  lines.push('');
  lines.push('## Security run ID');
  lines.push(
    lite
      ? '(none — the security stage did not run on this lane; see "## Lite lane" above)'
      : `.pipeline/security-history/${securityRunId}/`,
  );
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
 * structurally unable to disagree on the facts, even though they are two separate files on disk.
 *
 * PL-04 / B2, B3: `overrides` (default `[]`) is the machine-facing twin of buildEntryMarkdown's own
 * "## Overrides" section — always present, empty when nothing was overridden, same convention as
 * `redTestPaths`. `bypass` is derived here, not accepted as a separate caller-supplied flag, so it can
 * never drift from the verdicts it describes: it is `true` exactly when `reviewVerdict`/`securityVerdict`
 * are not BOTH literally `'PASS'` — i.e. exactly the runs `main()` could only write because an override
 * was recorded (see main()'s own gate checks; there is no other way to reach this function with a
 * non-PASS verdict). Reuses `build-ledger-index.mjs`'s existing hotfix-bypass exclusion mechanism
 * verbatim (B3's explicit instruction) rather than inventing a second, parallel "excluded" concept: a
 * run whose real, final verdict was not PASS never answers "which spec governs this file," because no
 * spec was ratified, the exact same reason a hotfix entry never does.
 *
 * `regate` (PL-04 / item 1 — default `null`) is the machine-facing twin of buildEntryMarkdown's own
 * `## Re-gate` section: `{ testerRan, gatesOnly, note: REGATE_NOTE }` for a `--re-gate` run, `null`
 * otherwise. Always present as a key (never omitted) so its absence is a checkable `null`, the same
 * "say something explicit" convention `redAbsenceNote` already uses — but, deliberately, NOT folded
 * into `bypass`: a re-gate run's verdicts really are PASS/PASS and its spec really was ratified
 * against the current tree, so build-ledger-index.mjs's `readEntryJson` never treats this field as a
 * reason to exclude a run — `regate` is disclosure sitting alongside an ordinary, indexed entry, not
 * a second bypass mechanism. (PL-04 / item 3: `readEntryJson` DOES read this field — to carry
 * `{ testerRan }` forward into every index.json record the run produces, so the qualification is
 * visible from the fast index path too, not only from this file — see build-ledger-index.mjs's own
 * header comment.) See .sdd/ledger/README.md's "Re-gate entries" section for why exclusion is the
 * wrong call here, unlike for `bypass`.
 *
 * `lite` (PL-11 — default `null`) is the machine-facing twin of buildEntryMarkdown's own `## Lite
 * lane` section: `{ skippedStages, note, eligibility }` for a `--lite` run, `null` otherwise. `bypass`
 * is amended to `reviewVerdict !== 'PASS' || (!lite && securityVerdict !== 'PASS')` — an ordinary lite
 * run's `securityVerdict` is the distinct literal `'SKIPPED_LITE'`, never `'PASS'`, so without this
 * amendment every lite run would read `bypass: true` and be silently excluded from `index.json`'s
 * file->spec map even though it has a real, ratified spec `review` genuinely passed against the final
 * tree (spec.md's Open questions #2) — `!lite` is what keeps a genuine `--lite --override-review` run
 * (where `reviewVerdict !== 'PASS'` on its own already forces `bypass: true`) excluded exactly like
 * any other override, without also excluding an ordinary lite pass. */
export function buildEntryJson({ runId, date, ticketId, ticketTitle, goal, files, redTestPaths, redAbsenceNote, securityRunId, commit, reviewVerdict, securityVerdict, overrides = [], regate = null, lite = null }) {
  const bypass = reviewVerdict !== 'PASS' || (!lite && securityVerdict !== 'PASS');
  return {
    runId,
    date,
    ticket: ticketId,
    ticketTitle,
    goal: goal || null,
    filesTouched: files,
    verdicts: { review: reviewVerdict, security: securityVerdict },
    overrides,
    bypass,
    regate: regate ? { testerRan: regate.testerRan, gatesOnly: regate.gatesOnly, note: REGATE_NOTE } : null,
    lite,
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

// PL-04 / item 2: `argv` here is `process.argv.slice(2)` — it still contains `--hotfix` itself (the
// token main()'s own dispatch below matched to route here in the first place), so `--hotfix` is
// listed as a known, no-op flag rather than left to fall through unchecked the way every other
// unrecognized token now fails loudly.
const HOTFIX_KNOWN_FLAGS = new Set([
  '--hotfix',
  ...Object.values(HOTFIX_REQUIRED_FLAGS),
  '--lane',
  '--files',
]);
const HOTFIX_VALUE_FLAGS = new Set([...Object.values(HOTFIX_REQUIRED_FLAGS), '--lane']);

function parseHotfixArgs(argv) {
  assertKnownFlags(argv, { knownFlags: HOTFIX_KNOWN_FLAGS, valueFlags: HOTFIX_VALUE_FLAGS, stopAt: '--files' });
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

/** A fresh, sortable, collision-safe run id in the `<timestamp>-<shortsha>-<MODE>-<random>` shape
 * every ledger run id already uses (see security-checker's own id convention) — one implementation,
 * not one per caller. `generateHotfixRunId` (below) delegates to this with `'HOTFIX'`; the `--lite`
 * branch (PL-11) calls it directly with `'LITE'` — there is no security run for either to reuse an id
 * from (a hotfix never runs security at all; a lite run deliberately skips it), so each mints its own,
 * still sorting chronologically alongside normal entries in `.sdd/ledger/`'s directory listing. The
 * mode segment (`HOTFIX`/`LITE`/...) is what makes a non-ordinary entry visually distinct from a
 * `PR_DELTA`/`REMEDIATION_RECHECK` one at a glance, on top of whichever structural field
 * (`bypass: true`, `lite: {...}`) `build-ledger-index.mjs` actually reads. */
export function generateRunId(mode, { cwd = repoRoot } = {}) {
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace('.', '');
  let shortSha = 'nogit0000000';
  try {
    shortSha = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd, encoding: 'utf8' }).trim() || shortSha;
  } catch {
    // No git, no HEAD yet, or git unavailable — a hotfix (or a lite run) must still be writable in a
    // degraded environment, so fall back rather than fail.
  }
  const random = randomBytes(3).toString('hex');
  return `${timestamp}-${shortSha}-${mode}-${random}`;
}

/** Delegates to `generateRunId('HOTFIX', ...)` — kept as its own named export since every existing
 * caller (this file's own `runHotfix`, and `scripts/ledger-append.test.mjs`) already imports it by
 * this name. */
export function generateHotfixRunId(options = {}) {
  return generateRunId('HOTFIX', options);
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

// --- Sanctioned overrides (PL-04 / B2, B3) ----------------------------------------------------------
//
// B2 (observed): a human needed to record a run whose review.json (or security.json) verdict was not
// PASS — deliberately, for a stated reason. There was no sanctioned way to say "proceed anyway," so the
// override happened by hand-editing a subagent prompt instead, and left no artifact, no ledger entry,
// nothing a future reader could find. "An override that is easier to use than to record is the same
// failure again" — so this is built the other way around: using the override AT ALL requires supplying
// its reason, in the same command, or it does not happen.
//
// CORRECTED (security-precondition fix round, this branch — advisory finding 3, disclosure-vs-authority
// half): this section, `readOverrideReason`'s own refusal message, and every other site describing this
// mechanism used to say a human records a non-PASS verdict "on their own authority" — language implying
// an authorization check that does not exist anywhere in this script. Nothing here verifies WHO invoked
// `--override-review`/`--override-security`; any agent or human with shell access to this repo can
// supply either flag. What actually exists, and all that is claimed below, is a **disclosure**
// requirement: the reason string becomes a permanent, readable part of the ledger entry
// (`entry.md`'s `## Overrides` section, `entry.json`'s `overrides` array), and the entry is visibly
// distinguishable at a glance from a clean pass (its title now carries an `(OVERRIDE)` marker — see
// `buildEntryMarkdown`'s own comment — the same reasoning `(RE-GATE)`/`(HOTFIX BYPASS)` already use).
// It is not a gate on WHO may accept a non-PASS verdict, only a guarantee that IF one is accepted, it is
// recorded rather than silently vanishing. Building an actual authorization scheme (checking the
// invoking identity against some allowed-approvers list) was not asked for and is not what this fixes —
// only the prose is corrected here, to say what this mechanism actually does.
//
// B3 (observed, same root cause from the other direction): ledger-append only ever wrote an entry on
// a genuine terminal PASS; every run that reached a real, final NEEDS_FIXES/BLOCKED verdict (PL-03a's
// three rounds among them) left nothing durable at all, even though "the runs that fail are the
// informative ones." `--override-review`/`--override-security` are the one mechanism that answers
// both: recording a non-PASS terminal state IS exactly what supplying a reasoned override does, so
// there is no separate "record a failure" flag to add on top of it.
//
// `--override-review "<reason>"` accepts review.json's verdict even when it is not PASS, given a
// non-empty reason; `--override-security "<reason>"` does the same for security.json (and, via
// `findCompletedSecurityRun`'s `allowNonPassVerdict`, its own independent cross-check against
// security-history/<run-id>/results.json — the override changes what verdict is acceptable there too,
// never whether the two files must still agree with each other). Either, both, or neither may be
// supplied independently; a flag is only "used" (and only appears in the recorded `overrides` list) if
// that specific gate's own verdict actually was not PASS — passing `--override-review` when review.json
// already says PASS is simply inert, not an error, since there was nothing on that gate to override.
//
// Every entry written this way still requires every other precondition main() already enforced
// unchanged (spec.md/spec.json must exist, the cited security run must exist and be COMPLETE, the
// run directory must not already exist, ...) — an override widens exactly one thing: which verdict
// literal is acceptable on the gate(s) named, never anything else.
//
// The resulting entry.json carries `bypass: true` (buildEntryJson derives this from the verdicts
// themselves — see that function's own comment) — B3's explicit instruction to reuse
// build-ledger-index.mjs's existing hotfix-bypass exclusion mechanism verbatim, rather than invent a
// second, parallel "this entry doesn't count" concept. A run recorded this way still gets its
// spec.md/spec.json/red.json/changes.json copied into the ledger exactly like a normal PASS run (there
// really was a spec, and it really was implemented against) — the one thing bypass:true changes is
// that index.json's file->spec map excludes it, because a non-PASS run never had its spec ratified.

/** Reads `--override-review`/`--override-security`'s value out of `argv`, enforcing B2's "no reason,
 * no override" rule at the point the flag is parsed, not later. Returns `null` when the flag was not
 * given at all (no override requested for that gate) — never `null` for "the flag was given but
 * empty"; that case fails loudly, naming the flag, instead. */
function readOverrideReason(argv, flagName) {
  const idx = argv.indexOf(flagName);
  if (idx === -1) return null;
  const value = argv[idx + 1];
  if (!value || value.startsWith('--') || !value.trim()) {
    fail(
      `${flagName} requires a non-empty reason string, e.g. ${flagName} "why you are proceeding anyway" ` +
      '— an override without a recorded reason is not sanctioned (B2: "refusing to provide a reason ' +
      'means the override does not happen"). Omit this flag entirely if you are not overriding this gate.',
    );
  }
  return value.trim();
}

// --- `/re-gate` (PL-04 / item 1) --------------------------------------------------------------------
//
// See this file's header ("`--re-gate --tester-ran <true|false> --ticket <id>`" paragraph, immediately
// after the "Sanctioned overrides" preconditions paragraph) for the full reasoning. In short: `/re-gate`
// existed only as documentation (`.sdd/pipeline.md`) and a skill shim before this — the flag its own
// step 5 names, `--re-gate --tester-ran <true|false>`, did not exist on this script at all. Because
// every argv token this file didn't already recognize was silently skipped (the exact defect PL-04 /
// item 2 fixes generally, see `assertKnownFlags` above), running `/re-gate`'s documented command against
// a `PASS` review.json would have written an ORDINARY ledger entry — indistinguishable from a run that
// actually passed through `dev`'s own loop — which is precisely the laundering `/re-gate` exists to
// make impossible. Implemented here to close that gap for real, not merely to stop the silent
// no-op: `--re-gate`/`--tester-ran` are additive metadata on the *normal* (non-`--hotfix`) path,
// requiring the exact same PASS/PASS (or overridden) preconditions every other normal run does.
// `--ticket` (PL-04 review pass 2 / Critical 1, added later than the rest of this section) is a further
// precondition specific to this path alone — see the header paragraph it points back to, and
// `readRegateArgs`/`main()` below, for why.

// --- `--lite` (PL-11) ---------------------------------------------------------------------------
//
// The ledger step of the `/pipeline-lite` lane (`.sdd/pipeline.md`'s `### /pipeline-lite <ticket>`
// section): `planner` -> `dev` -> `tester` -> `review` -> ledger, deliberately skipping `red` and
// `security`. `--lite` is a branch inside `main()`, not a parallel `runLite()` (unlike `--hotfix`,
// which shares almost none of `main()`'s preconditions): it shares review.json's verdict gate, the
// unconditional spec.json/spec.md agreement check, `filesTouched`, and the run-directory overwrite
// guard, and only diverges for what genuinely differs — no security.json requirement, an eligibility
// check against the live diff, and the fixed `lite` disclosure threaded into the entry.

/** Fixed, derived — never caller-supplied (AC-8: "skippedStages and note are derived by the script,
 * never caller-supplied" — there is no `--skipped-stages`/`--lite-note` flag). */
export const LITE_SKIPPED_STAGES = ['red', 'security'];

/** The distinct verdict literal a lite run's `entry.json`/`entry.md` record for the security gate —
 * never `'PASS'` (a stage that did not run cannot have passed) and never `'BLOCKED'` (nothing ran to
 * block). `build-ledger-index.mjs`'s widened verdicts gate accepts this literal only from an entry
 * that also declares a `lite` object listing `'security'` among its `skippedStages` (EC-15). */
export const LITE_SECURITY_VERDICT = 'SKIPPED_LITE';

/** The fixed lite-lane disclosure sentence — a constant, not reconstructed per call, so `entry.json`'s
 * `lite.note` (and `entry.md`'s `## Lite lane` section, which renders it verbatim) can never quietly
 * drift from what `.sdd/ledger/README.md`'s "Lite-lane entries" section documents it as (the same
 * reasoning `REGATE_NOTE` above already applies). */
export const LITE_NOTE = 'this run took the lite lane (`.sdd/pipeline.md`\'s `/pipeline-lite`): ' +
  '`red` did not author tests before `dev` ran, so any test covering this change was written after ' +
  'the diff existed; and the `security` stage did not run at all — no attacker-brief sweep, no ' +
  'CORE-01..06 pass, and no immutable audit record exists for this run. Eligibility was checked ' +
  'mechanically against `.sdd/bounds.yml`\'s `lite_eligibility` bounds and the barred-path union, ' +
  'which is a curated, best-effort list, not a complete classifier of security-sensitive code.';

const MAIN_KNOWN_FLAGS = new Set(['--override-review', '--override-security', '--re-gate', '--tester-ran', '--ticket', '--lite']);
const MAIN_VALUE_FLAGS = new Set(['--override-review', '--override-security', '--tester-ran', '--ticket']);

/** Reads `--re-gate`/`--tester-ran`/`--ticket` off argv. Returns `null` when this is not a re-gate run
 * (none of the three flags given) — never `null` for "given but malformed"; that fails loudly, naming
 * the flag, same as `readOverrideReason`'s own convention. `testerRan`/`gatesOnly` are exact inverses of
 * each other by construction (.sdd/ledger/README.md's own stated invariant: "both are recorded, rather
 * than just one, so a reader never has to infer one from the absence of the other") — there is
 * deliberately no separate `--gates-only` flag to this script; the *command* (`.sdd/pipeline.md`'s
 * `/re-gate [--gates-only]`) is what decides whether tester ran, and reports that decision here via
 * `--tester-ran` literally, which is the one fact this script needs.
 *
 * CORRECTED (PL-04 review pass 2 / Critical 1): `--ticket <id>` is new — see this file's own header
 * ("CORRECTED (PL-04 review pass 2 / Critical 1)" paragraph) for why. It is required whenever `--re-gate`
 * is given, exactly like `--tester-ran`, and this function only validates that it was SUPPLIED and is
 * non-empty — whether it actually MATCHES `.pipeline/spec.json`'s own ticket is main()'s job, once
 * `spec.json` has actually been read (see the dedicated check there), not this function's. */
function readRegateArgs(argv) {
  const reGate = argv.includes('--re-gate');
  const testerRanIdx = argv.indexOf('--tester-ran');
  const ticketIdx = argv.indexOf('--ticket');
  if (!reGate) {
    if (testerRanIdx !== -1) {
      fail(
        '--tester-ran was given without --re-gate — it only means something as part of a re-gate run ' +
        '(.sdd/pipeline.md\'s /re-gate step 5). Pass --re-gate --tester-ran <true|false> --ticket <id> ' +
        'together, or omit all three.',
      );
    }
    if (ticketIdx !== -1) {
      fail(
        '--ticket was given without --re-gate — it only means something as part of a re-gate run ' +
        '(.sdd/pipeline.md\'s /re-gate step 1: the caller\'s own assertion of which ticket ' +
        '.pipeline/spec.json must describe). Pass --re-gate --tester-ran <true|false> --ticket <id> ' +
        'together, or omit all three.',
      );
    }
    return null;
  }
  if (testerRanIdx === -1) {
    fail(
      '--re-gate requires --tester-ran <true|false> — .sdd/pipeline.md\'s /re-gate step 5 always ' +
      'records whether tester actually ran on this pass, so a fast re-gate (--gates-only) is visibly ' +
      'distinct from a full one in the durable ledger entry, not merely convenient in the moment it ' +
      'was chosen.',
    );
  }
  const value = testerRanIdx + 1 < argv.length ? argv[testerRanIdx + 1] : undefined;
  if (value !== 'true' && value !== 'false') {
    fail(
      `--tester-ran requires exactly "true" or "false" (got ${value === undefined ? '(nothing)' : JSON.stringify(value)}) ` +
      '— the ledger records this literally; an ambiguous or missing value must never be guessed at.',
    );
  }
  const testerRan = value === 'true';

  if (ticketIdx === -1) {
    fail(
      '--re-gate requires --ticket <id> (e.g. --ticket "PL-04") — the ticket you believe you are ' +
      're-gating, stated explicitly by the caller. /re-gate is the one entry point that reaches the ' +
      'ledger without ever running planner, so unlike every other path nothing else on disk guarantees ' +
      '.pipeline/spec.json actually describes the run being gated; main() cross-checks this assertion ' +
      'against spec.json\'s own ticket field rather than trusting whatever spec happens to be on disk.',
    );
  }
  const ticketValue = ticketIdx + 1 < argv.length ? argv[ticketIdx + 1] : undefined;
  if (!ticketValue || ticketValue.startsWith('--') || !ticketValue.trim()) {
    fail(
      `--ticket requires a non-empty ticket id (got ${ticketValue === undefined ? '(nothing)' : JSON.stringify(ticketValue)}) ` +
      '— an ambiguous or missing value must never be guessed at.',
    );
  }

  return { testerRan, gatesOnly: !testerRan, ticket: ticketValue.trim() };
}

function main() {
  const argv = process.argv.slice(2);
  assertKnownFlags(argv, { knownFlags: MAIN_KNOWN_FLAGS, valueFlags: MAIN_VALUE_FLAGS });
  const lite = argv.includes('--lite');
  const overrideReviewReason = readOverrideReason(argv, '--override-review');
  const overrideSecurityReason = readOverrideReason(argv, '--override-security');
  const regate = readRegateArgs(argv);

  // PL-11 / AC-7 item 1: --lite is not combined with --override-security or --re-gate — checked
  // before any .pipeline/ file is even read, so this refusal can never be confused with one of the
  // checks below firing for an unrelated reason.
  if (lite) {
    if (overrideSecurityReason !== null) {
      fail(
        '--lite --override-security is not accepted — there is no security verdict on this lane to ' +
        'override (the lite lane skips `security` outright); accepting the flag silently would imply ' +
        'one existed. Omit --override-security on a --lite run.',
      );
    }
    if (regate) {
      fail(
        '--lite --re-gate is not accepted in this ticket — finish through the full lane instead (run ' +
        '`/security`, then `--re-gate`), or re-run `/review` against the current tree and use plain ' +
        '--lite (the non-stale review.json requirement below already forces this).',
      );
    }
  }

  const reviewJson = readReviewJson(pipelineDir);
  refuseIfStale('review.json', reviewJson.stamp);
  const reviewOverridden = reviewJson.verdict !== 'PASS' && overrideReviewReason !== null;
  if (reviewJson.verdict !== 'PASS' && !reviewOverridden) {
    fail(
      `.pipeline/review.json's verdict is ${reviewJson.verdict}, not PASS — this is not a terminal PASS. ` +
      'Route back to dev instead of appending a ledger entry, or, if you are deliberately disclosing this ' +
      'run\'s real terminal state for a stated reason, re-run with --override-review "<reason>" (the ' +
      'reason becomes part of the durable ledger entry, which is excluded from index.json\'s file->spec ' +
      'map — the same way a --hotfix bypass entry already is — because no spec was ratified).',
    );
  }

  // PL-11 / AC-7 item 3: on the lite path, security.json is never required — it is only checked, IF
  // it happens to exist, for a FRESH stamp (a security run that genuinely happened against this tree
  // must never be recorded as SKIPPED_LITE — EC-9). A STALE or unknown-stamped leftover (a leftover
  // from a prior ticket) is ignored, with an explicit printed note, and never copied into the lite
  // entry (EC-10). The plain path is unchanged: security.json is still required and must show PASS
  // (or be accepted via --override-security).
  let securityJson = null;
  let securityOverridden = false;
  if (lite) {
    const leftoverSecurityJson = readSecurityJson(pipelineDir, { required: false });
    if (leftoverSecurityJson) {
      const freshness = stampFreshness(leftoverSecurityJson.stamp);
      if (freshness === STAMP_FRESH) {
        fail(
          '.pipeline/security.json exists with a FRESH stamp — a security run that genuinely happened ' +
          'against this tree must never be recorded as SKIPPED_LITE. Use the plain ' +
          '`node scripts/ledger-append.mjs` instead, to record the real PASS/BLOCKED verdict.',
        );
      }
      console.log(
        `ledger-append --lite: ignoring .pipeline/security.json (its stamp is ` +
        `${freshness === STAMP_STALE ? 'STALE' : 'unknown'}, a leftover from a prior run) — it is never ` +
        'copied into this lite entry.',
      );
    }
  } else {
    securityJson = readSecurityJson(pipelineDir);
    refuseIfStale('security.json', securityJson.stamp);
    securityOverridden = securityJson.verdict !== 'PASS' && overrideSecurityReason !== null;
    if (securityJson.verdict !== 'PASS' && !securityOverridden) {
      fail(
        `.pipeline/security.json's verdict is ${securityJson.verdict}, not PASS — this is not a terminal ` +
        'PASS. Route back to dev instead of appending a ledger entry, or, if you are deliberately disclosing ' +
        'this run\'s real terminal state for a stated reason, re-run with --override-security "<reason>".',
      );
    }
  }

  const specJson = readSpecJson(pipelineDir);
  const specMarkdown = readPipelineFile('spec.md'); // still copied verbatim into the ledger — never parsed
  // PL-11: the lite lane never reads red.json at all, leftover or not — see EC-11 (a lite entry
  // never copies it and never lists its tests as this run's red-test paths); reading it just to
  // discard it would also risk a malformed leftover blocking an otherwise-eligible lite run for a
  // reason that has nothing to do with this run.
  const redJson = lite ? null : readRedJson(pipelineDir, { required: false });
  const changesJson = readChangesJson(pipelineDir, { required: false });

  // CORRECTED (SEC-10 v2 fix round — FND-bd78355b6ae7, HIGH): the three checks that used to live here
  // were all scoped inside `if (regate)` — see the two "PL-04 review pass N" paragraphs this comment
  // replaces for why each was added. Security reproduced end to end that the PLAIN (non---re-gate)
  // path applied none of them: a `.pipeline/spec.json` naming one ticket sitting beside a
  // `.pipeline/spec.md` headed with a completely different one passed every check that existed and
  // filed the wrong spec body under the right-looking ticket name — reachable on any ordinary run, no
  // `--re-gate` required, and it is the literal, documented next action `.claude/skills/security/
  // SKILL.md` instructs on a PASS immediately following an already-PASS `review.json`. Split below
  // into what is genuinely `--re-gate`-specific and what is not.
  //
  // spec.json and spec.md agreeing WITH EACH OTHER needs no caller-supplied argument at all — unlike
  // `--ticket` (an external assertion only `--re-gate` needs, since it is the one path that reaches
  // this script without `planner` ever having run this round to write spec.json/spec.md together in
  // the first place) and the stamp-presence check below (a hygiene signal specific to a
  // hand-authored-or-retroactive spec.json), this is a plain, unconditional internal-consistency
  // check on two files this script already reads on every path. It now runs on every ledger write,
  // `--re-gate` or not — this is what actually closes FND-bd78355b6ae7 on the plain path.
  const specTicketId = extractTicketId(specJson.ticket);
  const specMdTicketId = extractTicketIdFromSpecMarkdown(specMarkdown);
  if (specTicketId !== specMdTicketId) {
    fail(
      `.pipeline/spec.json's ticket ("${specTicketId}", from "${specJson.ticket}") does not agree with ` +
      `.pipeline/spec.md's own first-heading ticket ("${specMdTicketId}"). These two files are supposed ` +
      'to describe the same run — spec.md (not spec.json) is what gets copied verbatim into the ledger ' +
      'and what index.json\'s "spec" pointer resolves to (.sdd/ledger/README.md\'s query path), so a ' +
      'mismatch here would file the wrong spec body under a ticket name it does not actually belong to, ' +
      'permanently (ledger entries are append-only; there is no correcting this afterward). Re-run ' +
      'planner for the ticket actually being worked, or correct whichever of the two files is stale, ' +
      'before appending a ledger entry.',
    );
  }

  // Decision, stated per this fix's own instruction to reason about it explicitly: the PLAIN path
  // does NOT also require a caller-supplied `--ticket`. The concrete, reproduced exploit
  // (FND-bd78355b6ae7) was a spec.json/spec.md MISMATCH, which the agreement check above now closes
  // unconditionally. The residual case it cannot catch — spec.json and spec.md agreeing with EACH
  // OTHER while both are stale leftovers from a different, prior ticket than the one actually being
  // worked this round (this very branch's own `.pipeline/` carried exactly that shape before this
  // fix) — is real, but it is not a fact this script, or any artifact on disk, can check
  // mechanically: there is no third, independent source of "which ticket is this round really about"
  // for the plain path to compare against, the way `--re-gate`'s caller-supplied `--ticket` provides
  // one for the no-`planner`-ran case. Requiring a `--ticket` on literally every plain invocation
  // would also be a far larger behavioral change than this fix's own scope — it is the documented,
  // unconditional happy path (`.claude/skills/security/SKILL.md`, `.sdd/pipeline.md`'s per-stage
  // `/security` step 4) reached with no ticket argument anywhere in that call chain. The fix for that
  // residual case is instead the one now reflected in `.claude/skills/security/SKILL.md`'s own ledger-
  // step instruction: route through `/re-gate --ticket <id>` specifically when `planner` did not run
  // this round, rather than widen every plain run's required arguments.
  //
  // The two checks below remain `--re-gate`-specific for exactly the reasons above: `--ticket` is the
  // caller's own assertion, checked against spec.json's own ticket (and, transitively, given the
  // unconditional agreement check just above already holds, against spec.md's too — a separate
  // `specMdTicketId !== regate.ticket` check would be unreachable dead code once both hold, so it is
  // not duplicated here); and the stamp-presence check is a hygiene signal only a hand-authored or
  // retroactive spec.json needs to clear.
  if (regate) {
    if (specTicketId !== regate.ticket) {
      fail(
        `--re-gate --ticket "${regate.ticket}" does not match .pipeline/spec.json's own ticket ` +
        `("${specTicketId}", from "${specJson.ticket}"). /re-gate never runs planner, so nothing else on ` +
        'disk guarantees spec.json describes the run actually being gated — writing this entry as-is ' +
        `would permanently attribute this run's real, current files to a different ticket's spec (ledger ` +
        'entries are append-only; there is no correcting this afterward). Either author/ratify a ' +
        `spec.md/spec.json for "${regate.ticket}" first (a retroactive spec is still a ratified one), or ` +
        'correct --ticket if it was mistyped. Refusing to write a ledger entry.',
      );
    }
  }
  // PL-11 / AC-7 item 4 (stamp half), EC-13: --lite requires the same spec.json stamp-presence
  // hygiene check --re-gate already applies — for a stated, lite-specific reason: --lite has no
  // security-history cross-check to compensate for an unstamped spec.json (a --re-gate run's
  // review.json/security.json PASS pair is itself cross-checked against the current tree via
  // refuseIfStale; --lite has that too, but no analogous immutable-record cross-check the way a
  // normal run's findCompletedSecurityRun provides), so this presence-and-shape signal is the one
  // available here. As with --re-gate, this is presence-and-shape, never proof of provenance.
  if (regate || lite) {
    if (!specJson.stamp) {
      fail(
        `--${regate ? 're-gate' : 'lite'} requires .pipeline/spec.json to carry a "stamp" field (node ` +
        'scripts/write-stamp.mjs .pipeline/spec.json) before this run can be attributed to it — planner ' +
        'attaches one automatically as its own last step; a hand-authored or retroactive spec.json must ' +
        'run write-stamp.mjs itself. An unstamped spec.json is missing the one hygiene signal this ' +
        'pipeline has that the file went through its documented authoring path at all (not proof that it ' +
        'did — a stamp is four unauthenticated JSON fields; see pipeline-contracts.mjs\'s readStamp doc ' +
        'comment), which is the same "cannot even show the minimal signal, so refuse" posture ' +
        '.sdd/stages/security.md already applies to a stale review.json, applied here at the other place ' +
        'a JSON sidecar\'s trustworthiness gates a durable, immutable write.' +
        (lite
          ? ' --lite has no security-history cross-check to fall back on (unlike a plain run, which ' +
            'independently re-verifies the cited security run against its own immutable manifest), so ' +
            'this presence check is the one signal available here.'
          : ' (This checks presence and shape, not exact currency against the tree right now — see this ' +
            'file\'s header for why literal freshness is deliberately not required here; --ticket and ' +
            'the agreement check above are what verify content.)'),
      );
    }
  }

  // PL-11 / AC-7 item 5, EC-12: tester still runs on the lite lane, so test-results.md is a required
  // input — the same "never improvise a missing input" rule every other required-file check in this
  // pipeline already follows.
  if (lite && !existsSync(join(pipelineDir, 'test-results.md'))) {
    fail(
      '.pipeline/test-results.md does not exist — `tester` still runs on the lite lane ' +
      '(`.sdd/pipeline.md`\'s `/pipeline-lite`); run it before appending a ledger entry.',
    );
  }

  let runId;
  let manifest = null;
  let liteInfo = null;
  // PL-11 / AC-7 item 6, EC-2/EC-3/EC-4/EC-16/EC-17/EC-19: the live touched-file set must be
  // eligible under evaluateLiteEligibility — reusing filesTouched() (below) is what makes this the
  // exact same "what changed" fact the entry's own "Files touched" section reports, not a second,
  // independently-derived file list that could disagree with it.
  const candidateFiles = filesTouched(changesJson);
  if (lite) {
    if (candidateFiles.length === 0) {
      fail(
        '--lite could not determine any files touched — the working tree is clean and there is nothing ' +
        'to measure. An unmeasured change is never certified small; commit/uncommit as needed, or name ' +
        'the files via .pipeline/changes.json, before running this again.',
      );
    }
    const bounds = readBounds();
    let sized;
    try {
      sized = countChangedLines(candidateFiles, { cwd: repoRoot });
    } catch (error) {
      fail(`--lite could not measure changed lines: ${error.message}`);
    }
    let lineLength;
    try {
      lineLength = maxChangedLineLength(candidateFiles, { cwd: repoRoot });
    } catch (error) {
      fail(`--lite could not measure line lengths: ${error.message}`);
    }
    let eligibility;
    try {
      eligibility = evaluateLiteEligibility({
        files: candidateFiles,
        changedLines: sized.changedLines,
        unsizable: sized.unsizable,
        lineLength,
        bounds,
      });
    } catch (error) {
      fail(`--lite could not evaluate eligibility: ${error.message}`);
    }
    if (!eligibility.eligible) {
      const detail = eligibility.violations
        .map((v) => `  - [${v.kind}]${v.path ? ` ${v.path}` : ''}: ${v.detail}`)
        .join('\n');
      fail(
        `--lite refuses: this change is not eligible for the lite lane (measured ${eligibility.fileCount} ` +
        `file(s), ${eligibility.changedLinesChecked ? `${eligibility.changedLines} changed line(s)` : 'lines not measured'} ` +
        `against max_files ${eligibility.maxFiles} / max_changed_lines ${eligibility.maxChangedLines}):\n${detail}\n` +
        'Escalation: run `/security`, then the plain `node scripts/ledger-append.mjs` — or, if a barred ' +
        'path above is a leftover `.sdd/ledger/**` entry from a previous run, commit it first and try ' +
        'again.',
      );
    }
    liteInfo = {
      skippedStages: LITE_SKIPPED_STAGES,
      note: LITE_NOTE,
      eligibility: {
        fileCount: eligibility.fileCount,
        changedLines: eligibility.changedLines,
        maxFiles: eligibility.maxFiles,
        maxChangedLines: eligibility.maxChangedLines,
      },
    };
    runId = generateRunId('LITE');
  } else {
    const found = findCompletedSecurityRun(securityJson.runId, securityJson.verdict, { allowNonPassVerdict: securityOverridden });
    runId = found.runId;
    manifest = found.manifest;
  }

  // PL-11 / AC-7 item 7, EC-18: reached on the lite path too — the same guard main() already applies.
  const runDir = join(ledgerDir, runId);
  if (existsSync(runDir)) {
    fail(`.sdd/ledger/${runId}/ already exists — refusing to overwrite an existing ledger entry. (A run id is only ever reused if security-checker's own run-id collision guard is violated, which it refuses to do.)`);
  }

  const ticketId = extractTicketId(specJson.ticket);
  const ticketTitle = specJson.ticket;
  const goal = specJson.goal;
  const touchedFiles = candidateFiles;
  const redTestPaths = lite ? [] : (redJson ? redJson.tests.map((test) => test.path) : []);

  const date = lite
    ? new Date().toISOString().slice(0, 10)
    : (typeof manifest.completed_at === 'string' && manifest.completed_at.length >= 10
      ? manifest.completed_at.slice(0, 10)
      : new Date().toISOString().slice(0, 10));

  const commitSha = lite ? currentCommitInfo().sha : (manifest.target?.commit_sha ?? '(unknown)');
  const dirty = lite ? currentCommitInfo().dirty : Boolean(manifest.target?.dirty);
  const commitLine = dirty
    ? `${commitSha} (worktree was dirty when ${lite ? 'this lite entry was written' : 'the security run audited it'} — the commit that actually lands this work may differ once it's committed)`
    : commitSha;

  const redAbsenceNote = lite
    ? 'The `red` stage was deliberately skipped by the lite lane (`.sdd/pipeline.md`\'s `/pipeline-lite`) — this is not a legacy ticket old enough to come from before `red` existed, and `red` did not run and simply produce nothing; it was never invoked for this run at all.'
    : (redJson
      ? '(`red.json` exists for this run but its "tests" list is empty)'
      : 'No `red.json` present for this run — either it predates the `red` stage (introduced in PL-03c) or this run genuinely produced no ledger-relevant tests. Stated explicitly rather than left blank.');

  // PL-04 / B2, B3: the reasoned record of exactly which gate(s), if any, were accepted despite a
  // non-PASS verdict. Empty when both gates genuinely passed on their own — see buildEntryMarkdown's/
  // buildEntryJson's own comments for how this is rendered and why `bypass` is derived from the
  // verdicts themselves rather than duplicated here. There is no security gate to override on the
  // lite path (checked above), so `securityOverridden` is always false there.
  const overrides = [];
  if (reviewOverridden) overrides.push({ gate: 'review', verdict: reviewJson.verdict, reason: overrideReviewReason });
  if (securityOverridden) overrides.push({ gate: 'security', verdict: securityJson.verdict, reason: overrideSecurityReason });

  const securityVerdict = lite ? LITE_SECURITY_VERDICT : securityJson.verdict;
  const securityRunIdForEntry = lite ? null : runId;

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
    securityRunId: securityRunIdForEntry,
    commitLine,
    reviewVerdict: reviewJson.verdict,
    securityVerdict,
    overrides,
    regate,
    lite: liteInfo,
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
    securityRunId: securityRunIdForEntry,
    commit: { sha: commitSha, dirty },
    reviewVerdict: reviewJson.verdict,
    securityVerdict,
    overrides,
    regate,
    lite: liteInfo,
  });
  writeFileSync(join(runDir, 'entry.json'), JSON.stringify(entryJson, null, 2) + '\n', 'utf8');

  copySidecarsIntoLedger(runId, lite ? LITE_SIDECAR_NAMES : undefined);
  if (!lite) copySecurityHistoryIntoLedger(runId);

  const index = writeIndex();

  if (overrides.length > 0) {
    console.log(
      `ledger-append: recorded an OVERRIDDEN terminal run (gate(s) accepted despite a non-PASS verdict: ` +
      `${overrides.map((o) => o.gate).join(', ')}) — see .sdd/ledger/${runId}/entry.md's "## Overrides" ` +
      'section for the recorded reason(s). Excluded from index.json\'s file->spec map (bypass: true) ' +
      'because no spec was ratified.',
    );
  }
  if (regate) {
    console.log(
      `ledger-append: recorded a RE-GATE run (tester ${regate.testerRan ? 'ran' : 'was skipped via --gates-only'} ` +
      `on this pass) — see .sdd/ledger/${runId}/entry.md's "## Re-gate" section. NOT excluded from ` +
      'index.json\'s file->spec map: the spec really was ratified and reviewed against this tree.',
    );
  }
  if (lite) {
    console.log(
      `ledger-append --lite: recorded a LITE-lane run (skipped: ${LITE_SKIPPED_STAGES.join(', ')}) — see ` +
      `.sdd/ledger/${runId}/entry.md's "## Lite lane" section. NOT excluded from index.json's file->spec ` +
      'map (unless also overridden above): review genuinely passed against this tree.',
    );
    console.log(`ledger-append: wrote .sdd/ledger/${runId}/{spec.md,spec.json,changes.json,review.json,entry.md,entry.json}`);
  } else {
    console.log(`ledger-append: wrote .sdd/ledger/${runId}/{spec.md,spec.json,entry.md,entry.json,security/}`);
  }
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
