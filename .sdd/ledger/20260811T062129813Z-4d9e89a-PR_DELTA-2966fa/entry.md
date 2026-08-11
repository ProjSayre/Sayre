# Ledger entry — 20260811T062129813Z-4d9e89a-PR_DELTA-2966fa (GAPFILL)

## Date
2026-08-11

## Ticket
W1-06

W1-06 — GitHub App queued-sync revocation gapfill

## Spec Goal
Close GAP-4 by enforcing the GitHub installation's current tenant binding and active state when the BullMQ ownership-sync worker begins a queued job, before any provider call, token mint, repository resolution, or graph write.

## Files touched
- services/core/src/integrations/git/worker.ts
- services/core/src/services/gitSyncService.test.ts
- services/core/src/services/gitSyncService.ts

## Verdicts
- review: PASS
- security: PASS

## Gapfill lane
this run took the gapfill lane (`.sdd/pipeline.md`'s `/pipeline-gapfill`): `gap-scout` audited an already-shipped MVP ticket against its acceptance criteria, and `planner`/`red`/`dev` only addressed non-OK gaps. `tester`, `review`, and `security` all ran in full. Overlays came from `.sdd/mvp-overlays.yml` and the Audit-Rebuild cheat sheet. This is disclosure that the work was gap-scoped, not a skipped-gate bypass.

Overlays: base, spot-check.
Gap counts: 1 non-OK of 6 (OK 5; open statuses: {"OK":5,"NARROWED":1}).

## Overrides
(none — both gates passed on their own; nothing here was overridden)

## Red-test paths
- services/core/src/services/gitSyncService.test.ts

## Security run ID
.pipeline/security-history/20260811T062129813Z-4d9e89a-PR_DELTA-2966fa/

## Commit
4d9e89a8dab9e1338a68ff023785d2631777f5fe (worktree was dirty when the security run audited it — the commit that actually lands this work may differ once it's committed)
