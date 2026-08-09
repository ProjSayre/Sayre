# Audit 09 — Python ingestion & structural parsing workers

Scope: `services/workers/sayre_workers/ingestion/` (13 files), `sayre_workers/parsing/` + `parsing/adapters/` (11 files), `services/workers/scripts/` (8 files).

**Note on what I did *not* find.** The threat surface this brief centres on is genuinely well handled, and I want to be explicit so the negative results are usable:

- **Scratch-clone cleanup** — `tempfile.TemporaryDirectory(prefix="sayre-ingestion-")` (`repository.py:573`) inside an `@asynccontextmanager` with `finally: await asyncio.to_thread(temporary.cleanup)` (`repository.py:616-617`). Not a predictable path; deletion is on the failure path. (One residual leak case is Finding 9.)
- **Path traversal** — `_canonical_path` (`repository.py:81-85`) rejects absolute, empty, `.` and `..` components, and is applied to every `git ls-files` / `git diff` path.
- **Symlink escape** — `repository.py:527-531` skips symlinks *and* re-checks `candidate.resolve().is_relative_to(checkout_root)`, which also catches the intermediate-symlinked-directory case (`a -> /etc`, tracked path `a/passwd`).
- **Command injection** — every `subprocess.Popen` uses `shell=False` with a list argv; refs are regex-validated (`_REVISION`, `ref_name.startswith("refs/")`); the git environment is a sanitized allowlist with `GIT_CONFIG_NOSYSTEM=1` / `GIT_CONFIG_GLOBAL=os.devnull`; the token lives only in one subprocess env, scoped via `http.https://github.com/.extraHeader` with `followRedirects=false`.
- **Archive extraction** — none present. No `zipfile`/`tarfile` anywhere in scope.
- **Tree-sitter robustness** — `parser.py:99-124` skips undecodable files and maps any adapter exception to `SkippedFile(reason="parse_error")` per file; one bad file cannot kill the job.
- **`org_id` on graph writes** — every node/edge Cypher in `graph.py` binds `org_id` from server-resolved `GraphScope`, and `parse_ingestion_envelope` (`models.py:247`) explicitly takes `org_id` from the envelope, ignoring any payload value.

The findings below are real defects in correctness, cost, and resource bounding, ordered by severity.

---

### [SEVERITY: HIGH] Every full rebuild cascade-deletes all embeddings for the ref and forces a complete re-embed

- **File:** `services/workers/sayre_workers/ingestion/chunks.py:111-115` (with `services/core/src/db/schema.ts:662-664`)
- **Code:**
```python
if full_rebuild:
    await connection.execute(
        "DELETE FROM code_chunks WHERE org_id = %s AND ref_id = %s",
        (scope.org_id, ref_id),
    )
```
and the FK:
```ts
chunkId: uuid("chunk_id")
  ...
  .references(() => codeChunks.id, { onDelete: "cascade" }),
```
- **Why it's wrong:** `code_embeddings.chunk_id` cascades on delete, so wiping `code_chunks` for a ref wipes **100% of that ref's vectors**. Re-inserted chunks get fresh `id`s, so the `ON CONFLICT (org_id, ref_id, graph_node_id, chunk_index, content_hash) DO UPDATE` path at `chunks.py:146` is dead code on this branch — the dedup key that `content_hash` exists for ("Hash of `content` for dedup / change detection", `schema.ts:621`) is never consulted. `service.py:163` passes `full_rebuild=full_rebuild or replayed`, so this fires on: every initial parse, **every force-push** (which CLAUDE.md mandates as a full rebuild), and every replayed delivery. Concrete scenario: a developer force-pushes a rebase to `main` on a 5k-file repo → all ~15k embeddings deleted, 15k embedding-provider calls re-queued, and RAG retrieval for that repo returns nothing until the `embedding-upserts` queue drains. Nothing about the content changed.
- **Fix:** Delete by *set difference* instead of truncating. Insert the new chunk rows first (the `ON CONFLICT ... DO UPDATE` already handles unchanged content, preserving `id` and therefore the embedding), then `DELETE FROM code_chunks WHERE org_id = %s AND ref_id = %s AND (graph_node_id, chunk_index, content_hash) NOT IN (<new set>)`. Additionally, only publish an `embedding_upsert` for chunks whose row was actually inserted (use `xmax = 0` or a `RETURNING (xmax = 0) AS inserted`) rather than for every persisted chunk (`service.py:167`).

