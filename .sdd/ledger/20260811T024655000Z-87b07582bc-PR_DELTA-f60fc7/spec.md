# W1-05 — Ingestion/Delta Worker core (gap-fill)

> **Gap-mode run.** `.pipeline/gaps.json` has `verdict: "GAPFILL"` for W1-05.
> Overlays: `base`. `securityRequired: true`. `auditFirst: false`. Lane: `gapfill`.
> Every `AC-*`/`EC-*` below maps to a `GAP-*` whose status is **not** `OK`.
> The five `OK` gaps are listed under "Scope → Out of scope / already satisfied" and must not be
> re-implemented or re-tested.

---

## Ticket Check

**What I'm about to build**
Two fixes and a set of real proofs for the part of the product that reads a connected GitHub
repository and turns it into the graph the app draws. The fixes stop a deleted or newly-created
branch from jamming the ingestion pipeline for that repository — today, deleting a branch can wedge
a repo's updates so no further pushes for that branch ever get processed. The proofs are tests that
actually run against a real database, a real graph store, and a real git repository, instead of
stand-ins.

**What I'm explicitly not doing**
I am not changing how code is parsed, how the graph is shaped, how the scratch clone is cleaned up,
or how a first-time ("cold start") repository import works — all of those were checked and are
already correct. I am also **not** deleting anything from the graph when a branch is deleted. Today
a deleted branch's old data lingers in the graph; it will still linger after this change. Cleaning
that up destroys data, so I am deliberately leaving it for a separate, dedicated ticket rather than
sneaking a destructive delete into a gap-fill.

**How you'll know it worked**
Delete a branch in a connected GitHub repository, then push a new commit to the main branch of that
same repository. Before this change, the second step could silently never appear in the app. After
this change, the push shows up in the app as normal, and the branch deletion is recorded as
"acknowledged, nothing to do" in the worker's logs rather than as a repeated failure. Separately,
pushing to a test repository and watching the graph update within roughly fifteen seconds is now
something a test proves end to end, rather than something we assumed.

**What I had to guess**
Three judgement calls, and one of them genuinely needs a human to agree with me:
1. **Where to fix the jam.** I chose to fix it in *both* places: stop sending branch create/delete
   notifications to the ingestion pipeline in the first place, *and* teach the worker to recognise
   and safely discard them if one arrives anyway. Fixing only the sender would leave messages
   already sitting in the queue during a deploy still able to jam it.
2. **Discard vs. clean up.** When a branch is deleted, I chose "recognise it and move on" over
   "recognise it and delete that branch's data from the graph." The second is arguably more correct
   but is destructive and unspecified by this ticket. **This is the item I'd want a human to sign
   off on** — see Open Questions Q-1.
3. **The "sync target" number.** The ticket says a graph update should arrive "within the sync
   target" but never states the number anywhere enforceable. I pinned it at 15 seconds, matching the
   only place it is written down today (a prose sentence in the provider-settings service).

---

## Goal

Close the seven non-`OK` items in `.pipeline/gaps.json` for W1-05: eliminate the `repo.branch` /
branch-deletion-push poison-message path that head-of-line blocks a tenant's ingestion FIFO group
(GAP-8, GAP-9), pin the Core↔worker push wire contract with a committed envelope fixture (GAP-10),
and replace the four fake-driven "we assume this works" coverage holes with real-infra and
real-git proofs of the ticket's literal Acceptance sentence (GAP-3, GAP-4, GAP-5, GAP-11, GAP-12).

---

## Scope

### In scope

- **Behavior fix (GAP-8):** Core stops routing GitHub `create`/`delete` branch events to the
  ingestion queue; they remain routed to ownership.
- **Behavior fix (GAP-8/GAP-9):** the worker gains an explicit, enumerated terminal classification
  for ingestion-queue messages it knows it must not parse (`repo.branch`, and a `repo.push` that is
  a branch deletion), so those deliveries are **acknowledged** instead of raising and being
  redelivered until DLQ. Genuinely unknown/malformed messages still raise (fail-loud preserved).
- **Contract test (GAP-10):** committed `repo.push` and branch-deletion envelope fixtures owned by
  Core, pinned on the Core side and consumed by a Python wire-fixture test.
- **Real-infra tests (GAP-3, GAP-4):** skip-gated integration suites that execute
  `Neo4jGraphStore.apply` against a real Cypher engine and `PostgresChunkStore` against a real
  Postgres/pgvector.
- **Envelope test (GAP-5):** direct assertions on the real `MessagingPublisher.graph_updated`
  envelope.
- **Acceptance tests (GAP-11, GAP-12):** a real fixture git repo (commit A → commit B) driven
  through `IngestionService`, asserting the resulting nodes/edges and that a real `graph.updated`
  is published inside a named structural sync budget.

### Out of scope — already satisfied (`status: OK` in gaps.json; do not re-spec or re-test)

