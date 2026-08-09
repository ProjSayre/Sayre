# Audit 07 — Async Messaging (BullMQ + SQS/SNS)

Scope: `services/core/src/queue/`, `services/workers/messaging/`, plus their real producers/consumers
(`services/core/src/integrations/`, `services/core/src/services/`, `services/workers/sayre_workers/`,
`services/gateway/src/sqs/`). Contract sources: `CLAUDE.md` §Conventions, `.claude/rules/async-messaging.md`,
`docs/wave0-foundation-contracts.md` §"Ingestion, events, and background work".

Note on what is *right*: the fleet split is honored (no BullMQ in Python, no SQS consumer loop in
`services/core`), every SQS queue has a DLQ with `maxReceiveCount=5`
(`infra/localstack/init/ready.d/01-create-sqs-queues.sh:51-88`), FIFO grouping is byte-identical
across languages (`sqs.ts:129` / `sqs_client.py:372`), and `consume_once` has a real visibility
heartbeat. The findings below are the gaps.

---

### [SEVERITY: CRITICAL] `graph.updated` carries an unbounded `changed_paths` list — every full rebuild of a repo with more than ~5k files permanently fails after the graph commit

- **File:** `services/workers/sayre_workers/ingestion/events.py:79` (producer), `services/workers/sayre_workers/ingestion/service.py:97-99,141-148` (source of the list)
- **Code:**

```python
# service.py:97-99  — on a full rebuild, "changed" means the ENTIRE tracked tree
tracked_paths = await snapshot.tracked_paths()
if full_rebuild or replayed:
    affected_paths = tracked_paths

# service.py:141-148
await self._publisher.graph_updated(
    scope=scope,
    graph_version=accepted_state.graph_version,
    full_rebuild=full_rebuild,
    changed_paths=affected_paths,      # <- every path in the repo
    ...
)

# events.py:74-83
payload={
    ...
    "changed_paths": list(changed_paths),   # no cap, no truncation
},
...
publish_graph_updated(envelope)
```

- **Why it's wrong:** SNS `Publish` (and SQS `SendMessage`) hard-cap a message body at 256 KB.
  At ~48 JSON bytes per repository path, that ceiling is ~5,400 files. Every `initial` parse takes
  the `full_rebuild` branch, so the very first ingestion of any normal-sized repo (React ≈ 7k files,
  a typical monorepo far more) produces an oversized body and `client.publish` raises.
  The failure lands at `service.py:141`, i.e. **after** the graph transaction committed and the ref
  was accepted (`service.py:134-135`) but **before** chunk persistence and `embedding_upsert`
  (`service.py:158-171`). Consequences, in order:
  1. `consume_once` catches the exception, releases the claim, does not delete
     (`sqs_client.py:635-646`) → redelivery.
  2. Redelivery takes the `replayed = True` branch (`service.py:78-81`), which again sets
     `affected_paths = tracked_paths` → identical oversized publish → identical failure.
  3. After 5 receives the message goes to `ingestion-dlq.fifo`. The repo now has a written graph,
     an accepted ref, **zero** `graph.updated` fanout (no realtime push, no enrichment) and
     **zero** chunks/embeddings — the RAG path for that repo is silently empty forever.
  This is not a tail case; it is the default path for the flagship "point Sayre at your repo" flow.
- **Fix:** Stop shipping the path list on a full rebuild. Either (a) send
  `changed_paths: []` whenever `full_rebuild` is true (consumers already branch on `full_rebuild`
  and `enrichment/service.py:123` discards `changed_paths` for the default lane anyway), or
  (b) cap the list at a constant (e.g. 500) and add a `changed_paths_truncated: bool`, or
  (c) persist the path set and send a pointer. Add a hard guard in
  `messaging/sns_client.py:publish_graph_updated` / `sqs_client.publish` that raises a typed error
  when `len(body.encode()) > 256_000`, so this is a loud failure at the boundary rather than an
  AWS 400 mid-pipeline. Also move `graph_updated` publication to be non-fatal to the
  chunk/embedding phase (or publish after it) so one event failure cannot zero out embeddings.

