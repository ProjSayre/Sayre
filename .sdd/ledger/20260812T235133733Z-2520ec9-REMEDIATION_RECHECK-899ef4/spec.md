# W7-01 — GitHub paginated reconciliation (removes the 25-repo cap)

> Fresh `/pipeline` run (NOT `/pipeline-gapfill`). W7-01 has not shipped; this is greenfield
> planning against real, already-shipped W1-06/W2-09 code. `.pipeline/gaps.json` on disk belongs
> to a prior W3-04 gapfill run and is deliberately ignored — this run is not on the gapfill lane.
>
> Ticket source: `docs/product/Ticket-Backlog-by-Feature-2.md` → `### W7-01`. Wave 7, depends on
> W1-06, effort 7, executor "AI agent". PRD §2.4 (GitHub Integration) states the requirement
> directly: *"Paginated reconciliation, no hard cap: the previous 25-repository-per-callback
> ceiling is replaced by paginated, async reconciliation with a visible partial-sync state in
> the UI."*
>
> **Revision 2 (post human review).** All six of revision 1's Open Questions were answered.
> OQ-1, OQ-2, OQ-5 and OQ-6 were accepted as proposed and are now settled decisions in the body
> below. **OQ-3 was rejected**: discovery durability no longer rests on BullMQ/Redis plus a
> manual admin reconcile — it is outbox-backed, following migration 0012's
> `github_initial_parse_outbox` precedent (durable dispatch state + a SECURITY DEFINER
> dispatcher boundary). **OQ-4 was rejected as deferred**: the destructive reconcile direction
> ("GitHub no longer reports a repo we hold active → revoke it"), deferred by W2-09's OQ-5, is
> now explicitly in scope for W7-01, because paginated discovery removes the "the list might be
> truncated" objection that justified the deferral. Both changes ripple through Scope, Affected
> files, Interfaces, Approach, Acceptance criteria and Edge cases; `AC-1`..`AC-17` /
> `EC-1`..`EC-22` keep their IDs (a few had their text corrected where the answers made the old
> wording untrue), and the new scope extends from `AC-18` / `EC-23`.

## Ticket Check

**What I'm about to build**
Today, when someone connects Sayre to a GitHub organization, we only ever pick up the first 25
repositories and silently ignore the rest — a 100-repo company gets 25 repos and no warning. I'm
changing it so every repository gets picked up, no matter how many there are, and so the connect
button returns immediately instead of hanging while we talk to GitHub. While the import is still
running, the workspace will say so on screen instead of pretending the org only has a handful of
repos (or none at all). Two things follow from your review notes: the import can no longer be
lost if our background queue server is wiped — it will pick itself back up from where it stopped,
by itself — and an admin pressing "Refresh installations" will now also *remove* repositories
that GitHub no longer gives us access to, instead of leaving them listed forever.

**What I'm explicitly not doing**
I'm not changing what happens to a repository once it's imported — parsing, the graph, and the
canvas views are untouched. Removing a repository is a soft removal: it stops being listed, but
its history is kept, and it comes back automatically if access is restored. Removal only ever
happens when an admin explicitly asks for a refresh, never on its own during a normal connect,
and never when we're unsure (a failed or partial look at GitHub removes nothing). I'm not
touching the Jira/Linear side, and I'm not building an admin settings screen — the only new
things a person sees are the "still importing" indicator in the workspace and repositories
disappearing after an admin refresh.

