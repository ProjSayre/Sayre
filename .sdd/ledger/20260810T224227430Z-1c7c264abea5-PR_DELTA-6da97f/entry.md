# Ledger entry — 20260810T224227430Z-1c7c264abea5-PR_DELTA-6da97f (RE-GATE)

## Date
2026-08-10

## Ticket
CH-02

CH-02 — get_ready_tickets service function + MCP tool

## Spec Goal
Give Sayre a deterministic, graph-computed answer to "which tickets are unblocked and ready to start right now?" — an ordered, feature-grouped list of open tickets whose prerequisite tickets are all done — exposed once as a service-layer function and once as a read-only MCP tool, so the CH-04 chat agent and any external MCP client get the identical, server-authorized answer with the model only narrating it.

## Files touched
- services/core/src/services/ticketReadinessService.ts

## Verdicts
- review: PASS
- security: PASS

## Re-gate
This run's review/security verdicts were produced by re-running the gates against a tree that was hand-edited directly, outside `dev`'s own re-invocation loop, after `changes.md`/`changes.json` were written for this ticket — see `.sdd/pipeline.md`'s `/re-gate` section. `changes.md`/`changes.json` describe the tree as it stood **before** that hand-edit, not as it stands now. `tester` was re-run against the hand-edited tree on this pass.

## Overrides
(none — both gates passed on their own; nothing here was overridden)

## Red-test paths
- services/core/src/services/ticketReadinessService.test.ts
- services/core/src/graph-query/ticketReadiness.test.ts
- services/core/src/mcp/gateway.test.ts
- services/core/src/mcp/handlerContract.test.ts
- services/core/test/mcp-interop/interop.test.ts

## Security run ID
.pipeline/security-history/20260810T224227430Z-1c7c264abea5-PR_DELTA-6da97f/

## Commit
1c7c264abea51d7ab8de447c5442dc3dd1942551 (worktree was dirty when the security run audited it — the commit that actually lands this work may differ once it's committed)
