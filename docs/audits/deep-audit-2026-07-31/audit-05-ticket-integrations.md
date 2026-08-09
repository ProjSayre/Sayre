# Audit 05 — Ticket provider integrations (Jira, Linear)

Scope: `services/core/src/integrations/tickets/**`, `services/core/src/services/ticketSyncService.ts`,
`services/core/src/services/ticketSyncIngress.ts`, `services/workers/sayre_workers/tickets/**`.
Focus commits: `3aff7a3` (Jira poll loop), `2059a64` (embedding-similarity ticket→file matching).

---

### [SEVERITY: CRITICAL] JQL `since` literal is formatted in UTC but Jira evaluates it in the requesting user's timezone — the poll loop returns zero issues forever for any site west of UTC

- **File:** `services/core/src/integrations/tickets/jira/jiraOAuthClient.ts:131-138`, used at `:274`
- **Code:**
```ts
/** Jira JQL absolute-date literal: `"yyyy-MM-dd HH:mm"` (UTC — a generous poll window makes the difference from the instance's local time irrelevant). */
function formatJqlDate(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
    ` ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`
  );
}
...
const jql = `updated >= "${formatJqlDate(since)}" order by updated asc`;
```
- **Why it's wrong:** A bare JQL datetime literal carries no offset; Jira interprets it in the timezone of the
  user the token belongs to, not UTC. The docstring's assumption ("a generous poll window makes the difference
  irrelevant") only holds if the offset is smaller than the 15-minute lookback. Real offsets are ±14 hours.
  - Site in `America/New_York` (UTC−4): `now` = 15:00Z, `since` = 14:45Z, literal = `"2026-07-31 14:45"`,
    Jira reads it as 14:45 EDT = **18:45Z — 3h45m in the future**. `updated >= <future>` matches nothing.
    Every cycle returns `[]`, `ticketsFound: 0`, no error, no log anomaly. The entire feature is silently dead,
    which is the exact symptom (`a real created Jira ticket never appeared in a node's drawer`) it was built to fix.
  - Site in `Asia/Tokyo` (UTC+9): the window silently widens by 9 hours, which then collides head-on with the
    unpaginated 100-result cap below (finding 3) and drops most of the result set.
- **Fix:** Stop emitting an absolute local literal. Use JQL's timezone-independent relative form —
  `updated >= "-20m"` — computed from the lookback, or send an explicit-offset literal. Add a test asserting
  the JQL string for a fixed `since` and a non-UTC account.

---

### [SEVERITY: CRITICAL] Fan-out to every repo + a repo-agnostic `CLEAR_TICKET_REFERENCES_CYPHER` deletes the ticket's links it just created — multi-repo orgs end every cycle with zero ticket→file edges

- **File:** `services/core/src/integrations/tickets/graphTicketStore.ts:34-51` and `services/core/src/integrations/tickets/jiraPoller.ts:104-113`
- **Code:**
```cypher
-- CLEAR: NOT scoped to repo_id / ref_name
MATCH (ticket:Ticket {org_id: $org_id, uid: $ticket_uid})
MATCH (ticket)-[old:REFERENCES]->()
DELETE old
```
```cypher
-- LINK: IS scoped to repo_id / ref_name
MATCH (target {org_id: $org_id, repo_id: $repo_id, ref_name: $ref_name})
```
```ts
// jiraPoller.ts — one sync job per ticket PER REPO
const repos = await resolved.listRepositories(db, orgId);
for (const repo of repos) {
  const jobIds = await resolved.enqueue({ provider: 'jira', scope: { orgId, repositoryId: repo.id, ... }, externalTicketIds: keys, cycleId });
}
```
- **Why it's wrong:** `ticketUid(orgId, provider, externalId)` (`identifiers.ts:4-12`) has no repo component, so all
  repos share ONE `Ticket` node. Org has `repo-a` and `repo-b`. Ticket `PROJ-1` tagged `[sayre:file:src/index.ts]`:
  - job(repo-a): CLEAR (no-op) → LINK matches the File in repo-a → 1 edge, drawer works.
  - job(repo-b): CLEAR **deletes repo-a's edge** → LINK finds nothing in repo-b → 0 edges.
  - Final state: the ticket has no REFERENCES edge at all. The poll loop's whole purpose is defeated for any
    org with ≥2 repos, and with `concurrency: 4` (`worker.ts:68`) the winner is nondeterministic run to run.
  The poller's header comment (`jiraPoller.ts:15-19`) claims fan-out is "a harmless no-op (`syncTicket`'s
  `graph.apply` links 0 nodes there)" — it is not a no-op, because CLEAR runs unconditionally before LINK.
  `UPSERT_TICKET_CYPHER:29-30` has the same problem: `ticket.repo_id` / `ticket.ref_name` thrash between repos.
