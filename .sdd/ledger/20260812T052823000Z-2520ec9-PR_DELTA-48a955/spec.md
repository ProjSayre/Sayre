# W3-04 — Git sync integration worker (provider-generic) — gapfill

> **Gap-mode run** (`/pipeline-gapfill`). Driven by `.pipeline/gaps.json` (`verdict: "GAPFILL"`,
> 10 items, none `OK`). Overlays: `base` only. `security_required: true` — a `security-checker`
> pass is mandatory after review PASS. No prior ledger entry exists for W3-04; this ticket shipped
> before the pipeline, so there is no past-intent artifact to reconcile against.
>
> Every `AC-*` below is tagged with the `GAP-*` id it closes. Nothing in this spec is a redesign of
> the shipped worker — the shipped structure (BullMQ `github-sync` queue, service-layer
> `syncGitMetadata`, `GitProviderRegistry`, `Neo4jOwnershipGraphStore`) is kept and made real where
> gap-scout found it stubbed, hardcoded, unmeasured, or unbounded.

## Ticket Check

**What I'm about to build**
When someone merges a pull request, the file cards in the visualizer are supposed to update to show
who now owns that file, when it was last touched, and which PR touched it. Right now nobody has ever
actually watched that happen — the tests that claim to prove it hand themselves the answer. I'm going
to make that update genuinely happen against a real database, prove it with a real test, put a clock
on it (five seconds), and make it so a second code host (GitLab, Bitbucket, a fake one for testing)
can be switched on by changing a setting instead of changing the program.

**What I'm explicitly not doing**
I am not changing how the visualizer looks, not adding a real second code host (only the mock one the
ticket names), not touching how repositories are first imported, and not rebuilding ownership history
for pushes that rewrite the past — when that happens I will record that a rebuild is owed rather than
quietly guessing. I am also not rewriting the shared job-queue machinery; I am only changing how this
one job asks to be retried.

**How you'll know it worked**
Merge a pull request in a connected repository, then look at any file that PR changed: the owner,
the "last edited" time, and the PR number/title/link shown for that file should all reflect that
merge, and should appear within about five seconds. Separately, an engineer can turn on the mock
"fakehub" provider by editing one configuration value — no code change — restart the worker, and see
a fakehub event update the same file information the same way.

**What I had to guess**
Three things the ticket left open, each resolved one way here so you can overrule it:
1. *How fast is "the sync target"?* The ticket just says "the sync target". I pinned it at **five
   seconds**, from the product requirements doc, which is stricter than the fifteen seconds the
   other (Python) half of the system uses. If five seconds is wrong, this is the one number to change.
2. *What "registers via configuration" is allowed to mean.* Letting a configuration file name an
   arbitrary code file to load would let anyone who can edit configuration run arbitrary code on our
   servers. So configuration chooses from providers that already exist in our codebase; adding a
   brand-new provider is still one new file plus one line in a list, plus the configuration switch —
   not an edit to the worker itself. If you wanted literal "configuration names any file", say so and
   I will raise it as a security question rather than build it.
3. *What to do about a bad job.* Today, if the update fails once for any reason, the merge is lost
   forever and silently. I made it retry a few times and, if it still fails, keep a durable record of
   the failure instead of deleting it. This is arguably the job-queue team's ticket, not this one — I
   scoped it to this one job only.

## Goal

Make W3-04's acceptance sentence literally true and literally measured: a merged PR must be shown to
change real `File` node ownership/recent-edit properties in a real graph inside a pinned 5-second
sync target, and a mock `fakehub` provider must be registrable purely through configuration plus one
adapter module, with no edit to the worker, the queue, or the pipeline. Along the way, close the
unbounded-provider-call, silent-truncation, silent-drop, and unvalidated-path defects that make the
"updates ownership metadata" claim conditional today.

## Scope

### In

- **GAP-1 / GAP-1b** — a real Neo4j-backed test of `APPLY_OWNERSHIP_CYPHER`; a cross-language pin of
  the `File` MATCH key against the Python ingestion writer; a distinct, observable outcome for a
  write that matched zero `File` nodes.
- **GAP-2** — a named `GIT_SYNC_TARGET_MS = 5_000` budget constant, a measured duration on the
  service result, an end-to-end timing assertion, and a recorded breach signal.
- **GAP-3** — page cap, per-request `AbortSignal.timeout`, `redirect: 'manual'`, and a bounded JSON
  read on `listPullRequestFiles`.
- **GAP-4** — retry/backoff and durable failed-job retention for the `github-sync` enqueue site only,
  plus a terminal-failure record from the worker.
- **GAP-5** — detection and reporting (not silent narrowing) of a truncated push payload and of a
  force-push.
- **GAP-6 / GAP-7 / GAP-8** — a `GIT_PROVIDER_CATALOG` configuration key, a provider-registration
  manifest, a real (non-`__fixtures__`) `fakehub` adapter module that actually normalizes, a
  provider-agnostic credential/auth seam, and the replacement of the misleading registry test.
- **GAP-9** — `owner/name` shape validation via the existing shared `isValidRepoFullName` before any
  provider API path is constructed.
- CI wiring: a `neo4j` service on the `node` job plus a dedicated graph-integration step with a
  zero-skip gate, mirroring the existing `workers` job's Neo4j gate and the `node` job's
  `MESSAGING_INTEGRATION_REQUIRED` Redis gate.

### Out

**There are no `OK` gaps to list.** All 10 items in `.pipeline/gaps.json` are non-`OK`
(`UNTESTED`/`MISSING`/`NARROWED`/`HARDCODED`/`MOCKED`), so the usual "these were verified correct,
do not touch them" list is empty. Dev must still not expand outside the items above without a new
gap id. In particular, the following were noted by gap-scout as *already correct* inside otherwise
non-`OK` findings and must be **preserved unchanged**, not re-litigated:

