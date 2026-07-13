---
name: pipeline-status
description: Reports which stage the .pipeline/ pipeline is currently at, without running or re-running anything. Use to check where a pipeline run left off.
disable-model-invocation: true
argument-hint: (no arguments)
---

Check the current state of the pipeline and report it — take no other action, don't invoke any subagent, don't write anything.

1. Check which files exist in `.pipeline/`, in this order: `spec.md`, `changes.md`, `test-results.md`, `review.md`, `security-report.md`. Use their modification times (`ls -la .pipeline/`) to sanity-check that later files aren't older than earlier ones — an older `changes.md` than `spec.md` likely means dev hasn't run against the current spec yet.
2. If `spec.md` exists, pull its **Goal** line so the report is human-readable, not just a file list.
3. If `review.md` exists, pull its **Verdict** (`PASS` / `NEEDS_FIXES`).
4. If `security-report.md` exists, pull its **Verdict** (`PASS` / `BLOCKED`).
5. Report back in this shape:
   - **Ticket**: (the Goal from spec.md, or "no spec.md found — pipeline hasn't started")
   - **Furthest stage reached**: (planner / dev / tester / review / security-checker / complete)
   - **Verdicts so far**: review = X, security = Y (omit if not yet run)
   - **Timestamp check**: flag if any file looks stale relative to a later one
   - **Suggested next action**: e.g. "run `/pipeline` to continue", "review.md says NEEDS_FIXES — invoke `dev` to address it", "security-report.md is BLOCKED — invoke `dev` with those findings", or "pipeline complete, security-report.md is PASS — ready to merge"

Keep this to a short status report, not a full re-read of every file's contents.
