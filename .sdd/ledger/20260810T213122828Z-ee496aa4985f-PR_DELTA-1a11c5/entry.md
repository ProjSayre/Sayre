# Ledger entry — 20260810T213122828Z-ee496aa4985f-PR_DELTA-1a11c5

## Date
2026-08-10

## Ticket
CH-02

CH-02 — get_ready_tickets service function + MCP tool

## Spec Goal
Give Sayre a deterministic, graph-computed answer to "which tickets are unblocked and ready to start right now?" — an ordered, feature-grouped list of open tickets whose prerequisite tickets are all done — exposed once as a service-layer function and once as a read-only MCP tool, so the CH-04 chat agent and any external MCP client get the identical, server-authorized answer with the model only narrating it.

## Files touched
- MCP_TOOL_CONTRACT.md
- docs/mcp-gateway.md
- packages/graph-schema/schema.md
- services/core/src/graph-query/index.ts
- services/core/src/graph-query/ticketReadiness.test.ts
- services/core/src/graph-query/types.ts
- services/core/src/mcp/gateway.test.ts
- services/core/src/mcp/gateway.ts
- services/core/src/mcp/handlerContract.test.ts
- services/core/src/mcp/handlers/getReadyTickets.ts
- services/core/src/mcp/toolServices.ts
- services/core/src/services/ticketReadinessService.test.ts
- services/core/src/services/ticketReadinessService.ts
- services/core/test/mcp-interop/contract.ts
- services/core/test/mcp-interop/fixtureGateway.ts
- services/core/test/mcp-interop/interop.test.ts

## Verdicts
- review: PASS
- security: PASS

## Overrides
(none — both gates passed on their own; nothing here was overridden)

## Red-test paths
- services/core/src/services/ticketReadinessService.test.ts
- services/core/src/graph-query/ticketReadiness.test.ts
- services/core/src/mcp/gateway.test.ts
- services/core/src/mcp/handlerContract.test.ts
- services/core/test/mcp-interop/interop.test.ts

## Security run ID
.pipeline/security-history/20260810T213122828Z-ee496aa4985f-PR_DELTA-1a11c5/

## Commit
ee496aa4985fc4145afbadf34c54de9cf3e9910a (worktree was dirty when the security run audited it — the commit that actually lands this work may differ once it's committed)