- **Fix:** Scope the delete to the repo being synced —
  `MATCH (ticket)-[old:REFERENCES]->(t {repo_id: $repo_id, ref_name: $ref_name})` — and stop stamping a single
  `repo_id`/`ref_name` on the shared Ticket node. Better: stop fanning a ticket into every repo and resolve the
  ticket's owning repo(s) explicitly.

---

### [SEVERITY: HIGH] `searchRecentIssueKeys` never paginates and pairs `maxResults: 100` with `order by updated asc` — a burst of >100 updates permanently loses tickets

- **File:** `services/core/src/integrations/tickets/jira/jiraOAuthClient.ts:274-286`
- **Code:**
```ts
const jql = `updated >= "${formatJqlDate(since)}" order by updated asc`;
...
body: JSON.stringify({ jql, fields: ['key'], maxResults: 100 }),
```
  and the parser drops everything but `issues[]` (`:140-149`) — `nextPageToken` is never read.
- **Why it's wrong:** `/rest/api/3/search/jql` is a cursor-paginated endpoint (`nextPageToken`); this reads page 1
  only. Combined with `order by updated asc`, the 100 returned are the *oldest* in the window. A bulk edit, CSV
  import, or Jira automation rule touching 500 issues means 400 are never returned — and because the next cycle
  re-issues the identical ascending-ordered, 100-capped query over a sliding 15-minute window, those 400 are
  never picked up before they age out of the window. Silent, permanent data loss with `ticketsFound: 100` logged
  as if healthy.
- **Fix:** Loop on `nextPageToken` with an explicit page cap (e.g. 20 pages) and log/alert when the cap is hit;
  at minimum switch to `order by updated desc` so the newest work is never the part that is dropped.

---

### [SEVERITY: HIGH] No watermark/cursor at all — any poll-worker downtime longer than the 15-minute lookback permanently drops every ticket updated during it

- **File:** `services/core/src/integrations/tickets/jiraPoller.ts:48-51`, `:85`
- **Code:**
```ts
  /** How far back to search on every cycle. Deliberately generous vs. the poll
   * interval — overlap is safe (BullMQ job ids are idempotency-keyed per
   * ticket/cycle), so there's no persisted "last polled" cursor to get wrong. */
  lookbackMs: number;
...
  const since = new Date(resolved.now().getTime() - resolved.lookbackMs);
```
- **Why it's wrong:** `since` is derived purely from wall-clock, never persisted. A deploy, crash, OOM, Redis
  outage, or Postgres blip that keeps `pollWorker` down for 16+ minutes means every ticket updated in that gap
  is outside the next cycle's window and is never synced — there is no catch-up mechanism and no signal that a
  gap occurred. `jiraConnectionStore.touchLastSynced(orgId, ...)` is already called per job (`worker.ts:63`) but
  is write-only; nothing reads it back as a resume point.
- **Fix:** Persist a per-org `last_polled_at` watermark, advance it **only after** the cycle's enqueues have all
  succeeded, and compute `since = max(watermark - overlapSkew, now - maxLookback)`. Clamp the catch-up window so
  a long outage doesn't produce an unbounded first query.

---

### [SEVERITY: HIGH] Cycle-scoped idempotency keys re-sync every ticket ~15× per window × every repo, and each re-sync fires a fresh embedding request — unbounded provider-API and embedding spend

