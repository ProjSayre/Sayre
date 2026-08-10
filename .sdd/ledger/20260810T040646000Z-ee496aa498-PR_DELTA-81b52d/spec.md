# W0-04 — SQS + BullMQ wiring (GAPFILL: GAP-3a/4/4a/5)

> **Lane:** `/pipeline-gapfill` (gap-mode). Scoped by `.pipeline/gaps.json`
> (`verdict: "GAPFILL"`, `overlays: ["base"]`, `securityRequired: true`, `auditFirst: false`).
> Only GAP-3a, GAP-4, GAP-4a and GAP-5 are in scope. GAP-1, GAP-2 and GAP-3 are `OK` and are
> listed under **Scope → Out** with their evidence paths — dev must not expand into them
> without a new `GAP-*` id.

---

## Ticket Check

*(Audit-Rebuild framing, cheat sheet §1 base template — `docs/product/Audit-Rebuild-Cheat-Sheet.md`.
This ticket was built during an MVP crunch (Wave 0). The existing implementation is not the source
of truth; the acceptance line is. `gap-scout` has already done the "diff every sentence" pass and
found that the queue **topology** is real and working, but that the ticket's literal Acceptance
line — "cross-language test messages consumed correctly; a priority message demonstrably drains
ahead of a backlog of default messages" — has never been executed as written. What follows is that
leftover delta, not a re-derivation of the messaging fleet. `overlays: ["base"]` only — no
security / interface-contract / spot-check overlay applies. Original Executor was "AI agent", not
Pair/Human, so cheat-sheet §1 item 4 does not apply.)*

**What I'm about to build**
Two things the queue system claims to do but has never actually been proven to do. First: a message
marked "urgent" on the Node side will genuinely jump the line ahead of a pile of ordinary messages
— today the Node queue has no urgent/ordinary distinction at all, so there is nothing to jump the
line with. Second: real tests that push a message from the Python half of the system into the Node
half (and back) through the actual running message broker, and watch it arrive correctly — today
the two halves are only ever tested talking to themselves.

**What I'm explicitly not doing**
Not redesigning, renaming or re-plumbing any queue. The queues, their dead-letter queues, the
fan-out, and the Python-side priority lanes all already exist and work — they stay exactly as they
are. And I am **not** deciding *which* Node jobs deserve to be urgent. I am only building the
urgent/ordinary capability and proving it works; picking winners is a separate, more opinionated
decision for a human, later.

**How you'll know it worked**
Someone can run the test suite (or look at a CI run) and see two named tests that did not exist
before: one that queues 20 ordinary jobs plus 1 urgent job and shows the urgent one came out first,
and one that sends a message from Python to Node through the live broker and shows Node received
exactly what Python sent. Both fail loudly in CI if the broker isn't actually running, rather than
quietly skipping.

**What I had to guess**
Two things. (1) The written ticket in `docs/product/Ticket-Backlog-by-Feature-2.md` and an older,
superseded copy in `docs/backlog.md` say different things — the older copy quietly drops both the
"cross-language" and the "priority drains ahead" requirements, and the tests that exist today match
the *older* one. I am targeting the newer, canonical text, and flagging this rather than silently
picking. (2) To make the Node-side priority guarantee actually true, *every* Node job has to be
tagged with an ordinary-or-urgent level, not just the urgent ones — this is a real (small) change in
how all Node jobs are stored. See Open Questions.

---

## Goal

Close W0-04's literal acceptance line against a live broker: build a real priority mechanism on the
BullMQ (Node) side so a priority job demonstrably drains ahead of a default backlog, and add genuine
cross-language, live-broker round-trip tests (Node→Python and Python→Node) to replace the current
same-language-only round-trips and the single static on-disk fixture.

---

## Scope

### In

- **GAP-3a** — Build the BullMQ priority mechanism: wire a lane/priority concept through
  `enqueue()` in `services/core/src/queue/bullmq.ts`, mirroring what SQS already has as separate
  physical queues. **Human-decided scope, recorded here rather than left as an open question:**
  *wiring the mechanism* is the acceptance-line-closing work. Nothing today marks any specific
  Node-side job as deserving priority, and deciding *which* jobs should pass a priority value is
  explicitly a separate, more opinionated question **not in scope for this run**. Dev must not
  invent a policy for which jobs get which lane — the three existing `enqueue()` call sites
  (`githubWebhookService.ts`, `ticketSyncIngress.ts` ×2) keep the default lane and are otherwise
  untouched. The deliverable is a capability plus a test proving a higher-priority job is dequeued
  before an unprioritized backlog, mirroring the existing SQS-side priority-lane test pattern.