---

### [SEVERITY: HIGH] Every BullMQ job runs with `attempts: 1` and no backoff — one transient provider 5xx permanently loses the job

- **File:** `services/core/src/queue/bullmq.ts:180-184`
- **Code:**

```ts
const job = await queue.add(envelope.type, envelope, {
  attempts: 1,
  removeOnComplete: true,
  ...opts,
});
```

- **Why it's wrong:** `attempts: 1` means zero retries and no `backoff` strategy at all. Every
  production caller passes only `{ jobId }` (`githubWebhookService.ts:83`,
  `ticketSyncIngress.ts:23-25`), so nothing overrides it. The handlers behind these queues make
  live third-party calls — `syncGitMetadata` hits the GitHub API, `syncTicket` hits Jira/Linear
  (`integrations/git/worker.ts:29`, `integrations/tickets/worker.ts:62,73`). GitHub 502s and Jira
  429s are routine. A single one permanently drops that ownership/ticket sync: the job moves to the
  `failed` set and **nothing in the codebase ever reads it** — there is no `worker.on('failed')`,
  no QueueEvents listener, no BullMQ DLQ equivalent, no alert (verified by grep across
  `services/**/*.ts`; the only `on('failed')` is in a test at
  `queue/__tests__/bullmq.roundtrip.test.ts:336`). `docs/wave0-foundation-contracts.md:55` requires
  every work queue to have a DLQ; the SQS side has one, the BullMQ side has nothing.
- **Fix:** Default to `attempts: 5` with `backoff: { type: 'exponential', delay: 1000 }` in
  `enqueue`, and set `removeOnFail: { age: 14 * 24 * 3600 }` so the failed set is a bounded,
  inspectable DLQ instead of an unbounded Redis leak. Add a `failed` listener in `createWorker`
  that emits a metric/log so a drop is observable.

---

### [SEVERITY: HIGH] `removeOnComplete: true` destroys BullMQ's jobId deduplication — the documented webhook-redelivery idempotency does not exist

- **File:** `services/core/src/queue/bullmq.ts:180-184`, `services/core/src/services/githubWebhookService.ts:83`, `services/core/src/services/ticketSyncIngress.ts:20-26`
- **Code:**

```ts
// bullmq.ts:182-183
attempts: 1,
removeOnComplete: true,

// githubWebhookService.ts:83
await enqueue('github-sync', envelope, { jobId: envelope.idempotency_key });

// githubWebhookService.ts:212-214 (the claim this relies on)
// "GitHub retries the whole delivery, and idempotency de-dupes
//  on whichever queue already received it."
```

- **Why it's wrong:** BullMQ's custom-`jobId` dedup only suppresses a duplicate while the job hash
  still exists in Redis. `removeOnComplete: true` deletes that hash the instant the job finishes,
  so the id is immediately reusable. Concrete failure: GitHub delivers push `X`, the job completes
  and is removed; GitHub's delivery retry (or an operator "Redeliver" click) arrives seconds later
  with the same `X-GitHub-Delivery` → same `jobId` → **a brand-new job is created and
  `syncGitMetadata` runs a second time**, re-writing OWNS/AUTHORED edges. The header comment at
  `githubWebhookService.ts:212-214` explicitly promises dedup that the implementation cannot
  deliver. Same defect for `ticketSyncIngress.ts:21` (its SHA-256 `jobId`) and for both
  `enqueueTicketWebhook` and `enqueueScheduledTicketSync`.
- **Fix:** Use BullMQ 5.28's first-class dedup — `queue.add(name, data, { deduplication: { id, ttl } })`
  with a TTL that exceeds the provider's redelivery window (GitHub retries for ~3 days) — instead of
  overloading `jobId`. Alternatively change the default to
  `removeOnComplete: { age: 259_200, count: 10_000 }` so the id survives long enough to dedup.
  Do not leave the current comment claiming dedup works.

---

### [SEVERITY: HIGH] Jira poller re-enqueues every open ticket on every cycle — ~15× duplicated provider calls and graph writes

