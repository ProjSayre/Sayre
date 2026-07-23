---
name: pipeline
description: Runs the full Planner -> Dev -> Tester -> Review -> Security pipeline for a feature or ticket. Invoke explicitly with /pipeline <ticket description or path to ticket file> — this always runs on request, never auto-triggers, since it takes real actions (spawns agents, writes to .pipeline/, runs tests).
disable-model-invocation: true
argument-hint: <ticket description or path to a ticket file>
---

Run the full agent pipeline for this ticket/feature request: $ARGUMENTS

Follow this sequence exactly. Do not skip a stage. Do not let a later stage improvise a missing earlier-stage file — if a required `.pipeline/` file is missing, stop and say which stage needs to run first.

## 1. Planner
If `.pipeline/spec.md` already exists, ask the user whether to reuse it as-is (e.g. if it came from `/spec-only` and may have been hand-edited) or regenerate it. Only invoke `planner` if it's missing or the user confirms regeneration.

Otherwise, invoke the `planner` subagent with the ticket/feature request above. It reads the PRD and writes `.pipeline/spec.md`.

If `spec.md` contains non-trivial **Open Questions**, stop here and surface them to the user before continuing — don't let dev start on an ambiguous spec.

## 2. Dev
Invoke the `dev` subagent. It reads `.pipeline/spec.md` and writes `.pipeline/changes.md`.

## 3. Tester
Invoke the `tester` subagent. It reads `.pipeline/changes.md` and `.pipeline/spec.md`, writes and runs tests, and writes `.pipeline/test-results.md`.

## 4. Review
Invoke the `review` subagent. It reads `spec.md`, `changes.md`, and `test-results.md`, runs its own `git diff`, and writes `.pipeline/review.md` with a verdict of `PASS` or `NEEDS_FIXES`.

## 5. Route on review verdict
- If `review.md`'s verdict is **NEEDS_FIXES**: go back to step 2. Invoke `dev` again — it will read `review.md`'s fix list automatically. Then repeat steps 3–4. Cap this loop at 3 total attempts; if still not passing after 3 rounds, stop and hand the situation to the user with a summary of what keeps failing rather than looping indefinitely.
- If `review.md`'s verdict is **PASS**: continue to step 6.

## 6. Security Checker
Invoke the `security-checker` subagent in `PR_DELTA` mode. It reads `review.md` (must be `PASS`), `spec.md`, and `changes.md`; applies the registered progress-audit briefs; writes immutable manifest/results/report artifacts under `.pipeline/security-history/<run-id>/`; and writes `.pipeline/security-report.md` with a verdict of `PASS` or `BLOCKED`.

- If **BLOCKED**: go back to step 2 with the security findings as the fix list (treat it the same way as a `NEEDS_FIXES` review). Re-run steps 3–6 once. If still blocked, stop and hand to the user.
- If **PASS**: continue to step 7.

## 7. Final summary
Report back to the user:
- Overall result: ready to merge, or stopped and why
- One-line summary of what was built (from spec.md's Goal)
- Links to the five `.pipeline/` files for anyone who wants the detail
- The security run ID, baseline run ID, immutable artifact directory, and concise finding/coverage trajectory
- Any Warnings/Suggestions from `review.md` or `security-report.md` that didn't block, so the user can decide whether to act on them before merging
