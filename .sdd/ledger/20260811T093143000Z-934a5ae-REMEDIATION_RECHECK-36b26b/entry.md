# Ledger entry — 20260811T093143000Z-934a5ae-REMEDIATION_RECHECK-36b26b (RE-GATE)

## Date
2026-08-11

## Ticket
CH-04

CH-04 — Worker agent loop: MCP-client chat consumer

## Spec Goal
Consume the chat-turns.fifo queue in the Python worker fleet and actually answer an "Ask Sayre" turn: run a bounded LangGraph agent loop that reaches the code graph exclusively through Core's MCP gateway as a real MCP client (bearer = the CH-01 ephemeral credential minted at enqueue time), synthesize a markdown answer with citations and the 70x token-KPI metrics through the existing ModelProvider boundary, publish chat.turn.progress / chat.turn.completed / chat.turn.error events onto Redis pub/sub for CH-05's gateway fan-out, and persist the terminal assistant turn in Postgres.

## Files touched
- services/core/src/db/ephemeralMcpCredentials.rls.test.ts

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
.pipeline/security-history/20260811T093143000Z-934a5ae-REMEDIATION_RECHECK-36b26b/

## Commit
934a5ae00c4eec0e477bcdf2f33b171f79f81b71 (worktree was dirty when the security run audited it — the commit that actually lands this work may differ once it's committed)