- **File:** `services/core/src/integrations/tickets/jiraPoller.ts:48-51,64,84,106-112`, `services/core/src/integrations/tickets/pollWorker.ts:9,23-25`
- **Code:**

```ts
// jiraPoller.ts:48-51
/** How far back to search on every cycle. Deliberately generous vs. the poll
 * interval — overlap is safe (BullMQ job ids are idempotency-keyed per
 * ticket/cycle), so there's no persisted "last polled" cursor to get wrong. */
lookbackMs: number;
...
lookbackMs: 15 * 60 * 1000,          // :64
const cycleId = randomUUID();        // :84  — NEW uuid every cycle

// pollWorker.ts:9,23-25
const POLL_INTERVAL_MS = Number(process.env.JIRA_POLL_INTERVAL_MS ?? 60_000);
setInterval(() => { void tick(); }, POLL_INTERVAL_MS);
```

with `ticketSyncIngress.ts:104` building the key as
`` `${provider}-schedule-${cycleId}-${externalId}` ``.

- **Why it's wrong:** The comment's premise is exactly backwards. Because `cycleId` is a fresh
  `randomUUID()` per cycle, the idempotency key — and therefore the `jobId` — is **different on
  every cycle for the same ticket**. With a 15-minute lookback and a 60-second interval, each
  recently-updated ticket is enqueued ~15 times, once per cycle, and every one of those jobs is a
  distinct job that runs `syncTicket`: a Jira REST fetch plus a graph `apply`. Multiply by the
  fan-out at `jiraPoller.ts:105-113` (every ticket × every active repo in the org) and a single org
  with 50 active tickets and 10 repos generates 7,500 Jira API calls and 7,500 graph writes per
  15 minutes. That is a self-inflicted Jira rate-limit (and a `ticket.reference_match` SQS message
  storm, see below). Separately, `setInterval` has no in-flight guard — if a cycle exceeds 60 s
  (very likely at this volume) cycles overlap and compound, and `pollWorker.ts` registers no
  SIGINT/SIGTERM handler at all, so shutdown drops the cycle mid-fan-out.
- **Fix:** Derive the dedup key from ticket identity plus a *quantized* time bucket
  (e.g. `${provider}-schedule-${externalId}-${floor(now/lookbackMs)}`) or, better, persist a
  per-org `last_polled_at` cursor and drop `cycleId` from the key entirely. Replace `setInterval`
  with a self-rescheduling `setTimeout` that only re-arms after `tick()` settles, and add
  `process.once('SIGTERM', ...)`.

---

### [SEVERITY: HIGH] Any transient SQS error kills the entire Python worker process — the consume loop has no try/except and no backoff

- **File:** `services/workers/messaging/sqs_client.py:565-572,607,660,686-695`
- **Code:**

```python
# consume_once — every boto3 call is bare
queue_url = get_queue_url(queue_name)          # :565
client = get_client()                          # :566
response = client.receive_message(...)         # :567  <- uncaught
...
client.delete_message(QueueUrl=queue_url, ReceiptHandle=receipt_handle)   # :607, :660  <- uncaught

# consume — no exception handling around the primitive
while effective_stop is None or not effective_stop.is_set():
    consume_once(queue_name, handler, ...)     # :687-695
```

- **Why it's wrong:** Only the *handler* is protected (`sqs_client.py:632-640`). Any failure in the
  transport — `ReceiveMessage` throttling, an expired IAM/STS credential, a DNS blip, a 500 from the
  SQS endpoint, `DeleteMessage` timing out — propagates out of `consume_once`, out of `consume`, up
  through `run_ingestion_consumer` (`ingestion/consumers.py:36-45`) to `cli.py:205-211`, which
  prints the fixed string `WORKER_FAILURE` and returns exit code 1. The container dies. Under an
  orchestrator this becomes a crash-restart loop with no backoff (each restart re-runs
  `build_ingestion_service`, re-resolving secrets and reconnecting Neo4j/Postgres), amplifying load
  during exactly the AWS incident that caused it. The Node gateway consumer got this right —
  `services/gateway/src/sqs/consumer.ts:172-176` catches receive errors and sleeps 1 s — so the
  Python fleet is strictly worse than the code that copied it.
