# Ledger entry — 20260811T025958679Z-6d3acfc-PR_DELTA-091a39

## Date
2026-08-11

## Ticket
CH-05

CH-05 — Gateway realtime chat events

## Spec Goal
Relay CH-04's chat.turn.progress / chat.turn.completed / chat.turn.error Redis pub/sub events to the owning client's live WebSocket connection, under a per-push RBAC re-filter, using the pinned client-facing frame shapes that CH-06 builds against.

## Files touched
- packages/shared-types/src/index.ts
- services/core/src/graph-query/index.test.ts
- services/core/src/graph-query/index.ts
- services/core/src/graph-query/types.ts
- services/core/src/http/realtimeDeltaRequest.test.ts
- services/core/src/http/realtimeDeltaRequest.ts
- services/core/src/routes/realtimeInternal.test.ts
- services/core/src/routes/realtimeInternal.ts
- services/core/src/services/chatService.ts
- services/core/src/services/realtimeChatService.test.ts
- services/core/src/services/realtimeChatService.ts
- services/gateway/src/chatE2e.test.ts
- services/gateway/src/coreClient.test.ts
- services/gateway/src/coreClient.ts
- services/gateway/src/fanout/chatFanout.test.ts
- services/gateway/src/fanout/chatFanout.ts
- services/gateway/src/redis/chatPubsub.test.ts
- services/gateway/src/redis/chatPubsub.ts
- services/gateway/src/redis/pubsub.ts
- services/gateway/src/server.ts
- services/gateway/src/ws/chatEvents.test.ts
- services/gateway/src/ws/chatEvents.ts
- services/gateway/src/ws/connection.test.ts
- services/gateway/src/ws/connection.ts
- services/gateway/src/ws/protocol.test.ts
- services/gateway/src/ws/protocol.ts

## Verdicts
- review: PASS
- security: PASS

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
.pipeline/security-history/20260811T025958679Z-6d3acfc-PR_DELTA-091a39/

## Commit
6d3acfce2d978ca4177038186e80b9c0ac96abe7 (worktree was dirty when the security run audited it — the commit that actually lands this work may differ once it's committed)