- **GAP-4 / GAP-4a** — Add tests that prove a genuine cross-language round-trip through a live
  broker, in both directions, replacing "two separate same-language round-trips plus one static
  on-disk fixture" as the evidence for "cross-language test messages consumed correctly".
- **GAP-5** — Add tests that prove priority-drain-ahead against a **backlog** on a **live broker**,
  on both fleets (SQS weighted lanes and the new BullMQ lanes).
- CI wiring so all of the above run with **zero broker skips**, matching the existing zero-skip
  gates already in `.github/workflows/ci.yml`.
- Documentation of the new BullMQ lane contract in `docs/wave0-foundation-contracts.md` (which today
  documents only the SQS priority lanes).

### Out — `OK` gaps from `gaps.json` (do not expand into these without a new `GAP-*` id)

| Gap | Finding | Evidence paths (already satisfied) |
|---|---|---|
| **GAP-1** `OK` | Both queues stand up with local equivalents (LocalStack for SQS, Redis for BullMQ) | `infra/docker-compose.yml`, `infra/localstack/init/ready.d/01-create-sqs-queues.sh`, `.github/workflows/ci.yml` |
| **GAP-2** `OK` | Base publisher/consumer wrappers per language | `services/workers/messaging/sqs_client.py`, `services/core/src/queue/bullmq.ts`, `services/workers/messaging/envelope.py`, `services/core/src/queue/envelope.ts`, `services/workers/tests/test_sqs_roundtrip.py`, `services/core/src/queue/__tests__/bullmq.roundtrip.test.ts` |
| **GAP-3** `OK` | A priority-lane mechanism exists (separate physical SQS queues) | `services/workers/messaging/sqs_client.py`, `infra/localstack/init/ready.d/01-create-sqs-queues.sh`, `docs/wave0-foundation-contracts.md` |

Additionally out of scope (topology is real, working infrastructure per gap-scout's audit — this run
is about *proving* the acceptance line, not redesigning anything):

- The FIFO ingestion queue, SNS `graph-updated` fanout, `embedding-upserts`, the two enrichment
  lanes, DLQ/redrive policies, visibility heartbeats, and the durable idempotency/delivery store.
  **None of these change.** No queue is created, renamed, deleted or repurposed.
- The permanent SQS/BullMQ fleet split (`.claude/rules/async-messaging.md`). No new queue system,
  no consolidation, no BullMQ client in Python, no SQS consumer loop in `services/core`.
- The envelope wire contract (`envelope.ts` / `envelope.py`). Both sides stay byte-compatible and
  neither gains or loses a field.
- Deciding *which* Node jobs get the priority lane (see GAP-3a above).
- Any change to `services/gateway/src/sqs/consumer.ts`'s or `services/workers/messaging/`'s
  production behaviour. The cross-runtime tests drive the **existing** production entry points;
  they do not add parallel implementations.

---

## Affected files

### Modified

- `services/core/src/queue/bullmq.ts` — add the lane type/constants and wire BullMQ's native
  `priority` job option through `enqueue()`. **The only production source file this run changes.**
- `services/workers/tests/test_messaging_topology.py` — add the live-broker backlog priority-drain
  test (this file is already broker-gated and already inside CI's zero-skip junit gate, so the new
  test inherits both).
- `services/core/src/queue/__tests__/bullmq.roundtrip.test.ts` — only if an existing assertion
  becomes vacuous under the lane change (see EC-5). Dev must check `getWaitingCount()` usage at
  lines ~391/417; do not otherwise touch this file.
- `services/core/src/queue/__tests__/initialParse.fixture.test.ts` — comment/label correction only
  (AC-8): its header currently reads as though the static fixture *is* the cross-language proof.