| Gap | What it covers | Evidence (from `.pipeline/gaps.md`) |
|---|---|---|
| **GAP-1** | Clones/diffs a repo | `services/workers/sayre_workers/ingestion/repository.py` (`GitRepositorySource.checkout`, `GitSnapshot.changed_paths`), `services/workers/sayre_workers/ingestion/service.py:78-95` (ancestry gate), `services/workers/tests/test_ingestion.py:707` |
| **GAP-2** | Runs Tree-sitter | `services/workers/sayre_workers/parsing/parser.py:21`, `services/workers/tests/fixtures/parsing/`, `services/workers/tests/test_parsing.py`, called at `services/workers/sayre_workers/ingestion/service.py:101,109` |
| **GAP-6** | Scratch clone destroyed after parsing | `services/workers/sayre_workers/ingestion/repository.py:562-617` (`finally` cleanup), `services/workers/tests/test_ingestion.py:707-735`, ordering assertion at `:504` |
| **GAP-7** | Handles `repo.initial_parse` (cold start) | `services/workers/sayre_workers/ingestion/models.py:205`, `service.py:82,150-156`, `services/workers/tests/test_ingestion.py:482-505`, `services/workers/tests/test_initial_parse_wire_fixture.py`, `services/core/src/queue/__fixtures__/repo_initial_parse.envelope.json` |
| **GAP-13** | `repo.initial_parse` triggers the full-parse path | `services/workers/tests/test_ingestion.py:482-505`, `services/workers/tests/test_initial_parse_wire_fixture.py:24`, `services/workers/sayre_workers/ingestion/service.py` |

Dev must not expand into any of the above without a new gap id.

### Explicitly out of scope (deferred, with reasons)

- **Destructive ref teardown on branch deletion** — removing the deleted ref's Folder/File/Function/
  Class/Test projection, its `code_chunks`/`code_embeddings` rows, and its `repository_refs` state.
  See Open Question Q-1. This is a new, destructive, multi-store capability that the W1-05 ticket
  sentence does not ask for; landing it inside a gap-fill would be scope creep on a data-deleting
  path.
- Changing the parser, the projection builder, the Cypher shapes themselves, the scratch-clone
  hardening, `--depth`/repo-size bounding on `git fetch` (noted in GAP-12's evidence as *related*,
  not as the gap), or any Neptune-portability rework.
- Alerting/telemetry gating on the sync budget. This spec adds the budget **constant** and asserts
  against it in tests; it does not add a runtime SLO alarm.
- Any change to the ownership (BullMQ) consumers.

---

## Affected files

### Modified — Core (Node/TypeScript)

| Path | Change |
|---|---|
| `services/core/src/webhooks/normalizeGithubEvent.ts` | `create`/`delete` branch case: `destinations = ['ownership']` (was `['ingestion', 'ownership']`). Add a comment citing GAP-8. |
| `services/core/src/webhooks/normalizeGithubEvent.test.ts` | Update the two branch cases (`:156`, `:174`) which currently assert ingestion+ownership. |
| `services/core/src/routes/githubWebhook.fixtures.test.ts` | Update `branch.create.json` / `branch.delete.json` routing expectations (`:191-227`); add the envelope-fixture pinning tests for AC-4. |

### Created — Core (Node/TypeScript)

| Path | Purpose |
|---|---|
| `services/core/src/queue/__fixtures__/repo_push.envelope.json` | Committed `repo.push` ingestion envelope, sibling of the existing `repo_initial_parse.envelope.json`. |
| `services/core/src/queue/__fixtures__/repo_push.branch-deletion.envelope.json` | Committed branch-deletion (`deleted: true`, all-zero `after`) ingestion envelope. |

### Modified — workers (Python)

| Path | Change |
|---|---|
| `services/workers/sayre_workers/ingestion/models.py` | Add `IngestionCommand` union + `classify_ingestion_envelope`; extend `IngestionResult.status`. `parse_ingestion_envelope` retained (see Interfaces). |
| `services/workers/sayre_workers/ingestion/service.py` | `IngestionService.handle` dispatches on the classification result instead of calling `parse_ingestion_envelope` directly; new terminal-ack branches; assert against the sync budget constant is *not* added to production code (tests only). |
| `services/workers/sayre_workers/ingestion/__init__.py` | Re-export `classify_ingestion_envelope`, `IngestionCommand`, `RefDeletionCommand`, `IgnoredIngestionMessage`, `STRUCTURAL_SYNC_TARGET_MS`. |

### Created — workers (Python)

| Path | Purpose |
|---|---|
| `services/workers/sayre_workers/ingestion/budgets.py` | The one named structural sync-target constant (GAP-12). |
| `services/workers/tests/test_ingestion_routing.py` | GAP-8/GAP-9 behavioral tests (classification + terminal-ack + no-checkout). |
| `services/workers/tests/test_push_wire_fixture.py` | GAP-10 cross-surface wire-fixture test (mirrors `test_initial_parse_wire_fixture.py`). |
| `services/workers/tests/test_ingestion_graph_integration.py` | GAP-3 real-Neo4j suite (skip-gated). |
| `services/workers/tests/test_chunk_store_integration.py` | GAP-4 real-Postgres/pgvector suite (skip-gated). |
| `services/workers/tests/test_graph_updated_envelope.py` | GAP-5 real `MessagingPublisher.graph_updated` envelope assertions. |
| `services/workers/tests/test_ingestion_fixture_repo.py` | GAP-11/GAP-12 real-git end-to-end acceptance suite. |

