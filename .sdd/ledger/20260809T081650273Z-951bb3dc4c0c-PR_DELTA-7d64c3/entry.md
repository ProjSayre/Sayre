# Ledger entry — 20260809T081650273Z-951bb3dc4c0c-PR_DELTA-7d64c3 (INLINE)

## Date
2026-08-09

## Ticket
PL-14

PL-14 — Wire PR #78's two dependency suites into package.json and CI

## Spec Goal
Make scripts/sdd-completeness.test.mjs's generalized assertion ("every scripts/*.test.mjs suite has both a package.json test:* script and a matching CI step") pass on PR #83, by wiring the two suites the merge from origin/main brought in unwired — scripts/dependency-baseline.test.mjs and scripts/dependency-install.test.mjs — following the convention PL-11 used for check-lite-eligible. Amendment 1 adds one repair in the same file: the PL-12-era [inline] test's git-diff-based "these ten files are untouched" loop becomes content assertions, because as a permanent regression test it fails for any uncommitted local edit to those files (including this ticket's own) while gating nothing in CI.

## Files touched
- .github/workflows/ci.yml
- package.json
- scripts/sdd-completeness.test.mjs

## Verdicts
- review: PASS
- security: PASS

## Inline edit
this run took the inline-edit lane (`.sdd/pipeline.md`'s `/inline-edit`): the implementation was a direct edit made in a live session, not a `dev`-stage run, so `changes.md`/`changes.json` are the editor's own self-report rather than a separate agent's; and `red` did not run, so any test covering this change was written after the diff already existed. A real `spec.md`/`spec.json` was ratified before the edit, and `tester`, `review`, and `security` all ran in full against the edited tree. This lane has no mechanical size bound — the measured size of the change is recorded below so a reader can judge for themselves how much skipped `red`.

Skipped stages: red, dev.
Reason: Three-file CI reconcile fix: wire the two W0-00 dependency suites the main merge brought in unwired, and convert PL-12's transient-state git-diff assertions to content assertions after they fired on this run's own legitimate uncommitted wiring. Made directly in-session; ci.yml is lite-barred, and the inline lane runs security in full.

Measured size: 3 file(s), 59 changed line(s), longest changed line 141 character(s).

## Overrides
(none — both gates passed on their own; nothing here was overridden)

## Red-test paths
The `red` stage was deliberately not invoked on the inline-edit lane (`.sdd/pipeline.md`'s `/inline-edit`) — this is neither a legacy ticket predating `red`'s own existence nor a run where `red` ran and produced nothing; it was never invoked for this run at all.

## Security run ID
.pipeline/security-history/20260809T081650273Z-951bb3dc4c0c-PR_DELTA-7d64c3/

## Commit
951bb3dc4c0ca5a0fa8a0cbbe0d97fbe3089a87f (worktree was dirty when the security run audited it — the commit that actually lands this work may differ once it's committed)
