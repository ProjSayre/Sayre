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
import { parseJsonOrThrow } from './pipeline-contracts.mjs';

/** Stage names that are read-only with respect to source code. Both spellings of the security
 * stage are listed because the runtime shim name and the neutral `.sdd/` stage name differ.
 * `pr-review` (PL-03d/PL-03i) is added here at the same time it is registered in
 * `.sdd/runtimes.yml` — its own stage file (`.sdd/stages/pr-review.md`) explicitly warns that the
 * enforcement below silently does not apply to a stage until it is added to this set. */
const READ_ONLY_AGENTS = new Set(['review', 'security-checker', 'security_checker', 'security', 'pr-review']);

/** The only directory a checker stage may write to. */
const WRITABLE_SUBTREE = '.pipeline';

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
  const allowedRoot = resolve(cwd, WRITABLE_SUBTREE);
  const resolvedTarget = resolve(cwd, targetPath);

  if (isContainedIn(allowedRoot, resolvedTarget)) allow();

  block(
    `agent "${agentType}" is read-only with respect to source code. It may only write under ` +
    `${WRITABLE_SUBTREE}/. Attempted: ${targetPath} (resolves to ${resolvedTarget}).`,
  );
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => main(raw));
