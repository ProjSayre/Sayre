#!/usr/bin/env node
/**
 * PreToolUse guard: the checker stages (`review`, `security-checker`) may write only inside
 * `.pipeline/`. Every other agent — `planner`, `red`, `dev`, `tester`, and the main session —
 * is unaffected.
 *
 * WHY THIS LIVES IN settings.json AND NOT IN SUBAGENT FRONTMATTER (PL-03g):
 * A 2026-07-31 diagnostic established that a `PreToolUse` hook declared in a subagent's own
 * frontmatter never fires, while the same hook declared in a settings file does — including for
 * subagent tool calls. So for the entire life of this repo, `review` and `security-checker` were
 * documented as "read-only, enforced by hook" and were in fact unenforced, for `Write` as well as
 * `Bash`. D-005 caught the `Bash` half and assumed the `Write` matcher worked; it did not.
 *
 * WHY PER-AGENT SCOPING IS POSSIBLE (the open question PL-03g was blocked on):
 * A 2026-08-04 payload probe showed `PreToolUse` receives `agent_type` (and `agent_id`) alongside
 * `tool_name`/`tool_input`. That is what lets one settings-level hook enforce against the checker
 * stages without also blocking `dev`, which must write code. Before that was known, the only
 * options looked like "block everyone" or "block no one".
 *
 * FAIL-CLOSED POSTURE:
 * An unparseable payload, or a checker write whose target path cannot be determined, is BLOCKED.
 * We cannot rule out that the caller is a checker, and a loud error is recoverable where a silent
 * bypass is not. A parse failure here should be impossible in normal operation; if it starts
 * happening, that is a bug worth surfacing rather than tolerating.
 *
 * PATH CONTAINMENT IS DELIBERATELY NOT A GLOB.
 * The predecessor script used a shell glob alternation over the raw path (matching `.pipeline`
 * either at the start or after any directory prefix). That allowed
 * `.pipeline/../../etc/passwd` (resolves outside) and blocked `C:\...\.pipeline\review.md` (the
 * native Windows form the tools actually pass). Both bugs come from pattern-matching a path
 * instead of resolving it. Here the target and the allowed root are both resolved to absolute
 * form and compared by containment, which is a closed problem: two paths, one prefix test.
 *
 * A NOTE ON THIS FILE'S OWN FAILURE MODE:
 * A PreToolUse hook blocks on exit 2; any other non-zero exit is treated as a non-blocking error.
 * So if this script fails to load at all — a syntax error, a missing import — it exits 1 and
 * enforces nothing, silently. That is the same shape as the bug this ticket exists to fix, so it
 * is covered by scripts/guard-checker-readonly.test.mjs, which CI runs. Do not rely on reading
 * this file to know it works.
 *
 * WHY A CHECKER MAY ALSO WRITE TO THE OS TEMP DIRECTORY (round G1 / A1 — "the guard pushes agents
 * toward its own bypass"):
 * This guard's purpose is repository integrity, not filesystem confinement. Before this change, the
 * only writable path for `review`/`security-checker` was `.pipeline/`, which has no scratch space —
 * so when `security-checker` needed one, the OS temp directory was blocked and `Bash` (the one write
 * path this guard has never covered; see `.sdd/stages/security.md`'s own read-only framing) was not.
 * A control that makes the compliant path impossible and the bypass convenient is worse than no
 * control at all, because it trains the habit of routing around the guard for perfectly legitimate
 * work — the next thing routed around it that way might not be legitimate.
 *
 * Writing to the OS temp directory cannot corrupt source, cause a review of a stale artifact, or let
 * a checker forge a verdict: nothing downstream (the ledger, `pr-review`, the next pipeline stage)
 * ever reads from there. And permitting it does not widen the existing `Bash` hole this file has
 * always had — anything reachable by writing to temp via `Bash` was already reachable by writing to
 * temp via `Bash` before this change; this only extends the SAME allowance to the `Write`/`Edit`/
 * `NotebookEdit` tools this guard actually enforces against. What it removes is the incentive to
 * reach for `Bash` at all for scratch space a checker has a legitimate reason to want.
 *
 * CONSIDERED AND DEFERRED (security-precondition fix round, this branch): scoping this allowance to a
 * run-specific subdirectory under the OS temp root, rather than the entire root, was raised alongside
 * advisory finding 2 above. Not done here: the whole OS temp directory is wider than a checker strictly
 * needs, but — per the same "nothing downstream ever reads from there" reasoning this section already
 * states — nothing makes that width exploitable today, so narrowing it is a hardening improvement, not
 * a fix for a live gap. Left as a known, stated tradeoff rather than silently accepted.
 *
 * This is deliberately narrow: anything that resolves inside the repository but outside
 * `.pipeline/` is still blocked exactly as before — that is the case this guard exists for, and
 * nothing about temp-directory scratch space changes it. See the tests in
 * scripts/guard-checker-readonly.test.mjs tagged A1 for both halves of this.
 *
 * CORRECTED (PL-04 review pass 1 / Blocker 4 / C4): the paragraph above is true only because `main()`
 * also checks that the repository checkout itself is not already inside the OS temp directory before
 * applying this allowance. Reproduced against the version of this file that shipped without that
 * check: `cwd` set to a path under `os.tmpdir()` (a temp `git worktree`, an ephemeral/sandboxed
 * checkout, or a CI runner whose workspace is nested under its own `TMPDIR` — all realistic, not
 * contrived) made `services/core/src/index.ts` resolve inside `OS_TMP_ROOT` too, by construction of
 * `resolve(cwd, targetPath)`, so the OS-temp allowance ALLOWed it — every source file in the repo,
 * silently, the guard enforcing nothing while still exiting 0 as if it had. Fixed by requiring
 * `!isContainedIn(OS_TMP_ROOT, resolve(cwd))` before the temp allowance applies at all; when the
 * checkout is itself under temp, this file falls through to the `.pipeline/`-only rule exactly as if
 * the temp allowance did not exist. See scripts/guard-checker-readonly.test.mjs's C4-tagged tests.
 *
 * CORRECTED (security-precondition fix round, this branch — advisory finding 2, MEDIUM): the C4 fix
 * above only ever guarded one direction (checkout nested under temp). Its unguarded MIRROR — the OS
 * temp directory itself nested inside the checkout, i.e. `TMP`/`TEMP` pointed at a path under the
 * repository — reproduced identically: `repoIsUnderOsTmp` is false in that configuration (the repo is
 * not under temp; temp is under the repo), so the temp allowance applied with no guard at all, ALLOWing
 * a write anywhere under that host-configured `TMP`/`TEMP` even though it resolves inside the
 * repository, outside `.pipeline/` — the same contradiction of this file's own "still blocked exactly
 * as before" header claim, from the other side. Requires an unusual host configuration to trigger
 * (rated MEDIUM, unlike C4's more realistic "checkout nested under a temp worktree"), but it is the
 * identical defect shape. Fixed symmetrically: the temp allowance now applies only when *neither* root
 * is nested inside the other (`!isContainedIn(OS_TMP_ROOT, resolvedCwd) && !isContainedIn(resolvedCwd,
 * OS_TMP_ROOT)`) — when the OS temp directory is itself under the checkout, this falls through to the
 * `.pipeline/`-only rule exactly as if the temp allowance did not exist, the same way C4's direction
 * already does. See guard-checker-readonly.test.mjs's tests tagged with this same finding.
 *
 * WHY THIS PARSES THE STDIN PAYLOAD WITH parseJsonOrThrow, NOT PLAIN JSON.parse (security round 6 /
 * the SEC-10 audit's "check every remaining JSON.parse call site" pass):
 * This payload is generated once per tool call by the trusted harness process, not read back from a
 * per-run artifact an earlier, less-trusted stage wrote to disk — it is not the same class of risk
 * `security-history/<run-id>/{manifest,results}.json` was (SEC-10), where a duplicate key let a
 * later, forged value silently override an earlier, real one written by a prior, distinct process.
 * There is no known way for a duplicate top-level key to reach this stdin payload today. This switch
 * is defense-in-depth and consistency, not a demonstrated exploit here: every JSON parse in the
 * security-relevant script surface now goes through the same duplicate-key-rejecting parser, so a
 * future change to how this payload is assembled inherits the same protection automatically rather
 * than needing its own audit later. Failure behavior is unchanged either way — this file already
 * fails closed (BLOCKED) on any parse error, and `parseJsonOrThrow`'s errors are ordinary `Error`s
 * the existing `catch` already handles.
 *
 * Exit 0 = allow. Exit 2 = block, with the reason on stderr.
 */