### Read-only reference (not modified)

`services/workers/sayre_workers/ingestion/graph.py`, `.../chunks.py`, `.../events.py`,
`.../repository.py`, `services/workers/messaging/sqs_client.py`, `services/core/src/queue/sqs.ts`,
`services/core/src/services/githubWebhookService.ts`,
`services/core/src/webhooks/__fixtures__/push.json`,
`services/core/src/webhooks/__fixtures__/push.branch-deletion.json`,
`services/workers/tests/test_onboarding_priority.py`,
`services/workers/tests/test_initial_parse_wire_fixture.py`,
`services/workers/tests/test_tenant_isolation.py`,
`services/workers/tests/test_graph_migrations.py`.

---

## Interfaces / signatures

### 1. Core routing (`services/core/src/webhooks/normalizeGithubEvent.ts`)

The `case 'create': case 'delete':` arm, currently at lines 193–205, changes exactly one line:

```ts
      type = 'branch';
      ref = `refs/heads/${branchName}`;
      payload = normalizeBranch(githubEvent, parsed);
      // GAP-8: a branch create/delete carries no revision SHA — there is nothing for the
      // ingestion worker to fetch or parse, and `repo.branch` has no handler on the Python
      // fleet. Routing it to the FIFO ingestion queue produced a permanently-failing
      // delivery that head-of-line blocked every later delta for the same
      // (org, repo, ref) group. Real content always arrives as a separate `push`.
      destinations = ['ownership'];
      break;
```

No other Core signature changes. `NormalizationResult`, `RepoEventType`, and the `repo.branch`
envelope type in `@sayre/shared-types` are all left intact — a `repo.branch` envelope is still a
legal shape, it is simply no longer published to ingestion.

### 2. Worker classification (`services/workers/sayre_workers/ingestion/models.py`)

New, additive. `parse_ingestion_envelope` keeps its exact current signature and behavior (it is
public API re-exported from `sayre_workers.ingestion` and is used by
`test_initial_parse_wire_fixture.py` and `test_repository_credential_binding.py`); the new
classifier wraps it.

```python
@dataclass(frozen=True)
class RefDeletionCommand:
    """A webhook signal that a ref no longer exists. Terminal: acknowledged, never parsed."""
    org_id: str
    repository: RepositoryLocator
    ref_name: str
    previous_revision_sha: str | None
    occurred_at: datetime
    trace_id: str | None
    idempotency_key: str


@dataclass(frozen=True)
class IgnoredIngestionMessage:
    """A message type known to be non-actionable for ingestion. Terminal: acknowledged."""
    message_type: str
    reason: Literal["branch_lifecycle_event", "ref_deleted"]


IngestionCommand = IngestionJob | RefDeletionCommand | IgnoredIngestionMessage

# Envelope types that may legitimately arrive on the ingestion FIFO queue but that this
# worker deliberately does not parse. Anything OUTSIDE this set and outside the handled
# set still raises InvalidIngestionJobError — an unknown type must fail loudly rather
# than be silently swallowed.
TERMINAL_IGNORED_TYPES: frozenset[str] = frozenset({"repo.branch"})

_ZERO_SHA = re.compile(r"^0{40,64}$")


def classify_ingestion_envelope(envelope: MessageEnvelope) -> IngestionCommand:
    """Terminal classification for every delivery on the ingestion queue.

    Returns an IngestionJob for work to perform, a RefDeletionCommand for a ref that no
    longer exists, or an IgnoredIngestionMessage for a known non-actionable type. Raises
    InvalidIngestionJobError only for genuinely unknown or malformed input.
    """
```

Classification rules, in order:

1. `envelope.type in TERMINAL_IGNORED_TYPES` → `IgnoredIngestionMessage(message_type=envelope.type,
   reason="branch_lifecycle_event")`. Never touches `envelope.payload` beyond the type check.
2. `envelope.type == "repo.push"` and the push is a **branch deletion** →
   `RefDeletionCommand(...)`. A push is a branch deletion when **either**
   `payload.payload.deleted is True` **or** `payload.payload.after` matches `_ZERO_SHA`.
   `previous_revision_sha` is `payload.payload.before` when it is a valid non-zero SHA, else `None`.
   `ref_name`/`repository` are extracted with the same helpers `parse_ingestion_envelope` already
   uses, so a malformed deletion push still raises `InvalidIngestionJobError`.
   `payload.payload.deleted`, if present, must be a `bool`, else `InvalidIngestionJobError`
   (mirrors the existing `forced` check at `models.py:232-233`).
