# Ledger entry — 20260812T052823000Z-2520ec9-PR_DELTA-48a955 (GAPFILL)

## Date
2026-08-12

## Ticket
W3-04

W3-04 — Git sync integration worker (provider-generic) — gapfill

## Spec Goal
Make W3-04's acceptance sentence literally true and literally measured: a merged PR must be shown to change real File node ownership/recent-edit properties in a real graph inside a pinned 5-second sync target, and a mock fakehub provider must be registrable purely through configuration plus one adapter module, with no edit to the worker, the queue, or the pipeline. Along the way, close the unbounded-provider-call, silent-truncation, silent-drop, and unvalidated-path defects that make the "updates ownership metadata" claim conditional today.

## Files touched
- .github/workflows/ci.yml
- infra/.env.example
- packages/config/src/config.ts
- services/core/src/github/appClient.ts
- services/core/src/http/boundedJson.test.ts
- services/core/src/http/boundedJson.ts
- services/core/src/integrations/git/__fixtures__/fakehubProvider.ts
- services/core/src/integrations/git/__tests__/crossServiceFileKey.test.ts
- services/core/src/integrations/git/__tests__/jobRetry.integration.test.ts
- services/core/src/integrations/git/__tests__/ownershipGraph.integration.test.ts
- services/core/src/integrations/git/__tests__/w3-04.acceptance.integration.test.ts
- services/core/src/integrations/git/__tests__/w3-04.ci-wiring.test.ts
- services/core/src/integrations/git/budgets.test.ts
- services/core/src/integrations/git/budgets.ts
- services/core/src/integrations/git/graphOwnershipStore.test.ts
- services/core/src/integrations/git/graphOwnershipStore.ts
- services/core/src/integrations/git/index.ts
- services/core/src/integrations/git/jobPolicy.test.ts
- services/core/src/integrations/git/jobPolicy.ts
- services/core/src/integrations/git/providerCatalog.test.ts
- services/core/src/integrations/git/providerCatalog.ts
- services/core/src/integrations/git/providerRegistry.test.ts
- services/core/src/integrations/git/providerRegistry.ts
- services/core/src/integrations/git/providers/fakehub.test.ts
- services/core/src/integrations/git/providers/fakehub.ts
- services/core/src/integrations/git/providers/github.test.ts
- services/core/src/integrations/git/providers/github.ts
- services/core/src/integrations/git/providers/index.ts
- services/core/src/integrations/git/types.ts
- services/core/src/integrations/git/worker.test.ts
- services/core/src/integrations/git/worker.ts
- services/core/src/queue/__fixtures__/repo_push.branch-deletion.envelope.json
- services/core/src/queue/__fixtures__/repo_push.envelope.json
- services/core/src/routes/githubWebhook.fixtures.test.ts
- services/core/src/routes/githubWebhook.gapfill.test.ts
- services/core/src/services/gitSyncService.test.ts
- services/core/src/services/gitSyncService.ts
- services/core/src/services/githubWebhookService.jobOptions.test.ts
- services/core/src/services/githubWebhookService.ts
- services/core/src/telemetry/gitSyncMetrics.ts
- services/core/src/webhooks/normalizeGithubEvent.ts

## Verdicts
- review: PASS
- security: PASS

## Gapfill lane
this run took the gapfill lane (`.sdd/pipeline.md`'s `/pipeline-gapfill`): `gap-scout` audited an already-shipped MVP ticket against its acceptance criteria, and `planner`/`red`/`dev` only addressed non-OK gaps. `tester`, `review`, and `security` all ran in full. Overlays came from `.sdd/mvp-overlays.yml` and the Audit-Rebuild cheat sheet. This is disclosure that the work was gap-scoped, not a skipped-gate bypass.

Overlays: base.
Gap counts: 10 non-OK of 10 (OK 0; open statuses: {"UNTESTED":1,"MISSING":6,"NARROWED":1,"HARDCODED":1,"MOCKED":1}).

## Overrides
(none — both gates passed on their own; nothing here was overridden)

## Red-test paths
- services/core/src/integrations/git/budgets.test.ts
- services/core/src/http/boundedJson.test.ts
- services/core/src/integrations/git/providerCatalog.test.ts
- services/core/src/integrations/git/providers/fakehub.test.ts
- services/core/src/integrations/git/__tests__/crossServiceFileKey.test.ts
- services/core/src/integrations/git/graphOwnershipStore.test.ts
- services/core/src/integrations/git/providerRegistry.test.ts
- services/core/src/integrations/git/providers/github.test.ts
- services/core/src/services/gitSyncService.test.ts
- services/core/src/integrations/git/jobPolicy.test.ts
- services/core/src/services/githubWebhookService.jobOptions.test.ts
- services/core/src/integrations/git/worker.test.ts
- services/core/src/integrations/git/__tests__/w3-04.ci-wiring.test.ts
- services/core/src/integrations/git/__tests__/ownershipGraph.integration.test.ts
- services/core/src/integrations/git/__tests__/w3-04.acceptance.integration.test.ts
- services/core/src/integrations/git/__tests__/jobRetry.integration.test.ts

## Security run ID
.pipeline/security-history/20260812T052823000Z-2520ec9-PR_DELTA-48a955/

## Commit
2520ec9d9919eab2498a548efb6321a440693c0b (worktree was dirty when the security run audited it — the commit that actually lands this work may differ once it's committed)