import { resolve, relative, isAbsolute, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { parseJsonOrThrow } from './pipeline-contracts.mjs';

/** Stage names that are read-only with respect to source code. Both spellings of the security
 * stage are listed because the runtime shim name and the neutral `.sdd/` stage name differ.
 * `pr-review` (PL-03d/PL-03i) is added here at the same time it is registered in
 * `.sdd/runtimes.yml` — its own stage file (`.sdd/stages/pr-review.md`) explicitly warns that the
 * enforcement below silently does not apply to a stage until it is added to this set. */
const READ_ONLY_AGENTS = new Set(['review', 'security-checker', 'security_checker', 'security', 'pr-review']);

/** The one directory *inside the repository* a checker stage may write to. */
const WRITABLE_SUBTREE = '.pipeline';

/** The OS temp directory, resolved once at module load — see this file's header ("WHY A CHECKER MAY
 * ALSO WRITE TO THE OS TEMP DIRECTORY") for why a checker may write here too, in addition to
 * `WRITABLE_SUBTREE`. Resolved independently of any per-call `cwd`, the same as `os.tmpdir()` itself
 * always is. */
const OS_TMP_ROOT = resolve(tmpdir());

function block(reason) {
  process.stderr.write(`Blocked: ${reason}\n`);
  process.exit(2);
}

function allow() {
  process.exit(0);
}

/** True when `target` is `root` itself or lives beneath it, after both are fully resolved.
 * Uses path.relative rather than string prefixing so that `.pipeline-notes/` is not treated as
 * being inside `.pipeline/`, and so `..` segments cannot escape. */
function isContainedIn(root, target) {
  const rel = relative(root, target);
  if (rel === '') return true;
  return !rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel);
}

