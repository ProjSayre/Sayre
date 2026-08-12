# W1-06 — GitHub App queued-sync revocation gapfill

## Ticket Check

- **What I'm about to build** — Make an uninstall or suspension stop GitHub ownership-sync work even when that work was already waiting in the queue.
- **What I'm explicitly not doing** — I am not redesigning the GitHub App install flow, changing webhook behavior, or rebuilding the already-working initial repository parse path.
- **How you'll know it worked** — A queued GitHub sync checked after an uninstall will be ignored without contacting GitHub or changing ownership data, while an active installation will continue syncing normally.
- **What I had to guess** — “Halt further sync” is interpreted to include work queued before revocation but started afterward; work already executing at the exact instant of revocation is outside this bounded fix.

## Goal

Close GAP-4 by enforcing the GitHub installation's current tenant binding and active state when the BullMQ ownership-sync worker begins a queued job, before any provider call, token mint, repository resolution, or graph write.

## Scope

### In

- Add an injectable installation-status resolver to the Git metadata sync service.
- Gate GitHub jobs on a positive safe-integer installation ID whose server-derived organization matches the envelope organization and whose installation is active.
- Wire the production worker to the existing narrow `resolveInstallationOrg` database boundary.
- Add leading-red coverage for revoked/suspended/unknown/cross-tenant/invalid installation states and for the active and non-GitHub control paths.

### Out — already satisfied; do not expand without a new gap id

- GAP-1: GitHub App manifest and install/callback routes (`infra/github-app/manifest.json`, `services/core/src/routes/githubInstall.ts`, `services/core/src/routes/githubInstall.test.ts`).
- GAP-2: callback persistence and correctly shaped durable `repo.initial_parse` enqueue (`services/core/src/services/githubAppInstallService.ts`, `services/core/src/db/githubAppInstallWrites.ts`, `services/core/src/db/githubInitialParseOutbox.ts`, `services/core/src/services/githubAppInstallService.test.ts`, `services/core/src/queue/__tests__/initialParse.fixture.test.ts`).
- GAP-3: uninstall lifecycle handling and admission-time rejection of later webhooks (`services/core/src/services/githubInstallationLifecycleService.ts`, `services/core/src/services/githubWebhookService.ts`, `services/core/src/services/githubInstallLifecycleTraceThrough.test.ts`).
- GAP-5: tampered `X-Hub-Signature-256` rejection (`services/core/src/webhooks/githubSignature.ts`, `services/core/src/webhooks/githubSignature.test.ts`, `services/core/src/services/githubWebhookService.test.ts`).
- GAP-6: credential reads confined to W0-07 loaders (`services/core/src/github/appClient.ts`, `packages/config/src/secrets.ts`, `services/workers/sayre_workers/config/secrets.py`, `scripts/check-secret-access.mjs`).
- No schema, migration, queue-envelope, route, webhook, or Python ingestion-worker changes.

## Affected files

- `services/core/src/services/gitSyncService.ts` — add the installation resolver dependency and pre-provider GitHub activity gate.
- `services/core/src/integrations/git/worker.ts` — wire the gate to `resolveInstallationOrg` through the existing runtime database accessor.
- `services/core/src/services/gitSyncService.test.ts` — add revocation-boundary regression tests and update existing dependency fixtures.

## Interfaces / signatures

- Add `export interface GitInstallationResolver { resolve(installationId: number): Promise<{ orgId: string; active: boolean } | null>; }`.
- Extend `GitSyncDependencies` with `installations: GitInstallationResolver`.
- Keep `syncGitMetadata(envelope: MessageEnvelope<ProviderRepoEvent>, dependencies: GitSyncDependencies): Promise<GitSyncResult>` unchanged.
- Keep `GitSyncResult` unchanged; blocked GitHub work returns the existing ignored result: `{ status: 'ignored', provider: 'github', updatedFiles: 0 }`.

## Approach

- Parse `event.installation_id` as a positive safe integer only for GitHub events.
- Before calling the provider adapter, resolve the installation through the injected server-side resolver.
- Continue only when the resolver returns the same `orgId` as the server-stamped envelope and `active: true`; otherwise return the existing ignored result.
- In the production worker, implement the resolver with `resolveInstallationOrg(await getRuntimeDb(), installationId)` so the existing least-privilege database function remains the sole pre-tenant lookup.
- Prove the guard runs before provider resolution (and therefore before token mint), repository resolution, and graph application; preserve behavior for active GitHub and non-GitHub jobs.

## Acceptance criteria

- **AC-1 (GAP-4):** A queued GitHub sync whose installation resolves as revoked, suspended, unknown, or bound to a different organization returns the existing ignored result before provider resolution, token mint, repository resolution, or graph write.
- **AC-2 (GAP-4):** A queued GitHub sync whose installation is active and bound to the envelope's server-derived organization continues through the existing provider, repository, and graph path unchanged.

## Edge cases

- **EC-1 (GAP-4):** A missing, non-decimal, non-positive, or greater-than-safe-integer GitHub installation ID fails closed as ignored and does not invoke the installation resolver or downstream dependencies.
- **EC-2 (GAP-4):** A non-GitHub provider event remains provider-agnostic and does not invoke the GitHub installation resolver.
- **EC-3 (GAP-4):** Installation resolution errors propagate so BullMQ can retry rather than treating an unavailable security decision as an allowed or acknowledged sync.

## Open questions

- None. Pair/security sign-off should specifically confirm that the execution-time gate is placed before provider/token use and that the existing pre-tenant resolver remains the only installation lookup.