- **Fix:** Wrap the `receive_message` / `delete_message` calls in `consume_once` and the loop body
  in `consume`/`consume_enrichment` with `except (BotoCoreError, ClientError)`, log, and apply
  exponential backoff with jitter (cap ~30 s) before continuing. Only unrecoverable configuration
  errors should terminate the process.

---

### [SEVERITY: HIGH] The only production entrypoint hardcodes a per-container SQLite delivery store — "durable idempotency" is not durable across replicas

- **File:** `services/workers/sayre_workers/cli.py:196-200`, `services/workers/messaging/idempotency.py:1-6`
- **Code:**

```python
# cli.py:196-200  — no injection point, no env-based selection
with _graceful_shutdown(stop_event):
    with SqliteDeliveryStore(delivery_path) as delivery_store:
        service = _build_service(definition.builder)
        definition.runner(service, delivery_store, stop_event)
```

against the module's own contract:

```python
# idempotency.py:3-6
"""The SQLite implementation is a local-development/shared-volume reference. Production
multi-host workers must inject a shared durable implementation of ``DeliveryStore``;
there is deliberately no in-memory fallback."""
```

- **Why it's wrong:** `sqs_client.consume_once:543-544` correctly *refuses* to run a production
  queue without a delivery store, but the only shipped store is a local SQLite file and `main()`
  offers no way to substitute another — the `--delivery-store` flag only changes the *path*.
  Scale the ingestion worker to two replicas (the whole point of a competing-consumer queue) and
  each container gets its own `delivery_claims` table. SQS at-least-once then delivers the same
  `graph.updated`/`embedding.upsert` to replica B, whose store has no record of replica A's
  completion → `claim` returns `acquired` → the work runs twice. That means duplicate graph
  writes and, on `embedding-upserts`, a **second paid embedding API call per chunk**
  (`ingestion/embeddings.py:143`). The `graph_watermarks` staleness guard
  (`idempotency.py:158-167`) is likewise per-replica and cannot prevent it. Mounting the SQLite
  file on a shared volume is not a workaround either: `idempotency.py:83` sets
  `PRAGMA journal_mode = WAL`, and SQLite's WAL mode is explicitly unsupported over NFS/EFS.
- **Fix:** Add a `DELIVERY_STORE_BACKEND` config (`sqlite` | `postgres`) and a
  `PostgresDeliveryStore` implementing the same `DeliveryStore` Protocol against the existing RDS
  instance (`INSERT ... ON CONFLICT` gives the same claim/renew/complete semantics transactionally).
  Until that exists, make `cli.py` refuse to start with the SQLite store unless an explicit
  `SAYRE_SINGLE_REPLICA=true` is set, so the constraint is enforced rather than documented.

---

### [SEVERITY: HIGH] Graceful shutdown closes the graph driver concurrently with the in-flight job drain, so draining jobs fail — and with `attempts: 1` they are lost

- **File:** `services/core/src/integrations/git/worker.ts:36-38`, `services/core/src/integrations/tickets/worker.ts:79-84`
- **Code:**

```ts
// git/worker.ts:36-38
async close() {
  await Promise.allSettled([worker.close(), resolved.graph.close()]);
},

// tickets/worker.ts:80-83
await Promise.allSettled([
  ...workers.map(async (worker) => worker.close()),
  resolved.graph.close(),
]);
```

- **Why it's wrong:** `worker.close()` is BullMQ's *drain*: it resolves only after in-flight jobs
  finish. `Promise.allSettled` starts `resolved.graph.close()` at the same instant, tearing down the
  Neo4j driver underneath jobs that are mid-`graph.apply`. Those jobs throw, and because
  `enqueue` sets `attempts: 1` (finding 2) they go straight to the `failed` set with no retry — a
  guaranteed silent data loss on every deploy/rolling restart, which is precisely when SIGTERM
  fires. `docs/wave0-foundation-contracts.md:56` requires consumers to finish in-flight work during
  graceful shutdown.
