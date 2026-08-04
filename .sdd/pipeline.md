# Pipeline — stage sequence, routing, and loop caps

This is the single, runtime-neutral definition of how the five stages
(`planner` → `dev` → `tester` → `review` → `security`, see `.sdd/stages/`) compose into a run, and
of the four ways a human can invoke them. It replaces two documents that had already drifted apart
on one material point (see "Review persistence" below): `.claude/skills/pipeline/SKILL.md` and
`.agents/skills/pipeline/SKILL.md`. Both are now thin wrappers over this file (Claude Code's is
`.claude/skills/pipeline/SKILL.md`; the equivalent for any other AGENTS.md-reading runtime lives
here directly, via `AGENTS.md`).

Each stage's own procedure lives in `.sdd/stages/<stage>.md` — this file only governs the
sequencing between them. Per-runtime invocation mechanics (which tool name to call, what model
tier it runs on, what enforces read-only) live in `.sdd/runtimes.yml`.

## Stage sequence

1. **planner** — reads the ticket, writes `.pipeline/spec.md`.
2. **dev** — reads `spec.md` (and `review.md` if this is a re-invocation), writes `.pipeline/changes.md`.
3. **tester** — reads `changes.md` and `spec.md`, writes and runs tests, writes `.pipeline/test-results.md`.
4. **review** — reads `spec.md`, `changes.md`, `test-results.md`, runs its own `git diff`, produces a
   report whose shape is defined in `.sdd/stages/review.md`. That report is persisted to
   `.pipeline/review.md` with a `Verdict` of `PASS` or `NEEDS_FIXES`.
5. **security** — runs only once `review.md` shows `PASS`. Reads `spec.md`, `changes.md`, `review.md`,
   applies the registered attacker briefs per `.sdd/stages/security.md`, writes the immutable
   artifacts under `.pipeline/security-history/<run-id>/`, and produces a report persisted to
   `.pipeline/security-report.md` with a `Verdict` of `PASS` or `BLOCKED`.

## Routing

- If `review.md`'s verdict is **NEEDS_FIXES**: go back to **dev**. Re-invoking dev is how it picks
  up `review.md`'s fix list — dev's own procedure (`.sdd/stages/dev.md`) already reads it
  automatically. Then repeat **tester** and **review**.
- If `review.md`'s verdict is **PASS**: continue to **security**.
- If `security-report.md`'s verdict is **BLOCKED**: go back to **dev** with the security findings as
  the fix list (same handling as a `NEEDS_FIXES` review). Repeat **tester**, **review**, and
  **security**.
- If `security-report.md`'s verdict is **PASS**: the run is complete and ready to merge.

**Loop cap:** three total `dev` attempts across both routing loops (review fix-loop and security
fix-loop combined is the existing cap the prior two skills already agreed on — this ticket does not
change it). If still not passing after three rounds, stop and hand the situation to the user with a
summary of what keeps failing, rather than looping indefinitely.

**Never:** skip a stage, let a later stage synthesize or improvise a missing earlier-stage
artifact, or run dependent stages in parallel. If a required `.pipeline/` file is missing, stop and
say which stage needs to run first.

## Review persistence — the resolved divergence

The two prior mirrors disagreed on *who writes* `.pipeline/review.md`: the Claude Code skill had
the `review` subagent write it directly (intended to be confined to `.pipeline/` by a hook guard —
see `.sdd/README.md`'s note on why that guard is not currently load-bearing); the other mirror had
its coordinator save the subagent's returned markdown verbatim. Both are the same contract
implemented two different ways, and the contract is what's neutral:

> `review` (and `security`) produce a report in the shape their stage file defines; that report is
> persisted verbatim to `.pipeline/review.md` (respectively `.pipeline/security-report.md`).

The *mechanism* — a runtime with subagents and hooks lets the stage write its own file directly; a
runtime without them has the coordinator save the returned markdown — is a per-runtime detail and
lives in `.sdd/runtimes.yml`, not here. Do not let a runtime difference in mechanism become a
difference in what gets persisted or in what the coordinator is allowed to alter before saving it:
the coordinator saves the report verbatim, it does not edit, summarize, or selectively drop
sections from it.

## Running stages in a single context (no subagent boundary)

A runtime without subagent isolation (e.g. one where the coordinator itself executes each stage's
`.sdd/stages/*.md` procedure in sequence, in one continuous context) does not get a structural
guarantee that, say, `review` can't see what `dev` was thinking. That guarantee does not exist for
that runtime — it is an accepted, recorded cost (see `.sdd/README.md`), not something this document
can restore. What this document *can* still require, and does, is that the coordinator behave as if
the boundary were real:

- Before starting a stage, **freshly read** that stage's required inputs from the `.pipeline/` files
  on disk — don't carry forward assumptions from having just written them as the previous stage.
- **Don't skip a stage** because "I already know what dev did" — tester, review, and security each
  have their own required-inputs list in their stage file; read it in full every time.
- **Don't improvise a missing input.** If `changes.md` is missing when tester is supposed to start,
  stop and say dev needs to run first, the same as a runtime with real subagent isolation would.
- **Don't let review or security silently reuse conclusions** the coordinator already formed while
  acting as dev/tester in the same session. Re-derive the verdict from the artifacts, not from
  memory of writing them.

## Entry points

Four commands compose the stages above. Each is documented at the neutral level here; each
runtime's shim (`.claude/skills/<name>/SKILL.md`, or the equivalent invocation in a runtime without
a skills mechanism) is a thin pointer to the matching section below.