---

### [SEVERITY: HIGH] Label-less `MATCH` in the CONTAINS edge write forces a full node scan per edge

- **File:** `services/workers/sayre_workers/ingestion/graph.py:70-75`
- **Code:**
```cypher
UNWIND $items AS item
MATCH (source {org_id: $org_id, uid: item.source_uid})
MATCH (target {org_id: $org_id, uid: item.target_uid})
MERGE (source)-[edge:CONTAINS {org_id: $org_id}]->(target)
```
- **Why it's wrong:** Neo4j indexes are label-scoped. Every constraint and index in `graph-migrations/003_constraints_and_indexes.cypher` is declared per label (`FOR (n:Folder) REQUIRE (n.org_id, n.uid) IS UNIQUE`, `FOR (n:File) ON (n.org_id)`, …). A pattern with no label cannot use any of them, so the planner emits `AllNodesScan` + `Filter` — **twice per UNWIND row**. Every other query in this file correctly labels both endpoints (`IMPORTS`, `CALLS`, `INHERITS`, `COVERS`). Concrete scenario: a full rebuild of a 20k-file repo emits ~25k CONTAINS rows; against a database holding 2M nodes across all tenants that is ~10¹¹ node visits inside a single write transaction that already holds a Postgres advisory lock (Finding 6). The ingestion effectively never completes, and it degrades as *other tenants'* graphs grow.
- **Fix:** CONTAINS endpoints are always `Folder→Folder` or `Folder→File`. Split `edges_by_type["CONTAINS"]` into the two typed groups in `apply()` and use two labelled queries: `MATCH (source:Folder {org_id: $org_id, uid: item.source_uid}) MATCH (target:Folder {...})` and the `:File` target variant.

---

### [SEVERITY: HIGH] No cap on file count or aggregate bytes — the whole repo's source is held in memory at once

- **File:** `services/workers/sayre_workers/ingestion/repository.py:519-535`
- **Code:**
```python
async def source_files(self, paths: Iterable[str]) -> tuple[SourceFile, ...]:
    checkout_root = self.repository_path.resolve()
    sources: list[SourceFile] = []
    for raw_path in sorted(set(paths)):
        ...
        if candidate.stat().st_size > 1_000_000:
            continue
        sources.append(SourceFile(path=path, content=await asyncio.to_thread(candidate.read_bytes)))
    return tuple(sources)
```
- **Why it's wrong:** The only limit is 1 MB *per file*. There is no cap on file count and no running total. `service.py:100` calls this with the entire tracked path set on any full rebuild, and the returned tuple stays alive until `build_bounded_chunks` at `service.py:158` — spanning the parse, the Neo4j write, and the chunk write. `SourceFile` is a pydantic model, so `content` is copied on validation, roughly doubling peak footprint. The only upstream bound is `_GIT_STDOUT_LIMIT_BYTES = 16MB` on the `git ls-files -z` output, which permits ~400k paths. Concrete scenario: a monorepo with 60k source files averaging 25 KB → ~1.5 GB of file bytes, ~3 GB peak RSS, plus the tree-sitter parse trees held by `_parse()`. The worker is OOM-killed mid-ingestion; because the Neo4j write has not happened yet nothing is corrupted, but the message is redelivered and OOMs again — a permanent poison message for that tenant.
- **Fix:** Add `MAX_SOURCE_FILES` and `MAX_TOTAL_SOURCE_BYTES` constants; accumulate `st_size` in the loop and raise a distinct, non-retryable `RepositoryTooLargeError` when either is exceeded so the message goes to the DLQ instead of looping. Longer term, make `source_files` an `AsyncIterator[SourceFile]` and stream through `_parse` so peak memory is bounded by one file rather than the repo.

---

### [SEVERITY: HIGH] `scripts/synthetic_graph_load.py` default (real-Neo4j) path is broken — async function called without `await`