- **Fix:** Sequence them: `await worker.close(); await resolved.graph.close();` (and for tickets,
  `await Promise.allSettled(workers.map(w => w.close())); await resolved.graph.close();`). Add a
  shutdown timeout so a hung job cannot block the process indefinitely.

---

### [SEVERITY: MEDIUM] Raw ticket titles and full descriptions are published onto SQS, contradicting the "structural metadata and embeddings only" persistence contract

- **File:** `services/core/src/queue/sqs.ts:243-262`, `services/core/src/services/ticketSyncService.ts:28-40`
- **Code:**

```ts
// sqs.ts:243-250
export interface TicketReferenceMatchRequest {
  repository_id: string;
  ref_name: string;
  provider: 'jira' | 'linear';
  external_ticket_id: string;
  title: string;
  description: string | null;     // full Jira/Linear body, no truncation
}

// ticketSyncService.ts:33-38
makeEnvelope({
  org_id: orgId,
  type: 'ticket.reference_match',
  source: 'sayre-ticket-sync',
  payload: request,               // <- title + description verbatim onto enrichment-default
})
```

- **Why it's wrong:** `CLAUDE.md` §Conventions and `docs/wave0-foundation-contracts.md:81-83` limit
  persistence to bounded structural metadata, chunks, and embeddings. A Jira description is
  free-form user text up to 32 KB that routinely contains customer names and emails, stack traces
  with internal hostnames, and pasted API keys/connection strings. Publishing it verbatim puts that
  content at rest in SQS for the queue's retention period, and — because a failing
  `TicketReferenceMatcher` will not delete the message — in `enrichment-default-dlq` for the full
  14 days configured at `infra/localstack/init/ready.d/01-create-sqs-queues.sh:6,31-35`, where
  nobody is redacting it. Compare `embedding_upsert` (`ingestion/events.py:120-127`), which
  correctly ships only IDs and lets the consumer load content from the tenant-scoped store — the
  right pattern already exists in the codebase. The volume amplification from finding 4 makes this
  worse: every duplicated poll cycle re-publishes every ticket body.
- **Fix:** Publish `{ repository_id, ref_name, provider, external_ticket_id }` only and have
  `TicketReferenceMatcher` read title/description from `ticket_cache` (the row `syncTicket` already
  wrote) under the envelope's `org_id`. If inlining is kept for latency, cap `description` to a
  documented length and record the truncation.

---

### [SEVERITY: MEDIUM] The gateway's realtime SQS consumer has neither a visibility heartbeat nor durable idempotency

- **File:** `services/gateway/src/sqs/consumer.ts:161-179`
- **Code:**

```ts
response = await client.send(
  new ReceiveMessageCommand({
    QueueUrl: url,
    MaxNumberOfMessages: 10,
    VisibilityTimeout: visibilityTimeoutSeconds,   // fixed 30s, never extended
    WaitTimeSeconds: waitTimeSeconds,
  }),
);
const messages = response.Messages ?? [];
await Promise.all(messages.map((message) => processMessage(client, url, message)));
```

- **Why it's wrong:** `docs/wave0-foundation-contracts.md:56-58` requires long-running consumers to
  extend visibility with a heartbeat and handlers to use durable idempotency keys — the Python side
  implements both (`sqs_client.py:436-508`, `idempotency.py`), this consumer implements neither.
  All 10 messages of a batch share one 30-second window that starts at receive; `onEnvelope` is a
  per-client RBAC re-filter plus Redis fan-out (`.claude/rules/security-multitenancy.md` requires
  the re-filter), so a slow Redis or a large subscriber set can push a batch past 30 s, at which
  point the messages become visible again and a second gateway replica fans out the same
  `graph.updated` — duplicate canvas refreshes for every connected client. The explicit
  "delete failed → at-least-once redelivery is expected and must be handled idempotently
  downstream" comment at `consumer.ts:154-157` names a downstream idempotency guard that does not
  exist. `assertValidEnvelope` does not check `graph_version` against any watermark, so an
  out-of-order redelivery can also push a *stale* graph version to clients.