- **File:** `services/core/src/services/ticketSyncIngress.ts:101`, `services/core/src/integrations/tickets/pollWorker.ts:9`, `services/core/src/integrations/tickets/jiraPoller.ts:64`, `services/core/src/queue/envelope.ts:61`
- **Code:**
```ts
// ticketSyncIngress.ts — key contains the per-cycle random UUID
idempotency_key: `${input.provider}-schedule-${input.cycleId}-${externalId}`,
```
```ts
// jiraPoller.ts:84 — new cycleId every cycle
const cycleId = randomUUID();
```
```ts
// envelope.ts:61 — reference-match publishes get a RANDOM idempotency key
idempotency_key: input.idempotency_key ?? messageId,   // messageId = randomUUID()
```
- **Why it's wrong:** Interval is 60s (`pollWorker.ts:9`) but the lookback is 15 min (`jiraPoller.ts:64`), so each
  ticket is returned by ~15 consecutive cycles. Because `cycleId` is fresh per cycle, the BullMQ `jobId`
  (`sha256(idempotency_key)`, `ticketSyncIngress.ts:22`) differs every time — the dedup the comment relies on only
  works *within* one cycle. Multiply by the per-repo fan-out (finding 2): **15 × N_repos full `fetchTicket` +
  Postgres upsert + 3 Cypher statements per ticket per 15 minutes.** For any ticket with no explicit tag and no
  stored inferred match, each of those also calls `requestReferenceMatch` (`ticketSyncService.ts:116`), and because
  `makeEnvelope` assigns a random `idempotency_key` the Python `DeliveryStore` claim never dedups it — so every one
  becomes a real `EmbeddingProvider.embed()` call. An org with 200 untagged tickets and 3 repos:
  200 × 15 × 3 × 96 windows/day ≈ **8.6M embedding calls/day**. Orgs with no embedding config at all
  (`reference_match.py:238-249` returns `no_config` and writes nothing) generate this traffic forever and never
  converge, since nothing is ever stored to stop the re-request.
- **Fix:** (a) Make the schedule idempotency key deterministic — drop `cycleId`, use a coarse time bucket, e.g.
  `${provider}-schedule-${externalId}-${bucketedUpdatedAt}`; (b) pass a deterministic `idempotency_key` to
  `makeEnvelope` in `defaultRequestReferenceMatch` (`ticketSyncService.ts:32-39`); (c) record a
  `inferred_reference_computed_at` / attempted-at marker even on `no_config` / `below_threshold` and skip
  re-requesting within a cooldown; (d) set the lookback to a small multiple of the interval, not 15×.

---

### [SEVERITY: HIGH] `requestReferenceMatch` is awaited unguarded — an SQS failure aborts the whole ticket sync before `graph.apply()`, so the ticket never reaches the graph

- **File:** `services/core/src/services/ticketSyncService.ts:99-127`
- **Code:**
```ts
  // ... Never blocks this sync on that request.
  if (payload.direction === 'inbound' && write.ticket.references.length === 0) {
    ...
    } else {
      await dependencies.requestReferenceMatch(envelope.org_id, { ... });   // no try/catch
    }
  }

  const graph = await dependencies.graph.apply(write);
```
- **Why it's wrong:** The comment says it never blocks the sync; the code awaits it and lets it throw.
  `publishTicketReferenceMatchEvent` → `publish` → `resolveQueueUrl` throws on a missing/unreachable
  `enrichment-default` queue, throttling, or expired AWS creds (`queue/sqs.ts:111-121, 201-204`). That exception
  propagates out of `syncTicket`, past `worker.ts:64-67` (which only swallows `OrgSecretUnavailableError`), and
  fails the BullMQ job — which is configured `attempts: 1` (`queue/bullmq.ts:181`), so there is no retry.
  Net effect: an SQS problem stops **all** untagged tickets from being written to Neo4j, while `cache.upsert`
  (line 97) has already run and marked them synced. The best-effort AI fallback becomes a hard dependency of the
  core structural sync, which also violates `.claude/rules/async-messaging.md` ("structural sync must never block
  on LLM enrichment"). No test covers a throwing `requestReferenceMatch` (`ticketSyncService.test.ts:109-242` all
  use `vi.fn(async () => undefined)`).
- **Fix:** Wrap in `try { ... } catch (error) { logAndContinue(error); }`, or move the publish to after
  `graph.apply()` and still guard it.

---

### [SEVERITY: HIGH] `setInterval` poll loop has no overlap guard and no backoff