**How you'll know it worked**
Connect a GitHub organization that has more than 25 repositories (we'll test with 120). The
connect flow should come back to the app right away. Open the workspace: it should say the
repositories are still being imported, and the repository list should keep filling in on its own
without a page refresh. Within a minute, all 120 repositories should be listed and the "importing"
message should disappear on its own. Then re-check the old behaviour: previously the list would
have stopped at exactly 25 and stayed there forever. For the two new pieces: pull the plug on the
background queue server mid-import, bring it back, and confirm the import finishes on its own
without anyone clicking anything; and remove Sayre's access to one repository on GitHub, press
"Refresh installations" as an admin, and confirm that repository stops being listed while the
other 119 stay exactly as they were.

**What I had to guess**
Three things the ticket left open, all inside the newly-approved removal behaviour, since your
answers closed everything else: (1) removal is allowed only from the admin-triggered "Refresh
installations" action, never from the automatic connect-time import, because a redirect from
GitHub is not somebody asking us to prune their catalogue; (2) I built in three refusals — we
never remove anything unless we saw *every* page of *every* connected installation successfully,
never if GitHub suddenly reports zero repositories, and never if more than half the org's
repositories would disappear at once (in those cases we remove nothing and record why, for an
admin to look at); (3) I capped total discovery at 10,000 repositories per installation and at 10
automatic re-attempts per import as runaway guards.

## Goal

Remove the hard 25-repository ceiling from the GitHub App install callback and the manual
reconcile endpoint by moving repository discovery off the request path onto a paginated,
resumable, tenant-scoped background job whose dispatch state lives in Postgres (a second
transactional outbox alongside migration 0012's), surface the resulting in-progress state to the
workspace canvas so a large installation reads as "partially imported" rather than "empty" or
"complete at 25", and let an admin-triggered reconcile close the loop in the destructive
direction by revoking repositories a fully-observed GitHub listing no longer reports.

## Scope

**In**

- Replace `GithubAppClient.listInstallationRepos(installationId, maxRepos?)` with a page-level
  `listInstallationReposPage(installationId, page, perPage?)`; delete the cap parameter and the
  whole-discovery accumulation loop from the client.
- Delete `MAX_REPOS_PER_CALLBACK` (25) from `githubAppInstallService.ts` and `MAX_RECONCILE_REPOS`
  (25) from `githubInstallationReconcileService.ts`, along with the `truncated` result flag.
- New durable, org-scoped run row (`github_installation_sync`, migration 0020) recording status,
  resume cursor, counts, **dispatch/lease bookkeeping**, the requesting subject, and the sweep
  outcome per installation.
- **Outbox-backed dispatch (OQ-3, human-directed).** `github_installation_sync` doubles as the
  transactional outbox for the discovery job: the request path only ever *commits a row*, and a
  dedicated dispatcher — modelled column-for-column on migration 0012's
  `github_initial_parse_outbox` boundary (NOLOGIN/NOINHERIT/NOBYPASSRLS owner role, three bounded
  SECURITY DEFINER functions, lease + `FOR UPDATE SKIP LOCKED`) — is the only thing that calls
  BullMQ `enqueue()`. Because the row also carries the resume cursor, a *stalled mid-run* job is
  redispatchable, not just an undelivered one: a total Redis loss recovers with no admin action.
- **Destructive reconcile direction (OQ-4, human-directed).** A discovery run started by the
  admin-gated `POST /integrations/github/reconcile`, and only such a run, ends by revoking every
  active GitHub repository in the org that the fully-paginated listing did not report — via the
  existing `markRepositoryRevoked` soft revoke — behind four independent false-positive guards
  (complete-run-only, all-active-installations-observed, non-empty-result, and a ≤50% blast-radius
  ratio), with the requesting subject, revoked count and sweep outcome recorded on the run row.
- New service `githubInstallationDiscoveryService.ts`: paginated discovery, committing one page
  (registrations + `repo.initial_parse` outbox rows + cursor advance + heartbeat) per transaction,
  then the sweep.
- New job type `github.installation_discovery` on the **existing** `github-sync` queue; the
  git-sync worker dispatches on `envelope.type`.
- The install callback and `POST /integrations/github/reconcile` become row-write-only; reconcile
  answers `202`.
- `GET /repositories` gains a server-derived `sync` summary; the web workspace renders a
  partial-sync indicator from it and re-polls while a sync is in flight.
- A ≥100-repo fixture install exercised end to end.

**Out**

- The `installation_repositories` `added`/`removed` webhook path
  (`githubInstallationRepositoriesService.ts`) — it handles small explicit deltas via
  `getInstallationRepo` and is unchanged. It remains a *second*, independent revoke call site;
  W7-01 adds exactly one more (the sweep) and no others.
- Hard deletion of repositories, or any graph/ingestion cleanup on revoke. Revocation stays the
  existing `repositories.revoked_at` soft revoke; graph history is retained, exactly as W2-09
  defined it.
- `githubInstallationLifecycleService.ts` (install/suspend/uninstall webhooks) — unchanged; an
  installation revoked mid-discovery is handled by discovery's own active-state re-check
  (EC-5), not by a new lifecycle hook.
- `GET /integrations/github/status`. The web client (`apps/web/app/lib/githubIntegrationStatus.ts`)
  and the proxy allowlist (`apps/web/app/api/core/[...path]/route.ts`) already reference this
  path, but **no core route implements it**. Human-confirmed (revision 1 OQ-5) as an unrelated
  pre-existing gap that stays out of scope; the partial-sync indicator is fed by
  `GET /repositories` instead.
- Parsing, graph writes, ingestion, and every canvas view's rendering. W7-01 stops at "registered
  + `repo.initial_parse` enqueued".
- Org-exclusivity enforcement (W7-02) and the <5s delta-sync target (W7-03).
- Any change to the Python worker fleet, SQS/SNS topology, or the `github_initial_parse_outbox`
  table and its SECURITY DEFINER dispatcher (migration 0012). Discovery writes initial-parse
  outbox rows through the existing `enqueueInitialParseOutbox` and kicks the existing dispatcher;
  the new discovery dispatcher is a *separate, parallel* boundary that never touches 0012's table,
  role, or functions.
- A new queue system. `.claude/rules/async-messaging.md`'s "don't add a new queue system for an
  integration" is respected: BullMQ's `github-sync` remains the only queue for this work, and the
  new outbox is the same transactional-handoff pattern this codebase already sanctions for GitHub
  in migration 0012 — a durability mechanism in front of the existing queue, not a second queue.

## Affected files

**Created**

- `services/core/drizzle/0020_w7_01_github_installation_sync.sql` — hand-authored migration:
  the `github_installation_sync` table (+ FK, indexes, RLS enable/force/`org_isolation`,
  `set_updated_at` trigger, least-privilege grants) following `0016_jira_connections.sql`'s idiom;
  the dispatcher role + three SECURITY DEFINER functions following `0012_github_initial_parse_outbox.sql`'s
  idiom; and the two additive `repositories` sweep-marker columns.
- `services/core/src/db/githubInstallationSyncStore.ts` — **tenant-scoped** readers/writers for
  the run row. Every export takes a `tx: Db` the caller already produced via `withOrgContext`.
- `services/core/src/db/githubInstallationDiscoveryOutbox.ts` — the **cross-tenant** dispatcher
  boundary (claim/complete/retry), calling only migration 0020's SECURITY DEFINER functions after
  `set local role sayre_app`, exactly as `db/githubInitialParseOutbox.ts` does for 0012.
  Deliberately a separate file from the store above so the trust boundary is greppable.
- `services/core/src/services/installationDiscoveryDispatcher.ts` — `InstallationDiscoveryDispatcher`
  class + `getInstallationDiscoveryDispatcher()`, mirroring `initialParseOutboxDispatcher.ts`
  (bounded batch, lease, poll interval, publish timeout, backoff) but publishing via BullMQ
  `enqueue('github-sync', …)` instead of SQS.
- `services/core/src/services/installationDiscoveryWake.ts` — `setInstallationDiscoveryWakeHandler`
  / `kickInstallationDiscoveryDispatcher`, mirroring `initialParseOutboxWake.ts` (keeps route
  imports from eagerly constructing the BullMQ dependency graph, and avoids a service↔dispatcher
  import cycle).
- `services/core/src/security/assertInstallationDiscoveryOutboxReady.ts` — startup fail-closed gate
  over migration 0020's boundary, mirroring `assertInitialParseOutboxReady.ts`.
- `services/core/src/services/githubInstallationDiscoveryService.ts` — enqueue + execute paginated
  discovery + the revoke sweep.
- `services/core/src/github/__fixtures__/largeInstallation.ts` — deterministic ≥100-repo fake
  installation (fake `GithubAppClient`) shared by the discovery, callback, and reconcile tests.
- `services/core/src/services/githubInstallationDiscoveryService.test.ts` — behavioral tests
  (authored by `red`, not by `dev`).
- `services/core/src/services/installationDiscoveryDispatcher.test.ts` — behavioral tests for the
  dispatcher/outbox recovery path (`red`).
- `services/core/src/services/githubInstallationRevokeTraceThrough.test.ts` — the replacement
  structural guarantee for W2-09's "additive-only" trace-through (see Modified below): against a
  stateful fake store, exactly two call sites can move `revoked_at` (the `removed` webhook and the
  sweep), and no request-path code can.

**Modified**

- `services/core/drizzle/meta/_journal.json` — journal entry `idx: 20`, tag
  `0020_w7_01_github_installation_sync`, `version: "7"`, `breakpoints: true`.
- `services/core/src/db/schema.ts` — add the `githubInstallationSync` pgTable and the two new
  `repositories` columns (RLS itself lives in the migration, per the file's existing header note).
- `services/core/src/db/rls_acceptance.tester.test.ts` — the expected-column spec for
  `repositories` gains `last_discovery_run_id` (`uuid`, nullable) and `last_discovery_at`
  (`timestamp with time zone`, nullable). Missing this is a known CI failure mode for this repo
  (commit `c39d8c4` was exactly this omission for W2-09's `revoked_at`).
- `services/core/src/github/appClient.ts` — replace `listInstallationRepos` with
  `listInstallationReposPage`; delete `positiveLimit`; rename/rescope
  `REPOSITORY_DISCOVERY_TIMEOUT_MS` (30s) to `PAGE_DISCOVERY_TIMEOUT_MS`, from whole-discovery to
  per-page.
- `services/core/src/github/appClient.test.ts` — existing `listInstallationRepos` tests
  (lines ~216–463, including the `maxRepos: 25` case at line 279) rewritten against the page API.
- `services/core/src/queue/bullmq.ts` — add `GithubInstallationDiscoveryPayload`, widen
  `QueuePayloads['github-sync']` to a union, export the job-type constant. `QUEUE_NAMES` is
  unchanged.
- `services/core/src/integrations/git/worker.ts` — dispatch on `envelope.type` between
  `syncGitMetadata` and `runInstallationDiscovery`.
- `services/core/src/index.ts` — call `assertInstallationDiscoveryOutboxReady(runtimeDsn)` alongside
  the existing gates; construct/start the discovery dispatcher and install its wake handler exactly
  as the initial-parse dispatcher is wired; on shutdown clear the handler, `stop()` it, and
  `closeQueues()` (currently only `closeSqsClient()` is called, since nothing in the process
  published to BullMQ before this ticket).
- `services/core/src/db/githubAppInstallWrites.ts` — `registerRepository` gains an optional
  `discoveryRunId` that stamps the sweep marker columns; new org-scoped readers
  `listRevokeSweepCandidates` and `countActiveGithubRepositories`; `markRepositoryRevoked` reused
  unchanged.
- `services/core/src/services/githubAppInstallService.ts` — remove `MAX_REPOS_PER_CALLBACK`,
  `listInstalledRepos`, and the repo loop; write the pending sync row in the existing
  `withOrgContext` transaction and kick the discovery dispatcher after commit.
  `buildInitialParseEnvelope` stays exported and unchanged.
- `services/core/src/services/githubAppInstallService.test.ts` — updated for the new
  `CallbackResult`.
- `services/core/src/services/githubInstallationReconcileService.ts` — row-write-only rewrite;
  remove `MAX_RECONCILE_REPOS`, `truncated`, `registered`, `enqueued`; **replace the file-header
  OQ-5 "never revokes" block** with the W7-01 authorization note (the destructive direction now
  exists, is asynchronous, and is authorized by this endpoint's admin gate — the endpoint itself
  still performs no revoke inline and has no `markRepositoryRevoked` dependency).
- `services/core/src/services/githubInstallationReconcileService.test.ts` — the
  `'never calls markRepositoryRevoked / ReconcileDeps has no such dependency, and revoked is
  always 0'` test (line ~136) is rewritten: `ReconcileDeps` still has no `markRepositoryRevoked`
  (the *request path* still never revokes), but the assertion that revocation can never happen at
  all is replaced by the new sweep-authorization assertions.
- `services/core/src/services/githubInstallationRepositoriesTraceThrough.test.ts` — the
  `'reconcile OQ-5 additive-only guarantee…'` describe block (lines ~296–400) is deliberately
  rewritten, not deleted: the "a repo GitHub no longer reports is left completely untouched"
  expectation is now false by design. Its replacement lives in the new
  `githubInstallationRevokeTraceThrough.test.ts`; what stays here is the still-true half — the
  synchronous reconcile request path performs no revoke. The fake client's
  `listInstallationRepos` (lines ~157, 326, 368, 394) also moves to the page API.
- `services/core/src/services/githubInstallLifecycleTraceThrough.test.ts` — same fake-client
  interface update.
- `services/core/src/routes/githubInstallationReconcile.ts` — `res.status(202).json(...)`.
- `services/core/src/routes/githubInstallationReconcile.test.ts`.
- `services/core/src/services/repositoryCatalogService.ts` — add the `sync` summary and its
  role-gated counts and sweep outcome.
- `services/core/src/services/repositoryCatalogService.test.ts`,
  `services/core/src/routes/repositoryCatalog.test.ts`.
- `apps/web/app/lib/repositoryCatalog.ts` — parse `sync`.
- `apps/web/app/workspace/types.ts` — `RepositoryImportSync` type.
- `apps/web/app/workspace/dataSource.ts` — `repositories()` returns catalog + sync (both the live
  source at ~line 283 and the fixture source at ~line 546).
- `apps/web/app/workspace/state/session.tsx` — hold/expose `sync`; extend the existing 2.5s
  re-poll effect (line 80) to also poll while a sync is in flight.
- `apps/web/app/workspace/components/CanvasStates.tsx` — new `ImportingRepositoriesState`.
- `apps/web/app/workspace/views/LegacyWorkspaceView.tsx` — new `'importing'` canvas status plus
  the chip placement.
- `apps/web/app/mock/fixtures.ts` — fixture `sync` value.

## Interfaces / signatures

### `services/core/src/github/appClient.ts`

```ts
export interface InstallationRepoPage {
  repos: InstalledRepo[];      // this page only, in GitHub's order
  page: number;                // the 1-based page just fetched
  hasNextPage: boolean;        // true iff GitHub returned a FULL page (repos.length === perPage)
  totalCount: number | null;   // GitHub's `total_count`, or null when absent/invalid
}

export interface GithubAppClient {
  authorizeInstallation(code: string, installationId: number): Promise<AuthorizedInstallation>;
  mintInstallationToken(installationId: number): Promise<string>;
  /** Replaces listInstallationRepos(). No repo-count cap parameter exists. */
  listInstallationReposPage(
    installationId: number,
    page: number,
    perPage?: number,          // default INSTALLATION_REPOS_PER_PAGE (100); valid 1..100
  ): Promise<InstallationRepoPage>;
  getInstallationRepo(installationId: number, fullName: string): Promise<InstalledRepo | null>;
}

export const INSTALLATION_REPOS_PER_PAGE = 100;
/** The existing 30s budget (REPOSITORY_DISCOVERY_TIMEOUT_MS), rescoped to ONE page + its
 *  branch lookups and renamed accordingly. */
const PAGE_DISCOVERY_TIMEOUT_MS = 30_000;
```

`listInstallationRepos`, its `maxRepos` parameter, and `positiveLimit` are **deleted**.
`resolveDefaultBranchHead`, `resolveRepositoryPage` (concurrency 5), `readBoundedJson`'s 256 KiB
cap, `REQUEST_TIMEOUT_MS`, and the `GithubAppApiError` normalization are all reused unchanged.

### `services/core/src/db/githubInstallationSyncStore.ts` (tenant-scoped)

```ts
export type InstallationSyncStatus =
  | 'pending' | 'running' | 'complete' | 'failed' | 'cancelled';
export type InstallationSyncReason = 'app_install' | 'manual_reconcile';
/** Fixed enum — NEVER a provider message, URL, or repository name. */
export type InstallationSyncErrorCode =
  | 'provider_unavailable' | 'page_limit_exceeded' | 'internal_error';
/** OQ-4: why the destructive sweep did or did not revoke anything on this run. */
export type InstallationSweepOutcome =
  | 'not_applicable'          // app_install run, or run never reached `complete`
  | 'applied'
  | 'withheld_coverage'       // an active installation of this org has no completed run
  | 'withheld_empty_result'   // GitHub reported 0 repos while the org holds >=1 active
  | 'withheld_ratio';         // candidates exceeded the blast-radius bound

/** OQ-4 audit: who asked for the run. Captured server-side from AuthContext, never client input. */
export interface InstallationSyncSubject {
  subjectType: 'user' | 'agent_key';
  subjectId: string;          // ctx.userId or ctx.agentKeyId
}

export interface InstallationSyncRow {
  installationId: number;
  runId: string;                              // uuid, regenerated on every reset
  status: InstallationSyncStatus;
  reason: InstallationSyncReason;
  nextPage: number;
  totalCount: number | null;
  discoveredCount: number;
  registeredCount: number;
  enqueuedCount: number;
  revokedCount: number;
  sweepOutcome: InstallationSweepOutcome;
  attemptCount: number;                       // worker executions
  dispatchAttemptCount: number;               // dispatcher hand-offs to BullMQ
  lastErrorCode: InstallationSyncErrorCode | null;
  requestedBy: InstallationSyncSubject | null;  // null for app_install
  startedAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  completedRunId: string | null;              // runId of the last fully-observed run
}

/**
 * Upsert on (org_id, installation_id). Resets run state (fresh `run_id`, cursor 1, counts 0,
 * attempts 0, sweep outcome 'not_applicable', `next_attempt_at = now()` so the dispatcher picks
 * it up) UNLESS the existing row is `running` and was touched within INSTALLATION_SYNC_STALL_MS
 * — in that case the live run is left alone and this returns { reset: false } with the LIVE
 * run's id (EC-20). `completed_run_id` is preserved across resets (the sweep's coverage input).
 */
export async function startInstallationSync(
  tx: Db,
  row: {
    orgId: string;
    installationId: number;
    reason: InstallationSyncReason;
    requestedBy: InstallationSyncSubject | null;
  },
): Promise<{ reset: boolean; runId: string }>;

/**
 * Moves pending|failed|running -> running, bumps attempt_count, pushes the redispatch watchdog
 * forward, and returns the resume cursor. `expectedRunId` guards a stale redispatch: a job for a
 * run that has since been reset returns null rather than resuming under the new run's counters.
 */
export async function claimInstallationSync(
  tx: Db,
  key: { orgId: string; installationId: number; expectedRunId: string },
): Promise<{ nextPage: number; runId: string; startedAt: Date } | null>;
// null = no row, run id superseded, or already complete/cancelled

/**
 * Compare-and-set page bookkeeping: applies ONLY when the stored cursor still equals
 * `expectedPage`, status is 'running', and run_id still equals `runId`. Returns false when
 * another runner already advanced past this page (the caller must then stop as superseded) —
 * this is what makes a replayed or concurrent page a no-op for the counters (AC-15, EC-10,
 * EC-11). Also acts as the run's HEARTBEAT: it pushes `next_attempt_at` to
 * `now() + INSTALLATION_DISCOVERY_REDISPATCH_SECONDS`, so a progressing run is never
 * redispatched underneath itself (AC-23).
 */
export async function advanceInstallationSyncPage(
  tx: Db,
  input: {
    orgId: string; installationId: number; runId: string; expectedPage: number;
    totalCount: number | null;
    discoveredDelta: number; registeredDelta: number; enqueuedDelta: number;
  },
): Promise<boolean>;

/** Terminal: status='complete', completed_at=now(), completed_run_id=run_id, lease cleared. */
export async function completeInstallationSync(
  tx: Db, key: { orgId: string; installationId: number; runId: string },
): Promise<void>;
export async function failInstallationSync(
  tx: Db,
  input: {
    orgId: string; installationId: number; runId: string;
    errorCode: InstallationSyncErrorCode;
  },
): Promise<void>;
export async function cancelInstallationSync(
  tx: Db, key: { orgId: string; installationId: number; runId: string },
): Promise<void>;

/** OQ-4: records the sweep result on the run row (the audit record). */
export async function recordSweepOutcome(
  tx: Db,
  input: {
    orgId: string; installationId: number; runId: string;
    outcome: InstallationSweepOutcome; revokedCount: number;
  },
): Promise<void>;

/** All rows for one org (RLS + explicit org predicate). Never crosses orgs. */
export async function listInstallationSyncRows(tx: Db, orgId: string): Promise<InstallationSyncRow[]>;

export const INSTALLATION_SYNC_STALL_MS = 5 * 60_000;
```

### `services/core/src/db/githubInstallationDiscoveryOutbox.ts` (cross-tenant dispatcher boundary)

Structurally identical to `db/githubInitialParseOutbox.ts`: each function opens its own
transaction, executes `set local role sayre_app`, clears `app.org_id`, and calls exactly one of
migration 0020's SECURITY DEFINER functions. No table access, no admin DSN, no `org_id` from
anywhere but the row itself.

```ts
export interface ClaimedInstallationDiscovery {
  id: string;                 // github_installation_sync.id
  leaseToken: string;
  orgId: string;              // server-side truth from the row — becomes envelope.org_id
  installationId: number;
  runId: string;
  reason: InstallationSyncReason;
  dispatchAttemptCount: number;
}

/** Lease a bounded due batch across tenants. batchSize 1..25, leaseSeconds 10..300. */
export async function claimInstallationDiscoveryOutbox(
  db: Db, batchSize: number, leaseSeconds: number,
): Promise<ClaimedInstallationDiscovery[]>;

/**
 * Mark dispatched for the current lease owner only. Unlike 0012's terminal `delivered_at`, this
 * is a WATCHDOG re-arm: it sets `dispatched_at = now()`, clears the lease, and sets
 * `next_attempt_at = now() + redispatchSeconds` so a run that neither progresses (heartbeat) nor
 * terminates becomes due again — this is what survives a total Redis loss (AC-20).
 * redispatchSeconds 30..3600.
 */
export async function completeInstallationDiscoveryOutbox(
  db: Db, id: string, leaseToken: string, redispatchSeconds: number,
): Promise<boolean>;

/** Release the lease with a bounded delay after a failed enqueue. delaySeconds 1..300. */
export async function retryInstallationDiscoveryOutbox(
  db: Db, id: string, leaseToken: string, delaySeconds: number,
): Promise<boolean>;
```

### `services/core/src/services/installationDiscoveryDispatcher.ts`

```ts
export interface InstallationDiscoveryDispatcherDeps {
  claim: (batchSize: number, leaseSeconds: number) => Promise<ClaimedInstallationDiscovery[]>;
  complete: (id: string, leaseToken: string, redispatchSeconds: number) => Promise<boolean>;
  retry: (id: string, leaseToken: string, delaySeconds: number) => Promise<boolean>;
  publish: (envelope: MessageEnvelope<GithubInstallationDiscoveryPayload>) => Promise<string>;
  reportError: (stage: 'claim' | 'publish' | 'complete' | 'retry') => void;
}

export interface InstallationDiscoveryDispatcherOptions {
  batchSize?: number;            // default 5, 1..25
  leaseSeconds?: number;         // default 60, 10..300
  pollIntervalMs?: number;       // default 2_000, 25..60_000
  publishTimeoutMs?: number;     // default 10_000, < leaseSeconds * 1000
  redispatchSeconds?: number;    // default INSTALLATION_DISCOVERY_REDISPATCH_SECONDS
}

export interface InstallationDiscoveryDrainResult {
  claimed: number; dispatched: number; deferred: number;
}

export class InstallationDiscoveryDispatcher {
  constructor(
    deps?: Partial<InstallationDiscoveryDispatcherDeps>,
    options?: InstallationDiscoveryDispatcherOptions,
  );
  start(): void;
  kick(): void;
  stop(): Promise<void>;
  drainOnce(): Promise<InstallationDiscoveryDrainResult>;
}
export function getInstallationDiscoveryDispatcher(): InstallationDiscoveryDispatcher;

export const INSTALLATION_DISCOVERY_REDISPATCH_SECONDS = 300;      // == INSTALLATION_SYNC_STALL_MS
export const MAX_INSTALLATION_DISCOVERY_DISPATCH_ATTEMPTS = 10;    // runaway guard (EC-27)
```

`services/core/src/services/installationDiscoveryWake.ts`:

```ts
export function setInstallationDiscoveryWakeHandler(handler: (() => void) | null): void;
export function kickInstallationDiscoveryDispatcher(): void;
```

### `services/core/src/queue/bullmq.ts`

```ts
export const GITHUB_INSTALLATION_DISCOVERY_EVENT_TYPE = 'github.installation_discovery';

export interface GithubInstallationDiscoveryPayload {
  provider: 'github';
  type: 'installation_discovery';
  installation_id: string;                 // stringified, matching the envelope conventions
  run_id: string;                          // the run this delivery belongs to (stale-redispatch guard)
  reason: 'app_install' | 'manual_reconcile';
}

export type GithubSyncJobPayload = NormalizedRepoEvent | GithubInstallationDiscoveryPayload;
export type GithubSyncPayload = NormalizedRepoEvent;   // back-compat alias, unchanged

export interface QueuePayloads {
  'github-sync': GithubSyncJobPayload;     // widened
  'jira-sync': JiraSyncPayload;
  'linear-sync': LinearSyncPayload;
}
```

`QUEUE_NAMES` stays `['github-sync', 'jira-sync', 'linear-sync']`. `org_id` remains envelope-level
only — it is never added to the discovery payload.

### `services/core/src/services/githubInstallationDiscoveryService.ts`

```ts
export const INSTALLATION_DISCOVERY_TARGET_MS = 60_000;      // AC-8 product bound (OQ-1, confirmed)
export const MAX_INSTALLATION_DISCOVERY_PAGES = 100;         // runaway guard ≈ 10,000 repos
/** OQ-4 blast-radius bound: a sweep may revoke at most this fraction of the org's active
 *  GitHub repositories, unless the candidate count is at or below MIN_SWEEP_RATIO_EXEMPT_ROWS. */
export const MAX_SWEEP_REVOKE_FRACTION = 0.5;
export const MIN_SWEEP_RATIO_EXEMPT_ROWS = 10;

export interface QueueInstallationDiscoveryDeps {
  withOrg: <T>(orgId: string, fn: (tx: Db) => Promise<T>) => Promise<T>;
  startInstallationSync: typeof startInstallationSync;
  kickDiscoveryDispatcher: () => void;      // REPLACES a direct enqueueJob dependency (OQ-3)
}

/**
 * OQ-3: writes the durable row ONLY (inside the caller's org transaction when `tx` is supplied,
 * otherwise in its own), then kicks the dispatcher after commit as a latency optimization. It
 * NEVER calls BullMQ `enqueue()` — losing the kick costs latency, never the job.
 */
export async function queueInstallationDiscovery(
  input: {
    orgId: string; installationId: number; reason: InstallationSyncReason;
    requestedBy: InstallationSyncSubject | null;
  },
  deps?: Partial<QueueInstallationDiscoveryDeps>,
): Promise<{ status: 'queued'; runId: string; reset: boolean }>;

/** Called by the DISPATCHER, from a claimed row's server-side fields. */
export function buildInstallationDiscoveryEnvelope(input: {
  orgId: string; installationId: number; runId: string; reason: InstallationSyncReason;
}): MessageEnvelope<GithubInstallationDiscoveryPayload>;
// type: GITHUB_INSTALLATION_DISCOVERY_EVENT_TYPE
// source: 'github-app-install' | 'github-reconcile' (from reason)
// trace_id: `installation:${installationId}`
// idempotency_key: ['github','installation_discovery',installationId,runId].join(':')
//   — stable ACROSS redispatches of the same run, distinct across runs.

export interface InstallationDiscoveryDeps {
  resolveInstallationOrg: (
    installationId: number,
  ) => Promise<{ orgId: string; active: boolean } | null>;
  githubClient: GithubAppClient;
  withOrg: <T>(orgId: string, fn: (tx: Db) => Promise<T>) => Promise<T>;
  claimInstallationSync: typeof claimInstallationSync;
  advanceInstallationSyncPage: typeof advanceInstallationSyncPage;
  completeInstallationSync: typeof completeInstallationSync;
  failInstallationSync: typeof failInstallationSync;
  cancelInstallationSync: typeof cancelInstallationSync;
  recordSweepOutcome: typeof recordSweepOutcome;
  registerRepository: typeof registerRepository;         // now called WITH discoveryRunId
  enqueueInitialParse: (tx: Db, e: MessageEnvelope<RepoInitialParseEvent>) => Promise<void>;
  kickInitialParseOutbox: () => void;
  // OQ-4 sweep dependencies:
  listActiveInstallationsForOrg: typeof listActiveInstallationsForOrg;
  listInstallationSyncRows: typeof listInstallationSyncRows;
  listRevokeSweepCandidates: typeof listRevokeSweepCandidates;
  countActiveGithubRepositories: typeof countActiveGithubRepositories;
  markRepositoryRevoked: typeof markRepositoryRevoked;
}

export interface InstallationSweepResult {
  outcome: InstallationSweepOutcome;
  revoked: number;
}

export type InstallationDiscoveryResult =
  | { status: 'complete'; pages: number; discovered: number; registered: number;
      enqueued: number; sweep: InstallationSweepResult }
  | { status: 'cancelled'; reason: 'unknown_installation' | 'org_mismatch'
      | 'inactive_installation' | 'superseded' | 'no_row' }
  | { status: 'failed'; errorCode: InstallationSyncErrorCode; nextPage: number };

/** BullMQ handler. Throws (after marking the row failed) so BullMQ retries with backoff; the
 *  outbox watchdog is the durable backstop when BullMQ's own retries are lost entirely. */
export async function runInstallationDiscovery(
  envelope: MessageEnvelope<GithubInstallationDiscoveryPayload>,
  deps?: Partial<InstallationDiscoveryDeps>,
): Promise<InstallationDiscoveryResult>;
```

### `services/core/src/db/githubAppInstallWrites.ts` (modified)

```ts
export async function registerRepository(
  tx: Db,
  row: {
    orgId: string; providerRepoId: string; fullName: string; defaultBranch: string | null;
    /** OQ-4 sweep marker. Set by discovery only; the webhook `added` path omits it, which
     *  leaves the marker untouched rather than clearing it. */
    discoveryRunId?: string;
  },
): Promise<{ repoId: string }>;

/**
 * OQ-4: active GitHub repositories of this org that the observed runs did NOT report.
 * `observedRunIds` = the completed_run_id of every active installation of the org.
 * `runStartedAt` excludes any row created/updated after the run began (mid-run `added`
 * webhook, or a concurrent installation's run) — the second false-positive guard.
 */
export async function listRevokeSweepCandidates(
  tx: Db,
  input: { orgId: string; observedRunIds: string[]; runStartedAt: Date },
): Promise<Array<{ id: string; externalId: string }>>;

export async function countActiveGithubRepositories(tx: Db, orgId: string): Promise<number>;
```

### `services/core/src/services/githubAppInstallService.ts`

```ts
export interface CallbackResult {
  redirectTo: string;
  discovery: 'queued' | 'skipped';   // REPLACES `enqueuedRepos: number` (OQ-6, confirmed)
}

export interface InstallCallbackDeps {
  // ... verifyState / resolveExistingInstallationOrg / githubClient / withOrg / getDb /
  //     upsertInstallation unchanged ...
  startInstallationSync: typeof startInstallationSync;              // NEW (runs in the tx)
  kickDiscoveryDispatcher: () => void;                              // NEW (after commit)
  // REMOVED: enqueueInitialParse, kickInitialParseOutbox, registerRepository
}
```

The callback always passes `reason: 'app_install'` and `requestedBy: null` — an install callback
is a GitHub redirect, not an authenticated admin action, which is precisely why its runs are
never sweep-eligible (AC-25).

### `services/core/src/services/githubInstallationReconcileService.ts`

```ts
export interface ReconcileResult {
  status: 'queued';
  installations: number;   // active installations for this org
  queued: number;          // discovery runs started (== installations on success)
}

export async function reconcileInstallationRepositories(
  ctx: AuthContext,
  deps?: Partial<ReconcileDeps>,
): Promise<ReconcileResult>;

export interface ReconcileDeps {
  resolveActiveInstallations: (orgId: string) => Promise<Array<{ installationId: number }>>;
  withOrg: <T>(orgId: string, fn: (tx: Db) => Promise<T>) => Promise<T>;
  startInstallationSync: typeof startInstallationSync;
  kickDiscoveryDispatcher: () => void;
  // Still NO markRepositoryRevoked, NO githubClient, NO registerRepository, NO
  // enqueueInitialParse: the request path performs no listing, no registration and no
  // revocation. It records an admin-authorized INTENT; the worker executes it.
}
```

Each row is written with `reason: 'manual_reconcile'` and `requestedBy` derived server-side from
`ctx` (`{ subjectType: 'user', subjectId: ctx.userId }` or `{ subjectType: 'agent_key',
subjectId: ctx.agentKeyId }`). `POST /integrations/github/reconcile` → `res.status(202).json(result)`.
`authenticate()` + `authorize('admin')` unchanged; `ctx.orgId` remains the only org source.

### `services/core/src/services/repositoryCatalogService.ts`

```ts
export type RepositoryImportSyncStatus = 'idle' | 'importing' | 'stalled' | 'failed';

export interface RepositoryImportSync {
  status: RepositoryImportSyncStatus;
  updatedAt: string | null;              // ISO-8601, most recent sync row touch
  discoveredRepositories: number | null; // admin/owner only; null for member
  registeredRepositories: number | null; // admin/owner only; null for member
  revokedRepositories: number | null;    // admin/owner only; null for member (OQ-4)
  sweepOutcome: InstallationSweepOutcome | null;  // admin/owner only; null for member (OQ-4)
}

export interface RepositoryCatalog {
  authorization: 'server-filtered';
  repositories: RepositoryCatalogEntry[];
  sync: RepositoryImportSync;            // NEW
}

export interface RepositoryCatalogServiceDeps {
  store: RepositoryCatalogStore;
  permissions: PermissionStore;
  syncRows: (orgId: string) => Promise<InstallationSyncRow[]>;   // NEW dep
  now: () => Date;                                               // NEW, for stall determination
}
```

Aggregation, in order: any `pending`/`running` row touched within `INSTALLATION_SYNC_STALL_MS` →
`importing`; else any `pending`/`running` row older than that → `stalled`; else any `failed` row →
`failed`; else `idle` (no rows, or all `complete`/`cancelled`). Counts, `revokedRepositories` and
`sweepOutcome` are non-null only when `ctx.roles` contains `'admin'` or `'owner'`;
`sweepOutcome` reports the most recently completed run's outcome, so a withheld mass-revoke is
visible to an admin rather than silent.

### `apps/web`

```ts
// apps/web/app/lib/repositoryCatalog.ts
export interface RepositoryCatalogResponse {
  authorization: 'server-filtered';
  repositories: RepositoryCatalogEntry[];
  sync: RepositoryImportSync;
}
// An ABSENT `sync` key parses as { status:'idle', updatedAt:null, counts null } (deploy skew).
// A PRESENT but malformed `sync` throws RepositoryCatalogResponseError.
// The web parser reads status/updatedAt/discoveredRepositories/registeredRepositories only;
// the admin-only audit fields (revokedRepositories, sweepOutcome) are accepted and ignored —
// nothing in W7-01's UI renders them.

// apps/web/app/workspace/dataSource.ts
repositories(signal: AbortSignal): Promise<{ repositories: Repository[]; sync: RepositoryImportSync }>;

// apps/web/app/workspace/state/session.tsx  (WorkspaceSessionContextValue)
sync: RepositoryImportSync;

// apps/web/app/workspace/components/CanvasStates.tsx
export function ImportingRepositoriesState(
  props: { sync: RepositoryImportSync; variant: 'canvas' | 'chip' },
): JSX.Element;   // data-canvas-state="importing-repositories" / data-repository-import=<status>
```

### Migration `0020_w7_01_github_installation_sync.sql`

Three parts, in this order: the tenant table, the additive `repositories` sweep markers, and the
dispatcher boundary.

```sql
CREATE TABLE "github_installation_sync" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "installation_id" bigint NOT NULL,
  "run_id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "status" text NOT NULL DEFAULT 'pending',
  "reason" text NOT NULL,
  "next_page" integer NOT NULL DEFAULT 1,
  "total_count" integer,
  "discovered_count" integer NOT NULL DEFAULT 0,
  "registered_count" integer NOT NULL DEFAULT 0,
  "enqueued_count" integer NOT NULL DEFAULT 0,
  "revoked_count" integer NOT NULL DEFAULT 0,
  "sweep_outcome" text NOT NULL DEFAULT 'not_applicable',
  "attempt_count" integer NOT NULL DEFAULT 0,
  "last_error_code" text,
  "requested_by_subject_type" text,
  "requested_by_subject_id" text,
  -- OQ-3 dispatch bookkeeping (mirrors github_initial_parse_outbox's delivery columns)
  "dispatch_attempt_count" integer NOT NULL DEFAULT 0,
  "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
  "lease_token" uuid,
  "lease_expires_at" timestamp with time zone,
  "dispatched_at" timestamp with time zone,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone,
  "completed_run_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT github_installation_sync_status_check
    CHECK (status IN ('pending','running','complete','failed','cancelled')),
  CONSTRAINT github_installation_sync_reason_check
    CHECK (reason IN ('app_install','manual_reconcile')),
  CONSTRAINT github_installation_sync_error_code_check
    CHECK (last_error_code IS NULL OR last_error_code IN
           ('provider_unavailable','page_limit_exceeded','internal_error')),
  CONSTRAINT github_installation_sync_sweep_outcome_check
    CHECK (sweep_outcome IN ('not_applicable','applied','withheld_coverage',
                             'withheld_empty_result','withheld_ratio')),
  CONSTRAINT github_installation_sync_subject_check
    CHECK ((requested_by_subject_type IS NULL) = (requested_by_subject_id IS NULL)
           AND (requested_by_subject_type IS NULL
                OR requested_by_subject_type IN ('user','agent_key'))),
  CONSTRAINT github_installation_sync_next_page_check CHECK (next_page >= 1),
  CONSTRAINT github_installation_sync_lease_pair_check
    CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL)),
  CONSTRAINT github_installation_sync_counts_check
    CHECK (discovered_count >= 0 AND registered_count >= 0
           AND enqueued_count >= 0 AND revoked_count >= 0
           AND attempt_count >= 0 AND dispatch_attempt_count >= 0
           AND (total_count IS NULL OR total_count >= 0)),
  CONSTRAINT github_installation_sync_org_installation_unique
    UNIQUE (org_id, installation_id)
);
-- FK org_id -> organizations(id) ON DELETE CASCADE
-- INDEX github_installation_sync_org_status_idx (org_id, status)
-- INDEX github_installation_sync_dispatch_due_idx (next_attempt_at, created_at)
--   WHERE status IN ('pending','running','failed')          -- the dispatcher's due scan
-- ENABLE + FORCE ROW LEVEL SECURITY; POLICY org_isolation USING/WITH CHECK
--   (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
-- TRIGGER set_updated_at BEFORE UPDATE ... EXECUTE FUNCTION trigger_set_updated_at()

-- Least privilege for the tenant runtime role: it owns RUN state, not DISPATCH state.
GRANT SELECT, INSERT ON github_installation_sync TO sayre_app;   -- no DELETE, ever
GRANT UPDATE (status, reason, run_id, next_page, total_count, discovered_count,
              registered_count, enqueued_count, revoked_count, sweep_outcome,
              attempt_count, last_error_code, requested_by_subject_type,
              requested_by_subject_id, next_attempt_at, started_at, completed_at,
              completed_run_id, updated_at)
  ON github_installation_sync TO sayre_app;
-- Deliberately NOT granted to sayre_app: lease_token, lease_expires_at, dispatched_at,
-- dispatch_attempt_count. Dispatch bookkeeping is the dispatcher's alone. `next_attempt_at`
-- IS granted because the run's heartbeat lives there (AC-23).
```

```sql
-- OQ-4 sweep markers (additive; existing repositories RLS policy covers them unchanged).
ALTER TABLE repositories ADD COLUMN "last_discovery_run_id" uuid;
ALTER TABLE repositories ADD COLUMN "last_discovery_at" timestamp with time zone;
CREATE INDEX repositories_org_last_discovery_idx
  ON repositories (org_id, last_discovery_run_id) WHERE revoked_at IS NULL;
```

```sql
-- OQ-3 dispatcher boundary — the same shape migration 0012 establishes, verbatim in structure:
--   * role sayre_installation_discovery_dispatcher: NOLOGIN NOINHERIT NOBYPASSRLS, created
--     idempotently, with the same DO $$ guard that RAISEs if it already exists with unsafe
--     attributes or any role membership;
--   * column-level SELECT (id, org_id, installation_id, run_id, reason, status,
--     next_attempt_at, lease_token, lease_expires_at, dispatched_at, dispatch_attempt_count,
--     created_at) and UPDATE (dispatch_attempt_count, next_attempt_at, lease_token,
--     lease_expires_at, dispatched_at, updated_at) for that role — it can never read counters,
--     the requesting subject, or the cursor, and can never INSERT or DELETE;
--   * permissive dispatcher_select / dispatcher_update policies TO that role only;
--   * three SECURITY DEFINER functions owned by it, `SET search_path = pg_catalog, public`,
--     REVOKE ALL FROM PUBLIC, GRANT EXECUTE TO sayre_app;
--   * GRANT CREATE ON SCHEMA public ... REVOKE CREATE immediately after, as 0012 does.

CREATE OR REPLACE FUNCTION public.claim_github_installation_discovery(
  requested_batch_size integer,     -- 0..25 enforced, invalid_parameter_value otherwise
  requested_lease_seconds integer   -- 10..300 enforced
) RETURNS TABLE (
  id uuid, lease_token uuid, org_id uuid, installation_id bigint,
  run_id uuid, reason text, dispatch_attempt_count integer
) ...
-- Due predicate:
--   status IN ('pending','running')
--   OR (status = 'failed' AND last_error_code <> 'page_limit_exceeded')
--   AND next_attempt_at <= clock_timestamp()
--   AND (lease_expires_at IS NULL OR lease_expires_at <= clock_timestamp())
--   AND dispatch_attempt_count < 10                     -- MAX_..._DISPATCH_ATTEMPTS (EC-27)
-- ORDER BY next_attempt_at, created_at, id FOR UPDATE SKIP LOCKED LIMIT requested_batch_size
-- Claim sets dispatch_attempt_count += 1, a fresh lease_token, and lease_expires_at.

CREATE OR REPLACE FUNCTION public.complete_github_installation_discovery(
  requested_id uuid, requested_lease_token uuid, requested_redispatch_seconds integer  -- 30..3600
) RETURNS boolean ...
-- Lease-owner-only: dispatched_at = clock_timestamp(), lease cleared,
-- next_attempt_at = clock_timestamp() + redispatch_seconds  (watchdog re-arm, NOT terminal).

CREATE OR REPLACE FUNCTION public.retry_github_installation_discovery(
  requested_id uuid, requested_lease_token uuid, requested_delay_seconds integer       -- 1..300
) RETURNS boolean ...
-- Lease-owner-only: lease cleared, next_attempt_at pushed out by the bounded delay.
```

Every *tenant* read and write of `github_installation_sync` still happens inside a known
`withOrgContext(orgId)`: the worker gets `org_id` from the envelope (itself written server-side
from the row at dispatch time) and re-verifies it against `resolveInstallationOrg`. The only
cross-tenant access is the three functions above, which can see dispatch columns and nothing else.

## Approach

Build in this order.

1. **`appClient.ts`** — add `InstallationRepoPage` + `listInstallationReposPage`; validate `page`
   (safe integer ≥ 1) and `perPage` (1..100) before any network call; issue exactly one
   `GET /installation/repositories?per_page=<perPage>&page=<page>`; read `total_count` defensively
   (safe non-negative integer or `null`); resolve default-branch HEADs for that page only via the
   existing `resolveRepositoryPage`; set `hasNextPage = repos.length === perPage`. Apply the 30s
   deadline per page. Delete `listInstallationRepos`, `maxRepos`, and `positiveLimit`.
2. **Schema + migration** — add `githubInstallationSync` and the two `repositories` columns to
   `schema.ts`; hand-author migration 0020's three parts (table idiom from
   `0016_jira_connections.sql`; dispatcher idiom from `0012_github_initial_parse_outbox.sql`);
   append the journal entry; add the two new `repositories` columns to
   `db/rls_acceptance.tester.test.ts`'s column spec.
3. **`githubInstallationSyncStore.ts`** — implement the tenant-scoped functions.
   `startInstallationSync` is a single `INSERT ... ON CONFLICT (org_id, installation_id) DO UPDATE
   ... WHERE` guarded by the stale-`running` predicate, resetting `run_id`/cursor/counts and
   setting `next_attempt_at = now()`; `advanceInstallationSyncPage` is a single guarded
   `UPDATE ... WHERE next_page = expectedPage AND run_id = $runId AND status = 'running'` that
   also pushes `next_attempt_at` (heartbeat) and returns row count.
4. **`githubInstallationDiscoveryOutbox.ts`** — claim/complete/retry wrappers with the same
   argument validation and `set local role sayre_app` discipline as
   `db/githubInitialParseOutbox.ts`.
5. **`bullmq.ts`** — add the payload type (including `run_id`), the job-type constant, and the
   widened `QueuePayloads['github-sync']` union. No new queue.
6. **`installationDiscoveryWake.ts` + `installationDiscoveryDispatcher.ts`** — copy
   `initialParseOutboxDispatcher.ts`'s bounded-cycle structure (start/kick/stop/drainOnce, timer
   `unref()`, sequential publish, timeout, `reportError` that never attaches the raw error).
   For each claimed row: `buildInstallationDiscoveryEnvelope(row)` → `enqueue('github-sync',
   envelope, { attempts: 5, backoff: { type: 'exponential', delay: 5_000 } })` → `complete(...,
   INSTALLATION_DISCOVERY_REDISPATCH_SECONDS)`; on publish failure `retry(...)` with exponential
   backoff derived from `dispatchAttemptCount`.
7. **`githubInstallationDiscoveryService.ts`**:
   - `queueInstallationDiscovery` → `withOrg(orgId)`: `startInstallationSync(...)`; after commit,
     `kickDiscoveryDispatcher()`. No BullMQ call here at all.
   - `runInstallationDiscovery(envelope)`:
     a. `orgId = envelope.org_id` — never from the payload.
     b. `resolveInstallationOrg(installationId)`; bail `cancelled` on `null`
        (`unknown_installation`), on `resolved.orgId !== orgId` (`org_mismatch`), or on
        `!resolved.active` (`inactive_installation`), writing nothing in the first two cases and
        `cancelInstallationSync` in the third.
     c. `withOrg`: `claimInstallationSync({ expectedRunId: payload.run_id })` → resume `page` +
        `startedAt`. `null` ⇒ return `cancelled`/`no_row` (covers a stale redispatch of a
        superseded run).
     d. Loop while `page - startPage < MAX_INSTALLATION_DISCOVERY_PAGES`:
        re-check installation active (cheap, pre-tx) → `cancelled` if not;
        `listInstallationReposPage(installationId, page)` **outside any transaction**;
        then one `withOrg` transaction: per repo `registerRepository({ ..., discoveryRunId: runId })`,
        and when `default_branch && default_branch_head_sha`
        `enqueueInitialParse(buildInitialParseEnvelope(...))`;
        finally `advanceInstallationSyncPage({ expectedPage: page, runId, ... })` — if it returns
        `false`, abort the whole run as `cancelled`/`superseded` (the transaction still commits;
        the writes are idempotent).
        After commit, `kickInitialParseOutbox()` when that page enqueued anything.
        If `!hasNextPage` → go to (f). Else `page += 1`.
     e. Ceiling hit with `hasNextPage` still true → `failInstallationSync('page_limit_exceeded')`,
        return `failed` **without throwing** (retrying cannot help, and the dispatcher's due
        predicate excludes this error code).
     f. **Completion + sweep, in ONE `withOrg` transaction:** `completeInstallationSync(...)`
        (which sets `completed_run_id = run_id`), then `runRevokeSweep` below, then
        `recordSweepOutcome(...)`.
     g. Any `GithubAppApiError` or store error → `failInstallationSync('provider_unavailable' |
        'internal_error')` leaving the cursor where it is, then rethrow so BullMQ retries. No
        sweep runs on this path — a partially-observed listing must never revoke anything.
   - `runRevokeSweep(tx, { orgId, installationId, runId, reason, startedAt, discovered })`, the
     OQ-4 direction, applying its guards in this order and returning at the first refusal:
     1. `reason !== 'manual_reconcile'` → `not_applicable`, revoked 0. (Authorization guard: only
        the admin-gated endpoint's runs may revoke; an install-callback run never can.)
     2. Coverage: `listActiveInstallationsForOrg` ∩ `listInstallationSyncRows` — if any active
        installation has no row or a `null` `completedRunId`, → `withheld_coverage`, revoked 0.
        `observedRunIds` = every active installation's `completedRunId`.
     3. Empty-result: `discovered === 0 && countActiveGithubRepositories(orgId) > 0` →
        `withheld_empty_result`, revoked 0.
     4. `candidates = listRevokeSweepCandidates({ orgId, observedRunIds, runStartedAt: startedAt })`.
        Ratio: `candidates.length > MIN_SWEEP_RATIO_EXEMPT_ROWS &&
        candidates.length > MAX_SWEEP_REVOKE_FRACTION * countActiveGithubRepositories(orgId)` →
        `withheld_ratio`, revoked 0.
     5. Otherwise `markRepositoryRevoked` per candidate (COALESCE-idempotent), → `applied` with
        the count.
   - Never log a provider message, token, repo name, or full response — only stable codes. The
     sweep emits exactly one structured line: outcome code, counts, installation id, org id.
8. **`integrations/git/worker.ts`** — branch on `envelope.type === GITHUB_INSTALLATION_DISCOVERY_EVENT_TYPE`
   → `runInstallationDiscovery(envelope)`; everything else → `syncGitMetadata` exactly as today.
   `startGitSyncWorker`'s existing `concurrency: 4` and shutdown path are unchanged.
9. **`assertInstallationDiscoveryOutboxReady.ts` + `index.ts`** — port
   `assertInitialParseOutboxReady`'s single metadata query to migration 0020's role/functions/ACLs
   (RLS enabled+forced, owner is `sayre_installation_discovery_dispatcher` with
   NOLOGIN/NOSUPERUSER/NOBYPASSRLS and no memberships, functions SECURITY DEFINER with a pinned
   `search_path`, PUBLIC cannot execute, `sayre_app` can execute, `sayre_app` cannot read or
   mutate lease/dispatch columns, the dispatcher role cannot INSERT/DELETE or read counters).
   Wire the gate + dispatcher lifecycle + `closeQueues()` into `index.ts`.
10. **`githubAppInstallService.ts`** — delete the cap, `listInstalledRepos`, and the repo loop; in
    the existing `withOrg` transaction call `upsertInstallation` then `startInstallationSync({
    reason: 'app_install', requestedBy: null })`; after commit call `kickDiscoveryDispatcher()`;
    return `{ redirectTo, discovery: 'queued' }`. The `setup_action=request` early return becomes
    `{ redirectTo, discovery: 'skipped' }`. Order of the pre-existing guards (state verify → OAuth
    authorize → org-conflict check) is unchanged, so a conflict still throws before any sync row
    exists.
11. **`githubInstallationReconcileService.ts`** — for each active installation,
    `startInstallationSync` with `reason: 'manual_reconcile'` and the `ctx`-derived subject, all
    in one `withOrg` transaction; kick the dispatcher after commit; return `{ status: 'queued',
    installations, queued }`. Replace the file-header OQ-5 block with the W7-01 note. Route → `202`.
12. **`repositoryCatalogService.ts`** — add the `syncRows`/`now` deps and the aggregation;
    role-gate the counts, `revokedRepositories` and `sweepOutcome` off `ctx.roles`.
13. **Web** — extend the catalog parser, thread `sync` through `dataSource` → `session` →
    `LegacyWorkspaceView`, add `ImportingRepositoriesState`, add the `'importing'` canvas status
    (taken when `session.repository === null` and sync is `importing`/`stalled`, so the misleading
    "No repository has been connected" state no longer wins), and render the chip variant whenever
    sync is non-`idle` and a repository *is* selectable. Extend the existing 2.5s re-poll effect's
    condition to `catalog.some(r => r.readiness === 'registered') || sync.status === 'importing'`.
14. **Fixture + end-to-end tests** — `largeInstallation.ts` yields a fake `GithubAppClient` for N
    repos (default 120) paginating at 100/page, with a couple of empty repos (no HEAD) mixed in;
    drive callback → dispatcher → discovery → catalog and assert the whole chain, plus the
    Redis-loss recovery path (drop the queue between pages, drain the dispatcher, resume) and the
    admin-reconcile sweep path (drop one repo from the fixture, reconcile, assert exactly that
    repo's `revoked_at` moved).
15. Verification order per `CLAUDE.md`: `npx tsc --noEmit`, then `npm run test`, then `npm run lint`.

## Acceptance criteria

- **AC-1** — `handleGithubAppCallback` performs **no** repository listing and **no** queue call:
  it verifies state, authorizes the installation, and in one `withOrgContext` transaction writes
  the installation row plus a `pending` `github_installation_sync` row (`reason: 'app_install'`),
  then kicks the discovery dispatcher after commit and returns `{ redirectTo, discovery: 'queued' }`.
  No GitHub repo-list call and no BullMQ `enqueue()` happen on the request path.
- **AC-2** — The constants `MAX_REPOS_PER_CALLBACK` (25) and `MAX_RECONCILE_REPOS` (25), the
  `allRepos.slice(0, …)` second cap, the `truncated` result flag, and
  `GithubAppClient.listInstallationRepos` (with its `maxRepos` parameter) no longer exist anywhere
  in the repository.
- **AC-3** — `listInstallationReposPage(installationId, page, perPage?)` fetches exactly one page
  (`GET /installation/repositories?per_page=<perPage>&page=<page>`, default `perPage` 100) and
  returns `{ repos, page, hasNextPage, totalCount }`, where `hasNextPage` is true iff the page came
  back full.
- **AC-4** — For a 120-repo fixture installation, discovery issues exactly 2 page requests
  (page 1 full, page 2 with 20) and yields each of the 120 repositories exactly once.
- **AC-5** — Discovery registers every discovered repository via `registerRepository` and enqueues
  exactly one `repo.initial_parse` outbox row per repository that has both a default branch and a
  HEAD sha, built by the unchanged `buildInitialParseEnvelope`; the 120-repo fixture ends with
  `status = 'complete'` and counts matching the fixture.
- **AC-6** — Each page's registrations, outbox rows, and cursor advance commit in a single
  transaction before the next page is fetched, and no network call is made while a transaction is
  open.
- **AC-7** — A run interrupted after page 1 resumes at page 2 on the next attempt: page 1 is not
  re-fetched, and no duplicate repository rows or outbox rows are produced.
- **AC-8** — For the ≥100-repo fixture, every repository is registered and its parse job enqueued
  within `INSTALLATION_DISCOVERY_TARGET_MS` (60 000 ms) of the install callback returning.
- **AC-9** — Discovery runs as job type `github.installation_discovery` on the existing
  `github-sync` queue; `QUEUE_NAMES` is unchanged, and the git-sync worker still routes every
  `repo.*` envelope to `syncGitMetadata` with identical behaviour.
- **AC-10** — `reconcileInstallationRepositories` performs no inline repo listing, registration or
  revocation: it records one durable `manual_reconcile` run row per active installation (carrying
  the `ctx`-derived subject), kicks the dispatcher, and returns `{ status: 'queued', installations,
  queued }`; `POST /integrations/github/reconcile` responds `202` and remains
  `authenticate()` + `authorize('admin')` gated.
- **AC-11** — `GET /repositories` returns a `sync` object `{ status, updatedAt,
  discoveredRepositories, registeredRepositories, revokedRepositories, sweepOutcome }` derived
  only from the caller's own org rows, with `status` resolving in the documented precedence
  (`importing` → `stalled` → `failed` → `idle`).
- **AC-12** — `sync.discoveredRepositories`, `sync.registeredRepositories`,
  `sync.revokedRepositories` and `sync.sweepOutcome` are populated for an admin/owner caller and
  `null` for a member caller, while `sync.status` is present for both.
- **AC-13** — Tenant isolation: discovery takes `org_id` only from the envelope (written
  server-side from the leased row, never from client input), re-verifies it against
  `resolveInstallationOrg` before any write, and performs every tenant read/write inside
  `withOrgContext`; `github_installation_sync` has RLS enabled **and** forced with the standard
  `org_isolation` policy, and `sayre_app` holds no `DELETE` on it.
- **AC-14** — No credential or provider text escapes: the installation token is minted only through
  `GithubAppClient`, and neither the sync row, the queue payload, nor any log line contains a
  token, private key, GitHub response body, or provider error message — `last_error_code` is
  restricted to `provider_unavailable | page_limit_exceeded | internal_error` by both the TypeScript
  type and a SQL CHECK constraint.
- **AC-15** — Page bookkeeping advances by compare-and-set on the stored cursor and run id: a
  second runner (or a replayed job) whose expected page or run id no longer matches stops
  immediately as superseded, and reprocessing the same page produces no duplicate repository rows,
  duplicate outbox rows, or double-counted progress.
- **AC-16** — The workspace shows a partial-sync indicator while `sync.status` is `importing` or
  `stalled` — as the canvas state when no repository is selectable yet, and as a chip alongside the
  canvas once repositories are listed — the catalog is re-polled while a sync is in flight, and
  both the indicator and the polling stop once status returns to `idle`.
- **AC-17** — Migration `0020_w7_01_github_installation_sync.sql` creates the table with the FK to
  `organizations`, the `(org_id, installation_id)` unique constraint, the status/reason/error-code/
  sweep-outcome/subject/count CHECK constraints, the `org_isolation` RLS policy under ENABLE +
  FORCE, the `set_updated_at` trigger, and a `sayre_app` grant of SELECT/INSERT plus column-scoped
  UPDATE and no DELETE; `schema.ts` and `drizzle/meta/_journal.json` are updated to match.
- **AC-18** — The same migration establishes the dispatch boundary: the dispatch bookkeeping
  columns and the partial due index; the `sayre_installation_discovery_dispatcher` role created
  NOLOGIN/NOINHERIT/NOBYPASSRLS with no memberships (failing loudly if it pre-exists with unsafe
  attributes); column-scoped SELECT/UPDATE and dispatcher-only policies for that role, with no
  INSERT/DELETE and no access to counters, cursor, or requesting subject; three SECURITY DEFINER
  functions owned by it with pinned `search_path` and range-checked parameters, EXECUTE revoked
  from `PUBLIC` and granted to `sayre_app`; and the additive `repositories.last_discovery_run_id` /
  `last_discovery_at` columns (also added to `rls_acceptance.tester.test.ts`'s column spec).
- **AC-19** — Outbox-first dispatch: the only code that calls BullMQ `enqueue()` for
  `github.installation_discovery` is the dispatcher, acting on a row it holds a lease on. Both the
  install callback and reconcile commit their rows first and merely `kick()` afterwards, so
  dropping the kick entirely delays the job but never loses it.
- **AC-20** — Total Redis loss recovery, no human in the loop: given a `running` row whose cursor
  is at page k and whose BullMQ job has been destroyed, the dispatcher re-claims the row once
  `next_attempt_at` elapses, re-enqueues the same logical run (same `run_id`, same
  `idempotency_key`), and the run resumes at page k and reaches `complete` — with no duplicate
  repository rows, no duplicate `repo.initial_parse` outbox rows, and no admin reconcile required.
- **AC-21** — Dispatch failures are bounded and lossless: a failed `enqueue()` releases the lease
  with exponential backoff (row stays claimable, `dispatch_attempt_count` incremented), a process
  death after `enqueue()` but before the completion mark is recovered by lease expiry, and the
  resulting duplicate delivery is absorbed as `superseded` by the claim/CAS guards.
- **AC-22** — `assertInstallationDiscoveryOutboxReady` runs at startup alongside the existing gates
  and fails closed on a missing function, a widened ACL, an unsafe owner role, or `sayre_app`
  holding any read/write on the lease columns; `index.ts` starts the dispatcher, installs its wake
  handler, and on shutdown clears the handler, `stop()`s it, and closes the BullMQ queues.
- **AC-23** — Heartbeat: every committed page pushes `next_attempt_at` forward by
  `INSTALLATION_DISCOVERY_REDISPATCH_SECONDS`, so a run making progress is never redispatched
  concurrently, while a run that stops progressing becomes due again within that interval.
- **AC-24** — Destructive direction (the OQ-4 reversal of W2-09's OQ-5): when a
  `manual_reconcile` run finishes every page and reaches `complete`, every active GitHub
  repository in that org not reported by the observed listings is soft-revoked via
  `markRepositoryRevoked` in the same transaction as completion; `revoked_count` and
  `sweep_outcome = 'applied'` are recorded, and repository rows and graph history are retained.
- **AC-25** — Authorization: a sweep can only occur on a run whose stored `reason` is
  `manual_reconcile` — i.e. one created by the `authenticate()` + `authorize('admin')` endpoint.
  An `app_install` run never revokes anything even when it completes with repositories missing,
  no webhook path gains a revoke, and nothing about the sweep can be influenced by request input:
  the authorization decision is captured on the row at creation time and re-read from the row by
  the worker.
- **AC-26** — Audit trail: the run row records `requested_by_subject_type`/`requested_by_subject_id`
  (server-derived from `AuthContext`, `null` for `app_install`), `revoked_count`, `sweep_outcome`,
  `completed_at` and `completed_run_id`; each revoked repository keeps its row with `revoked_at`
  set; exactly one structured log line per sweep carries the outcome code and counts and **no**
  repository name or provider text; and an admin can read the outcome back through
  `GET /repositories`'s `sync`.
- **AC-27** — Four independent false-positive guards, each of which revokes nothing and records
  its own outcome: (a) a run that fails, is cancelled, or is superseded never sweeps
  (`not_applicable`); (b) `withheld_coverage` when any active installation of the org has no
  completed run; (c) `withheld_empty_result` when the run discovered zero repositories while the
  org holds at least one active repository; (d) `withheld_ratio` when candidates exceed both
  `MIN_SWEEP_RATIO_EXEMPT_ROWS` and `MAX_SWEEP_REVOKE_FRACTION` of the org's active repositories.
- **AC-28** — Reversibility: a repository revoked by a sweep and later reported again by GitHub is
  re-activated (`revoked_at` cleared, marker restamped) by the next discovery run or
  `installation_repositories` `added` webhook, and is re-enqueued for parse when it has a HEAD.
- **AC-29** — Revoke call sites remain structurally enumerable: after this ticket exactly two code
  paths can move `repositories.revoked_at` — `applyRemoved` (the `removed` webhook) and the
  discovery sweep — and neither `ReconcileDeps` nor any other request-path service declares or
  reaches a `markRepositoryRevoked` dependency. W2-09's trace-through test is replaced by an
  equally structural test asserting exactly this, not deleted.

## Edge cases

- **EC-1** — Installation with zero accessible repositories: page 1 returns empty,
  `hasNextPage` false, sync ends `complete` with all counts 0, and no outbox row is written.
- **EC-2** — Installation with exactly 100 repositories (page-size boundary): page 1 is full so
  page 2 is fetched, returns empty, and the run completes with exactly 100 registered — no repo
  registered twice, none missed.
- **EC-3** — A repository with no default branch or no HEAD sha (empty repo): registered but not
  enqueued; it increments `registered_count` and not `enqueued_count`, matching today's callback
  behaviour.
- **EC-4** — GitHub returns 5xx / a network error on page 3 of 5: pages 1–2 stay committed, the row
  is marked `failed` with `provider_unavailable` and the cursor still at 3, the handler rethrows so
  BullMQ retries with backoff, and a later attempt resumes at page 3.
- **EC-5** — Installation suspended or uninstalled mid-discovery: the next loop iteration's active
  check fails, the row is marked `cancelled`, and no further repository or outbox row is written.
- **EC-6** — Envelope names an installation id that no longer resolves, or resolves to a
  **different** org than `envelope.org_id`: the run performs zero writes and ends `cancelled`
  (`unknown_installation` / `org_mismatch`).
- **EC-7** — Callback with `setup_action=request` (GitHub sends no `installation_id`): no sync row,
  no dispatcher kick, result `{ discovery: 'skipped' }`.
- **EC-8** — Callback for an installation already bound to a different org: still throws
  `InstallationOrgConflictError` before any sync row is written or any dispatch occurs.
- **EC-9** — The dispatcher's BullMQ `enqueue()` fails (Redis unreachable) after the pending row
  committed: the callback has already redirected successfully, the lease is released with bounded
  backoff, `dispatch_attempt_count` increments, the row stays `pending` and claimable, and the
  work is dispatched automatically once Redis returns — **no manual reconcile is required**
  (revision 2, OQ-3). Until then the catalog reports `importing`, then `stalled` past
  `INSTALLATION_SYNC_STALL_MS`.
- **EC-10** — Duplicate/redelivered discovery job after a run already completed: `claimInstallationSync`
  returns `null` (status `complete`), the run exits without re-fetching or re-writing anything.
- **EC-11** — GitHub reorders repositories between pages so one repo appears on two pages: the
  `registerRepository` upsert and the outbox's `(org_id, idempotency_key)` `DO NOTHING` make the
  second occurrence a no-op — no duplicate rows, and no duplicate `repo.initial_parse` delivery.
- **EC-12** — Malformed page response (missing/non-array `repositories`, malformed `full_name`,
  blank default branch, non-hex HEAD sha, oversized body, bad `Content-Length`): normalized to
  `GithubAppApiError`, the page is not committed, the cursor does not move, and the run fails with
  `provider_unavailable`.
- **EC-13** — `total_count` absent, negative, non-integer, or absurdly large: stored as `null`;
  progress reports registered counts only and never fabricates a denominator.
- **EC-14** — An installation that keeps reporting full pages past
  `MAX_INSTALLATION_DISCOVERY_PAGES` (100 pages ≈ 10 000 repositories): the loop stops at the
  ceiling, marks the row `failed` with `page_limit_exceeded`, and does **not** rethrow (a retry
  cannot help); the dispatcher's due predicate excludes that error code, so it is not redispatched
  either.
- **EC-15** — Invalid arguments to `listInstallationReposPage` (`page` < 1, non-integer, `perPage`
  0, negative, > 100, non-integer): `GithubAppApiError` is thrown before any network call and
  before any token mint.
- **EC-16** — Member (non-admin) caller of `GET /repositories`: `sync.status` and `sync.updatedAt`
  are present, every admin-gated field is `null`, and the payload leaks no installation id,
  account login, or name of a repository the member cannot read.
- **EC-17** — Unauthenticated or member caller of `POST /integrations/github/reconcile`: 401 / 403
  respectively (unchanged), and no sync row is written, no dispatcher kick occurs, and — because
  no `manual_reconcile` row exists — no sweep can subsequently run on their behalf.
- **EC-18** — Two organizations syncing simultaneously: each org's `/repositories` `sync` reflects
  only its own rows, enforced by RLS plus the explicit org predicate; neither org's counts move
  because of the other's discovery.
- **EC-19** — Re-running discovery for an org whose repositories are already registered (including
  ones previously revoked): repositories are upserted with `revoked_at` cleared, no duplicate rows
  appear, and counts reflect repositories processed in this run.
- **EC-20** — A `running` row abandoned by a dead worker and older than `INSTALLATION_SYNC_STALL_MS`:
  a new `startInstallationSync` resets it to a fresh `pending` run with a new `run_id`, while a
  `running` row touched within the window is left alone (`{ reset: false }`) so a live run is never
  restarted underneath itself.
- **EC-21** — Web deploy skew: a `/repositories` payload with **no** `sync` key parses as
  `{ status: 'idle' }`; a payload with a *present but malformed* `sync` (unknown status string,
  non-numeric counts, unparseable `updatedAt`) throws `RepositoryCatalogResponseError` rather than
  silently rendering an importing state; unknown *extra* keys inside `sync` are ignored.
- **EC-22** — UI termination: once `sync.status` returns to `idle` and no repository is still
  `registered`, the 2.5s catalog re-poll stops and the indicator unmounts — no unbounded polling
  loop, and no indicator left stuck on screen after a completed import.
- **EC-23** — Redis entirely unavailable for the whole dispatch window: rows accumulate as
  `pending`, every claim/publish cycle defers with backoff, nothing is lost or double-counted, and
  when Redis returns every accumulated row dispatches and completes.
- **EC-24** — Redis flushed **mid-run** (row `running`, cursor at page 3 of 5, job object gone):
  the heartbeat stops advancing, `next_attempt_at` elapses, the dispatcher redispatches the same
  `run_id`, and the run resumes at page 3 and completes — pages 1–2 are not re-fetched and
  counters are not double-counted.
- **EC-25** — Two core replicas dispatching concurrently: `FOR UPDATE SKIP LOCKED` plus the lease
  means each due row is claimed by exactly one dispatcher; if a duplicate job still reaches a
  worker, `claimInstallationSync`/`advanceInstallationSyncPage`'s CAS ends it as `superseded`.
- **EC-26** — Dispatcher dies after `enqueue()` succeeded but before the completion mark: the lease
  expires, the row is redispatched, and the second job either resumes safely or exits `superseded`;
  at-least-once dispatch never produces a duplicate repository or outbox row.
- **EC-27** — A permanently undispatchable row (e.g. an installation whose every attempt fails):
  `dispatch_attempt_count` reaches `MAX_INSTALLATION_DISCOVERY_DISPATCH_ATTEMPTS` (10) and the row
  stops being due — no infinite redispatch loop — while the catalog keeps reporting `stalled` /
  `failed` to admins.
- **EC-28** — Terminal rows are never claimed: `complete`, `cancelled`, and `failed` with
  `page_limit_exceeded` all fall outside the dispatcher's due predicate.
- **EC-29** — The cross-tenant claim cannot leak: each claimed row yields only its own `org_id`
  into the envelope, the dispatcher never opens an org context and never touches a tenant table,
  and privilege-level assertions confirm `sayre_app` can neither read nor write the lease/dispatch
  columns while the dispatcher role can neither INSERT/DELETE nor read counters, cursor, or the
  requesting subject.
- **EC-30** — **Transient GitHub failure misread as "repo no longer present"** (the primary
  false-positive risk of OQ-4): a `manual_reconcile` run gets a 502 on page 4 of 5. The run fails
  with the cursor at 4, `sweep_outcome` stays `not_applicable`, and **zero** repositories are
  revoked; only the later attempt that fetches every page and reaches `complete` may sweep, and it
  then revokes exactly the genuinely-absent repositories.
- **EC-31** — GitHub returns HTTP 200 with an empty repository list (installation permissions
  narrowed, or token scoped down) while the org holds 40 active repositories: the run completes but
  the sweep records `withheld_empty_result` and revokes nothing.
- **EC-32** — GitHub reports only 3 of 100 repositories across a fully-paginated, error-free run
  (a partial provider outage returning 200s): 97 candidates exceed both the row floor and the 50%
  fraction, so the sweep records `withheld_ratio` and revokes nothing; an admin sees the withheld
  outcome in `GET /repositories`'s `sync`.
- **EC-33** — Multi-installation org: installation A's reconcile run completes while installation B
  has never completed a run. The sweep records `withheld_coverage` and revokes nothing, so B's
  repositories can never be revoked by A's run. Once both have completed runs, only repositories
  absent from *both* observed listings are revoked.
- **EC-34** — A repository added by the `installation_repositories` `added` webhook **mid-run**,
  after its page was already fetched: its `updated_at` is later than the run's `started_at`, so the
  candidate query excludes it and it is not revoked despite carrying no marker for this run.
- **EC-35** — An `app_install` run that completes while several held repositories are absent from
  GitHub's listing: nothing is revoked, `sweep_outcome` is `not_applicable`, and the run is
  otherwise a normal successful discovery.
- **EC-36** — A candidate that is already revoked: the candidate query only selects
  `revoked_at IS NULL` rows, and `markRepositoryRevoked`'s COALESCE keeps an existing timestamp
  fixed, so `revoked_count` never counts a re-revoke and no timestamp advances on a repeated sweep.
- **EC-37** — A sweep-revoked repository re-granted on GitHub: the next discovery run registers it
  again with `revoked_at` cleared and the current run marker, and re-enqueues `repo.initial_parse`
  when it has a default branch and HEAD.
- **EC-38** — Revocation is unreachable from any non-admin surface: no member/unauthenticated
  request, no webhook payload field, and no queue payload field can cause or target a sweep — the
  only inputs are the row's own `reason`/`run_id` and the server's own paginated observation — and
  a member's `GET /repositories` shows `revokedRepositories`/`sweepOutcome` as `null`.

## Open questions

None. Revision 1's OQ-1, OQ-2, OQ-5 and OQ-6 were confirmed as specified (60 s discovery target
for ~120 repos; counts withheld from non-admin members; `GET /integrations/github/status` stays an
unrelated out-of-scope gap; `CallbackResult.enqueuedRepos` → `discovery` is safe to replace).
OQ-3 and OQ-4 were rejected as drafted and their replacements — the outbox-backed dispatcher and
the destructive reconcile direction — are specified above rather than deferred. The three residual
judgement calls inside that new scope (sweeps restricted to admin-triggered `manual_reconcile`
runs; the coverage/empty-result/ratio refusals and their thresholds; the 10-attempt dispatch
ceiling) are recorded in Ticket Check → "What I had to guess" and are tunable constants, not
blockers for Dev.
