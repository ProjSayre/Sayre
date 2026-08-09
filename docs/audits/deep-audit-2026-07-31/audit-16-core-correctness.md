# Audit 16 — `services/core/src/services/` correctness & reliability

Scope: all 30 non-test source files in `services/core/src/services/`. Security/authz
findings deliberately excluded (covered by a parallel auditor). Supporting files
(`db/`, `queue/`, `graph-query/`) read only where they determine whether a
service-layer behavior is correct.

Note on type-safety: `services/core/tsconfig.json` sets `strict: true` but **not**
`noUncheckedIndexedAccess`, so `array[0]` is typed non-`undefined` and the compiler
will not catch missing bounds checks. The service layer happens to guard every array
index it uses (all 10 sites verified), so this is latent rather than active. There are
zero `any`, `as unknown as`, `@ts-ignore`, or async-`forEach` occurrences in this
directory — the code is unusually disciplined for an unreviewed MVP.

---

### [SEVERITY: HIGH] Dead-code liveness verdict computed from an already-truncated dependency list — live files reported as `no_inbound_imports`

- **File:** `services/core/src/services/livenessService.ts:70-93` (root cause at `services/core/src/graph-query/index.ts:1648-1650`)
- **Code:**

```ts
// livenessService.ts:70-79
const inbound = overlay.dependencies.filter(
  (dependency) => dependency.direction === 'inbound',
);
const testImporters: string[] = [];
const productionImporters: string[] = [];
for (const dependency of inbound) {
  (isTestPath(dependency.path) ? testImporters : productionImporters).push(
    dependency.path,
  );
}
```

```ts
// graph-query/index.ts:1623-1628 — inbound AND outbound share one map
for (const prefix of ['out_dependency_', 'in_dependency_'] as const) {
  const dependency = overlayDependency(record, prefix, rowTarget, scope);
  if (dependency) {
    dependencies.set(`${dependency.direction}:${dependency.id}`, dependency);
  }
}
// graph-query/index.ts:1648-1650 — combined, sorted by PATH, truncated to 128
dependencies: [...dependencies.values()]
  .sort((a, b) => a.path.localeCompare(b.path) || a.id.localeCompare(b.id))
  .slice(0, 128),
```

- **Why it's wrong:** `getNodeOverlay` returns at most 128 dependencies, mixing both
  directions and sorted by **path**, not direction. `getNodeLiveness` then treats that
  truncated list as the complete inbound set and derives a verdict plus counts from it.
  Concrete failure: `src/utils/index.ts` imports 130 modules under `src/a…/` (outbound)
  and is imported once by `src/zz/app.ts` (inbound). Sorted by path, all 128 surviving
  entries are the `src/a…` outbound edges; the single `src/zz/app.ts` inbound edge is
  dropped. `getNodeLiveness` returns
  `{ liveness: 'no_inbound_imports', inbound: { production: 0, tests: 0 } }` for a file
  that is actively imported. The docstring at line 29 (`counts carry the magnitude`)
  and line 15's `LivenessVerdict` contract are both silently false above 128 edges —
  exactly the barrel/util/index files most likely to be inspected for dead code. This
  drives a destructive user decision (delete the file) from a wrong answer.
- **Fix:** Do not derive liveness from the canvas overlay projection. Add a dedicated
  Graph Query Service method that returns inbound-import counts (`count(*)`, unbounded)
  plus a bounded sample, and have `getNodeLiveness` call that. Failing that, at minimum
  have the overlay carry a `dependenciesTruncated: boolean` / separate per-direction
  caps, and make `getNodeLiveness` refuse to emit `no_inbound_imports` when truncated.

---

### [SEVERITY: HIGH] Memoized DB promise is never evicted on rejection — one transient failure poisons the reader for the process lifetime

- **File:** `services/core/src/services/providerJobStateService.ts:63-68` (identical twin: `services/core/src/db/installations.ts:57-65`)
- **Code:**

```ts
let defaultDbPromise: Promise<Db> | undefined;

async function getDefaultDb(): Promise<Db> {
  defaultDbPromise ??= createPoolFromSecret().then(createDb);
  return defaultDbPromise;
}
```

