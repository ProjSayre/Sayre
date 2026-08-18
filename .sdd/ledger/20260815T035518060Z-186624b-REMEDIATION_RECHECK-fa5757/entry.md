# Ledger entry — 20260815T035518060Z-186624b-REMEDIATION_RECHECK-fa5757 (RE-GATE)

## Date
2026-08-15

## Ticket
CH-01

CH-01 — Ephemeral scoped MCP credentials for first-party chat

## Spec Goal
Give the first-party "Ask Sayre" agent loop a short-lived, conversation-bound, digest-only MCP bearer credential whose effective RBAC scope is exactly the asking user's own effective scope, so the existing MCP gateway and every existing tool handler enforce that user's access with zero handler changes.

## Files touched
- .github/workflows/ci.yml
- docs/wave0-foundation-contracts.md
- packages/config/src/config.ts
- packages/shared-types/src/index.ts
- services/core/drizzle/0021_ch01_ephemeral_mcp_credentials.sql
- services/core/drizzle/meta/_journal.json
- services/core/package.json
- services/core/src/db/ephemeralMcpCredentialStore.ts
- services/core/src/db/ephemeralMcpCredentials.rls.test.ts
- services/core/src/db/mcpKeyStore.ts
- services/core/src/db/rls_acceptance.tester.test.ts
- services/core/src/db/schema.ts
- services/core/src/mcp/gateway.test.ts
- services/core/src/mcp/metrics.ts
- services/core/src/mcp/toolExecution.ts
- services/core/src/security/ephemeralMcpCredentialMigration.test.ts
- services/core/src/services/ephemeralMcpCredentialService.ts
- services/core/src/services/mcpKeyService.test.ts
- services/core/src/services/mcpKeyService.ts
- services/core/test/mcp-interop/fixtureGateway.ts

## Verdicts
- review: PASS
- security: PASS

## Re-gate
This run's review/security verdicts were produced by re-running the gates against a tree that was hand-edited directly, outside `dev`'s own re-invocation loop, after `changes.md`/`changes.json` were written for this ticket — see `.sdd/pipeline.md`'s `/re-gate` section. `changes.md`/`changes.json` describe the tree as it stood **before** that hand-edit, not as it stands now. `tester` was re-run against the hand-edited tree on this pass.

## Overrides
(none — both gates passed on their own; nothing here was overridden)

## Red-test paths
- services/core/src/services/ephemeralMcpCredentialService.test.ts
- services/core/src/services/mcpCredentialResolution.test.ts
- services/core/src/db/mcpKeyStoreKind.test.ts
- services/core/src/mcp/ephemeralMcpGateway.test.ts
- services/core/src/security/ephemeralMcpCredentialMigration.test.ts
- services/core/src/security/ch01UnmodifiedSurfaces.test.ts
- services/core/src/db/ephemeralMcpCredentials.rls.test.ts

## Security run ID
.pipeline/security-history/20260815T035518060Z-186624b-REMEDIATION_RECHECK-fa5757/

## Commit
186624ba7e2a87e55eed25ed4c073ad6f489a8ae