3. `envelope.type in {"repo.initial_parse", "repo.push"}` → delegate to
   `parse_ingestion_envelope(envelope)` unchanged.
4. Otherwise → `raise InvalidIngestionJobError("unsupported ingestion message type")` (unchanged
   message, so any existing assertion on it keeps passing).

`parse_ingestion_envelope` itself additionally gains one guard: a `repo.push` whose `after` matches
`_ZERO_SHA` raises `InvalidIngestionJobError("branch-deletion push must be classified, not parsed")`.
This is a defence-in-depth assertion that no caller can route an all-zero SHA into the checkout
path; `classify_ingestion_envelope` is the only supported entry point for the consumer.

### 3. `IngestionResult` status widening (`models.py:167`)

```python
    status: Literal["accepted", "replayed", "stale", "ref_deleted", "ignored"]
```

`revision_sha` for the two new statuses is the envelope's `after` value as received (all-zero for a
deletion push) or `""` for an ignored message; `graph_version` is `None`; `full_rebuild` is `False`.

### 4. Service dispatch (`services/workers/sayre_workers/ingestion/service.py`)

`IngestionService.handle` keeps its signature — `async def handle(self, envelope: MessageEnvelope)
-> IngestionResult` — and gains a prologue before any other work:

```python
    async def handle(self, envelope: MessageEnvelope) -> IngestionResult:
        command = classify_ingestion_envelope(envelope)
        if isinstance(command, IgnoredIngestionMessage):
            logger.info(
                "Ingestion message acknowledged without work: type=%s reason=%s",
                command.message_type, command.reason,
            )
            return IngestionResult(
                status="ignored", revision_sha="", graph_version=None, full_rebuild=False,
            )
        if isinstance(command, RefDeletionCommand):
            logger.info(
                "Ref deletion acknowledged without projection teardown (see spec Q-1): ref=%s",
                command.ref_name,
            )
            return IngestionResult(
                status="ref_deleted", revision_sha="", graph_version=None, full_rebuild=False,
            )
        job = command
        ...  # existing body, unchanged from the current line 61 onward
```

Both new branches return **normally**, which is what makes `messaging/sqs_client.py:630-645` treat
the delivery as handled and call `delete_message` — the fix for the head-of-line block. Neither
branch acquires the ref-state lock, mints a credential, or calls `RepositorySource.checkout`.
A module-level `logger = logging.getLogger(__name__)` is added.

### 5. Sync budget (`services/workers/sayre_workers/ingestion/budgets.py`, new)

```python
"""Named structural-sync budget for W1-05's Acceptance sentence.

The 15-second figure previously existed only as prose in
services/core/src/services/providerSettingsService.ts:48 ("...never the 15-second
structural-sync target") and in .claude/rules/async-messaging.md. This is the single
Python-side binding of that number, so a test can assert against a constant rather
than a magic literal.
"""

STRUCTURAL_SYNC_TARGET_MS: int = 15_000
```

### 6. Committed Core envelope fixtures

`services/core/src/queue/__fixtures__/repo_push.envelope.json` — same top-level shape as the
existing `repo_initial_parse.envelope.json` (a serialized `MessageEnvelope`), with:

```
type: "repo.push"
source: "github-webhook"
org_id: "22222222-2222-4222-8222-222222222222"   (same tenant id the sibling fixture uses)
payload: {
  provider: "github",
  type: "push",
  repo: { provider_repo_id: "583231", full_name: "acme-corp/widgets", repo_id: null },
  ref: "refs/heads/main",
  installation_id: "555",
  delivery_id: "...",
  payload: { before: "<40-hex>", after: "<40-hex>", forced: false, deleted: false,
             ref: "refs/heads/main", commits: [...], pusher: {...} }
}
```

`repo_push.branch-deletion.envelope.json` — identical shape, derived from
`services/core/src/webhooks/__fixtures__/push.branch-deletion.json`, with
`payload.ref: "refs/heads/feature-x"`, `payload.payload.deleted: true`, and
`payload.payload.after: "0000000000000000000000000000000000000000"`.

Both fixture bodies must be **exactly** what `normalizeGithubEvent` + `makeEnvelope` produce for the
corresponding raw fixture — the Core pinning test in AC-4 is what enforces that.

### 7. Neo4j integration store handle (test-only)

No production signature change. The GAP-3 suite constructs
`Neo4jGraphStore(neo4j.AsyncGraphDatabase.driver(uri, auth=(user, password)))` directly and calls
the existing `async def apply(self, projection: GraphProjection) -> None` and
`async def load_symbols(self, scope: GraphScope) -> tuple[SymbolRef, ...]`.

---

## Approach

Build in this order — the behavior fix first, so the new tests have something real to assert.

1. **`budgets.py`** — trivial, unblocks GAP-12's test.
2. **`models.py`** — add `RefDeletionCommand`, `IgnoredIngestionMessage`, `IngestionCommand`,
   `TERMINAL_IGNORED_TYPES`, `_ZERO_SHA`, `classify_ingestion_envelope`; widen
   `IngestionResult.status`; add the all-zero-SHA guard inside `parse_ingestion_envelope`.