- **File:** `services/workers/scripts/synthetic_graph_load.py:259` and `:336`
- **Code:**
```python
# line 336, inside the synchronous main():
driver = neo4j_driver_from_env()
for org_id in args.orgs:
    seed_org_data(driver, org_id)
```
```python
# line 259, inside async def run_load():
driver = neo4j_driver_from_env()
```
against `services/workers/sayre_workers/graph_migrations/runner.py:313`:
```python
async def neo4j_driver_from_env() -> "Driver":
```
- **Why it's wrong:** `neo4j_driver_from_env` is a coroutine function. Neither call site awaits it, so `driver` is a coroutine object. `seed_org_data(driver, org_id)` immediately does `with driver.session()` → `AttributeError: 'coroutine' object has no attribute 'session'`, plus a `RuntimeWarning: coroutine ... was never awaited`. Line 336 is in a *synchronous* `main()`, so it cannot even be fixed by adding `await` in place. The sibling script gets this right (`run_graph_migrations.py:163`: `neo4j_driver = await neo4j_driver_from_env()`), which is what makes this an oversight rather than a design. The default invocation documented in the module docstring — `poetry run python scripts/synthetic_graph_load.py` — crashes before emitting a single metric, meaning the W0-08 Neo4j→Neptune migration-trigger evidence this script exists to produce has never actually been gathered against real Neo4j. Tests miss it: `tests/test_graph_metrics_tester.py:527` monkeypatches the symbol with a synchronous `lambda: _fail_if_called()` and only exercises `--simulate`.
- **Fix:** Move driver construction inside the async context. Make `main()` build the driver in an `asyncio.run`-ed coroutine (e.g. an `async def _main()` that does `driver = await neo4j_driver_from_env()`, seeds, calls `run_load(driver=driver, ...)`, then cleans up), and pass the driver into `run_load` instead of constructing it there. Add a test that asserts `inspect.iscoroutinefunction` compatibility at the call site, or monkeypatch with an `async` stub so the missing `await` fails the suite.

---

### [SEVERITY: HIGH] "Bounded" chunks persist whole source files minus one character; the guarantee in the comment is false and its test is vacuous

- **File:** `services/workers/sayre_workers/ingestion/chunks.py:24-25, 55, 62-64`
- **Code:**
```python
MAX_CHUNK_CHARACTERS = 3_000
MAX_CHUNKS_PER_FILE = 4
...
    """Create useful excerpts while deliberately never persisting a complete file."""
...
        # Leave at least one source character out even for tiny files. Combined with
        # the hard per-file cap, the persisted excerpts cannot reconstruct a checkout.
        budget = min(max(0, len(text) - 1), MAX_CHUNK_CHARACTERS * MAX_CHUNKS_PER_FILE)
```
- **Why it's wrong:** The effective per-file bound is 12,000 characters. For any file at or below that — which is the large majority of source files in a normal repo — `budget` evaluates to `len(text) - 1`, i.e. **the entire file minus its final character** is written to `code_chunks.content` in Postgres. The claim that the persisted excerpts "cannot reconstruct a checkout" is not true: concatenating `code_chunks.content` per `graph_node_id` for a tenant yields a near-byte-exact copy of the source tree, each file missing one trailing character (usually the terminating newline). CLAUDE.md permits "bounded, tenant-scoped code/document chunks" to persist, so this is not a clean rule violation — but the invariant the code claims to enforce is not the invariant it enforces, and the security posture documented elsewhere (`security-multitenancy.md`: "never persist raw source trees, only structural metadata and embeddings") is written assuming it is. The regression test gives false assurance:
```python
# tests/test_ingestion.py:618-626
def test_bounded_chunks_never_reconstruct_the_source_file() -> None:
    content = b"def hello():\n    return 'world'\n"
    ...
    assert "".join(chunk.content for chunk in chunks) != content.decode("utf-8")
    assert sum(len(chunk.content) for chunk in chunks) < len(content.decode("utf-8"))
```
Both assertions are satisfied by the `- 1` alone and would pass for a 999,999-character excerpt of a 1 MB file.
- **Fix:** Decide the actual intent and encode it. If the intent is genuine non-reconstructability, sample discontiguously (e.g. cap total persisted characters at a fraction of `len(text)` and skip a gap between chunks) so a meaningful portion of every file is absent, and rewrite the test to assert the *ratio* (`sum(len(c.content)) <= 0.6 * len(text)`) rather than strict inequality. If the intent is "retrieval-useful excerpts up to 12 KB", delete the `- 1` and both misleading comments, and state the real bound in the docstring so downstream security review is not built on a false premise.