- `services/workers/tests/test_initial_parse_wire_fixture.py` — same, docstring only (AC-8).
- `services/workers/tests/test_sqs_roundtrip.py` — docstring only (AC-8): its module docstring cites
  "Acceptance criterion 1 (Python round-trip)", which is `docs/backlog.md`'s superseded reword.
- `.github/workflows/ci.yml` — extend the existing `core messaging — Redis required (zero broker
  skips)` step to include the new BullMQ priority test file; add a cross-runtime step (plus its
  zero-skip junit assertion) to the `workers` job.
- `docs/wave0-foundation-contracts.md` — record the BullMQ lane contract alongside the existing SQS
  priority-lane paragraph (around the "Enrichment has separate physical … queues" bullet).
- `services/core/package.json`, `services/gateway/package.json` — only if a `tsx` harness entry
  script is needed (both already depend on `tsx@4.x`; prefer invoking
  `npx tsx <path>` from the pytest harness over adding a script).

### Created (none of these exist yet)

- `services/core/src/queue/__tests__/bullmq.priority.test.ts` — live-Redis BullMQ priority-drain
  test (GAP-3a, GAP-5). Same broker-probe/`MESSAGING_INTEGRATION_REQUIRED` gating pattern as
  `bullmq.roundtrip.test.ts` lines 187–229.
- `services/workers/tests/test_cross_runtime_roundtrip.py` — the cross-language, live-broker
  round-trip test in both directions (GAP-4, GAP-4a). Pytest is the orchestrator because the
  `workers` CI job is the only job that already has **both** LocalStack and Node 20 + a root
  `npm ci` available (`.github/workflows/ci.yml` lines 357–380).
- `services/core/test/cross-runtime/publishIngestion.ts` — thin `tsx`-runnable harness that calls the
  **real** `publishInitialParseEvent` from `services/core/src/queue/sqs.ts`. No business logic.
- `services/gateway/test/cross-runtime/consumeRealtime.ts` — thin `tsx`-runnable harness that starts
  the **real** `createRealtimeSqsConsumer` from `services/gateway/src/sqs/consumer.ts`. No business
  logic.

---

## Interfaces / signatures

### BullMQ lane API (`services/core/src/queue/bullmq.ts`)

```ts
/** Named lanes, mirroring the SQS split (`enrichment-onboarding-priority` / `enrichment-default`). */
export const JOB_LANES = ['priority', 'default'] as const;
export type JobLane = (typeof JOB_LANES)[number];

/**
 * BullMQ native `priority`: LOWER number = higher priority; the value 0 / undefined means
 * "unprioritized". Both lanes map to a NON-ZERO value on purpose — see the Approach note.
 */
export const LANE_PRIORITY: Readonly<Record<JobLane, number>> = { priority: 1, default: 2 };
export const DEFAULT_JOB_LANE: JobLane = 'default';

export type EnqueueOptions = Omit<JobsOptions, 'priority'> & { lane?: JobLane };

export async function enqueue<Q extends QueueName>(
  name: Q,
  envelope: MessageEnvelope<QueuePayloads[Q]>,
  opts?: EnqueueOptions,
): Promise<string>;
```

Behaviour of `enqueue()`, in order:

1. `assertValidEnvelope(envelope)` — unchanged, still first, before any lane resolution.
2. Resolve `lane = opts?.lane ?? DEFAULT_JOB_LANE`; throw `Error` (message naming the bad value and
   the valid set) if `lane` is not in `JOB_LANES`.
3. Throw `Error` if the caller supplied a raw `priority` key on `opts` (runtime check — TS's `Omit`
   is erased at runtime, and a raw `0`/`undefined` silently defeats the guarantee; see EC-5/EC-6).
4. `queue.add(envelope.type, envelope, { attempts: 1, removeOnComplete: true, ...rest, priority: LANE_PRIORITY[lane] })`
   — `priority` is applied **after** the spread so it cannot be clobbered.
5. Return `job.id ?? ''` — unchanged.

`createWorker`, `getQueue`, `getRedisConnection`, `closeQueues`, `QUEUE_NAMES` and the payload types
are **unchanged**.

### Cross-runtime harnesses (test-only, no business logic)