3. **`service.py`** — swap `parse_ingestion_envelope` for `classify_ingestion_envelope` and add the
   two terminal-ack branches. Nothing else in `handle` moves.
4. **`__init__.py`** — re-export the new names alphabetically into `__all__`.
5. **`normalizeGithubEvent.ts`** — the one-line `destinations` change plus the citing comment.
6. **Core test updates** — `normalizeGithubEvent.test.ts` (`:156`, `:174`) and
   `githubWebhook.fixtures.test.ts` (`:191-227`) now expect ownership-only for branch create/delete.
   Read them before editing; the existing assertions pin the *old* buggy behavior and must be
   changed deliberately, not deleted.
7. **Core envelope fixtures + pinning test** — generate the two fixtures from the raw webhook
   fixtures by running the normalizer, then add the AC-4 Core-side test that replays the raw fixture
   and deep-compares the published ingestion envelope against the committed file, ignoring only the
   volatile fields (`message_id`, `occurred_at`; `trace_id`/`idempotency_key` are the delivery id,
   which the raw fixture pins, so those **are** compared).
8. **Python tests**, in this order: `test_ingestion_routing.py` (GAP-8/9),
   `test_push_wire_fixture.py` (GAP-10), `test_graph_updated_envelope.py` (GAP-5),
   `test_ingestion_fixture_repo.py` (GAP-11/12), then the two skip-gated real-infra suites
   `test_ingestion_graph_integration.py` (GAP-3) and `test_chunk_store_integration.py` (GAP-4).
9. **Verification**: `npx tsc --noEmit`, `npm run test` (Core), `poetry run pytest` from
   `services/workers/`, `npm run lint`.

### Skip-gating convention for the two real-infra suites (GAP-3, GAP-4)

Follow the established in-repo precedent exactly — do **not** invent a new mechanism:

- Neo4j: mirror `services/workers/tests/test_graph_migrations.py:820-846` — a
  `functools.lru_cache(maxsize=1)` reachability probe that calls `driver.verify_connectivity()`
  inside a `try/except` and a module-level
  `pytestmark = pytest.mark.skipif(not _neo4j_reachable(), reason=...)`.
- Postgres: mirror `services/workers/tests/test_tenant_isolation.py:55-79` — resolve
  `DATABASE_ADMIN_URL` through `sayre_workers.config.get_secret`, probe with
  `psycopg.connect(url, connect_timeout=2)`, module-level `pytestmark = pytest.mark.skipif(...)`.