- **Fix:** Add a `ChangeMessageVisibility` heartbeat at ~1/3 of the timeout while a batch is in
  flight, and drop messages whose `(graph_scope_key, graph_version)` is at or below a Redis-held
  watermark before fan-out — that reuses the same watermark idea as
  `idempotency.py:158-167` and makes both duplicate and out-of-order delivery harmless.

---

### [SEVERITY: MEDIUM] Embedding fan-out is per-chunk, sequential, and blocking — one full rebuild is 4 × file-count individual `SendMessage` calls on the event loop

- **File:** `services/workers/sayre_workers/ingestion/service.py:158-171`, `services/workers/sayre_workers/ingestion/events.py:111-129`
- **Code:**

```python
# service.py:167-171
for chunk in persisted:
    await self._publisher.embedding_upsert(
        embedding_task(scope, accepted_state.ref_id, chunk),
        chunk.chunk.content_hash,
    )

# events.py:129  — sync boto3 call inside an async def, one message per chunk
publish(EMBEDDING_UPSERTS_QUEUE, envelope)
```

- **Why it's wrong:** `build_bounded_chunks` bounds chunks *per file*
  (`ingestion/chunks.py:24-25`: `MAX_CHUNK_CHARACTERS = 3_000`, `MAX_CHUNKS_PER_FILE = 4`) but not
  per repository, so a 10k-file repo emits up to 40,000 messages. Each goes out as a separate
  `SendMessage` (SQS supports `SendMessageBatch` at 10/call, unused), issued sequentially, using
  the *synchronous* boto3 client directly inside a coroutine — so the ingestion event loop is
  blocked for the entire fan-out and the visibility heartbeat thread is the only thing keeping the
  ingestion message alive. This is 10× the SQS API calls it needs and turns the tail of ingestion
  into a multi-minute blocking stretch. Separately, `EmbeddingConsumer.handle`
  (`ingestion/embeddings.py:141-148`) constructs a brand-new `AsyncOpenAI` client — and re-resolves
  the credential via `get_secret` — for **every single message**, then closes it, so each of those
  40,000 messages pays a fresh secret lookup and TLS handshake.
- **Fix:** Batch with `SendMessageBatch` in groups of 10 and run the publish through
  `asyncio.to_thread` (or switch to `aioboto3`). Cache the provider per `EmbeddingConfig` on the
  `EmbeddingConsumer` instead of rebuilding it per message.

---

### [SEVERITY: MEDIUM] Handler failures are logged without the exception, and the worker entrypoint replaces every crash with fixed text — production failures are undiagnosable

- **File:** `services/workers/messaging/sqs_client.py:632-640`, `services/workers/sayre_workers/cli.py:205-211`
- **Code:**

```python
# sqs_client.py:632-640
try:
    handler(envelope)
    handler_succeeded = True
except Exception:
    logger.warning(
        "Handler failed for message_id=%s on queue %r; not deleting.",
        envelope.message_id,
        queue_name,
    )                      # no exc_info, no exception type, no traceback

# cli.py:205-211
except Exception:
    print(f"{mode} worker FAILED: {WORKER_FAILURE}", file=sys.stderr, flush=True)
    return 1
```

- **Why it's wrong:** This is not a silent ack (the message is correctly left for redrive), but it
  is total diagnostic loss. When a message reaches `ingestion-dlq.fifo` after 5 failures, the only
  evidence anywhere is five identical warnings naming a message id and a queue — no exception type,
  no traceback, no file/line. `cli.py` then converts any escaping error into the constant string
  "The worker process could not be completed." The stated motive (keeping DSNs and credentials out
  of logs) is legitimate but is being served by discarding *all* signal rather than by redacting.
- **Fix:** Log `exc_info=True` (or at minimum `type(error).__name__` plus a sanitized
  `str(error)`) at `error` level, and attach the envelope's `trace_id`/`org_id`. Route the raw
  exception to the error tracker rather than stdout if leakage into log aggregation is the concern.