function main(raw) {
  let payload;
  try {
    payload = parseJsonOrThrow(raw, 'PreToolUse payload');
  } catch {
    block(
      'could not parse the PreToolUse payload, so the calling agent could not be identified. ' +
      'Failing closed — see scripts/guard-checker-readonly.mjs.',
    );
    return;
  }

  const agentType = typeof payload?.agent_type === 'string' ? payload.agent_type : null;

  // The main session reports no agent_type. Only the checker stages are constrained; everyone
  // else — including `dev`, which must write code — passes straight through.
  if (!agentType || !READ_ONLY_AGENTS.has(agentType)) allow();

  const input = payload?.tool_input ?? {};
  const targetPath = input.file_path ?? input.notebook_path ?? null;

  if (typeof targetPath !== 'string' || targetPath.trim() === '') {
    block(
      `agent "${agentType}" is read-only with respect to source code, and this ` +
      `${payload?.tool_name ?? 'tool'} call has no resolvable target path. Failing closed.`,
    );
    return;
  }

  const cwd = typeof payload?.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();
  const resolvedCwd = resolve(cwd);
  const allowedRoot = resolve(resolvedCwd, WRITABLE_SUBTREE);
  const resolvedTarget = resolve(cwd, targetPath);

  if (isContainedIn(allowedRoot, resolvedTarget)) allow();

  // PL-04 review pass 1 / Blocker 4 (C4): the OS-temp allowance below must apply only when the
  // *repository checkout itself* is not already inside the OS temp directory. Before this check, the
  // allowance was computed purely from the target path's own containment in OS_TMP_ROOT — if `cwd`
  // (a temp `git worktree`, an ephemeral/sandboxed checkout, a CI runner whose workspace lives under
  // its own TMPDIR) is anywhere beneath OS_TMP_ROOT, then EVERY path inside that checkout also
  // resolves inside OS_TMP_ROOT, so `isContainedIn(OS_TMP_ROOT, resolvedTarget)` was true for
  // `services/core/src/index.ts` just as much as for a real scratch file — the guard allowed
  // everything, silently, the exact "control weakened, caveat added" pattern this ticket exists to
  // stop. Repo-containment must win: if the checkout lives under temp, skip the temp allowance
  // entirely and fall through to the `.pipeline/`-only rule below, exactly as if this allowance did
  // not exist. This is what makes this file's own header claim ("anything that resolves inside the
  // repository but outside `.pipeline/` is still blocked exactly as before") actually true, in every
  // checkout location, not only the common one. See guard-checker-readonly.test.mjs's C4-tagged tests.
  const repoIsUnderOsTmp = isContainedIn(OS_TMP_ROOT, resolvedCwd);

  // CORRECTED (security-precondition fix round, this branch — advisory finding 2): C4 above only ever
  // guarded the checkout-nested-under-temp direction. Security reproduced the unguarded MIRROR case —
  // `TMP`/`TEMP` pointed at a path *inside* the checkout (`OS_TMP_ROOT` nested under `resolvedCwd`,
  // rather than the other way around) — which this file's header claims is still blocked ("anything
  // that resolves inside the repository but outside `.pipeline/` is still blocked exactly as before")
  // but was not: `repoIsUnderOsTmp` is false in this configuration (the repo is not under temp; temp is
  // under the repo), so the temp allowance below applied unguarded, allowing a write anywhere under
  // that host-configured temp directory even though it resolves inside the repository, outside
  // `.pipeline/`. Same defect shape as C4, the other direction — the fix is the same idea applied
  // symmetrically: the temp allowance may apply only when neither root is nested inside the other.
  // This requires an unusual host configuration (`TMP`/`TEMP` set to a path under the checkout) to
  // trigger, unlike C4's more realistic "checkout under a temp worktree" — rated accordingly lower —
  // but it is the identical class of bug and the header's claim was equally false for it either way.
  const osTmpIsUnderRepo = isContainedIn(resolvedCwd, OS_TMP_ROOT);
  const tempAllowanceApplies = !repoIsUnderOsTmp && !osTmpIsUnderRepo;
  if (tempAllowanceApplies && isContainedIn(OS_TMP_ROOT, resolvedTarget)) allow();

  block(
    `agent "${agentType}" is read-only with respect to source code. It may only write under ` +
    `${WRITABLE_SUBTREE}/${tempAllowanceApplies ? ` or the OS temp directory (${OS_TMP_ROOT})` : ''}. ` +
    `Attempted: ${targetPath} (resolves to ${resolvedTarget}).` +
    (repoIsUnderOsTmp
      ? ` The OS-temp allowance does not apply here because the checkout itself (${resolvedCwd}) ` +
        `already lives inside the OS temp directory (${OS_TMP_ROOT}) — see this file's header.`
      : osTmpIsUnderRepo
        ? ` The OS-temp allowance does not apply here because the OS temp directory (${OS_TMP_ROOT}) ` +
          `itself resolves inside the checkout (${resolvedCwd}), outside ${WRITABLE_SUBTREE}/ — see ` +
          'this file\'s header.'
        : ''),
  );
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => main(raw));