- Both suites seed a fresh random-UUID org per test and clean up in a `finally` (Postgres via
  `ON DELETE CASCADE` from `organizations`; Neo4j via an org-scoped `DETACH DELETE` of every node
  carrying the test org's `org_id`), so repeated runs never collide and never leave residue in a
  shared dev store. A machine with no infra must still see `poetry run pytest` pass green.

---

## Acceptance criteria

- **AC-1 (GAP-8)** — `normalizeGithubEvent` returns `destinations: ['ownership']` (ingestion
  excluded) for a GitHub `create` **and** for a GitHub `delete` event with `ref_type: 'branch'`; the
  normalized `event.type` stays `'branch'`, `event.ref` stays `refs/heads/<name>`, and `event.payload`
  is unchanged (`{ action, ref, ref_type }`). Replaying `branch.create.json` / `branch.delete.json`
  through `POST /webhooks/github` returns 202, calls the ownership enqueue exactly once, and calls
  `publishIngestionEvent` **zero** times.
- **AC-2 (GAP-8)** — `classify_ingestion_envelope` returns
  `IgnoredIngestionMessage(message_type="repo.branch", reason="branch_lifecycle_event")` for a
  `repo.branch` envelope (both `action: "created"` and `action: "deleted"`), and
  `IngestionService.handle` returns `IngestionResult(status="ignored")` **without raising** and
  without invoking `RefStateStore.lock` or `RepositorySource.checkout`. A returning `handle` is what
  makes the SQS consumer delete the message, so the delivery no longer redelivers into
  `ingestion-dlq.fifo` nor blocks its FIFO group.
- **AC-3 (GAP-9)** — a `repo.push` envelope whose `payload.payload.deleted` is `true` **or** whose
  `payload.payload.after` is an all-zero SHA classifies as `RefDeletionCommand` carrying the
  envelope's server-resolved `org_id`, the repository locator, `ref_name`, and `previous_revision_sha`
  from `before`; `IngestionService.handle` returns `IngestionResult(status="ref_deleted")` without
  raising, without acquiring the ref lock, and without calling `RepositorySource.checkout`. Calling
  `parse_ingestion_envelope` directly on such an envelope raises `InvalidIngestionJobError`.
- **AC-4 (GAP-10)** — Core commits `services/core/src/queue/__fixtures__/repo_push.envelope.json`
  and `repo_push.branch-deletion.envelope.json`; a Core test replays the corresponding raw fixture
  through the webhook route and asserts the envelope handed to `publishIngestionEvent` matches the
  committed file field-for-field (excluding only `message_id` and `occurred_at`); and
  `services/workers/tests/test_push_wire_fixture.py` loads both committed files via
  `MessageEnvelope.from_body` and asserts `classify_ingestion_envelope` yields an `IngestionJob`
  with `kind == "delta"`, the fixture's `org_id`/`ref_name`/`revision_sha`/`installation_id` for the
  first, and a `RefDeletionCommand` for the second. A change to Core's normalizer that drifts the
  wire shape fails on both sides.
- **AC-5 (GAP-3)** — `services/workers/tests/test_ingestion_graph_integration.py` executes
  `Neo4jGraphStore.apply` against a real Cypher engine and proves, by reading the graph back, that:
  a full-rebuild projection lands every Folder/File/Function/Class/Test node with the expected
  `org_id`/`repo_id`/`ref_name`/`revision_sha`/`path` properties and every CONTAINS/IMPORTS/CALLS/
  INHERITS/COVERS edge; a subsequent delta projection prunes the nodes and edges whose paths left
  the head and leaves untouched files alone; and `load_symbols` returns the Function/Class symbols
  just written. The suite skips (never errors) when Neo4j is unreachable.
- **AC-6 (GAP-4)** — `services/workers/tests/test_chunk_store_integration.py` executes
  `PostgresChunkStore.replace_chunks` and `PostgresChunkStore.store_embedding` against a real
  Postgres with pgvector and proves, by reading the rows back, that: chunks insert with the expected
  `org_id`/`ref_id`/`graph_node_id`/`content_hash` and the `ON CONFLICT` path updates rather than
  duplicates; a real 1024-element vector round-trips through the `%s::vector` cast with the
  `format(value, ".17g")` literal preserving the values; and `provider`/`model`/`dimension` are
  persisted as supplied. The suite skips (never errors) when Postgres is unreachable.
- **AC-7 (GAP-5)** — a test drives the real `MessagingPublisher.graph_updated` (monkeypatching only
  the transport, `publish_graph_updated`, exactly as `test_onboarding_priority.py:80-108` does for
  `publish`) and asserts the emitted envelope has `type == "graph.updated"`,
  `source == "ingestion-worker"`, `org_id == scope.org_id`,
  `graph_scope_key == graph_scope_key(scope)`, `graph_version` as supplied,
  `idempotency_key == f"{scope_key}:{scope.revision_sha}:graph.updated"`, and a payload of exactly
  `{repository_id, ref_name, revision_sha, full_rebuild, changed_paths, structural_duration_ms}`
  with `changed_paths` a JSON-serializable list.
- **AC-8 (GAP-11)** — `services/workers/tests/test_ingestion_fixture_repo.py` builds a real local
  git repository with commit A and commit B (B adds a file, modifies a file, and deletes a file),
  drives `IngestionService` with the real `GitRepositorySource(allow_local_for_tests=True)`, the real
  parser, and the real `build_projection`, and asserts on the resulting `GraphProjection` that: the
  File nodes exactly match commit B's tracked source files, the Folder nodes match its directories,
  the Function/Class nodes match the symbols actually present at B, CONTAINS edges connect each file
  to its parent folder, and the removed file's node and its edges are absent. The push from A to B
  is a fast-forward, so `result.full_rebuild is False`, `result.status == "accepted"`,
  `result.changed_paths` is the real `git diff --name-status` output for A→B, and
  `result.deleted_paths` contains the removed file — i.e. `GitSnapshot.changed_paths` and
  `GitSnapshot.is_ancestor` are executed against real git, not assumed.
- **AC-9 (GAP-12)** — the same real-git harness asserts, on the **push/delta** path, that the
  publisher received exactly one `graph.updated` for the accepted revision, that its
  `structural_duration_ms` is a positive float strictly less than
  `STRUCTURAL_SYNC_TARGET_MS` (imported from
  `services/workers/sayre_workers/ingestion/budgets.py`, not a magic `15_000`), that the
  independently measured wall-clock elapsed time from `handle()` entry to the publish call is also
  under that budget, and that the published `structural_duration_ms` is the **pre-publish**
  measurement (strictly less than `result.structural_duration_ms`). The equivalent assertion is
  also made on the initial-parse path, replacing the current vacuous inline `< 15_000` literal at
  `services/workers/tests/test_ingestion.py:495` with the named constant.

---

## Edge cases

- **EC-1 (GAP-8)** — A `repo.branch` envelope with `payload.action == "created"` and one with
  `"deleted"` both classify as `IgnoredIngestionMessage`; neither reads any further payload field,
  so a `repo.branch` envelope with a completely empty or structurally junk `payload` still
  terminal-acks rather than raising. (The type check must precede payload validation.)
- **EC-2 (GAP-8)** — An envelope type that is neither handled nor in `TERMINAL_IGNORED_TYPES`
  (e.g. `repo.tag`, `repo.pull_request`, `graph.updated`) still raises
  `InvalidIngestionJobError("unsupported ingestion message type")`. Fail-loud on the genuinely
  unknown is preserved; this fix is not a blanket `except: pass`.
- **EC-3 (GAP-9)** — `deleted: false` (or absent) with an all-zero `after`: still classified as a
  ref deletion, so the zero SHA can never reach `git fetch`/`checkout`. A payload cannot bypass the
  guard by lying about `deleted`.
- **EC-4 (GAP-9)** — `deleted: true` with a real, non-zero `after`: the `deleted` flag is
  authoritative and the message classifies as a ref deletion (no fetch attempted).
- **EC-5 (GAP-9)** — `payload.payload.deleted` present but non-boolean (`"true"`, `1`, `null`) raises
  `InvalidIngestionJobError`, mirroring the existing `forced` type check.
- **EC-6 (GAP-9)** — A branch-deletion push whose `before` is itself all-zero or absent yields
  `previous_revision_sha is None` rather than an invalid SHA.
- **EC-7 (GAP-8/GAP-9)** — FIFO head-of-line recovery: after a `repo.branch` (or deletion-push)
  delivery is terminal-acked, a subsequent legitimate `repo.push` for the *same*
  `(org_id, provider_repo_id, ref)` group is processed normally. The regression this whole item
  exists to prevent is "the second message never runs."
- **EC-8 (GAP-9)** — A `repo.push` envelope whose payload is a ref deletion still ignores any forged
  `payload.org_id`; the `RefDeletionCommand.org_id` is `envelope.org_id` only (the same invariant
  `test_job_parser_uses_only_server_resolved_envelope_org` pins for `IngestionJob`).
- **EC-9 (GAP-10)** — The committed envelope fixtures are byte-parseable by
  `MessageEnvelope.from_body` and carry no secret material (no installation token, no clone URL with
  credentials, no real org identifier) — the fixture tenant id must be the same synthetic UUID the
  existing `repo_initial_parse.envelope.json` uses.
- **EC-10 (GAP-11)** — Real-git rename: `git mv` between A and B. Because `changed_paths` runs with
  `--no-renames`, the projection must show the old path deleted and the new path added, not a rename.
- **EC-11 (GAP-11)** — Real-git force-push/divergence: commit B is *not* a descendant of commit A
  (`git commit --amend` or a reset), so neither `is_ancestor(A, B)` nor `is_ancestor(B, A)` holds and
  `result.full_rebuild is True`.
- **EC-12 (GAP-11)** — Real-git stale push: the incoming revision is an *ancestor* of the current
  ref state, so `is_ancestor(job.revision_sha, current.revision_sha)` holds and `handle` returns
  `status == "stale"` with no graph write and no `graph.updated`.
- **EC-13 (GAP-11)** — Real-git replay: the incoming revision equals the current ref state, so
  `status == "replayed"` and the projection is a full re-derive, not a delta.
- **EC-14 (GAP-11)** — A commit-B tree containing a file in a language the parser does not support,
  and an empty file: the projection still produces a File node and does not crash.
- **EC-15 (GAP-3)** — Cross-org isolation on real Neo4j: two orgs whose projections carry
  *identical* node `uid`s. Applying org A's projection (including its full-rebuild `DETACH DELETE`)
  must leave org B's nodes and edges untouched, and `load_symbols` for org B must return only B's
  symbols. This is the `org_id`-stamped-on-every-write rule proved against a real engine rather than
  against a string-recording fake.
- **EC-16 (GAP-3)** — Empty projection (zero nodes, zero edges) against real Neo4j: `apply` must
  complete without error, and a full-rebuild empty projection must clear the ref's prior nodes.
- **EC-17 (GAP-3)** — Double-apply of the *same* projection is idempotent: node/edge counts are
  identical after the second run (the `MERGE` shapes must not duplicate).
- **EC-18 (GAP-4)** — Cross-org isolation on real Postgres: `store_embedding` for a `chunk_id`/
  `ref_id` belonging to a *different* org returns `False` (the `SELECT ... WHERE` guard matches no
  row) and writes nothing, even though the connection is org-scoped.
- **EC-19 (GAP-4)** — A vector whose length does not match the column's 1024 dimensions is rejected
  by Postgres (the statement raises rather than silently truncating).
- **EC-20 (GAP-4)** — Extreme float values in the vector (`0.0`, a very small denormal, a
  high-precision value that round-trips only at 17 significant digits) survive the
  `format(value, ".17g")` literal path within `float` tolerance.
- **EC-21 (GAP-4)** — `replace_chunks` with `full_rebuild=True` deletes the ref's prior chunks;
  with `full_rebuild=False` and a non-empty `affected_node_ids` it deletes only those nodes' chunks
  and leaves the rest, whose `revision_sha` is advanced to the new head.
- **EC-22 (GAP-5)** — The `graph.updated` payload must contain **no** `org_id` key (tenant identity
  belongs on the envelope, not in the fanned-out payload), matching the assertion
  `test_onboarding_priority.py` already makes for `onboarding.generate`.
- **EC-23 (GAP-5)** — The `idempotency_key` is stable for the same `(scope, revision_sha)` across
  two separate calls, so a redelivered ingestion job cannot produce two distinct downstream fanout
  identities.
- **EC-24 (GAP-12)** — `structural_duration_ms` is measured from `handle()` entry (including
  checkout and parse), not from the graph write, and the value published on the wire is captured
  *before* `publish_graph_updated` is called.
- **EC-25 (GAP-3/GAP-4)** — Infra unreachable: both integration suites must **skip**, never error
  or hang. Each reachability probe uses a short connect timeout (≤2s) so a machine with no
  Neo4j/Postgres does not stall `poetry run pytest`.
- **EC-26 (GAP-8)** — No regression on the ownership lane: `branch.create.json` and
  `branch.delete.json` still enqueue exactly one ownership job with the unchanged payload, and no
  other event type's `destinations` changes (push stays `['ingestion','ownership']`, pull_request
  stays `['ownership']`, tag/ping/unsupported stay ignored).

