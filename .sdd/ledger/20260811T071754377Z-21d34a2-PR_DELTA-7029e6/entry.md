# Ledger entry — 20260811T071754377Z-21d34a2-PR_DELTA-7029e6 (RE-GATE)

## Date
2026-08-11

## Ticket
CH-05

CH-05 — Gateway realtime chat events

## Spec Goal
Relay CH-04's chat.turn.progress / chat.turn.completed / chat.turn.error Redis pub/sub events to the owning client's live WebSocket connection, under a per-push RBAC re-filter, using the pinned client-facing frame shapes that CH-06 builds against.

## Files touched
- apps/web/app/workspace/state/realtime.tsx

## Verdicts
- review: PASS
- security: PASS

## Re-gate
This run's review/security verdicts were produced by re-running the gates against a tree that was hand-edited directly, outside `dev`'s own re-invocation loop, after `changes.md`/`changes.json` were written for this ticket — see `.sdd/pipeline.md`'s `/re-gate` section. `changes.md`/`changes.json` describe the tree as it stood **before** that hand-edit, not as it stands now. `tester` was re-run against the hand-edited tree on this pass.

## Overrides
(none — both gates passed on their own; nothing here was overridden)

## Red-test paths
- services/gateway/src/ws/chatEvents.test.ts
- services/gateway/src/redis/chatPubsub.test.ts
- services/gateway/src/fanout/chatFanout.test.ts
- services/gateway/src/chatE2e.test.ts
- services/gateway/src/ws/protocol.test.ts
- services/gateway/src/ws/connection.test.ts
- services/gateway/src/coreClient.test.ts
- services/core/src/services/realtimeChatService.test.ts
- services/core/src/graph-query/index.test.ts
- services/core/src/http/realtimeDeltaRequest.test.ts
- services/core/src/routes/realtimeInternal.test.ts

## Security run ID
.pipeline/security-history/20260811T071754377Z-21d34a2-PR_DELTA-7029e6/

## Commit
21d34a26936ac2b14690ee83a2ab04b67454cda9 (worktree was dirty when the security run audited it — the commit that actually lands this work may differ once it's committed)
