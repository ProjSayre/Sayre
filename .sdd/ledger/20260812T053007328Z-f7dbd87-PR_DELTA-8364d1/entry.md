# Ledger entry — 20260812T053007328Z-f7dbd87-PR_DELTA-8364d1 (RE-GATE)

## Date
2026-08-12

## Ticket
CH-04

CH-04 — Worker agent loop: MCP-client chat consumer

## Spec Goal
Consume the chat-turns.fifo queue in the Python worker fleet and actually answer an "Ask Sayre" turn: run a bounded LangGraph agent loop that reaches the code graph exclusively through Core's MCP gateway as a real MCP client (bearer = the CH-01 ephemeral credential minted at enqueue time), synthesize a markdown answer with citations and the 70x token-KPI metrics through the existing ModelProvider boundary, publish chat.turn.progress / chat.turn.completed / chat.turn.error events onto Redis pub/sub for CH-05's gateway fan-out, and persist the terminal assistant turn in Postgres.

## Files touched
- infra/.env.example
- services/core/drizzle/0022_ch04_mcp_key_conversation_fk.sql
- services/core/drizzle/meta/_journal.json
- services/core/src/db/schema.ts
- services/core/src/queue/sqs.ts
- services/core/src/routes/chat.test.ts
- services/core/src/services/chatService.test.ts
- services/core/src/services/chatService.ts
- services/workers/poetry.lock
- services/workers/pyproject.toml
- services/workers/sayre_workers/chat/__init__.py
- services/workers/sayre_workers/chat/agent.py
- services/workers/sayre_workers/chat/consumers.py
- services/workers/sayre_workers/chat/events.py
- services/workers/sayre_workers/chat/mcp_client.py
- services/workers/sayre_workers/chat/models.py
- services/workers/sayre_workers/chat/prompt.py
- services/workers/sayre_workers/chat/redis_publisher.py
- services/workers/sayre_workers/chat/runtime.py
- services/workers/sayre_workers/chat/service.py
- services/workers/sayre_workers/chat/store.py
- services/workers/sayre_workers/cli.py
- services/workers/sayre_workers/config/config.py
- services/workers/tests/test_worker_entrypoints.py

## Verdicts
- review: PASS
- security: PASS

## Re-gate
This run's review/security verdicts were produced by re-running the gates against a tree that was hand-edited directly, outside `dev`'s own re-invocation loop, after `changes.md`/`changes.json` were written for this ticket — see `.sdd/pipeline.md`'s `/re-gate` section. `changes.md`/`changes.json` describe the tree as it stood **before** that hand-edit, not as it stands now. `tester` was re-run against the hand-edited tree on this pass.

## Overrides
(none — both gates passed on their own; nothing here was overridden)

## Red-test paths
- services/workers/tests/test_chat_events.py
- services/workers/tests/test_chat_mcp_client.py
- services/workers/tests/test_chat_prompt.py
- services/workers/tests/test_chat_agent_loop.py
- services/workers/tests/test_chat_turn_consumer.py
- services/workers/tests/test_chat_boundaries.py
- services/core/src/services/chatService.test.ts
- services/core/src/security/ch04ChatCredentialFkMigration.test.ts

## Security run ID
.pipeline/security-history/20260812T053007328Z-f7dbd87-PR_DELTA-8364d1/

## Commit
f7dbd87e88a404342e1091fa8e9e3f1f8dadf647