- **Why it's wrong:** `createPoolFromSecret()` awaits `getSecret('env://DATABASE_RUNTIME_URL')`,
  which throws `SecretNotFoundError` when the reference is unresolved, and
  `createPool` throws when the resolved URL is empty (`db/client.ts:21-28`). The
  rejected promise is cached in module scope and **never cleared**. Concrete failure:
  the first `GET /repos/:id/provider-state` request lands during a window where the
  secret is not yet resolvable (cold start ahead of env injection, or a transient
  Secrets-Manager error once PM-07's KMS phase lands). `defaultDbPromise` is
  permanently a rejected promise; every provider-state request for the rest of the
  process's life fails with the same stale error even after the environment is
  corrected. Only a restart recovers. The same bug in `db/installations.ts:57-65`
  (`getRuntimeDb`) is far worse: it is the default `getDb` for `agentSkillMdStore`,
  `mcpKeyStore`, `ticketCacheStore`, `providerSettingsStore`, `githubWebhookService`'s
  `resolveOrg`, and every install/outbox write — a single cold-start hiccup poisons all
  Postgres access process-wide.
  The correct idiom already exists in this repo: `packages/config/src/secrets.ts:138-143`
  attaches `pending.catch(() => { if (cache.get(ref) === pending) cache.delete(ref); })`.
- **Fix:** Mirror the `secrets.ts` pattern in both places:

```ts
async function getDefaultDb(): Promise<Db> {
  if (!defaultDbPromise) {
    const pending = createPoolFromSecret().then(createDb);
    pending.catch(() => { if (defaultDbPromise === pending) defaultDbPromise = undefined; });
    defaultDbPromise = pending;
  }
  return defaultDbPromise;
}
```

---

### [SEVERITY: HIGH] Ticket cache is written before the AI-inferred reference is merged — cache and graph diverge permanently

- **File:** `services/core/src/services/ticketSyncService.ts:97-127`
- **Code:**

```ts
await dependencies.cache.upsert(write);          // line 97 — references still []

if (payload.direction === 'inbound' && write.ticket.references.length === 0) {
  const inferredNodeId = await dependencies.cache.resolveInferredReferenceNodeId({...});
  if (inferredNodeId !== null) {
    write.ticket = {                              // line 111 — mutated AFTER the upsert
      ...write.ticket,
      references: [{ kind: 'node_id', value: inferredNodeId }],
    };
  } else { ... }
}

const graph = await dependencies.graph.apply(write);   // line 127 — gets the merged version
```

- **Why it's wrong:** `cache.upsert` persists `payload.references` (see
  `integrations/tickets/ticketCacheStore.ts:56`) from the pre-merge object, so
  `ticket_cache.payload.references` is written as `[]`, while `graph.apply` receives
  the merged `[{ kind: 'node_id', value: 'inferred-node-uid-123' }]` and creates the
  `Ticket -[REFERENCES]-> File` edge. Concrete failure: Jira `PAY-42` has no
  `[sayre:file:…]` tag, the Python matcher previously inferred `src/pay.ts`. After
  sync, the canvas/node-overlay (graph-backed) shows the ticket linked to `src/pay.ts`,
  but any consumer reading `ticket_cache` sees a ticket with zero references — the two
  stores permanently disagree about the same entity, and a graph rebuild replayed from
  the cache would silently drop the link. The existing tests
  (`ticketSyncService.test.ts:139-175`) assert only what `graph.apply` received and
  never inspect the cache write, so this is untested.
- **Fix:** Move the reference-resolution/merge block above line 97 so a single fully
  formed `write` is handed to both `cache.upsert` and `graph.apply`.

---

### [SEVERITY: MEDIUM] `requestReferenceMatch` is awaited despite "never blocks this sync" — an SQS outage half-syncs every untagged ticket

- **File:** `services/core/src/services/ticketSyncService.ts:99-125`
- **Code:**

```ts
// ... Never blocks this sync on that request.
} else {
  await dependencies.requestReferenceMatch(envelope.org_id, {   // line 116
    repository_id: payload.repository_id,
    ...
  });
}
```

- **Why it's wrong:** The comment claims the request never blocks the sync, but it is
  awaited and its rejection propagates. `defaultRequestReferenceMatch` calls
  `publishTicketReferenceMatchEvent` (`queue/sqs.ts:258-262`), which throws on any SQS
  failure — it does not swallow. Concrete failure: `enrichment-default` is unreachable
  for 10 minutes. Every inbound ticket with no `[sayre:file:…]` tag now throws *after*
  `cache.upsert` has already committed and *before* `graph.apply` runs, so the ticket
  is cached but never projected into the graph. The BullMQ job retries and re-runs the
  whole sequence, so it eventually self-heals — but for the outage window, untagged
  tickets are visible in the cache and absent from the graph, and every one of them
  burns its retry budget on a failure in an explicitly best-effort side channel.