---

## Open questions

**Q-1 — [NEEDS HUMAN SIGN-OFF] Ref-deletion remedy: terminal-ack now, teardown later?**

`.pipeline/gaps.md` explicitly flags this as an architecture decision requiring human sign-off, and
the original W1-05 Executor was "AI agent" rather than Pair/Human. The change is cross-service
(Core + Python worker) and security-adjacent (it is an availability/DLQ defect: anyone able to push
or delete a branch on a connected repo can currently park a permanently-failing message on a FIFO
queue and head-of-line block that tenant's ref group until the redrive budget is exhausted).

**The call this spec makes**, and the reasoning:

- *Fix at both layers, not one.* Core-only filtering (AC-1) is the cleanest fix but is
  producer-side: messages already enqueued when the fix deploys, and any future producer, would
  still poison the queue. Worker-only handling leaves Core knowingly publishing messages no consumer
  wants. Both is the only combination with no deploy-ordering hole.
- *Enumerated terminal classification, not `except: pass`.* `TERMINAL_IGNORED_TYPES` is an explicit
  allowlist; anything outside the handled ∪ ignorable union still raises and still reaches the DLQ
  (EC-2). The failure mode this fix removes is "known-unroutable blocks the queue," not "all errors
  are swallowed."
- *No destructive teardown in this pass.* On a ref deletion the worker acknowledges and logs; it
  does **not** delete the ref's graph projection, `code_chunks`/`code_embeddings` rows, or
  `repository_refs` state. Rationale: (a) the W1-05 ticket sentence asks the worker to *handle*
  webhook-triggered delta jobs, not to garbage-collect deleted refs; (b) the teardown needs new
  destructive surface across three stores (`GraphStore.delete_ref`, `ChunkStore.delete_ref`,
  `LockedRef.delete`) plus a decision about what `graph.updated` even means for a ref that no longer
  has a revision SHA — the gateway's fanout consumes `revision_sha` and `graph_version`, and an
  all-zero SHA there is a contract change for a downstream service; (c) landing a multi-store delete
  driven by inbound webhook input inside a gap-fill, without its own red-stage adversarial coverage,
  is exactly the kind of scope creep the gapfill lane exists to avoid.

**The consequence a human must accept:** a deleted branch's nodes, chunks, and embeddings remain in
the graph and in Postgres indefinitely. That is stale data and a (bounded, same-tenant) storage
leak. It is *not* a new regression — it is the status quo today — but this spec chooses not to fix
it here. **If the reviewer disagrees, the alternative is a follow-up ticket ("ref-deletion teardown
for W1-05"), not an amendment to this one**, because the teardown deserves its own `red` stage.

**Q-2 — Should the 15-second structural sync target be a cross-language shared constant?**
This spec binds it once on the Python side (`ingestion/budgets.py`) and leaves the TypeScript
reference as the prose it is today (`services/core/src/services/providerSettingsService.ts:48`).
A single shared source of truth would mean exporting it from `packages/shared-types` and
code-generating or hand-mirroring the Python value, with a drift test. That is a reasonable
follow-up, but it is broader than W1-05 and would touch every consumer of the budget. Flagging, not
resolving.

**Q-3 — CI availability of Neo4j and Postgres for the two new integration suites.**
The suites follow the in-repo skip-when-unreachable convention (AC-5, AC-6, EC-25), which means on a
machine or CI job with no infra they contribute **zero** assertions. `test_sqs_roundtrip.py` solves
the same problem with a `MESSAGING_INTEGRATION_REQUIRED` config flag that turns an unreachable
broker into a hard failure. Whether CI should set an equivalent required-mode flag for these two
suites (so GAP-3/GAP-4 cannot silently regress to "skipped everywhere") is a CI-configuration
decision outside this spec's file scope. Flagged for the reviewer.
