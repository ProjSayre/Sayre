# Ledger entry — 20260812T235133733Z-2520ec9-REMEDIATION_RECHECK-899ef4

## Date
2026-08-12

## Ticket
W7-01

W7-01 — GitHub paginated reconciliation (removes the 25-repo cap)

## Spec Goal
Remove the hard 25-repository ceiling from the GitHub App install callback and the manual reconcile endpoint by moving repository discovery off the request path onto a paginated, resumable, tenant-scoped background job whose dispatch state lives in Postgres (a second transactional outbox alongside migration 0012's), surface the resulting in-progress state to the workspace canvas so a large installation reads as "partially imported" rather than "empty" or "complete at 25", and let an admin-triggered reconcile close the loop in the destructive direction by revoking repositories a fully-observed GitHub listing no longer reports.

## Files touched
- apps/web/app/lib/repositoryCatalog.ts
- apps/web/app/lib/repositoryCatalogSync.test.ts
- apps/web/app/mock/fixtures.ts
- apps/web/app/workspace/components/CanvasStates.tsx
- apps/web/app/workspace/components/ImportingRepositoriesState.test.tsx
- apps/web/app/workspace/dataSource.ts
- apps/web/app/workspace/state/session.tsx
- apps/web/app/workspace/state/sessionSync.test.tsx
- apps/web/app/workspace/types.ts
- apps/web/app/workspace/views/LegacyWorkspaceView.tsx
- docs/product/Pipeline-Efficiency-Plan.md
- services/core/drizzle/0020_w7_01_github_installation_sync.sql
- services/core/drizzle/meta/_journal.json
- services/core/src/db/githubAppInstallWrites.ts
- services/core/src/db/githubInstallationDiscoveryOutbox.ts
- services/core/src/db/githubInstallationSync.rls.test.ts
- services/core/src/db/githubInstallationSyncStore.ts
- services/core/src/db/rls_acceptance.tester.test.ts
- services/core/src/db/schema.ts
- services/core/src/github/__fixtures__/largeInstallation.ts
- services/core/src/github/appClient.page.test.ts
- services/core/src/github/appClient.test.ts
- services/core/src/github/appClient.ts
- services/core/src/index.ts
- services/core/src/indexDiscoveryWiring.test.ts
- services/core/src/integrations/git/worker.discoveryRouting.test.ts
- services/core/src/integrations/git/worker.ts
- services/core/src/queue/bullmq.ts
- services/core/src/routes/githubInstallationReconcile.discoveryStatus.test.ts
- services/core/src/routes/githubInstallationReconcile.test.ts
- services/core/src/routes/githubInstallationReconcile.ts
- services/core/src/security/assertInstallationDiscoveryOutboxReady.test.ts
- services/core/src/security/assertInstallationDiscoveryOutboxReady.ts
- services/core/src/services/githubAppInstallService.discoveryCallback.test.ts
- services/core/src/services/githubAppInstallService.test.ts
- services/core/src/services/githubAppInstallService.ts
- services/core/src/services/githubInstallationDiscoveryEndToEnd.test.ts
- services/core/src/services/githubInstallationDiscoveryService.test.ts
- services/core/src/services/githubInstallationDiscoveryService.ts
- services/core/src/services/githubInstallationReconcileService.discoveryQueue.test.ts
- services/core/src/services/githubInstallationReconcileService.test.ts
- services/core/src/services/githubInstallationReconcileService.ts
- services/core/src/services/githubInstallationRepositoriesTraceThrough.test.ts
- services/core/src/services/githubInstallationRevokeTraceThrough.test.ts
- services/core/src/services/installationDiscoveryDispatcher.test.ts
- services/core/src/services/installationDiscoveryDispatcher.ts
- services/core/src/services/installationDiscoveryWake.ts
- services/core/src/services/repositoryCatalogService.sync.test.ts
- services/core/src/services/repositoryCatalogService.test.ts
- services/core/src/services/repositoryCatalogService.ts
- services/core/src/services/w701StructuralRemovals.test.ts

## Verdicts
- review: PASS
- security: PASS

## Overrides
(none — both gates passed on their own; nothing here was overridden)

## Red-test paths
- services/core/src/github/appClient.page.test.ts
- services/core/src/services/w701StructuralRemovals.test.ts
- services/core/src/services/githubAppInstallService.discoveryCallback.test.ts
- services/core/src/services/githubInstallationReconcileService.discoveryQueue.test.ts
- services/core/src/routes/githubInstallationReconcile.discoveryStatus.test.ts
- services/core/src/services/githubInstallationDiscoveryService.test.ts
- services/core/src/services/installationDiscoveryDispatcher.test.ts
- services/core/src/security/assertInstallationDiscoveryOutboxReady.test.ts
- services/core/src/integrations/git/worker.discoveryRouting.test.ts
- services/core/src/services/githubInstallationRevokeTraceThrough.test.ts
- services/core/src/services/repositoryCatalogService.sync.test.ts
- services/core/src/db/githubInstallationSync.rls.test.ts
- services/core/src/indexDiscoveryWiring.test.ts
- apps/web/app/lib/repositoryCatalogSync.test.ts
- apps/web/app/workspace/components/ImportingRepositoriesState.test.tsx
- apps/web/app/workspace/state/sessionSync.test.tsx

## Security run ID
.pipeline/security-history/20260812T235133733Z-2520ec9-REMEDIATION_RECHECK-899ef4/

## Commit
2520ec9d9919eab2498a548efb6321a440693c0b (worktree was dirty when the security run audited it — the commit that actually lands this work may differ once it's committed)