---

### [SEVERITY: MEDIUM] A Postgres transaction, advisory lock, and `FOR UPDATE` row lock are held across the git fetch, checkout, and the entire CPU-bound parse

- **File:** `services/workers/sayre_workers/ingestion/service.py:70-135` (with `state.py:214-243`)
- **Code:**
```python
async with self._state_store.lock(job.org_id, job.repository, job.ref_name) as locked_ref:
    current = locked_ref.current
    async with self._repository_source.checkout(...) as snapshot:
        ...
        source_files = await snapshot.source_files(tracked_paths)
        parsed = parse_full(source_files)
        ...
        await self._graph_store.apply(projection)
        accepted_state = await locked_ref.accept(job.revision_sha)
```
`state.py` holds it open the whole time:
```python
await connection.execute(
    "SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))",
    (f"{org_id}:{repository_id}:{ref_name}",),
)
```
- **Why it's wrong:** `pg_advisory_xact_lock` is released only at transaction end, so the `org_scoped_connection` transaction stays open for the full duration of: token mint, `git init`/`remote add`/`fetch` (up to 60 s each per `_GitRunner.timeout_seconds`), `checkout`, `ls-files`, reading every file off disk, the synchronous `parse_full`, and the Neo4j write. On a large repo that is minutes. Concrete scenario: ten repos ingesting concurrently pin ten Postgres connections in idle-in-transaction for minutes each, exhausting the pool and blocking unrelated request-path queries; autovacuum on `repository_refs` and `code_chunks` also stalls behind the oldest open transaction's xmin horizon. Note `parse_full` is additionally called directly on the event loop rather than via `asyncio.to_thread`, so it blocks the loop too — that is benign today only because `consumers.py:33` processes exactly one message at a time (the SQS visibility heartbeat is a separate `threading.Thread`, `sqs_client.py:467`, so it survives), but it forecloses any future concurrency in the consumer.
- **Fix:** Split the lock into two short transactions. Take the lock, read `current`, and release it; do the checkout/parse/projection unlocked; then re-take the lock and re-read `repository_refs` before `apply()` + `accept()`, aborting if `graph_version` changed under you (the compare-and-set in `_PostgresLockedRef.accept` already provides that check). Wrap `parse_full` in `asyncio.to_thread`.

---

### [SEVERITY: MEDIUM] Neo4j is committed before the Postgres accept, with no compensation on failure

- **File:** `services/workers/sayre_workers/ingestion/service.py:134-135`
- **Code:**
```python
await self._graph_store.apply(projection)
accepted_state = await locked_ref.accept(job.revision_sha)
```
- **Why it's wrong:** `apply()` commits its own Neo4j transaction (`graph.py:361-362`, `session.execute_write`). If `accept()` then raises `RevisionConflictError` (`state.py:126`) or the Postgres connection drops, the enclosing `async with` rolls back Postgres while Neo4j has already advanced. The graph now holds the new head while `repository_refs.revision_sha` holds the old one, and `graph_updated` at `service.py:141` never fires — so the realtime fan-out, the enrichment lane, and the canvas never learn the head moved. Redelivery usually self-heals (the delivery store only marks complete on handler success), but once retries exhaust and the message lands in the DLQ, the divergence is permanent and silent: the graph shows revision N+1, Postgres and every consumer believe N.
- **Fix:** Make the accept the ordering authority. Either write a `pending_revision` row in Postgres before `apply()` and flip it to accepted afterwards (so a reconciler can detect and finish/roll back a partial run), or emit `graph.updated` keyed off a durable outbox row written in the same Postgres transaction as `accept()`. At minimum, catch the post-`apply()` failure and log a distinct, alertable `graph_ahead_of_state` event with the scope and both revisions.

---

### [SEVERITY: MEDIUM] `git fetch` pulls full history with no depth/blob filter and no disk quota