```ts
// services/core/test/cross-runtime/publishIngestion.ts
// Usage: npx tsx test/cross-runtime/publishIngestion.ts   (envelope JSON on stdin)
// Stdout (single line): {"messageId": "<sqs message id>"}
// Exit 0 on publish; non-zero with the error on stderr otherwise.
```

```ts
// services/gateway/test/cross-runtime/consumeRealtime.ts
// Usage: npx tsx test/cross-runtime/consumeRealtime.ts --queue graph-updated-realtime \
//          --match-idempotency-key <key> --timeout-ms 30000
// Stdout (single line): the received envelope as JSON.
// Exit 0 on match; non-zero on timeout or validation failure, reason on stderr.
```

### Python-side test entry points reused (no signature changes)

- `workers.messaging.sqs_client.consume_once(queue_name, handler, *, consumer_id, delivery_store, wait_seconds, visibility_timeout_seconds, heartbeat_interval_seconds) -> int`
- `workers.messaging.sqs_client.consume_enrichment(handler, *, consumer_id, mode, priority_weight, delivery_store, stop_event, visibility_timeout_seconds) -> None`
- `workers.messaging.sns_client.publish_graph_updated(payload) -> str`
- `sayre_workers.ingestion.parse_ingestion_envelope(envelope)`
- Existing helpers in `test_messaging_topology.py`: `_envelope(**overrides)`, `_drain(queue_name)`,
  `_poll(queue_name, handler, store, count, *, consumer_id, deadline_seconds)`.

---

## Approach

*(Audit-Rebuild base template, in order: diff the implementation against every sentence of the
Acceptance line; list what was stubbed/narrowed; then re-run — or here, write — the literal
acceptance test. Steps 1 and 2 were done by `gap-scout` and are summarised inline below so dev does
not redo them.)*

### 0. Read this before writing any code — the load-bearing BullMQ finding

**BullMQ 5.28 drains the unprioritized `wait` list *completely* before it ever looks at the
`prioritized` set.** Verified in the installed package, not inferred:

- `node_modules/bullmq/dist/cjs/classes/scripts.js:145` — `else if (opts.priority)`: a falsy priority
  (`0` or `undefined`) routes to `addStandardJob`, which `LPUSH`es onto the `wait` list
  (`commands/addStandardJob-8.lua:107-111`). A truthy priority routes to `addPrioritizedJob`, which
  `ZADD`s into the `prioritized` zset with score `priority * 2^32 + counter`
  (`commands/includes/addJobWithPriority.lua:10-12`).
- `commands/moveToActive-11.lua:70-87` — the worker first does `RPOPLPUSH wait → active`, and **only
  if that returns nothing** calls `moveJobFromPriorityToActive` (`ZPOPMIN prioritized`).

Consequence: naively passing `priority` only on the "urgent" job **would not** make it beat a
default backlog — the backlog sits in `wait` and wins. The literal acceptance line is only true if
**every** job `enqueue()` adds carries a non-zero priority, so all jobs live in the same
`prioritized` zset and `ZPOPMIN` ordering (priority value first, then the FIFO tie-break counter)
governs. That is why `LANE_PRIORITY.default` is `2` and not `0`. A red/dev pass that assigns a
priority only to priority-lane jobs will produce a test that fails, or a test that only ever compares
prioritized-vs-prioritized and quietly proves nothing.

### 1. BullMQ lane mechanism (GAP-3a)

- Add `JOB_LANES` / `JobLane` / `LANE_PRIORITY` / `DEFAULT_JOB_LANE` / `EnqueueOptions` to
  `services/core/src/queue/bullmq.ts` exactly as in Interfaces above.
- Extend the module header comment: state that the lane split mirrors the SQS physical-queue split
  per `.claude/rules/async-messaging.md`, that both lanes map to a **non-zero** BullMQ priority
  deliberately (with the `wait`-before-`prioritized` reason), and that no job type is currently
  assigned the priority lane by policy — that is a separate decision.
- Leave the three existing call sites alone. They now enqueue on the default lane implicitly.

### 2. BullMQ priority-drain test (GAP-3a, GAP-5)

- New file `services/core/src/queue/__tests__/bullmq.priority.test.ts`.
- Reuse `bullmq.roundtrip.test.ts`'s broker gating verbatim in spirit: probe Redis; `describe.skipIf`
  locally; hard-throw when `MESSAGING_INTEGRATION_REQUIRED === 'true'`.
