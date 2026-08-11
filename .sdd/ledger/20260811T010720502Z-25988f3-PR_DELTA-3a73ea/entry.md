# Ledger entry — 20260811T010720502Z-25988f3-PR_DELTA-3a73ea

## Date
2026-08-11

## Ticket
CH-04

CH-04 — Worker agent loop: MCP-client chat consumer

## Spec Goal
Consume the chat-turns.fifo queue in the Python worker fleet and actually answer an "Ask Sayre" turn: run a bounded LangGraph agent loop that reaches the code graph exclusively through Core's MCP gateway as a real MCP client (bearer = the CH-01 ephemeral credential minted at enqueue time), synthesize a markdown answer with citations and the 70x token-KPI metrics through the existing ModelProvider boundary, publish chat.turn.progress / chat.turn.completed / chat.turn.error events onto Redis pub/sub for CH-05's gateway fan-out, and persist the terminal assistant turn in Postgres.

## Files touched
- infra/.env.example
- services/core/drizzle/0021_ch04_mcp_key_conversation_fk.sql
- services/core/drizzle/meta/_journal.json
- services/core/src/db/schema.ts
- services/core/src/queue/sqs.ts
- services/core/src/routes/chat.test.ts
- services/core/src/security/ch04ChatCredentialFkMigration.test.ts
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
- services/workers/tests/test_chat_agent_loop.py
- services/workers/tests/test_chat_boundaries.py
- services/workers/tests/test_chat_events.py
- services/workers/tests/test_chat_mcp_client.py
- services/workers/tests/test_chat_prompt.py
- services/workers/tests/test_chat_turn_consumer.py
- services/workers/tests/test_worker_entrypoints.py

## Verdicts
- review: PASS
- security: PASS

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
.pipeline/security-history/20260811T010720502Z-25988f3-PR_DELTA-3a73ea/

## Commit
25988f3e048ff3fd58336b4d9869c6fa8f0249b1 (worktree was dirty when the security run audited it — the commit that actually lands this work may differ once it's committed)