- **File:** `services/workers/sayre_workers/ingestion/repository.py:590-597`
- **Code:**
```python
await git.run(
    "fetch",
    "--quiet",
    "--no-tags",
    "origin",
    ref_name,
    environment=authentication,
)
```
- **Why it's wrong:** No `--depth`, no `--filter=blob:none`, no `core.bigFileThreshold`, and no check on available space in the scratch directory. The only bound is the 60 s per-command timeout (`_GitRunner.__init__`, `repository.py:419`), which on a fast link permits multiple gigabytes to land before it trips. The projection only needs one tree plus enough history for `merge-base --is-ancestor` and `diff older newer`, so full blob history is fetched and discarded. Concrete scenario: a tenant connects a repo with large binary history; the fetch fills the container's ephemeral disk, and because `/tmp` is shared, *every other* in-flight ingestion on that worker fails with unrelated ENOSPC errors until the `TemporaryDirectory` is cleaned.
- **Fix:** Add `--filter=blob:none` (partial clone; blobs are fetched lazily only for the paths actually read) and, for the `kind == "initial"` path where no ancestry check is needed, `--depth=1`. Add a pre-flight free-space check against a configured `MIN_SCRATCH_FREE_BYTES` and fail fast with a distinct error rather than mid-fetch.

---

### [SEVERITY: MEDIUM] A cleanup failure leaks the checkout permanently; a killed worker leaves it forever

- **File:** `services/workers/sayre_workers/ingestion/repository.py:616-617`
- **Code:**
```python
        finally:
            await asyncio.to_thread(temporary.cleanup)
```
- **Why it's wrong:** Two gaps in the "scratch clone is destroyed after parsing" invariant. (1) `TemporaryDirectory.cleanup()` calls `self._finalizer.detach()` *before* `_rmtree`. If the rmtree then raises (EBUSY, ENOSPC on the rename path, a read-only tree, long paths on Windows), the finalizer is already detached, so the directory will never be removed — not by GC, not at interpreter exit. The source tree stays on disk indefinitely. The same raise also propagates out of a `finally`, replacing whatever real ingestion error was in flight with an opaque `OSError`. (2) If the worker is `SIGKILL`ed or OOM-killed mid-parse — which Finding 3 makes likely — the checkout is orphaned in the system temp directory, and nothing sweeps it: there is no startup reaper for stale `sayre-ingestion-*` directories anywhere in the codebase. Over time a restarting worker accumulates full copies of every tenant repo it was killed on, which is precisely the persisted-source-tree state the architecture rule forbids.
- **Fix:** Replace with an explicit best-effort teardown that cannot mask the body's exception and cannot silently give up: `try: await asyncio.to_thread(shutil.rmtree, scratch_root, ignore_errors=False) except OSError: log + retry with an onerror handler that chmods, then log an alertable "scratch clone leak" event`. Add a startup sweep in `build_ingestion_service()` that removes `sayre-ingestion-*` directories in `tempfile.gettempdir()` older than a threshold.

---

### [SEVERITY: MEDIUM] Every delta re-MERGEs every File and Folder node in the repository

- **File:** `services/workers/sayre_workers/ingestion/projection.py:104-121` and `graph.py:333-334`
- **Code:**
```python
# projection.py — file_paths is the FULL tracked set, not the affected set
for path in file_paths:
    nodes.append(GraphNode(label="File", uid=stable_uid(scope, "File", path), properties={...}))
```
```python
# graph.py — every label's full item list is UNWIND/MERGEd on every run
for label, query in _NODE_QUERIES.items():
    await transaction.run(query, items=nodes_by_label[label], **common)
```
- **Why it's wrong:** `build_projection` always emits a node for every tracked file and folder, regardless of `full_rebuild`, so the "delta" path writes the entire File/Folder node set on every push. A one-line README change on a 20k-file repo performs 20k+ `MERGE` + `SET` operations inside the write transaction (each of which also holds the lock from Finding 6). The file already demonstrates the cheaper pattern for the other labels — `graph.py:335-343` bumps `revision_sha` on Function/Class/Test with a single set-based query instead of re-merging them.
- **Fix:** On the delta path, emit File/Folder `GraphNode`s only for `affected_paths` plus any newly-created folder ancestors, and advance `revision_sha` on the untouched remainder with the same single set-based `MATCH ... SET node.revision_sha = $revision_sha` already used for Function/Class/Test.