- `packages/shared-types/src/index.ts:141` — `NormalizedRepoEvent.provider` stays an open `string`.
  A provider plug-in must not require editing the shared schema.
- `services/core/src/queue/bullmq.ts:48` — `QUEUE_NAMES` stays closed at three queues. A new git
  provider is a provider-keyed job type on the existing `github-sync` queue, never a new queue
  (`.claude/rules/async-messaging.md`).
- `services/core/src/services/gitSyncService.ts:24-36` — `org_id` and the repository id keep coming
  only from the envelope and Postgres, never from `event.payload`.

Explicitly deferred, **not** built here:

- **Compare/Commits-API backfill of a truncated (>20-commit) push.** GAP-5 is closed by *detecting
  and reporting* the shortfall, which is the alternative the audit itself sanctions
  (`docs/audits/deep-audit-2026-07-31/audit-04-webhooks-git.md:297-299`: "…**or** flag the ref for an
  ownership rebuild"). Backfill needs an authenticated push-path token flow the push path does not
  have today. See Open Questions Q-2.
- **Deleting stale `OWNS`/`MODIFIED` edges after a force-push.** Reported (`rebuildRequired`), not
  performed. See Open Questions Q-2.
- **Changing `enqueue()`'s queue-wide `attempts: 1` / `removeOnComplete: true` defaults.** GAP-4 is
  closed at W3-04's own call site with an exported policy object. The queue-wide default belongs to
  W0-04. See Open Questions Q-3.
- Live-presence/open-branch push handling (PRD §2.12) — a later ticket.
- Registering a real second git host (GitLab/Bitbucket). Only the mock `fakehub` the ticket names.

## Affected files

### Created

| Path | Purpose |
| --- | --- |
| `services/core/src/integrations/git/budgets.ts` | `GIT_SYNC_TARGET_MS` (GAP-2), mirroring `services/workers/sayre_workers/ingestion/budgets.py` |
| `services/core/src/integrations/git/providerCatalog.ts` | Parses `GIT_PROVIDER_CATALOG`; builds a `GitProviderRegistry` (GAP-6, GAP-8) |
| `services/core/src/integrations/git/providers/index.ts` | The provider-registration manifest (`GIT_PROVIDER_REGISTRATIONS`) — the one line a new adapter module adds (GAP-6) |
| `services/core/src/integrations/git/providers/fakehub.ts` | Real, shipped `fakehub` adapter module that genuinely normalizes a provider-shaped payload (GAP-7) |
| `services/core/src/integrations/git/jobPolicy.ts` | `GIT_SYNC_JOB_OPTIONS` — retry/backoff/failed-retention for the `github-sync` enqueue only (GAP-4) |
| `services/core/src/http/boundedJson.ts` | `readBoundedJson` extracted from `github/appClient.ts` so both callers share one bounded reader (GAP-3) |
| `services/core/src/telemetry/gitSyncMetrics.ts` | `git_sync_duration_ms`, `git_sync_unmatched_files_total`, `git_sync_budget_breach_total`, `git_sync_push_truncated_total` (GAP-1b, GAP-2, GAP-5) |
| `services/core/src/integrations/git/__tests__/ownershipGraph.integration.test.ts` | Neo4j-backed proof of the ownership write (GAP-1, GAP-1b) |
| `services/core/src/integrations/git/__tests__/w3-04.acceptance.integration.test.ts` | Both acceptance clauses end to end over the real BullMQ + Neo4j path (GAP-1, GAP-2, GAP-6, GAP-7) |
| `services/core/src/integrations/git/__tests__/crossServiceFileKey.test.ts` | Static cross-language pin: Node's `File` MATCH key vs the Python ingestion writer (GAP-1) |
| `services/core/src/integrations/git/providerCatalog.test.ts` | Catalog parsing / fail-closed behavior (GAP-6, GAP-8) |
| `services/core/src/integrations/git/providers/fakehub.test.ts` | The fakehub adapter's real normalization (GAP-7) |

### Modified

| Path | Change |
| --- | --- |
| `services/core/src/integrations/git/types.ts` | `GitProviderContext`, `GitProviderRegistration`, `ProviderChangeSet.truncated`/`.rebuildRequired` (GAP-5, GAP-6, GAP-8) |
| `services/core/src/integrations/git/providers/github.ts` | Options-object constructor + credential seam (GAP-8), `full_name` validation (GAP-9), bounded pagination (GAP-3), truncation/`forced` reporting (GAP-5) |
| `services/core/src/integrations/git/graphOwnershipStore.ts` | Export `OWNERSHIP_FILE_MATCH_KEYS`; return `matchedPaths` alongside `updatedFiles` (GAP-1, GAP-1b) |
| `services/core/src/integrations/git/providerRegistry.ts` | Add `providers(): string[]` (needed by the config test; GAP-6) |
| `services/core/src/integrations/git/worker.ts` | Providers come from `loadGitProviderRegistry()`; `startGitSyncWorker` takes partial overrides; result is consumed, not discarded; terminal-failure listener (GAP-1b, GAP-4, GAP-6) |
| `services/core/src/integrations/git/index.ts` | Barrel exports for the new modules (GAP-7 — fakehub must not be unexported) |
| `services/core/src/services/gitSyncService.ts` | `durationMs`, `'unmatched'` status, `truncated`/`rebuildRequired`, metrics (GAP-1b, GAP-2, GAP-5) |
| `services/core/src/services/githubWebhookService.ts` | `publishOwnership` passes `GIT_SYNC_JOB_OPTIONS` (GAP-4) |
| `services/core/src/webhooks/normalizeGithubEvent.ts` | Carry `size` / `distinct_size` through `normalizePush` so truncation is detectable (GAP-5) |
| `services/core/src/github/appClient.ts` | Use the extracted `readBoundedJson` (GAP-3); behavior unchanged |
| `packages/config/src/config.ts` | Add `GIT_PROVIDER_CATALOG` (default `[{"provider":"github"}]`) and `GRAPH_INTEGRATION_REQUIRED` (default `'false'`) |
| `infra/.env.example` | Document `GIT_PROVIDER_CATALOG` (non-secret, placeholder only) |
| `.github/workflows/ci.yml` | `neo4j` service on the `node` job; a graph-integration step with `GRAPH_INTEGRATION_REQUIRED: 'true'` + junit; a zero-skip assertion step (GAP-1) |
| `services/core/src/integrations/git/providerRegistry.test.ts` | Replace the misleading "registers a second provider…" test (GAP-7) |
| `services/core/src/integrations/git/providers/github.test.ts` | Adapt to the options-object constructor |
| `services/core/src/services/gitSyncService.test.ts` | Import fakehub from `providers/fakehub`, adapt constructors |
| `services/core/src/integrations/git/graphOwnershipStore.test.ts` | Adapt to the `matchedPaths` return |

### Deleted

- `services/core/src/integrations/git/__fixtures__/fakehubProvider.ts` — replaced by the real
  adapter module `services/core/src/integrations/git/providers/fakehub.ts` (GAP-7). The whole
  `__fixtures__` directory goes with it if it is then empty.

## Interfaces / signatures

### Budget (GAP-2) — `services/core/src/integrations/git/budgets.ts`

```ts
/**
 * W3-04 acceptance: "…within the sync target". PRD-V1.md:16 and :258 pin git delta sync at <5s
 * (tightened from 15s in v6). Deliberately TIGHTER than the Python fleet's
 * STRUCTURAL_SYNC_TARGET_MS = 15_000 (services/workers/sayre_workers/ingestion/budgets.py):
 * that budget covers a full Tree-sitter parse + graph projection; this one covers a metadata
 * delta only.
 */
export const GIT_SYNC_TARGET_MS: number = 5_000;

/** Per-request hang guard for a provider API call. Deliberately LARGER than the target above:
 *  it bounds a pathological stall, it is not the budget. See Approach. */
export const GIT_PROVIDER_REQUEST_TIMEOUT_MS: number = 10_000;

/** GitHub truncates the PR-files endpoint at 3000 files == 30 pages of 100. */
export const MAX_PULL_REQUEST_FILE_PAGES: number = 30;

/** GitHub push payloads carry at most 20 commits. */
export const GITHUB_PUSH_COMMIT_CAP: number = 20;
```

### Provider seam (GAP-6, GAP-8) — `services/core/src/integrations/git/types.ts`

```ts
import type { SecretRef } from '@sayre/config';

/** Provider-agnostic auth seam. Constructed by the catalog loader, handed to every adapter
 *  factory, so a config-registered provider can obtain credentials without a code edit. */
export interface GitProviderContext {
  readonly provider: string;
  /** null when the catalog entry declared no credential. */
  readonly credentialRef: SecretRef | null;
  /** Rejects with GitProviderCredentialError when credentialRef is null or unresolvable.
   *  Never includes the secret value (or the resolved value) in its error message. */
  resolveCredential(): Promise<string>;
}

export type GitProviderAdapterFactory = (context: GitProviderContext) => GitProviderAdapter;

export interface GitProviderRegistration {
  readonly create: GitProviderAdapterFactory;
  /** true => refused whenever NODE_ENV === 'production'. `fakehub` sets this. */
  readonly mockOnly?: boolean;
}

export interface ProviderChangeSet {
  refName: string | null;
  edits: ProviderFileEdit[];
  /** GAP-5: the provider payload is known to be an incomplete view of the change (e.g. a push
   *  payload truncated at GITHUB_PUSH_COMMIT_CAP). Default false. */
  truncated?: boolean;
  /** GAP-5: history on this ref was rewritten (force-push); ownership derived from a MERGE delta
   *  may now be stale and a scoped ownership rebuild is owed. Default false. */
  rebuildRequired?: boolean;
}
```

`GitProviderAdapter` itself is unchanged (`{ provider, resolveChanges }`) — the auth seam lives on
the *factory* input, which is what makes it pluggable from a deployment rather than only from a unit
test.

### Catalog loader (GAP-6) — `services/core/src/integrations/git/providerCatalog.ts`

```ts
export interface GitProviderCatalogEntry {
  provider: string;              // must match a key in GIT_PROVIDER_REGISTRATIONS
  credentialRef: SecretRef | null; // optional in JSON; normalized to null
}

export class GitProviderCatalogError extends Error {}      // name: 'GitProviderCatalogError'
export class GitProviderCredentialError extends Error {}   // name: 'GitProviderCredentialError'

/** Pure parser over the raw config string. Throws GitProviderCatalogError on any malformed input.
 *  Never partially succeeds. */
export function parseGitProviderCatalog(raw: string): GitProviderCatalogEntry[];

/** Reads GIT_PROVIDER_CATALOG, parses it, resolves each entry against `registrations`, and returns
 *  a fully populated registry. Fails closed (throws) on: unknown provider id, duplicate provider id,
 *  empty catalog, malformed JSON, malformed credentialRef, or a mockOnly provider under
 *  NODE_ENV === 'production'. */
export function loadGitProviderRegistry(
  registrations: Readonly<Record<string, GitProviderRegistration>> = GIT_PROVIDER_REGISTRATIONS,
): GitProviderRegistry;
```

`GIT_PROVIDER_CATALOG` config value shape (JSON array, default `[{"provider":"github"}]`):

```json
[{ "provider": "github" }, { "provider": "fakehub", "credentialRef": "env://SOME_LISTED_SECRET" }]
```

Unknown object keys are rejected (same `exactKeys` posture as
`services/core/src/services/providerSettingsCatalog.ts`).

### Provider manifest (GAP-6) — `services/core/src/integrations/git/providers/index.ts`

```ts
/**
 * The closed set of git provider adapters this build can register. Adding a provider is: one new
 * adapter module in this directory + one entry here + a GIT_PROVIDER_CATALOG value. worker.ts,
 * bullmq.ts, gitSyncService.ts, and packages/shared-types are all untouched.
 *
 * Deliberately a closed in-repo map rather than a config-supplied module path: a config-named
 * import specifier is arbitrary code execution for anyone who can write configuration
 * (.claude/rules/security-multitenancy.md). See spec.md Open Questions Q-1.
 */
export const GIT_PROVIDER_REGISTRATIONS: Readonly<Record<string, GitProviderRegistration>> = {
  github: { create: (context) => new GithubProviderAdapter({ context }) },
  fakehub: { create: (context) => new FakeHubProviderAdapter({ context }), mockOnly: true },
};
```

### GitHub adapter (GAP-3, GAP-5, GAP-8, GAP-9) — `providers/github.ts`

```ts
export interface GithubProviderAdapterOptions {
  context?: GitProviderContext;
  mintToken?: MintInstallationToken;   // test seam, unchanged semantics
  fetcher?: FetchLike;                 // test seam, unchanged semantics
}

export class GithubProviderAdapter implements GitProviderAdapter {
  readonly provider = 'github';
  constructor(options?: GithubProviderAdapterOptions);
  resolveChanges(event: ProviderRepoEvent, occurredAt: string): Promise<ProviderChangeSet>;
}

/** GAP-9: replaces the bare `.split('/').map(encodeURIComponent).join('/')`. */
function encodedRepositoryPath(fullName: string): string;   // throws GithubGitSyncError

/** GAP-3: bounded. */
async function listPullRequestFiles(
  event: ProviderRepoEvent,
  pullNumber: number,
  token: string,
  fetcher: FetchLike,
): Promise<string[]>;
```

### Bounded JSON reader (GAP-3) — `services/core/src/http/boundedJson.ts`

```ts
export const MAX_JSON_RESPONSE_BYTES: number = 256 * 1024;

/** Mechanical extraction of github/appClient.ts's private readBoundedJson, with the thrown error
 *  type injected so appClient keeps throwing GithubAppApiError and the git adapter throws
 *  GithubGitSyncError. Behavior for appClient is byte-for-byte unchanged. */
export async function readBoundedJson<T>(
  response: Response,
  context: string,
  makeError: (message: string) => Error,
): Promise<T>;
```

### Ownership store (GAP-1, GAP-1b) — `graphOwnershipStore.ts`

```ts
/** The exact property set APPLY_OWNERSHIP_CYPHER matches a File node on. Must stay identical to
 *  the keys the Python ingestion writer sets — see __tests__/crossServiceFileKey.test.ts. */
export const OWNERSHIP_FILE_MATCH_KEYS = ['org_id', 'repo_id', 'ref_name', 'path'] as const;

export interface OwnershipApplyResult {
  updatedFiles: number;
  /** Distinct paths the write actually matched. Lets the caller name the paths that did NOT
   *  match, instead of only knowing a count (GAP-1b). */
  matchedPaths: string[];
}

export interface OwnershipGraphStore {
  apply(input: OwnershipGraphWrite): Promise<OwnershipApplyResult>;
  close(): Promise<void>;
}
```

`APPLY_OWNERSHIP_CYPHER`'s trailing clause becomes
`RETURN count(DISTINCT file) AS updated_files, collect(DISTINCT file.path) AS matched_paths`
(openCypher-compatible; no Neo4j-only extension — `.claude/rules/graph-schema.md`).

### Service layer (GAP-1b, GAP-2, GAP-5) — `services/gitSyncService.ts`

```ts
export interface GitSyncResult {
  /** 'applied'    — at least one File node changed.
   *  'unmatched'  — the provider resolved edits but the graph matched zero File nodes (GAP-1b).
   *  'ignored'    — the provider legitimately produced no change to apply. */
  status: 'applied' | 'unmatched' | 'ignored';
  provider: string;
  updatedFiles: number;
  /** Paths the provider resolved that matched no File node. Empty on 'ignored'. */
  unmatchedPaths: string[];
  /** Monotonic elapsed ms for the whole service call (provider resolve + repo resolve + graph
   *  write). Compared against GIT_SYNC_TARGET_MS (GAP-2). */
  durationMs: number;
  /** Mirrors ProviderChangeSet (GAP-5); false unless the provider said otherwise. */
  truncated: boolean;
  rebuildRequired: boolean;
}

export async function syncGitMetadata(
  envelope: MessageEnvelope<ProviderRepoEvent>,
  dependencies: GitSyncDependencies,
): Promise<GitSyncResult>;
```

### Worker (GAP-4, GAP-6, GAP-1b) — `integrations/git/worker.ts`

```ts
export async function startGitSyncWorker(
  overrides?: Partial<GitSyncDependencies>,
): Promise<GitSyncWorkerRuntime>;
```

Any dependency not supplied is built the production way — crucially `providers` defaults to
`loadGitProviderRegistry()`, so a test can inject `repositories`/`graph` while still exercising the
real configuration-driven provider path. This is what makes AC-11's acceptance test meaningful.

### Job policy (GAP-4) — `integrations/git/jobPolicy.ts`

```ts
/** W3-04 GAP-4. The GitHub webhook has already answered 202 by the time this job runs
 *  (docs/audits/deep-audit-2026-07-31/audit-04-webhooks-git.md:162-186), so GitHub will never
 *  redeliver: a single transient failure with enqueue()'s attempts:1 default permanently loses a
 *  merge. Scoped to this call site only; enqueue()'s queue-wide defaults are W0-04's. */
export const GIT_SYNC_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 1_000 },
  /** false => an exhausted job stays in BullMQ's `failed` set. That set IS the DLQ of record for
   *  this queue; nothing is silently deleted. */
  removeOnFail: false,
} as const;
```

### Config (GAP-6) — `packages/config/src/config.ts`

Two additions to `CONFIG_NAMES`, with defaults that preserve today's behavior exactly:

- `GIT_PROVIDER_CATALOG` — default `'[{"provider":"github"}]'`
- `GRAPH_INTEGRATION_REQUIRED` — default `'false'` (mirrors `MESSAGING_INTEGRATION_REQUIRED`)

## Approach

Build in this order; each step is independently reviewable.

1. **Pin the numbers (GAP-2).** Create `budgets.ts`. Nothing else references it yet.
2. **Extract the bounded reader (GAP-3).** Create `http/boundedJson.ts` by moving `appClient.ts`'s
   private `readBoundedJson` verbatim, adding the `makeError` parameter. Update `appClient.ts` to
   call it with `(m) => new GithubAppApiError(m)`. `appClient`'s existing tests must pass untouched —
   if any needs editing, the extraction was not mechanical.
3. **Harden the GitHub adapter (GAP-3, GAP-9).**
   - `encodedRepositoryPath(fullName)` calls `isValidRepoFullName` from
     `services/core/src/github/repoFullName.ts` (the W1-02 gapfill module — reuse, do not
     reinvent; do not copy `appClient`'s weaker two-part check, which allows `..` segments) and
     throws `GithubGitSyncError('GitHub repository full_name is malformed.')` on failure. The
     message must not echo the offending value.
   - `listPullRequestFiles` gains: `for (let page = 1; page <= MAX_PULL_REQUEST_FILE_PAGES; ...)`,
     `signal: AbortSignal.timeout(GIT_PROVIDER_REQUEST_TIMEOUT_MS)` per request,
     `redirect: 'manual'`, and `readBoundedJson` instead of `response.json()`. Reaching the page cap
     **throws** `GithubGitSyncError` — it must never silently return a truncated file list (that
     would be GAP-5 reintroduced on the PR path). The throw is then retried by GAP-4's policy.
   - The 10s request timeout is intentionally larger than the 5s target: it bounds a hang, it does
     not enforce the budget. Budget breaches are *recorded*, never used to abort an in-flight write —
     aborting mid-write would leave partial ownership, which is worse than being late.
4. **Truncation and force-push reporting (GAP-5).** Add `size`/`distinct_size` passthrough to
   `normalizePush` in `webhooks/normalizeGithubEvent.ts` (additive only). In `resolvePush`, set
   `truncated: true` when `size > commits.length`, or when `size` is absent and
   `commits.length >= GITHUB_PUSH_COMMIT_CAP`; set `rebuildRequired: true` when
   `event.payload.forced === true`. Still apply the edits it *can* derive — the defect is the
   silence, not the write.
5. **Ownership store returns what it matched (GAP-1, GAP-1b).** Add `matchedPaths` to the Cypher
   RETURN and to `OwnershipApplyResult`; export `OWNERSHIP_FILE_MATCH_KEYS`.
6. **Service layer observability (GAP-1b, GAP-2, GAP-5).** `syncGitMetadata` wraps its body in a
   monotonic timer; computes `unmatchedPaths` as the resolved edit paths minus `matchedPaths`;
   returns `'unmatched'` when edits were resolved but `updatedFiles === 0`; records
   `git_sync_duration_ms`, and increments `git_sync_budget_breach_total` when
   `durationMs > GIT_SYNC_TARGET_MS`, `git_sync_unmatched_files_total` by `unmatchedPaths.length`,
   `git_sync_push_truncated_total` when `truncated || rebuildRequired`. All metric attributes are
   `org_id` + `provider` + `status` only — never a path, a repo name, or a token.
7. **Auth seam (GAP-8).** Add `GitProviderContext` / `GitProviderRegistration` to `types.ts`.
   `GithubProviderAdapter` takes the options object; in `resolveChanges`, when
   `context?.credentialRef !== null && context !== undefined`, obtain the bearer via
   `context.resolveCredential()` and skip installation-token minting entirely; otherwise fall back
   to today's `mintToken(installationId)`. `resolveCredential` wraps `getSecret` and rethrows as
   `GitProviderCredentialError` with no secret material in the message.
8. **Configuration-driven registration (GAP-6).** Add the two config keys. Write
   `providerCatalog.ts` and `providers/index.ts`. Rewrite `worker.ts` so `defaultDependencies` calls
   `loadGitProviderRegistry()` and `startGitSyncWorker` merges `overrides`. Register a
   `worker.on('failed', …)` listener that logs `{ org_id, provider, delivery_id, attemptsMade,
   error_name }` only — never the payload, never a token (GAP-4).
9. **Real fakehub adapter (GAP-7).** Create `providers/fakehub.ts`; delete
   `__fixtures__/fakehubProvider.ts`; export the adapter from `index.ts`. It must actually read its
   event: a `pull_request` payload of shape
   `{ action: 'merged', pull_request: { number, title, url, merged_at, merge_commit_sha, base_ref,
   author: { login, name, email }, files: string[] } }` → a populated `ProviderChangeSet`; a `push`
   payload of shape `{ ref, commits: [{ sha, message, timestamp, author, paths: string[] }] }` →
   per-path edits. Both arguments must be used — no `void event; void occurredAt;`. `occurredAt` is
   the fallback for a missing/invalid timestamp, exactly as the GitHub adapter does it.
10. **Enqueue policy (GAP-4).** `githubWebhookService.ts`'s `publishOwnership` becomes
    `enqueue('github-sync', envelope, { jobId: envelope.idempotency_key, ...GIT_SYNC_JOB_OPTIONS })`.
    Verify `enqueue()` still routes the job through the `default` lane (it must not pass a raw
    `priority` — `bullmq.ts` rejects that).
11. **Tests + CI (GAP-1).**
    - `crossServiceFileKey.test.ts` (no infra): reads
      `services/workers/sayre_workers/ingestion/graph.py`, extracts `_NODE_QUERIES["File"]`, and
      asserts it merges on `{org_id: $org_id, uid: item.uid}` and sets `node.repo_id`,
      `node.ref_name`, `node.path`; asserts `APPLY_OWNERSHIP_CYPHER`'s File MATCH uses exactly
      `OWNERSHIP_FILE_MATCH_KEYS`. A rename on either side must fail this test.
    - `ownershipGraph.integration.test.ts` (Neo4j): **seeds File nodes by executing the Python
      writer's own File query text, read from `graph.py` at runtime** — not hand-written Cypher.
      That is what makes the cross-service key agreement load-bearing rather than decorative. Then
      runs the real `Neo4jOwnershipGraphStore` and reads the `File` node back with a raw driver
      session, asserting `primary_owner_login`, `primary_owner_name`, `primary_owner_email`,
      `primary_owner_provider`, `last_edited_at`, `recent_pr_number`, `recent_pr_title`,
      `recent_pr_url`, `recent_pr_merged_at` all changed to the merged-PR values, and that
      `(:Person)-[:OWNS]->(:File)`, `(:Person)-[:AUTHORED]->(:Commit)`,
      `(:Commit)-[:MODIFIED]->(:File)` exist.
    - `w3-04.acceptance.integration.test.ts` (Redis + Neo4j): the literal acceptance sentence, both
      clauses, in one run. Set `GIT_PROVIDER_CATALOG` to `[{"provider":"fakehub"}]` via
      `setConfigOverrideForTests`, call `startGitSyncWorker({ repositories, graph })` — **no
      `providers` override, and no edit to `worker.ts`** — enqueue a fakehub merged-PR envelope on
      `github-sync`, and assert the seeded `File` node's ownership/recent-edit properties changed
      **and** that the enqueue→graph-visible elapsed time is `< GIT_SYNC_TARGET_MS`.
    - Both integration files probe reachability and skip when the store is unavailable **unless**
      `GRAPH_INTEGRATION_REQUIRED === 'true'`, in which case an unreachable store is a hard failure.
      Follow `services/core/src/queue/__tests__/bullmq.roundtrip.test.ts:216`'s exact pattern.
    - `ci.yml`: add a `neo4j: image: neo4j:5.24-community` service to the `node` job (copy the
      `workers` job's block at `:346-355`, including its healthcheck), then a
      `core graph integration — Neo4j required (zero skips)` step running the two integration files
      with `--reporter=junit`, then an `Assert no git-sync graph tests skipped` step, mirroring
      `ci.yml:491-498`.
12. **Replace the misleading test (GAP-7).** `providerRegistry.test.ts`'s
    `"registers a second provider through one adapter module without a pipeline switch"` is deleted,
    not amended. It asserts constructor injection into a bare registry and would still pass with
    GAP-6 fully unfixed. Its replacement lives in `providerCatalog.test.ts` (configuration →
    registry) and `w3-04.acceptance.integration.test.ts` (configuration → worker → graph).
    `providerRegistry.test.ts` keeps only its genuinely-scoped duplicate/unknown-provider test.

**Architecture constraints re-checked against this plan** — the graph write stays in the service
layer via the Graph Query/write path, never in a handler (`.claude/rules/service-layer.md`);
`org_id` continues to come only from the envelope and is stamped on every write
(`.claude/rules/graph-schema.md`, `.claude/rules/security-multitenancy.md`); the Cypher change is
`collect(DISTINCT …)`, plain openCypher; no new node label or edge type is introduced; no new queue
is added and `fakehub` is a provider-keyed job type on the existing `github-sync` queue
(`.claude/rules/async-messaging.md`).

## Acceptance criteria

- **AC-1 (GAP-1)** — A test running against a **real Neo4j** applies the shipped
  `APPLY_OWNERSHIP_CYPHER` for a merged PR and asserts, by reading the node back, that the target
  `File` node's `primary_owner_name`/`primary_owner_email`/`primary_owner_login`/
  `primary_owner_provider`, `last_edited_at`, and `recent_pr_number`/`recent_pr_title`/
  `recent_pr_url`/`recent_pr_merged_at` all changed to the merged-PR values, and that the
  `OWNS`, `AUTHORED`, and `MODIFIED` edges exist. No `vi.fn()` may supply the observed values.
- **AC-2 (GAP-1)** — The `File` nodes that test writes against are seeded by executing the Python
  ingestion writer's own `File` query text, read at runtime from
  `services/workers/sayre_workers/ingestion/graph.py`. Additionally, a non-infra test asserts the
  Node MATCH key equals `OWNERSHIP_FILE_MATCH_KEYS` and that the Python writer sets every one of
  those properties. Renaming `repo_id`, `ref_name`, or `path` on **either** side fails a test.
- **AC-3 (GAP-1)** — The `node` CI job gains a `neo4j` service and a dedicated step that runs the
  graph-backed git-sync tests with `GRAPH_INTEGRATION_REQUIRED: 'true'`, followed by a zero-skip
  assertion step. A silently-skipped graph test fails CI.
- **AC-4 (GAP-1b)** — When the provider resolves file edits but the graph matches zero `File` nodes,
  `syncGitMetadata` returns `status: 'unmatched'` (never `'ignored'`) with the unmatched paths on
  `unmatchedPaths`, increments `git_sync_unmatched_files_total`, and the worker records it. A branch
  event that legitimately produced no edits still returns `'ignored'`. The two are distinguishable
  by a caller, a log, and a metric.
- **AC-5 (GAP-2)** — `GIT_SYNC_TARGET_MS = 5_000` exists as a single named constant with a comment
  citing PRD-V1.md:16/:258; `GitSyncResult.durationMs` carries a monotonic measurement; a breach
  increments `git_sync_budget_breach_total`; and the end-to-end acceptance test asserts the
  enqueue→graph-visible elapsed time is under `GIT_SYNC_TARGET_MS` by reference to the constant,
  not a literal.
- **AC-6 (GAP-3)** — `listPullRequestFiles` is bounded on all three axes: at most
  `MAX_PULL_REQUEST_FILE_PAGES` pages (exceeding it throws, never silently truncates), every request
  carries `AbortSignal.timeout(GIT_PROVIDER_REQUEST_TIMEOUT_MS)` and `redirect: 'manual'`, and the
  body is read through the shared `readBoundedJson`. `appClient.ts`'s existing behavior and tests
  are unchanged by the extraction.
- **AC-7 (GAP-4)** — The `github-sync` enqueue passes `GIT_SYNC_JOB_OPTIONS` (`attempts: 5`,
  exponential backoff, `removeOnFail: false`), so a transient failure is retried and an exhausted
  job is durably retained in the `failed` set rather than deleted. The worker's `failed` listener
  records org/provider/delivery/attempt/error-name only — no payload, no credential.
- **AC-8 (GAP-5)** — A push payload that is truncated (`size > commits.length`, or `size` absent and
  `commits.length >= GITHUB_PUSH_COMMIT_CAP`) sets `truncated: true`, and a force-push
  (`payload.forced === true`) sets `rebuildRequired: true`, both surfaced on `GitSyncResult` and
  counted. Neither case is silently reduced to "we updated everything".
- **AC-9 (GAP-6)** — Providers are registered from the `GIT_PROVIDER_CATALOG` configuration value.
  `worker.ts` contains no adapter constructor literal, and enabling a different provider requires no
  edit to `worker.ts`, `bullmq.ts`, `gitSyncService.ts`, or `packages/shared-types`. The loader fails
  closed on unknown, duplicate, or malformed entries and on malformed JSON.
- **AC-10 (GAP-6)** — A registration marked `mockOnly` (i.e. `fakehub`) is refused with a thrown
  error when `NODE_ENV === 'production'`, so making a mock provider config-registrable does not make
  it production-registrable.
- **AC-11 (GAP-7)** — `fakehub` ships as a real adapter module under `providers/`, exported from the
  package barrel, whose `resolveChanges` genuinely normalizes both arguments into a
  `ProviderChangeSet` (no `void event; void occurredAt;`). An end-to-end test drives the literal
  second acceptance clause: configuration only → `startGitSyncWorker` → BullMQ `github-sync` job →
  graph write, with the `File` node's properties asserted afterwards. The prior
  `providerRegistry.test.ts` test titled "registers a second provider through one adapter module
  without a pipeline switch" is deleted, and the new test **fails** if provider registration is
  hardcoded.
- **AC-12 (GAP-8)** — `GitProviderContext` (provider id, credential ref, `resolveCredential`) is
  passed to every adapter factory by the catalog loader, so a config-registered provider can declare
  and resolve a credential without a code edit. `GithubProviderAdapter` uses
  `context.resolveCredential()` when a credential ref is configured and does **not** mint an
  installation token in that case; it falls back to today's minting when no ref is configured.
- **AC-13 (GAP-9)** — `event.repo.full_name` is validated with the shared
  `isValidRepoFullName` (`services/core/src/github/repoFullName.ts`) before any provider API path is
  built. `a/../../owner/repo`, `a/b/c`, `owner/`, `/name`, `owner//name`, `..`, and `''` are all
  rejected with `GithubGitSyncError` before any network call is made, and the error message does not
  echo the offending value.

## Edge cases

- **EC-1 (GAP-1)** — A `File` node with the same `repo_id`/`ref_name`/`path` but a **different
  `org_id`** is not touched by the write (structural tenant isolation, verified against real Neo4j).
- **EC-2 (GAP-1)** — A `File` node with the same `org_id`/`repo_id`/`path` but a different
  `ref_name` is not touched (a merge into `main` must not rewrite a feature branch's ownership).
- **EC-3 (GAP-1)** — Two edits in one change set touching the same path with different authors: the
  final `OWNS` edge is single-valued (the prior `OWNS` is deleted, per the existing
  `OPTIONAL MATCH … DELETE old_owns` clause) and `primary_owner_*` reflects one author, not both.
- **EC-4 (GAP-1)** — Re-delivering the identical merged-PR event a second time is idempotent: node
  properties and edge counts are unchanged after the second apply (the write is all `MERGE`/`SET`).
- **EC-5 (GAP-1b)** — Merged PR resolves N paths, the graph matches **zero**: `status: 'unmatched'`,
  `unmatchedPaths.length === N`, counter incremented, distinguishable from EC-6.
- **EC-6 (GAP-1b)** — A `branch` event (or a non-merged PR close) produces no edits at all:
  `status: 'ignored'`, `unmatchedPaths` empty, no repository resolve, no graph call — the existing
  early return is preserved.
- **EC-7 (GAP-1b)** — Partial match: 3 resolved paths, 2 matching `File` nodes → `status: 'applied'`,
  `updatedFiles: 2`, `unmatchedPaths` names exactly the third path.
- **EC-8 (GAP-2)** — A run that exceeds `GIT_SYNC_TARGET_MS` still completes and still applies the
  write; it records the breach rather than aborting mid-write.
- **EC-9 (GAP-3)** — The provider endpoint returns a full 100-entry page indefinitely: the loop stops
  at `MAX_PULL_REQUEST_FILE_PAGES` and throws `GithubGitSyncError`; it neither loops forever nor
  returns a silently truncated list.
- **EC-10 (GAP-3)** — A request that never resolves is aborted by the per-request timeout and
  surfaces as a rejection, so a stalled endpoint cannot hold a worker slot indefinitely (the worker
  runs at `concurrency: 4`).
- **EC-11 (GAP-3)** — A response declaring or streaming more than `MAX_JSON_RESPONSE_BYTES` is
  rejected before being buffered.
- **EC-12 (GAP-3)** — A 3xx from the provider endpoint is not followed (`redirect: 'manual'`), so an
  installation token is never replayed to a redirected host.
- **EC-13 (GAP-4)** — A transient graph failure on attempt 1 followed by success on attempt 2 ends
  with the ownership metadata applied exactly once.
- **EC-14 (GAP-4)** — All attempts exhausted: the job is present in the queue's `failed` set (not
  removed), and the recorded failure carries no payload, path, token, or repository secret.
- **EC-15 (GAP-4)** — `GitRepositoryNotRegisteredError` (repo not registered for this org) still
  fails the job — it must not be swallowed into a false `'ignored'`.
- **EC-16 (GAP-5)** — Push with `size: 47` and 20 inline commits → `truncated: true`; push with
  `size: 3` and 3 commits → `truncated: false`; push with no `size` and exactly 20 commits →
  `truncated: true` (conservative).
- **EC-17 (GAP-5)** — Push with `forced: true` → `rebuildRequired: true` on the result, while the
  derivable edits are still applied.
- **EC-18 (GAP-6)** — `GIT_PROVIDER_CATALOG` that is malformed JSON / not an array / an empty array /
  contains an unknown provider id / contains a duplicate provider id / contains an unknown object
  key / has a non-`env://` `credentialRef` → the loader throws `GitProviderCatalogError` and the
  worker does not start. It must never fall back silently to a github-only registry.
- **EC-19 (GAP-6)** — Default (unset) `GIT_PROVIDER_CATALOG` yields exactly today's behavior: a
  registry containing `github` and nothing else.
- **EC-20 (GAP-6)** — `fakehub` enabled while `NODE_ENV === 'production'` → refused with a thrown
  error naming the provider; enabled under `test`/`development` → registers normally.
- **EC-21 (GAP-7)** — A fakehub event whose payload is missing `files`, has an empty `files`, has a
  non-string entry in `files`, or has an unparseable timestamp: the adapter degrades the way the
  GitHub adapter does (drop the bad entry, fall back to `occurredAt`) rather than throwing or
  inventing a path.
- **EC-22 (GAP-8)** — A configured `credentialRef` naming a secret outside `SECRET_NAMES`, or one
  that resolves empty, fails closed as `GitProviderCredentialError`; the error message contains
  neither the secret value nor the resolved credential.
- **EC-23 (GAP-8)** — A provider configured with `credentialRef: null` and no minting path available
  fails closed rather than issuing an unauthenticated provider call.
- **EC-24 (GAP-9)** — `full_name` values `'a/../../owner/repo'`, `'a/b/c'`, `'owner/'`, `'/name'`,
  `'owner//name'`, `'..'`, `''`, `'own er/repo'`, `'owner/re%2Fpo'` are each rejected before any
  `fetcher` call is made (assert the fetcher was never invoked).
- **EC-25 (GAP-9)** — A legitimate dotted repository name (`'acme/my.repo.js'`) and a legitimate
  hyphen/underscore name (`'acme/my-repo_2'`) still succeed — the validation must not break real
  repositories.
- **EC-26 (GAP-1/GAP-3)** — Neo4j (or Redis) unreachable: the integration files skip locally and hard
  fail when `GRAPH_INTEGRATION_REQUIRED`/`MESSAGING_INTEGRATION_REQUIRED` is `'true'`; CI's zero-skip
  gate turns a skip into a red build.

## Open questions

- **Q-1 (GAP-6, needs a human answer before merge).** "Registers via configuration" is implemented as
  *configuration selects from a closed, in-repo registration manifest*, because the literal reading —
  configuration supplies a module specifier the worker imports — is arbitrary code execution for
  anyone who can write configuration, which `.claude/rules/security-multitenancy.md` does not permit.
  Under this reading, adding a genuinely new provider is: one new adapter module + one line in
  `providers/index.ts` + a config value; `worker.ts`, the queue, and the shared schema are untouched.
  If the ticket author intended "configuration names any module", that needs an explicit security
  decision (signed manifest? allowlisted specifier prefix?) rather than a planner ruling.
- **Q-2 (GAP-5).** Force-push and >20-commit truncation are *reported*, not repaired. Who performs
  the scoped ownership rebuild — a follow-up W3-04b, an extension of the Python ingestion rebuild
  that already handles head projection
  (`services/workers/sayre_workers/ingestion/service.py`, CLAUDE.md's persistence rule), or a
  Compare-API backfill inside this adapter? The audit sanctions "flag the ref for an ownership
  rebuild" as an acceptable fix
  (`docs/audits/deep-audit-2026-07-31/audit-04-webhooks-git.md:297-299`), so this spec flags. The
  consumer of that flag is undefined and should be named before this closes.
- **Q-3 (GAP-4).** Gap-scout noted GAP-4 may belong to W0-04 (queue infra) rather than W3-04. This
  spec scopes it to W3-04's own enqueue call site only, on the grounds that the acceptance verb is
  "updates" and today it is "updates, unless anything failed once". If the reviewer prefers, the
  same change belongs one level down as an `enqueue()` default — that is a W0-04 decision and would
  change every queue's behavior, which is why it is not taken here.
- **Q-4 (GAP-2).** The 5s target is measured **enqueue → graph-visible** in the acceptance test. It
  excludes GitHub's own delivery latency to our webhook endpoint, which we cannot observe. If the
  PRD's "<5s" was meant to include provider delivery time, the budget is unverifiable from inside
  this system and the acceptance assertion should be re-stated.
- **Q-5 (GAP-1).** Adding a `neo4j` service to the `node` CI job lengthens every Node CI run. The
  alternative — moving the git-sync graph test to the `workers` job, which already has Neo4j — was
  rejected because it would run TypeScript tests inside the Python job. Flagging the cost, not the
  decision.