### `/pipeline <ticket>`

Runs the full stage sequence and routing above, end to end.

1. If `.pipeline/spec.md` already exists, ask whether to reuse it as-is (e.g. it came from
   `/spec-only` and may have been hand-edited) or regenerate it. Only invoke **planner** if it's
   missing or the user confirms regeneration.
2. Otherwise invoke **planner** with the ticket.
3. If `spec.md` contains non-trivial Open Questions, stop and surface them before continuing — don't
   let dev start on an ambiguous spec.
4. Run stages 2–5 above with their routing.
5. Report back: overall result (ready to merge, or stopped and why); a one-line summary of what was
   built (from spec.md's Goal); links to all five `.pipeline/` artifacts; the security run ID,
   baseline run ID, immutable artifact directory, and finding/coverage trajectory; and any
   non-blocking Warnings/Suggestions from `review.md` or `security-report.md`.

### `/spec-only <ticket>`

Runs only **planner** and stops before any code changes.

1. If `.pipeline/spec.md` already exists, warn that regeneration will replace it and get
   confirmation.
2. Invoke **planner** with the ticket.
3. Do not continue to dev, tester, review, or security.
4. Report the Goal, Scope, and Open Questions from spec.md; where the file lives; that it can be
   hand-edited before continuing; and that continuing means invoking **dev** directly (not
   `/pipeline`, which restarts from planner and would overwrite the reviewed spec).

### `/pipeline-status`

Reports where a run currently stands. Takes no action — no stage is invoked, no file is written.

1. Check which of `spec.md`, `changes.md`, `test-results.md`, `review.md`, `security-report.md`
   exist under `.pipeline/`, in that order, and compare modification times — an older downstream
   artifact than its upstream dependency likely means that stage hasn't run against current input
   yet.
2. Pull spec.md's Goal, review.md's Verdict, and security-report.md's Verdict where present.
3. Report: Ticket (the Goal, or "no spec.md — pipeline hasn't started"); Furthest stage reached;
   Verdicts so far; a timestamp/staleness flag; and a suggested next action (e.g. "run `/pipeline`
   to continue," "review.md says NEEDS_FIXES — invoke dev," "security-report.md is BLOCKED — invoke
   dev," or "complete — ready to merge").

### `/security-recheck`

Re-runs only **security**, against whatever is currently on disk, for a fast check after a
hand-edit made outside the pipeline.

1. Require `spec.md` and `changes.md` to exist; if either is missing, say the full pipeline hasn't
   run and recommend `/pipeline` instead.
2. Require `review.md` to show `PASS`. Do not bypass a missing or failed review — a hand-edit made
   after a failed review isn't safe to security-clear in isolation.
3. Invoke **security** in `REMEDIATION_RECHECK` mode against the current working-tree diff (it runs
   its own `git diff`, so it catches hand-edits `changes.md` doesn't mention). Pass along any prior
   finding IDs or remediation references that prompted the recheck when available; never instruct it
   to skip sibling or bypass paths.
4. Report the resulting `security-report.md` verdict, run ID, baseline run ID, finding transitions,
   and coverage gains/losses. If `BLOCKED`, route fixes through dev and re-run `/security-recheck`
   afterward — this command deliberately does not re-run tester or review automatically.