---

### [SEVERITY: MEDIUM] Tree-sitter `.scm` queries are recompiled once per file

- **File:** `services/workers/sayre_workers/parsing/adapters/python.py:98`, `adapters/javascript.py:197`, `adapters/go.py:123`
- **Code:**
```python
query = tree.language.query(_QUERY_SOURCE)
captures = query.captures(tree.root_node)
```
- **Why it's wrong:** `_QUERY_SOURCE` is loaded once at module import, but `Language.query()` — which parses and compiles the S-expression pattern into the query automaton — runs inside `extract()`, i.e. once per file. `registry.get_adapter` (`registry.py:48-54`) deliberately makes adapters process-wide singletons precisely so per-file setup can be amortized, and the docstring calls them "stateless pure `Tree -> FileExtract` functions" — the compiled query is the one piece of state that should have been cached. Parsing a 20k-file repo compiles the same four queries 20k times. Pure overhead on the critical path of the 15-second structural-sync target.
- **Fix:** Memoize per `(adapter, grammar)` — e.g. a module-level `functools.lru_cache`d `_compiled_query(language: tree_sitter.Language, source: str) -> tree_sitter.Query`, or an instance dict on the adapter singleton keyed by `id(tree.language)`. `tree_sitter.Query` objects are reusable across `captures()` calls.

---

### [SEVERITY: MEDIUM] A new `AsyncOpenAI` client and TLS connection pool is built and torn down per embedding message

- **File:** `services/workers/sayre_workers/ingestion/embeddings.py:141-148` (with `:76-85`)
- **Code:**
```python
provider = await self._factory.create(work.config)
try:
    vector = (await provider.embed([work.content]))[0]
    return await self._store.store_embedding(work, vector)
finally:
    close = getattr(provider, "aclose", None)
    if callable(close):
        await close()
```
- **Why it's wrong:** `EmbeddingProviderFactory.create` → `OpenAICompatibleEmbeddingProvider.from_config` constructs a fresh `AsyncOpenAI` with a fresh `DefaultAsyncHttpxClient` for **every** `embedding.upsert` message, and closes it immediately after one single-item `embeddings.create` call. That is a full TCP + TLS handshake per chunk, and a fresh `get_secret(config.credential_ref)` resolution per chunk. Combined with Finding 1 (every force-push re-queues every chunk in the repo), a 5k-file repo re-embed means ~15k sequential handshakes. Connection reuse is the single largest available win here and it is being discarded.
- **Fix:** Cache providers on the `EmbeddingConsumer` keyed by the resolved `EmbeddingConfig` (it is a frozen dataclass, so it is hashable), close them in a consumer-level `aclose()` wired into the existing `run_embedding_consumer` teardown, and drop the per-message `finally` close.

---

### [SEVERITY: LOW] A backwards force-push is silently ignored when the provider `forced` flag is absent

- **File:** `services/workers/sayre_workers/ingestion/service.py:82-95`
- **Code:**
```python
elif current is None or job.kind == "initial" or job.forced:
    full_rebuild = True
elif await snapshot.is_ancestor(current.revision_sha, job.revision_sha):
    full_rebuild = False
elif await snapshot.is_ancestor(job.revision_sha, current.revision_sha):
    return IngestionResult(status="stale", ...)
else:
    # Non-fast-forward divergence without a trustworthy provider flag.
    full_rebuild = True
```
- **Why it's wrong:** A force-push that moves the ref *backwards* to an ancestor is a non-fast-forward update, which CLAUDE.md says must trigger a full scoped rebuild. It only does so here via the `job.forced` flag; if that flag is false or missing, the third branch classifies it as a stale out-of-order delivery and returns without touching the graph, leaving the head projection permanently ahead of the real ref. The comment on the `else` branch explicitly distrusts the provider flag, yet the branch above depends on it. In practice GitHub does set `forced` and `normalizeGithubEvent.ts:95` forwards it (`forced: parsed.forced ?? false`), so this is currently latent — but it is the failure mode for any non-GitHub provider or a dropped field.
- **Fix:** Distinguish the two cases structurally rather than by flag. `IngestionJob` already carries `previous_revision_sha`; when it is present and does not equal `current.revision_sha`, the ref moved non-linearly and warrants a rebuild regardless of `forced`. Reserve the `stale` return for the case where `previous_revision_sha` confirms an ordering the current state has already passed.

