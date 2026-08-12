# Ledger entry — 20260811T034551458Z-7ba3067-REMEDIATION_RECHECK-0a781b (RE-GATE)

## Date
2026-08-11

## Ticket
CH-01

CH-01 — Ephemeral scoped MCP credentials for first-party chat

## Spec Goal
Give the first-party "Ask Sayre" agent loop a short-lived, conversation-bound, digest-only MCP bearer credential whose effective RBAC scope is exactly the asking user's own effective scope, so the existing MCP gateway and every existing tool handler enforce that user's access with zero handler changes.

## Files touched
- .github/workflows/ci.yml
- packages/config/src/config.ts
- services/core/src/db/ephemeralMcpCredentials.rls.test.ts

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
.pipeline/security-history/20260811T034551458Z-7ba3067-REMEDIATION_RECHECK-0a781b/

## Commit
7ba3067f7ccfcfd38346f53ba5773b7f1a54b1e4 (worktree was dirty when the security run audited it — the commit that actually lands this work may differ once it's committed)