---

### [SEVERITY: MEDIUM] Work that completed successfully is discarded when SIGTERM arrives mid-handler

- **File:** `services/workers/messaging/sqs_client.py:476-482,631-646`
- **Code:**

```python
# _HeartbeatController._run:476-480 — stop renewing as soon as shutdown is requested
while not self._stop.wait(self._interval_seconds):
    if self._global_stop is not None and self._global_stop.is_set():
        self.lost.set()
        return

# consume_once:644-646 — a set `lost` flag discards the result even on success
if not handler_succeeded or heartbeat.lost.is_set():
    _safe_release(delivery_store, consumer_id, idempotency_key, owner_id)
    return 0
```

- **Why it's wrong:** Halting renewal at shutdown is correct per
  `docs/wave0-foundation-contracts.md:56`. Treating it as a *failure* is not. The handler is never
  cancelled — it runs to completion — so on every rolling restart, any message whose handler was
  in flight has its claim released and is never deleted, even though its side effects (graph write,
  ref acceptance, embedding API call) already committed. On redelivery the whole job is redone: for
  ingestion that is a full re-parse and re-publish; for `embedding-upserts` it is a second paid
  embedding call, since the release wipes the very claim row that would have suppressed it.
- **Fix:** Distinguish "heartbeat could not be renewed" (genuine fence loss → release) from
  "shutdown requested" (stop renewing, but if the handler still returns before the lease expires,
  `complete()` and delete normally). The `complete()` call is already conditional on the lease
  still being valid (`idempotency.py:231-236`), so it is safe to attempt.

---

### [SEVERITY: LOW] `consume_enrichment` weighted mode short-polls both lanes at ~10 receives/second per worker

- **File:** `services/workers/messaging/sqs_client.py:732-765`
- **Code:**

```python
handled = consume_once(scheduled, handler, ..., wait_seconds=0, ...)   # :737-745
if handled == 0 and (...):
    handled = consume_once(alternate, handler, ..., wait_seconds=0, ...)  # :752-760
if handled == 0:
    stop_event.wait(0.1)                                               # :763
```

- **Why it's wrong:** `wait_seconds=0` is short polling. On an idle system each worker issues two
  `ReceiveMessage` calls every 100 ms — ~1.7 million billable requests per day per worker, versus
  ~4,300 with the 20-second long poll `consume()` uses by default (`sqs_client.py:671`). It also
  means every replica wakes on the same 100 ms cadence with no jitter. `priority_only` mode
  (`:727`) at least uses `wait_seconds=1`.
- **Fix:** The weighted path is already superseded by D6 — `enrichment/consumers.py:3-9` says the
  enrichment worker now uses plain `consume(ENRICHMENT_DEFAULT_QUEUE, ...)` and only
  `mode="priority_only"` is wired up (`enrichment/onboarding.py:97-104`). Either delete the
  weighted branch as dead code or give it `wait_seconds>=1` plus jittered idle sleep.

---

### [SEVERITY: LOW] `embedding.upsert` idempotency keys are not org-scoped

- **File:** `services/workers/sayre_workers/ingestion/events.py:116-119`
- **Code:**

```python
idempotency_key=(
    f"{task.repository_id}:{task.ref_name}:{task.revision_sha}:"
    f"{task.graph_node_id}:{content_hash}"
),
```

- **Why it's wrong:** Every other key in the system folds in `org_id` — `graph_updated` and
  `onboarding_generate` both build on `graph_scope_key`, which hashes
  `(org_id, repository_id, ref_name)` (`events.py:45-47`). The delivery store's primary key is
  `(consumer_id, idempotency_key)` (`idempotency.py:95`) with no tenant column, so this key's
  uniqueness rests entirely on `repository_id` being globally unique. That holds today, but it
  makes the store's tenant isolation implicit where the rest of the codebase makes it structural.
- **Fix:** Prefix with `task.org_id` (or reuse `graph_scope_key`) for consistency with the other
  two publishers.
