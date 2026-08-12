# Ledger entry — 20260812T033049095Z-083acb4-PR_DELTA-c1485b (RE-GATE)

## Date
2026-08-12

## Ticket
CH-03

CH-03 — Chat conversation persistence, turn API, and `chat-turns` queue

## Spec Goal
Give "Ask Sayre" its durable spine: Postgres tables for conversations and turns, a chatService that atomically records a user turn plus a pending assistant turn and enqueues exactly one job onto a new chat-turns.fifo SQS FIFO queue, and four thin REST routes over that service. No worker, no realtime, no UI.

## Files touched
- apps/web/app/api/core/[...path]/route.ts
- docs/wave0-foundation-contracts.md
- infra/.env.example
- infra/localstack/init/ready.d/01-create-sqs-queues.sh
- services/core/drizzle/0021_ch03_chat_conversations_and_turns.sql
- services/core/drizzle/meta/_journal.json
- services/core/package.json
- services/core/src/app.ts
- services/core/src/db/chatStore.ts
- services/core/src/db/schema.ts
- services/core/src/http/express.ts
- services/core/src/queue/sqs.ts
- services/core/src/routes/chat.ts
- services/core/src/services/chatService.ts
- services/workers/messaging/sqs_client.py

## Verdicts
- review: PASS
- security: PASS

## Re-gate
This run's review/security verdicts were produced by re-running the gates against a tree that was hand-edited directly, outside `dev`'s own re-invocation loop, after `changes.md`/`changes.json` were written for this ticket — see `.sdd/pipeline.md`'s `/re-gate` section. `changes.md`/`changes.json` describe the tree as it stood **before** that hand-edit, not as it stands now. `tester` was re-run against the hand-edited tree on this pass.

## Overrides
(none — both gates passed on their own; nothing here was overridden)

## Red-test paths
- services/core/src/db/chatMigration.test.ts
- services/core/src/db/chatStore.rls.test.ts
- services/core/src/services/chatService.test.ts
- services/core/src/routes/chat.test.ts
- services/core/src/queue/sqs.test.ts
- apps/web/app/api/core/[...path]/route.test.ts
- services/workers/tests/test_messaging_topology.py
- services/workers/tests/test_sqs_delivery.py

## Security run ID
.pipeline/security-history/20260812T033049095Z-083acb4-PR_DELTA-c1485b/

## Commit
083acb4cb4e69fa2e6eb5423f9ea3157c22bc376