- `beforeAll`: `(await getQueue('github-sync')).obliterate({ force: true })`.
- Enqueue **20** default-lane envelopes, then **1** priority-lane envelope. **Only then** create the
  worker, with `{ concurrency: 1 }`. Record `envelope.idempotency_key` in handler order.
- Assert: the priority job is at index `0` of the processed order; all 21 jobs eventually complete;
  the 20 default jobs retain their enqueue order among themselves (EC-2).
- Add a second assertion (or sibling test) that after `enqueue()` and before the worker starts,
  `getWaitingCount() === 0` and `getPrioritizedCount() === 21` — this is what pins AC-2 and stops a
  future regression to `priority: 0` from silently passing.

### 3. SQS backlog priority-drain test (GAP-5)

- Add to `services/workers/tests/test_messaging_topology.py` (broker-gated, already CI-zero-skipped).
- `_drain` both enrichment lanes. Publish **20** default envelopes to `ENRICHMENT_DEFAULT_QUEUE`,
  **then** 1 priority envelope to `ENRICHMENT_PRIORITY_QUEUE` (priority published *after* the
  backlog — EC-8). Unique per-run `idempotency_key`s (EC-15).
- Run `consume_enrichment(..., mode="weighted", priority_weight=3, delivery_store=SqliteDeliveryStore(...))`
  against the **live** broker with **no `monkeypatch` of `consume_once`** — that mock is precisely
  what made the existing coverage not count.
- Assert: the priority envelope appears in the handled sequence at an index `<= 3` (bounded by
  `priority_weight`, i.e. O(1), not O(backlog)), strictly before the backlog is exhausted, and with
  default messages still remaining on the default lane at that moment.
- Then let the loop continue and assert the default backlog still drains to zero (EC-9 — weighted
  fairness must not starve default work, per `docs/wave0-foundation-contracts.md`).

### 4. Cross-language live-broker round-trip (GAP-4, GAP-4a)

New file `services/workers/tests/test_cross_runtime_roundtrip.py`, same LocalStack gating as
`test_messaging_topology.py`. Two directions, both through real production entry points:

- **Node → Python** (`ingestion.fifo`): build a `repo.initial_parse` envelope with a per-run-unique
  `idempotency_key`; pipe it as JSON into
  `npx tsx test/cross-runtime/publishIngestion.ts` (cwd `services/core`) which calls the real
  `publishInitialParseEvent`. Then consume with the real
  `sqs_client.consume_once(INGESTION_QUEUE, ..., delivery_store=SqliteDeliveryStore(...))` and assert
  `MessageEnvelope.from_body` accepts it and `parse_ingestion_envelope` yields the expected
  `org_id` / `ref_name` / `revision_sha` / `installation_id`.
- **Python → Node** (`graph-updated` SNS topic → `graph-updated-realtime`): `_drain` the realtime
  queue, start `npx tsx test/cross-runtime/consumeRealtime.ts` (cwd `services/gateway`) as a
  subprocess with `--match-idempotency-key`, then call the real
  `sns_client.publish_graph_updated(envelope)`. Assert the subprocess exits `0` and its stdout
  envelope is field-for-field equal to what Python published (`org_id`, `type`, `graph_scope_key`,
  `graph_version`, `payload`, `idempotency_key`).
- Subprocess handling: bounded timeout, non-zero exit ⇒ test failure with captured stderr in the
  assertion message (EC-13). Never `except Exception: pass`.

### 5. Correct the superseded-acceptance citations (GAP-4a, AC-8)

Docstring/comment-only edits in the three files named under Affected files: stop citing
`docs/backlog.md`'s reworded "Python→Python SQS roundtrip and Node→Node BullMQ roundtrip" as "the
acceptance criterion", cite `docs/product/Ticket-Backlog-by-Feature-2.md` §W0-04, and point at the
new cross-runtime test as the actual cross-language evidence. The static fixture test is re-labelled
as a **wire-shape regression** test (which is what it is, and it remains valuable), not the
cross-language proof. **No test logic changes in those three files.**

### 6. CI (AC-9)

- `node` job: extend the existing `core messaging — Redis required (zero broker skips)` step's file
  list with `src/queue/__tests__/bullmq.priority.test.ts`.