- **Fix:** Make it genuinely non-blocking and match the comment:
  `void dependencies.requestReferenceMatch(...).catch(() => reportError('reference_match'));`
  (a bare `void` with no `.catch` would be an unhandled rejection — attach the handler),
  or move it after `graph.apply` and wrap in try/catch.

---

### [SEVERITY: MEDIUM] Output-buffer overflow is misreported as `timed_out` with a null exit code

- **File:** `services/core/src/services/onboardingSandboxService.ts:87-100`, consumed at `:229-240`
- **Code:**

```ts
exitCode:
  processError === null ? 0
  : typeof processError.code === 'number' ? processError.code
  : null,
timedOut:
  processError?.killed === true ||
  processError?.signal === 'SIGTERM' ||
  processError?.signal === 'SIGKILL',
```

- **Why it's wrong:** When `execFile` exceeds `maxBuffer` it kills the child and calls
  back with `error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'` (a **string**) and
  `error.killed === true`. Both branches then misfire: `exitCode` becomes `null` (the
  string is not a number) and `timedOut` becomes `true`. `run()` at line 231 maps that
  to `status: 'timed_out'`. Concrete failure: `ONBOARDING_SANDBOX_MAX_OUTPUT_BYTES` is
  allowed as low as `1_024` (validated at line 200-205), so an onboarding step like
  `npm ci` that prints 2 KB and exits 0 in three seconds is reported to the user as
  `{ status: 'timed_out', exitCode: null }` with truncated stdout — an operator will
  chase a nonexistent timeout and raise `ONBOARDING_SANDBOX_TIMEOUT_MS`, which cannot
  help. The route (`routes/onboardingTree.ts`) additionally returns 422 for this.
- **Fix:** Distinguish the cases explicitly before the `killed` check:

```ts
const maxBufferExceeded = processError?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
// add `outputTruncated: maxBufferExceeded` to HostProcessResult and surface a
// distinct 'output_truncated' status; only treat killed/SIGTERM as timedOut when
// !maxBufferExceeded.
```

---

### [SEVERITY: MEDIUM] Repository catalog loads the whole org unbounded, then silently drops everything past 250

- **File:** `services/core/src/services/repositoryCatalogService.ts:158-186`; store at `services/core/src/db/repositoryCatalogStore.ts:43-69`
- **Code:**

```ts
const [stored, scope] = await Promise.all([
  deps.store.list(ctx.orgId),      // no LIMIT anywhere in the store query
  deps.permissions.getReadScope(ctx),
]);

const repositories = stored
  .flatMap(...)                     // per-repo permission evaluation
  .sort((left, right) => left.name.localeCompare(right.name) || ...)
  .slice(0, MAX_REPOSITORIES);      // 250 — applied AFTER everything
```