- **File:** `services/core/src/integrations/tickets/pollWorker.ts:11-25`
- **Code:**
```ts
async function tick(): Promise<void> {
  try {
    const result = await runJiraPollCycle();
    console.log('[jira-poll]', JSON.stringify(result));
  } catch (error) {
    console.error('[jira-poll] cycle failed:', error);
  }
}
void tick();
setInterval(() => { void tick(); }, POLL_INTERVAL_MS);
```
- **Why it's wrong:** `runJiraPollCycle` is fully sequential over orgs (`jiraPoller.ts:90`), each doing a
  `resolveContext` + possible OAuth refresh + a Jira search + a repo query + N enqueues. With 100 connected orgs
  at ~1s each, a cycle takes ~100s while the interval is 60s — cycles stack, unbounded, one new concurrent cycle
  per minute. Each stacked cycle has its own `cycleId`, so they don't dedup against each other; they compete for
  the same Jira rate limit and the same Postgres pool, making each cycle slower and the pileup worse. Separately,
  a hard failure (Postgres down at `getDb`/`listOrgIds`, outside the per-org `try`) retries at full speed every
  60s with no backoff. `jiraPoller.test.ts` has no overlap or long-cycle test.
- **Fix:** Replace `setInterval` with a self-scheduling loop: `let running = false;` guard (or a Postgres advisory
  lock so multiple worker replicas don't double-run), `await tick()` then
  `setTimeout(loop, POLL_INTERVAL_MS)`, plus exponential backoff with jitter on consecutive failures.

---

### [SEVERITY: HIGH] Linear sync uses one global `LINEAR_ACCESS_TOKEN` for every tenant

- **File:** `services/core/src/integrations/tickets/providers/linear.ts:76`, wired at `services/core/src/integrations/tickets/worker.ts:72-74`
- **Code:**
```ts
private readonly loadToken: TokenLoader = () => getSecret('env://LINEAR_ACCESS_TOKEN'),
```
- **Why it's wrong:** Jira was moved to per-org credentials (`worker.ts:50-63` via `getOrgSecret`), but the
  `linear-sync` worker still calls `syncTicket(envelope, resolved)` with the shared registry built in
  `defaultDependencies()`. Every org's Linear job authenticates as the same single Linear workspace. Any path that
  enqueues a `linear-sync` job for org B with an arbitrary `external_ticket_id` fetches that issue from the one
  configured workspace and writes its title, description, status, URL, and full `raw` payload into org B's
  `ticket_cache` and Neo4j under `org_id = B`. That is cross-tenant content disclosure, not just a stubbed
  integration. The inline comment acknowledges the shape ("Linear keeps its existing global `LINEAR_*` env
  secrets") but not the disclosure consequence.
- **Fix:** Until a per-org Linear connect flow exists, gate `linear-sync` behind an explicit per-org
  `linear_connections` lookup and no-op (like the Jira `ctx === null` path) for orgs without one; do not fall back
  to a shared workspace token.

---

### [SEVERITY: HIGH] No 429 / `Retry-After` handling on any provider call, and jobs are `attempts: 1`

- **File:** `services/core/src/integrations/tickets/jira/jiraOAuthClient.ts:290-292`, `services/core/src/integrations/tickets/providers/jira.ts:141-143`, `services/core/src/integrations/tickets/providers/linear.ts:123-125`, `services/core/src/queue/bullmq.ts:180-184`
- **Code:**
```ts
if (!response.ok) {
  throw new JiraSyncError(`Jira issue request returned ${response.status}.`);
}
```
```ts
const job = await queue.add(envelope.type, envelope, { attempts: 1, removeOnComplete: true, ...opts });
```
- **Why it's wrong:** 429 is treated identically to 500 — thrown, not retried, `Retry-After` discarded.
  Amplification from finding 5 makes 429s likely, not hypothetical: Jira Cloud rate-limits per app+tenant, and the
  fan-out issues `15 × N_repos` `GET /rest/api/3/issue/{key}` calls per ticket per window with `concurrency: 4`.
  Once throttling starts, every job dies immediately (`attempts: 1`) and the poller re-enqueues the same tickets
  60 seconds later at the same rate — a self-sustaining throttle loop with no decay. Search-side 429s just log via
  `onOrgError` (`jiraPoller.ts:118`) and the next cycle retries at full rate.
- **Fix:** Detect `response.status === 429` (and 503), parse `Retry-After`, and either sleep-and-retry inside the
  adapter or throw a typed `RateLimitedError` that the worker converts into a BullMQ delayed retry. Set
  `attempts > 1` with exponential backoff for transient statuses.

---

### [SEVERITY: MEDIUM] Embedding match ignores `ref_id` / `revision_sha`, so it can return a File uid from another branch — and once stored the ticket is permanently stuck with a reference that can never link

- **File:** `services/workers/sayre_workers/tickets/reference_match.py:176-193`; consumed at `services/core/src/services/ticketSyncService.ts:104-114`
- **Code:**
```sql
SELECT graph_node_id, 1 - (embedding <=> %s::vector) AS similarity
FROM code_embeddings
WHERE org_id = %s AND repository_id = %s
  AND provider = %s AND model = %s
  AND graph_node_id IS NOT NULL
ORDER BY embedding <=> %s::vector
LIMIT 1
```
- **Why it's wrong:** `code_embeddings` carries `ref_id` and `revision_sha` (`db/schema.ts:658-661`) and the
  request carries `ref_name` (`reference_match.py:99`) — neither is used. A `graph_node_id` is
  `stable_uid(scope, "File", path)` = `sha256(repository_id \0 ref_name \0 "File" \0 path)`
  (`ingestion/projection.py:14-16`), so it is **ref-scoped**. Matching a chunk embedded from `feature/x` yields a
  uid that does not exist under `main`. `LINK_TICKET_REFERENCES_CYPHER` requires both
  `target.ref_name = $ref_name` and `target.uid = reference.value`, so the link silently fails —
  `linkedNodes: 0`. Worse, it is now permanent: `syncTicket` only re-requests a match when
  `references.length === 0`, and a stored `inferred_reference_node_id` makes `references.length === 1`
  (`ticketSyncService.ts:104-114`), so the ticket never gets another chance. Stale rows from deleted files have
  the same effect.
- **Fix:** Join `repository_refs` and filter `ref_name = %s` (and prefer the current `revision_sha`) in
  `find_best_match`; add a `ref_name` column check before writing. Separately, invalidate
  `inferred_reference_node_id` when `graph.apply` links 0 nodes so a bad match self-heals.

---

### [SEVERITY: MEDIUM] The inferred-reference columns are not repo-scoped, so per-repo fan-out makes N matchers race over one column

- **File:** `services/core/drizzle/0018_ticket_cache_inferred_reference.sql:12-15`, written by `services/workers/sayre_workers/tickets/reference_match.py:210-219`, read by `services/core/src/integrations/tickets/ticketCacheStore.ts:102-120`
- **Code:**
```sql
UPDATE ticket_cache
SET inferred_reference_node_id = %s, inferred_reference_score = %s, inferred_reference_computed_at = now()
WHERE org_id = %s AND provider = %s AND external_ticket_id = %s
```
- **Why it's wrong:** `ticket_cache` is unique on `(org_id, provider, external_ticket_id)`
  (`db/schema.ts:215-219`) — one row per ticket, no repo dimension. But the poller publishes one reference-match
  request per repo, each searching `code_embeddings` for its *own* `repository_id`. N matchers race to write N
  different repo-local node ids into the same column; last writer wins nondeterministically. On the next cycle,
  `resolveInferredReferenceNodeId` hands that single uid to every repo's sync job, so at most one repo can link it
  and the rest write `references: [<foreign uid>]` that matches nothing — and, per the previous finding, never
  re-requests. The read path is also not repo-filtered.
- **Fix:** Key the inferred reference by `(org_id, provider, external_ticket_id, repo_id)` — either add
  `repo_id` to the predicate on both sides, or move the inferred match into a separate table with that key.

---

### [SEVERITY: MEDIUM] `write_inferred_reference` ignores rowcount — a match against a ticket with no cache row is silently discarded

- **File:** `services/workers/sayre_workers/tickets/reference_match.py:200-219`, and the caller at `:286-299`
- **Code:**
```python
await connection.execute("""UPDATE ticket_cache SET inferred_reference_node_id = %s ...""", (...))
...
return TicketReferenceMatchResult(status="matched", ..., node_id=node_id, score=score)
```
- **Why it's wrong:** The UPDATE matches 0 rows if the `ticket_cache` row was deleted (repo unregistered,
  cascade from `repositories`) between publish and consume, or if RLS hides it. `cursor.rowcount` is never
  checked, so the matcher reports `status="matched"` with a node id and score, the SQS message is acked, the work
  is thrown away, and nothing ever retries — the ticket looks matched in logs and metrics but stays unlinked.
  A real embedding API call was paid for and discarded.
- **Fix:** Check `cursor.rowcount`; return a distinct `status="stale"` (or raise for redelivery) when it is 0.

---

### [SEVERITY: MEDIUM] `LINK_TICKET_REFERENCES_CYPHER` matches an unlabeled node pattern — full-graph scan per ticket sync

- **File:** `services/core/src/integrations/tickets/graphTicketStore.ts:41-51`
- **Code:**
```cypher
UNWIND $references AS reference
MATCH (ticket:Ticket {org_id: $org_id, uid: $ticket_uid})
MATCH (target {org_id: $org_id, repo_id: $repo_id, ref_name: $ref_name})
WHERE (reference.kind = 'file' AND target:File AND target.path = reference.value)
   OR ...
```
- **Why it's wrong:** The `target` pattern has no label, so no label-scoped index applies — Neo4j resolves it as
  an all-nodes scan filtered by properties. The graph contains Function, Class, and Module nodes that dwarf the
  File count (CLAUDE.md: Function/Class nodes are graph-internal), so this scans the entire org's graph to find
  one File. It runs once per ticket per repo per cycle — i.e. `15 × N_repos × ticket_count` full scans per
  15 minutes given finding 5.
- **Fix:** Split into label-specific branches (`MATCH (target:File {org_id, repo_id, ref_name, path})`,
  `MATCH (target:Feature {...})`, `MATCH (target:File {org_id, repo_id, ref_name, uid})`) driven by
  `reference.kind`, so the existing File/Feature indexes are used.

---

### [SEVERITY: LOW] The merged inferred reference is written to Neo4j but never back to `ticket_cache.payload.references`

- **File:** `services/core/src/services/ticketSyncService.ts:97-127`
- **Code:**
```ts
await dependencies.cache.upsert(write);          // payload.references = []
...
write.ticket = { ...write.ticket, references: [{ kind: 'node_id', value: inferredNodeId }] };
const graph = await dependencies.graph.apply(write);   // graph gets the reference
```
- **Why it's wrong:** `cache.upsert` runs before the inferred reference is merged, so
  `ticket_cache.payload.references` stays `[]` forever while Neo4j holds a REFERENCES edge. Any consumer that
  reads the cached payload (drawers, MCP tools, debugging) reports the ticket as unlinked, disagreeing with the
  graph. Also, if `graph.apply` throws, the cache row is already marked `synced_at` — a partial write with no
  compensation.
- **Fix:** Merge the inferred reference into `write.ticket` before `cache.upsert`, or re-upsert after
  `graph.apply` succeeds.

---

## Notes on things checked and found sound (not findings)

- Embedding dimension **is** validated: `EmbeddingProviderFactory.create` rejects `config.dimension != 1024` and
  `validate_embeddings` rejects wrong-length / non-finite vectors (`ingestion/embeddings.py:29-42, 96-100`).
- Python-side tenant scoping is real: `org_scoped_connection` does `SET LOCAL ROLE sayre_app` + transaction-local
  `app.org_id` before every query (`db/session.py`), and both matcher queries also carry an explicit `org_id`
  predicate.
- `listActiveJiraOrgIds` (`db/jiraPollDiscovery.ts:27-38`) drops to `sayre_app`, clears `app.org_id`, and returns
  only `org_id` from the migration-0017 `SECURITY DEFINER` function — it accepts no tenant-controlled input.
- Jira OAuth refresh is correctly serialized under a Postgres row lock spanning the HTTP call, re-checks freshness
  under the lock, persists the rotated refresh token, and soft-revokes only on `invalid_grant`
  (`jira/orgSecrets.ts:126-169`). No token is logged; `getOrgSecret` collapses all failures to
  `OrgSecretUnavailableError`.
- `model_provider_configs` has `unique(org_id, purpose)`, so `load_embedding_config`'s `fetchone()` without
  `ORDER BY` is deterministic.
- The similarity threshold exists and is enforced before any write (`reference_match.py:46, 277-284`) — the code
  does not blindly accept a nearest neighbor. The value (0.75) is explicitly flagged as untuned.