- `workers` job: add a `Cross-runtime round-trip — LocalStack + Node required (zero skips)` step
  running `poetry run pytest tests/test_cross_runtime_roundtrip.py -q --junitxml=.cross-runtime-junit.xml`
  with the same env block the existing messaging step uses, followed by the same junit
  `skipped == 0` assertion step. LocalStack, Node 20 and root `npm ci` are already present in that
  job (lines 357–380) — do **not** add a LocalStack service to the `node` job.

### 7. Docs

Add the BullMQ lane contract to `docs/wave0-foundation-contracts.md` next to the existing enrichment
priority-lane bullet: two named lanes, both non-zero BullMQ priority values, no job type assigned to
the priority lane by policy yet.

---

## Acceptance criteria

- **AC-1 (GAP-3a)** — `services/core/src/queue/bullmq.ts` exports `JOB_LANES`, `JobLane`,
  `LANE_PRIORITY` and `DEFAULT_JOB_LANE`, and `enqueue()` accepts an optional `lane` option whose
  resolved value is passed to BullMQ as the native `priority` job option on every `queue.add()` call.
- **AC-2 (GAP-3a)** — Every job added through `enqueue()` lands in BullMQ's `prioritized` structure
  and never in the unprioritized `wait` list, for both lanes: after enqueueing N default-lane and M
  priority-lane jobs on a live Redis queue with no worker attached,
  `getWaitingCount() === 0` and `getPrioritizedCount() === N + M`.
- **AC-3 (GAP-3a)** — `enqueue()` throws (adding nothing to the queue) when given an unknown `lane`
  value, and throws when the caller supplies a raw `priority` key on `opts`, with an error message
  naming `lane` as the supported mechanism.
- **AC-4 (GAP-3a, GAP-5)** — Against a live Redis broker: with 20 default-lane jobs enqueued first,
  then 1 priority-lane job, and only then a worker started at `concurrency: 1`, the priority-lane job
  is the **first** job processed, and all 21 jobs subsequently complete.
- **AC-5 (GAP-5)** — Against a live LocalStack SQS broker, with **no mocking of `consume_once`**:
  with 20 envelopes on `enrichment-default` and 1 published afterwards to
  `enrichment-onboarding-priority`, `consume_enrichment(mode="weighted", priority_weight=3)` handles
  the priority envelope at an index bounded by `priority_weight` (`<= 3`) in the handled sequence,
  strictly before the default backlog is exhausted, and the default backlog still drains to zero
  afterwards.
- **AC-6 (GAP-4, GAP-4a)** — Node→Python, live broker: an envelope published by
  `services/core/src/queue/sqs.ts`'s real `publishInitialParseEvent` onto `ingestion.fifo` is received
  and accepted by the real Python `sqs_client.consume_once` +
  `MessageEnvelope.from_body` + `parse_ingestion_envelope`, with `org_id`, `ref_name`,
  `revision_sha` and `installation_id` matching what Node sent. No on-disk fixture is read.
- **AC-7 (GAP-4, GAP-4a)** — Python→Node, live broker: an envelope published by the real Python
  `sns_client.publish_graph_updated` to the `graph-updated` SNS topic is received off
  `graph-updated-realtime` by the real Node `createRealtimeSqsConsumer`, passes `assertValidEnvelope`,
  and is field-for-field equal (`org_id`, `type`, `graph_scope_key`, `graph_version`, `payload`,
  `idempotency_key`) to what Python published.
- **AC-8 (GAP-4a)** — `services/core/src/queue/__tests__/initialParse.fixture.test.ts`,
  `services/workers/tests/test_initial_parse_wire_fixture.py` and
  `services/workers/tests/test_sqs_roundtrip.py` no longer describe themselves as satisfying W0-04's
  acceptance criterion; each cites `docs/product/Ticket-Backlog-by-Feature-2.md` §W0-04 as canonical,
  names `docs/backlog.md` as the superseded reword, and points at the new cross-runtime test as the
  cross-language evidence. Their test logic is unchanged and still passes.