- **Why it's wrong:** `repositoryCatalogStore.list` is a `repositories LEFT JOIN
  repository_refs` with `WHERE org_id = …` and no `LIMIT`. Concrete failure: an org
  with 3,000 registered repos averaging 40 refs each materializes ~120,000 rows into
  a `Map` on every `GET /repositories` call, runs `repositoryIsVisible` +
  `currentAuthorizedRef` (each `O(allows × refs)`) over all of them, sorts, and then
  throws away all but 250 — with no `nextCursor`, no `truncated` flag, and no way for
  the client to reach repo #251. Repos 251+ are invisible forever. A handful of
  concurrent calls will pin the event loop and can OOM the API process.
- **Fix:** Push `LIMIT`/keyset pagination into `repositoryCatalogStore.list` (order by
  `name, id` in SQL, which it already does), over-fetch modestly to absorb permission
  filtering, and return a cursor plus an explicit `truncated` flag in
  `RepositoryCatalog`.

---

### [SEVERITY: MEDIUM] Up-to-300-second Docker run awaited inline in an HTTP handler, with no concurrency cap

- **File:** `services/core/src/services/onboardingTreeService.ts:120-122`; runner at `onboardingSandboxService.ts:208-241`; route `routes/onboardingTree.ts` (`POST /repos/:repoId/onboarding-steps/:stepId/execute`)
- **Code:**

```ts
const result = await (
  dependencies.sandbox ?? createOnboardingSandboxRunner()
).run(step.command);
```

- **Why it's wrong:** Two problems. (1) `ONBOARDING_SANDBOX_TIMEOUT_MS` is accepted up
  to `300_000` (`onboardingSandboxService.ts:193-198`), so the request handler can block
  for five minutes. Any ALB/nginx/Cloudflare in front will cut the connection at its
  own idle timeout (commonly 60 s) — the client gets a 504 while the container keeps
  running to completion, and the cleanup `docker rm -f` at line 224 only executes if the
  Node process is still alive on that path. (2) Nothing bounds concurrency: each call
  constructs a fresh runner and spawns its own container (256 MB / 0.5 CPU / 64 pids
  each). Ten concurrent admin clicks are ten simultaneous containers plus ten pinned
  Node request slots. This also directly violates `.claude/rules/service-layer.md`
  ("Async work … never awaited inline in a request handler").
- **Fix:** Move execution onto BullMQ: the route enqueues and returns `202` with an
  execution id; the client polls or receives the result over the existing WebSocket
  gateway. If that is out of scope for MVP, at minimum add a process-wide semaphore
  around `run()` and cap the request-path timeout well under the proxy idle timeout.

---

### [SEVERITY: LOW] `enqueuedRepos` counts rows that `ON CONFLICT DO NOTHING` discarded

- **File:** `services/core/src/services/githubAppInstallService.ts:334-335`; also `githubInstallationRepositoriesService.ts:97-98` and `githubInstallationReconcileService.ts:156-157`
- **Code:**

```ts
await resolvedDeps.enqueueInitialParse(tx, envelope);
enqueued += 1;
```

- **Why it's wrong:** `enqueueInitialParseOutbox` (`db/githubInitialParseOutbox.ts:75-89`)
  ends with `on conflict (org_id, idempotency_key) do nothing` and returns `void`, so the
  caller cannot tell an insert from a no-op. Concrete failure: a user re-runs the GitHub
  App install callback (browser back/refresh) for an unchanged installation. Every
  envelope collides on its deterministic idempotency key and nothing is enqueued, yet the
  callback reports `enqueuedRepos: 25` and calls `kickInitialParseOutbox()`. The number
  shown to the operator ("25 repositories queued for parsing") is fiction.
- **Fix:** Have `enqueueInitialParseOutbox` return `boolean` (add `returning id` / check
  `rowCount`) and increment only when a row was actually inserted.

---

### [SEVERITY: LOW] Dispatcher constructor throws about a parameter the caller never passed

- **File:** `services/core/src/services/initialParseOutboxDispatcher.ts:152-157`
- **Code:**

```ts
this.publishTimeoutMs = boundedInteger(
  options.publishTimeoutMs ?? DEFAULT_PUBLISH_TIMEOUT_MS,   // 10_000
  'publishTimeoutMs',
  25,
  this.leaseSeconds * 1_000 - 1,
);
```

- **Why it's wrong:** `leaseSeconds` is documented and validated as low as `10`
  (line 140-145). `new InitialParseOutboxDispatcher({}, { leaseSeconds: 10 })` computes
  a maximum of `9_999` and compares it against the untouched default of `10_000`, so
  construction throws `publishTimeoutMs must be an integer between 25 and 9999` — naming
  an option the caller never supplied. Any lease below 11 seconds is unusable without
  also overriding `publishTimeoutMs`.
- **Fix:** Clamp rather than reject: `Math.min(DEFAULT_PUBLISH_TIMEOUT_MS, this.leaseSeconds * 1_000 - 1)`
  as the default, and only range-check an explicitly supplied value.

---

### [SEVERITY: LOW] `Date.parse` NaN silently degrades `recentEdits` ordering into an inconsistent comparator

- **File:** `services/core/src/services/productTreeService.ts:100-104`
- **Code:**

```ts
recentEdits.sort(
  (a, b) =>
    Date.parse(b.editedAt) - Date.parse(a.editedAt) ||
    a.filePath.localeCompare(b.filePath),
);
```

- **Why it's wrong:** If any `editedAt` is not parseable, `Date.parse` yields `NaN`,
  the subtraction yields `NaN`, `NaN` is falsy, and the comparator silently falls
  through to `localeCompare`. That makes the comparator non-transitive when only *some*
  entries are unparseable (A-vs-B compares by date, A-vs-C by path), which V8's TimSort
  may resolve into an arbitrary order. Concrete failure: one enrichment row writes
  `editedAt: '2026-07-22 12:00'` (space-separated, non-ISO — `Date.parse` is
  implementation-defined here) and the Product Tree's "recent edits" panel shows edits
  out of chronological order with no error anywhere.
- **Fix:** Parse once and validate up front — reject or bucket unparseable timestamps
  rather than letting `NaN` flow into the comparator:
  `const t = (v: string) => { const n = Date.parse(v); return Number.isNaN(n) ? -Infinity : n; };`

---

### [SEVERITY: LOW] Endpoint catalog is re-parsed and re-validated on every provider-settings request

- **File:** `services/core/src/services/providerSettingsService.ts:295, 329`; parser at `providerSettingsCatalog.ts:266-318`
- **Code:**

```ts
const endpoints = endpointOptionsForOrg(ctx.orgId, deps.loadEndpoints());
// loadEndpointCatalog() -> parseEndpointCatalog(getConfig('MODEL_PROVIDER_ENDPOINT_CATALOG'))
```

- **Why it's wrong:** Every `GET`/`PUT` of provider settings re-parses up to 64 KB of
  JSON (`MAX_CATALOG_CHARS`), and for each of up to 64 entries constructs a `URL`,
  spreads the string into code points for the control-character scan, and runs full
  IPv4/IPv6 classification. The config is deployment-static — this is pure repeated
  work on a request path. Not a wrong result, but it is the only unbounded per-request
  CPU cost in this directory.
- **Fix:** Memoize `loadEndpointCatalog()` at module scope keyed on the raw config
  string (and, per the HIGH finding above, evict on parse failure rather than caching
  a thrown state).

---

### [SEVERITY: LOW] Concurrent reconcile runs read-modify-write across a network gap with no lock

- **File:** `services/core/src/services/githubInstallationReconcileService.ts:110-160`
- **Code:**

```ts
const ourRepos = await resolvedDeps.listOurRepos(orgId);          // tx #1
const activeExternalIds = new Set(...);
for (const installation of installations) {
  const githubRepos = await resolvedDeps.githubClient.listInstallationRepos(...);  // network, up to 30s each
  ...
}
const { registered, enqueued } = await resolvedDeps.withOrg(orgId, async (tx) => { ... });  // tx #2
```

- **Why it's wrong:** The snapshot read (tx #1) and the writes (tx #2) are separate
  transactions with up to 30 s of GitHub round-trips between them, and nothing
  serializes the endpoint. Two admins clicking "Refresh installations" concurrently both
  observe the same `activeExternalIds`, compute the same candidate set, and both
  register + enqueue. Downstream this is contained — `registerRepository` is an upsert
  and `enqueueInitialParseOutbox` is `ON CONFLICT DO NOTHING` — so the practical damage
  is doubled `registered` counts in the HTTP response and doubled work, not corruption.
  Also note line 126: `if (githubRepos.length >= MAX_RECONCILE_REPOS) truncated = true`
  reports `truncated: true` for an installation with exactly 25 repos and nothing more,
  because the client is asked for at most 25.
- **Fix:** Take a per-org transaction advisory lock (the pattern
  `db/agentSkillMdStore.ts:135-137` already uses) around the whole reconcile, and use
  `> MAX_RECONCILE_REPOS` semantics by requesting `MAX + 1` and truncating locally.

---

## Things checked and found correct (not findings)

Recorded so a future reviewer does not re-derive them:

- `livenessService.ts:94` `recentChanges[0]?.timestamp` — the Graph Query Service does
  sort `recentChanges` descending by timestamp (`graph-query/index.ts:1651-1657`), so
  "most recent first" holds.
- `githubWebhookService.ts:221-227` — `Promise.allSettled` + rethrow-first is the right
  shape here (both queues are attempted, partial success still 500s for GitHub retry);
  `Number(event.installation_id)` cannot be `NaN` because `normalizeGithubEvent`
  ignores payloads with no numeric installation id (`normalizeGithubEvent.ts:163-166`).
- `initialParseOutboxDispatcher.ts:99-116` `withTimeout` — the losing `reject` on an
  already-settled promise is a no-op, so a late publish rejection does not become an
  unhandled rejection; `activeRun` assignment cannot race `kick()` because both are in
  the same synchronous block.
- `loginService.ts:188-227` — the create-vs-resolve retry loop correctly distinguishes
  the two unique-violation constraints, is bounded, and wraps org+user in one
  transaction so a failed user insert cannot orphan an org.
- `providerSettingsCatalog.ts:186-207` IPv6 classification — `::ffff:7f00:1`,
  `::ffff:127.0.0.1`, `::`, `fe80::1`, and `1::2::3` all classify correctly (the
  textual IPv4-mapped form fails closed to `blocked`).
- All 10 array-index sites in this directory are guarded despite
  `noUncheckedIndexedAccess` being off.