---

### [SEVERITY: LOW] `assert` used for runtime invariants that hold real data (stripped under `python -O`)

- **File:** `services/workers/sayre_workers/ingestion/service.py:137`, `chunks.py:171`, `repository.py:284`
- **Code:**
```python
assert accepted_state is not None            # service.py:137
assert row is not None                       # chunks.py:171 — after RETURNING id::text
assert process.stdin is not None             # repository.py:284
```
- **Why it's wrong:** Under `-O` / `PYTHONOPTIMIZE`, all three vanish. `service.py:137` then proceeds to `accepted_state.graph_version` on `None` — an `AttributeError` after the graph has already been written, which is exactly the divergence in Finding 7 but with a confusing traceback. `chunks.py:171` would append a `PersistedChunk` built from `None`. These are guarding real runtime outcomes (a DB row, a subprocess pipe), not developer-only invariants.
- **Fix:** Replace with explicit raises: `if accepted_state is None: raise RuntimeError("ref state was not accepted")`, and likewise for the cursor row. `repository.py:284` is defensible since `stdin=subprocess.PIPE` was just requested, but converting it costs nothing.

---

### [SEVERITY: LOW] Local runner scripts use a fixed, world-writable `/tmp` path for the delivery store

- **File:** `services/workers/scripts/run_local_ingestion_consumer.py:30` and `run_local_enrichment_consumer.py:29`
- **Code:**
```python
delivery_store = SqliteDeliveryStore("/tmp/sayre-ingestion-delivery-store.sqlite")
```
- **Why it's wrong:** A predictable path in a shared, world-writable directory. On a multi-user host any local user can pre-create that path as a symlink and have SQLite write through it, or simply pre-create the file and corrupt the idempotency ledger — which decides which messages get processed versus skipped as `completed`. These are documented as manual-testing-only scripts, which caps the impact, but the path is also unusable on Windows where the rest of the codebase explicitly accommodates `win32` (`consumers.py:20`).
- **Fix:** Derive the path from the platform data directory — `Path(tempfile.gettempdir()) / f"sayre-ingestion-delivery-{os.getuid()}.sqlite"` with `0o600`, or better an env-overridable `SAYRE_LOCAL_DELIVERY_STORE` defaulting under `~/.cache/sayre/`.

---

### [SEVERITY: LOW] No per-file parse timeout

- **File:** `services/workers/sayre_workers/parsing/parser.py:117-124`
- **Code:**
```python
parser = get_parser(adapter.grammar_name(source_file.path))
tree = parser.parse(source_file.content)
extract = adapter.extract(file_path=source_file.path, source=source_file.content, tree=tree)
```
- **Why it's wrong:** `repository.py:532` admits any file up to 1 MB, and there is no time bound on the parse or the query walk. Tree-sitter is error-tolerant but not linear-time on all inputs; a 1 MB minified or generated file (or one crafted with deep nesting) can pin a CPU for a long time inside C code that no `asyncio` timeout can interrupt. Because the parse runs on the event loop (Finding 6) and inside the Postgres transaction, one such file stalls the whole ingestion. Note that minified and generated files are not excluded — `registry.EXTENSION_LANGUAGE` matches `.js` regardless of whether it is `vendor.min.js`, and such files produce no useful structural records anyway.
- **Fix:** `tree_sitter.Parser` exposes a timeout (`parser.timeout_micros` in the installed version) — set it and treat the resulting empty/partial tree as `SkippedFile(reason="parse_error")`. Independently, skip obvious non-source before parsing: filename patterns (`*.min.js`, `*.bundle.js`, `*_pb2.py`, `*.generated.*`), files under `vendor/`/`node_modules/`/`dist/`, and files whose mean line length exceeds a threshold.