- **AC-9 (GAP-4, GAP-5)** — `.github/workflows/ci.yml` runs every new test with a zero-skip gate: the
  BullMQ priority test is added to the existing Redis-required step, and the cross-runtime test runs
  in the `workers` job under a junit `skipped == 0` assertion identical in form to the existing
  messaging and graph-migration gates.
- **AC-10 (GAP-3a)** — `docs/wave0-foundation-contracts.md` records the BullMQ lane contract
  (two named lanes, both mapped to non-zero BullMQ priority values, no job type assigned to the
  priority lane by policy) alongside the existing SQS enrichment-lane paragraph.

---

## Edge cases

- **EC-1 (GAP-3a)** — `lane` omitted: `enqueue()` resolves `DEFAULT_JOB_LANE`. The three existing
  call sites (`githubWebhookService.ts:83`, `ticketSyncIngress.ts:23`, `ticketSyncIngress.ts:25`)
  compile and behave identically apart from lane placement, and are not edited.
- **EC-2 (GAP-3a)** — FIFO within a lane is preserved: two default-lane jobs enqueued in order are
  processed in that order (BullMQ's `prioCounter` tie-break), and likewise for two priority-lane jobs.
  Lane priority must not degenerate into arbitrary reordering of same-lane work.
- **EC-3 (GAP-3a)** — Unknown/invalid `lane` (e.g. `'urgent'`, `''`, `null`, a number) throws and
  adds nothing: the queue's job count is unchanged after the rejected call.
- **EC-4 (GAP-3a)** — Rollout state: jobs already sitting in the `wait` list from a pre-change deploy
  will still drain ahead of any prioritized job until `wait` empties. This is documented in the
  module header, **not** fixed (draining/migrating an in-flight queue is out of scope) — but it must
  be stated, because it is the one window in which AC-4's guarantee does not hold.
- **EC-5 (GAP-3a)** — Any existing assertion that counts queued jobs via `getWaitingCount()` becomes
  structurally vacuous under this change. `bullmq.roundtrip.test.ts`'s "enqueue rejects an envelope
  with empty org_id and adds nothing" (lines ~390–419) compares before/after and still passes because
  the rejected call adds nothing either way — but dev must confirm this rather than assume it, and
  any *new* count-based assertion must use `getPrioritizedCount()`.
- **EC-6 (GAP-3a)** — `assertValidEnvelope` still runs **before** lane resolution: an invalid envelope
  is rejected identically on the priority lane and the default lane, and nothing is added.
- **EC-7 (GAP-5, BullMQ)** — Worker-start ordering: if the worker is attached before the backlog is
  fully enqueued it will drain jobs as they arrive and the ordering assertion becomes meaningless.
  The test must enqueue all 21 jobs first and use `concurrency: 1`.
- **EC-8 (GAP-5, SQS)** — The priority message is published **after** the entire default backlog, so
  a pass cannot be an artifact of publish order.
- **EC-9 (GAP-5, SQS)** — Weighted mode must not starve the default lane: after the priority envelope
  is handled, the 20-message default backlog still drains to zero within the test's deadline.
- **EC-10 (GAP-4/4a)** — Cross-language malformed input: a body written by one runtime that fails the
  other runtime's validator is rejected **and left on the queue** (not deleted), matching the existing
  same-language behaviour in `test_sqs_roundtrip.py::test_invalid_message_is_not_deleted` and
  `consumer.ts`'s redrive path.
- **EC-11 (GAP-4/4a)** — Tenant context survives the crossing: `org_id` is byte-identical on both
  sides, and a cross-language message with a blank `org_id` is rejected by the consuming runtime
  (`MessageEnvelope` min_length / `assertValidEnvelope`), never silently defaulted.
- **EC-12 (GAP-4/4a, GAP-5)** — Broker unreachable: every new integration test skips quietly for an
  ordinary local run and **hard-fails** under `MESSAGING_INTEGRATION_REQUIRED=true`, matching the
  existing pattern. A skipped run must never read as a pass in CI.
- **EC-13 (GAP-4/4a)** — Subprocess failure modes: a non-zero exit, a crash, a timeout, or unparseable
  stdout from either `tsx` harness fails the pytest test with the captured stderr in the message.
  No bare `except`, no default-to-pass.
- **EC-14 (GAP-4/4a)** — FIFO deduplication: `ingestion.fifo` has a 5-minute dedup window keyed on the
  hashed `idempotency_key`. The test must use a per-run-unique key, or a rerun within 5 minutes is
  silently swallowed and the test hangs/fails confusingly.
- **EC-15 (GAP-4/4a, GAP-5)** — Test isolation: every new test drains its queues first **and** matches
  on a per-run-unique marker, so a leftover message from another suite can never satisfy an assertion.
  Both enrichment lanes and `graph-updated-realtime` are shared with `test_messaging_topology.py`.
- **EC-16 (GAP-4/4a)** — Node harness environment: the harnesses resolve config/secrets through
  `@sayre/config` exactly like production (`SQS_ENDPOINT_URL`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`,
  `AWS_SECRET_ACCESS_KEY`). The pytest orchestrator must pass those through to the subprocess env; a
  missing one must surface as a clear failure, not as a silent fall-through to real AWS.
- **EC-17 (GAP-4/4a)** — Concurrent/partial failure: if the Node consumer harness is killed after
  receiving but before deleting, the message is redelivered (at-least-once) rather than lost. The
  test's cleanup must not leave the shared realtime queue holding an unconsumed marker message for a
  later suite.

---

## Open questions

1. **Two documents disagree about W0-04's acceptance criterion, and the current tests implement the
   wrong one.** `docs/product/Ticket-Backlog-by-Feature-2.md:40` (canonical) reads: *"cross-language
   test messages consumed correctly; a priority message demonstrably drains ahead of a backlog of
   default messages."* `docs/backlog.md:45` — a file explicitly marked superseded / "do not use for
   current scope" — reads: *"Python→Python SQS roundtrip and Node→Node BullMQ roundtrip proven by
   local integration tests,"* dropping **both** the cross-language and the priority-drain
   requirements. The current test suite implements the superseded reword: `test_sqs_roundtrip.py`'s
   docstring cites "Acceptance criterion 1 (Python round-trip)" and
   `bullmq.roundtrip.test.ts`'s cites "Acceptance criterion 9 (Node round-trip)" — both citing the
   wrong document while presenting themselves as the acceptance proof. **This spec targets the
   canonical text** (which is exactly what GAP-4/4a/5 encode), and AC-8 corrects the citations. Flagged
   here rather than silently resolved so review and dev both know the existing docstrings are
   authoritative-sounding but wrong. *Needs a human only if someone believes `docs/backlog.md` should
   be canonical after all — in which case GAP-4/4a/5 largely evaporate and this run should stop.*
2. **All Node jobs move from the `wait` list into the `prioritized` zset.** This is forced by BullMQ
   5.28's `moveToActive` semantics (Approach §0) — it is the only design under which the acceptance
   line is true. BullMQ's own docs note that priority carries a slight performance cost, and this
   applies it to 100% of Node integration jobs rather than a subset. Volume is currently tiny
   (webhook-driven GitHub/Jira/Linear sync), so this is almost certainly fine, but it is a real
   production behaviour change to a shared queue and someone may want to say so out loud before merge.
   *Dev should proceed as specified; this is a flag for review, not a blocker.*
3. **Which Node jobs should actually use the priority lane is deliberately unanswered.** Recorded here
   per the human decision noted in Scope → In: this run builds and proves the capability only. A
   follow-up ticket should decide policy (the obvious candidates — cold-start/onboarding-adjacent work
   — are Python-fleet concerns today, which is part of why nothing on the Node side needs it yet).
   Dev must not invent a policy.
4. **Lane vocabulary vs. raw numbers.** This spec exposes named lanes (`'priority' | 'default'`) and
   forbids a raw `priority` in `opts`, so a caller cannot accidentally pass `0` and silently drop back
   into the `wait` list. If a future job type genuinely needs finer gradation than two lanes, that is
   an additive change to `JOB_LANES`/`LANE_PRIORITY`, not a reason to expose the raw integer now.
   *Noted, not blocking.*
5. **Ticket lane (`spec.json.lane`) is `null`.** W0-04 is a backlog ticket re-fed through
   `/pipeline-gapfill`, not filed through `.github/ISSUE_TEMPLATE/pipeline-ticket.yml`, so it declares
   no lane. Recorded as absent rather than guessed.
