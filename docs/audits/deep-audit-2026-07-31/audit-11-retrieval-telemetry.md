# Audit 11 — Retrieval/RAG, Telemetry, Dynamic Coverage, Worker Config

Scope: `services/workers/sayre_workers/{retrieval,telemetry,dynamic_coverage,config}/` + top-level `*.py`.

---

## VERDICT: Retrieval tenant isolation — **ENFORCED (pre-filter)**, but the RLS backstop is silently disabled on this one path

**Application-layer pre-filter: correct.** `org_id` is bound into the SQL `WHERE` clause of both
retrieval queries, not applied to results afterward:

- `retrieval/store.py:106` — `WHERE chunk.org_id = %s` (bound to `scope.org_id` at `store.py:129`)
- `retrieval/store.py:156` — same predicate on the token-count baseline query
- `retrieval/service.py:86` — `if scope.org_id != auth.org_id: raise RetrievalScopeError(...)`, so the
  scope used to build the query is checked against the server-derived auth tenant before any read.
- `retrieval/models.py:30-38` — `org_id` lives on `RetrievalAuthContext`, never on `RetrievalQuery`, so
  it structurally cannot be copied from a request body.
- There is **no** top-k vector similarity search in the retrieval path at all — chunks are fetched by
  `graph_node_id = ANY(...)` (`store.py:111`) from an already-authorized traversal. No k-slot
  consumption or score leakage is possible here.

**RBAC on retrieval: correct.** Node authorization is delegated to Core's Graph Query Service via
`AuthorizedGraphGateway` (`service.py:49-61`); the returned traversal is re-validated
(`service.py:100-132`), the chunk fetch is restricted to those node ids (`service.py:318-324`), and
`_bounded_chunks` fails closed on any chunk outside that set (`service.py:147`). No canvas-invisible
file can reach the prompt.

**The gap:** the retrieval store is the only Postgres store in the fleet that does not engage RLS
correctly — see HIGH-2 below. It is defense-in-depth loss, not an active cross-tenant leak, because
the explicit `org_id` predicate is present and correctly bound.

**Adjacent (just outside scope, checked because the brief said "trace every search call"):** the only
real pgvector search in the repo is `services/workers/sayre_workers/tickets/reference_match.py:178-184`.
It *is* correctly pre-filtered (`WHERE org_id = %s AND repository_id = %s`), uses `org_scoped_connection`,
and pins `provider`/`model` so vectors from different embedding spaces are never compared. Metric is
consistent: `<=>` (cosine distance) against the `hnsw (embedding vector_cosine_ops)` index declared in
`services/core/drizzle/0007_rls_triggers_indexes_w0_05_v2.sql:159-160`. No metric mismatch, no dimension
mismatch (`dimension = 1024` guard at `store.py:121`). That query is, however, uninstrumented — see MEDIUM-1.

---

### [SEVERITY: HIGH] Coverage CI adapter subprocess inherits the worker's entire environment, including every secret

- **File:** `services/workers/sayre_workers/dynamic_coverage/command_runner.py:66-71`
- **Code:**
```python
process = await asyncio.create_subprocess_exec(
    *self._command,
    stdin=asyncio.subprocess.PIPE,
    stdout=asyncio.subprocess.PIPE,
    stderr=asyncio.subprocess.DEVNULL,
)
```
- **Why it's wrong:** no `env=` argument, so the child inherits `os.environ` wholesale. In this process
  that includes `DATABASE_RUNTIME_URL` (DSN with password), `NEO4J_PASSWORD`, `ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `MCP_TOKEN_PEPPER`,
  `JIRA_TOKEN_ENC_KEY`, and the AWS keys — the full catalog at `config/secrets.py:15-41`. The command is
  a deployment-configured "CI adapter" that runs a customer repository's test suite; any `pytest`
  conftest, npm lifecycle script, or malicious dependency in the repo under test reads `os.environ` and
  exfiltrates the whole fleet's credentials. The codebase already has the exact fix and uses it
  elsewhere: `config/config.py:132-144` `get_subprocess_environment()` ("Provider credentials, database
  URLs, application secrets ... are deliberately absent"), consumed at
  `ingestion/repository.py:389` for Git. This call site is the sole outlier.
- **Fix:** pass `env=get_subprocess_environment()` (plus any adapter-specific non-secret vars) to
  `create_subprocess_exec`. Add a test asserting the child cannot see `DATABASE_RUNTIME_URL`, mirroring
  `tests/test_github_repository_auth.py`'s ephemeral-header test.

---

### [SEVERITY: HIGH] Retrieval store is the only Postgres store that skips `org_scoped_connection` — no `SET LOCAL ROLE`, session-scoped org context, and no startup RLS gate

- **File:** `services/workers/sayre_workers/retrieval/store.py:74-77`
- **Code:**
```python
async def _connect(self, org_id: str) -> psycopg.AsyncConnection[Any]:
    connection = await psycopg.AsyncConnection.connect(self._dsn, row_factory=dict_row)
    await connection.execute("SELECT set_config('app.org_id', %s, false)", (org_id,))
    return connection
```
- **Why it's wrong:** three concrete regressions of findings `docs/tenant-isolation.md:288-302` records
  as *closed*:
  1. **No `SET LOCAL ROLE sayre_app`.** `sayre_workers/db/session.py:67-74` states plainly: "Without this,
     FORCE-RLS is silently bypassed when the DSN's login role is a superuser/BYPASSRLS role (the
     historical gap on this path, `docs/tenant-isolation.md` 'Finding 1')." Every other Postgres store
     routes through `org_scoped_connection` — `enrichment/config_store.py:42`, `ingestion/state.py:148`,
     `tickets/reference_match.py:142,175,208`. Retrieval alone hand-rolls it. The RLS policies on
     `code_chunks`/`code_embeddings` (`services/core/drizzle/0007_*.sql:39-51`) therefore do nothing on
     this path whenever the runtime DSN resolves to a privileged role — and `docs/tenant-isolation.md:227`
     says local dev's login role *is* intentionally a superuser.
  2. **`is_local=false`** (session-scoped) instead of transaction-local. That is verbatim "Finding 3"
     (`docs/tenant-isolation.md:299-302`), which the shared helper exists to prevent. The org GUC
     survives past the transaction; the moment anyone puts a pooler in front of this DSN, org A's
     context is live on a connection handed to org B.
  3. **No startup RLS assertion.** `retrieval/runtime.py:12-27` `build_retrieval_service` never calls
     `assert_runtime_role_rls_safe`, unlike `ingestion/runtime.py:30,53` and `enrichment/runtime.py:24`.
     So the retrieval worker will happily start against a BYPASSRLS role in CI/production.
  Net effect: the only thing standing between tenants on the AI-answer path is the hand-written
  `chunk.org_id = %s` predicate. Delete or mistype that one clause in a future edit and there is no
  second line of defense — which is precisely the failure mode the fleet-wide helper was built to make
  impossible.
- **Fix:** replace `_connect` with `async with org_scoped_connection(self._dsn, scope.org_id) as connection:`
  in both `load_bounded_chunks` and `load_full_repo_token_count`, delete `_connect`, and add
  `await assert_runtime_role_rls_safe(dsn)` to `build_retrieval_service`. Add a filter-removed test
  (drop the `org_id` predicate, assert zero rows) matching `tests/test_tenant_isolation.py:281-294`.

---

### [SEVERITY: MEDIUM] `vector_query_duration_ms` measures zero actual vector queries — the pgvector→OpenSearch migration trigger is instrumented on the wrong statements

- **File:** `services/workers/sayre_workers/retrieval/store.py:94` and `:147`
- **Code:**
```python
async with instrument_vector_query(scope.org_id):
    cursor = await connection.execute(
        """
        SELECT chunk.id::text AS chunk_id, ...
        FROM code_chunks AS chunk
        ... AND chunk.graph_node_id = ANY(%s)
```
- **Why it's wrong:** these are the *only two* call sites of `instrument_vector_query` in the entire
  repo, and neither performs a similarity search — they are B-tree lookups by `graph_node_id` with an
  `EXISTS` existence check on `code_embeddings`. Meanwhile the one genuine pgvector query,
  `tickets/reference_match.py:178-184` (`ORDER BY embedding <=> %s::vector`), is **not** wrapped. The
  module docstring at `telemetry/vector_metrics.py:11-15` claims "every future pgvector similarity query
  routes through `instrument_vector_query()`". Consequence: `otel.py:38-51` tunes explicit histogram
  buckets so `histogram_quantile(0.95/0.99, ...)` on this series drives the documented Neo4j/pgvector
  scaling decisions (`docs/migration-triggers.md`) — and that p95 currently reflects fast index lookups,
  not HNSW search latency. The migration trigger will never fire, and the query that would fire it is
  invisible.
- **Fix:** wrap `reference_match.py:176` in `instrument_vector_query(org_id)`, and either unwrap the two
  `store.py` call sites or move them to a separate non-vector instrument. Add a lint/test asserting every
  `<=>`-bearing SQL string in `sayre_workers/` is lexically inside an `instrument_vector_query` block.

---

### [SEVERITY: MEDIUM] Every user question triggers a full-repo `SUM(token_count)` aggregate purely to compute a vanity metric

- **File:** `services/workers/sayre_workers/retrieval/store.py:142-186`, called at `service.py:333`
- **Code:**
```python
full_repo_tokens = await self._store.load_full_repo_token_count(scope)
full_prompt_baseline = full_repo_tokens + (prompt_tokens - context_tokens)
reduction_ratio = max(1.0, full_prompt_baseline / max(1, prompt_tokens))
```
  backed by `SELECT COALESCE(SUM(chunk.token_count), 0)::bigint FROM code_chunks ... AND EXISTS (SELECT 1
  FROM code_embeddings ...)` over *every chunk in the repository at that revision*.
- **Why it's wrong:** this is a second full round-trip on a fresh connection (`_connect` at `store.py:145`
  — see HIGH-2, no pooling anywhere) that scans and aggregates the entire repo's chunk table with a
  correlated `EXISTS` per row, on the *interactive* AI-answer path, and the result is never returned to
  the user (`RetrievalAnswer`, `models.py:80-87`, has no such field). It exists only to feed
  `retrieval_token_reduction_ratio` at `service.py:347-353`. On a 50k-file monorepo this dominates
  question latency and its cost grows with repo size while adding nothing to the answer.
- **Fix:** precompute the per-`(org_id, repository_id, ref_id, revision_sha)` baseline once at ingestion
  and read it as a single indexed row, or emit the ratio asynchronously off the request path. At minimum
  cache it per scope for the life of the revision.

---

### [SEVERITY: MEDIUM] `_bounded_chunks` silently truncates authorized content using a 4-chars-per-token assumption that contradicts the stored token count

- **File:** `services/workers/sayre_workers/retrieval/service.py:157-167`
- **Code:**
```python
content = chunk.content[:remaining_characters]
token_count = min(chunk.token_count, remaining_tokens, math.ceil(len(content) / 4))
...
content=content[: token_count * 4],
```
- **Why it's wrong:** `chunk.token_count` comes from the database, produced by the real embedding-time
  tokenizer. `content[: token_count * 4]` then re-derives a character budget from it at a fixed 4 chars/token.
  Whenever the chunk's true density exceeds 4 chars/token — ordinary for docstrings, comments, and long
  identifiers — this discards the tail of an authorized chunk with no error and no signal. A 4,000-char
  docstring chunk stored as 800 tokens becomes `content[:3200]`: 800 characters of the retrieved evidence
  vanish mid-sentence, and the model answers from a truncated excerpt while `context_tokens_used`
  (`service.py:332`, returned to the caller) reports the operation as complete. Note this is separate from
  the deliberate cap-driven truncation — it fires even when the budget is nowhere near exhausted.
- **Fix:** drop the `[: token_count * 4]` re-slice. Bound content by `remaining_characters` only, and
  account tokens as `min(chunk.token_count, remaining_tokens)` scaled by how much of the content survived
  the character cap. If a chars/token bound is genuinely needed, derive it from the same tokenizer that
  produced `token_count`, not a constant.

---

### [SEVERITY: MEDIUM] Coverage runner reads unbounded subprocess stdout into memory, then checks the size limit

- **File:** `services/workers/sayre_workers/dynamic_coverage/command_runner.py:73-84`
- **Code:**
```python
stdout, _stderr = await asyncio.wait_for(
    process.communicate(payload),
    timeout=self._timeout_seconds,
)
...
if len(stdout) > _MAX_REPORT_BYTES:
    raise CoverageRunnerError("coverage runner report exceeded the size limit")
```
- **Why it's wrong:** `communicate()` buffers the child's *entire* stdout in the worker's memory before
  `len(stdout)` is ever evaluated. `_MAX_REPORT_BYTES = 1_048_576` is therefore decorative: an adapter that
  emits 8 GB (a runaway test suite dumping to stdout, or a hostile repo) OOM-kills the worker long before
  the check runs. The default timeout is 7,200 s (`command_runner.py:32`), so there is two hours of runway.
  The ingestion path already solved this correctly with a streaming byte cap
  (`ingestion/repository.py::_GIT_STDOUT_LIMIT_BYTES`, exercised at `tests/test_ingestion.py:768-771`).
- **Why it's also wrong (second defect, same block):** the process is killed only in the `TimeoutError`
  branch. If the awaiting task is cancelled — which is exactly what happens on `SIGTERM` via the
  consumer's `stop_event` shutdown path — `process` is never killed or awaited, orphaning a CI container
  that holds the repo checkout.
- **Fix:** read stdout incrementally and abort once `_MAX_REPORT_BYTES` is exceeded, mirroring
  `_GIT_STDOUT_LIMIT_BYTES`. Wrap the whole `communicate` in `try/except BaseException` (or `finally`)
  that kills and reaps the process on any exit path, not just timeout.

---

### [SEVERITY: MEDIUM] COVERS topology load has no `LIMIT` — unbounded result set into worker memory

- **File:** `services/workers/sayre_workers/dynamic_coverage/graph.py:34-57`, executed at `:87-93`
- **Code:**
```python
RETURN test.path AS test_path,
       file.path AS file_path,
       coverage.status AS status,
       coverage.last_run AS last_run
ORDER BY test.path, file.path
"""
```
- **Why it's wrong:** `execute_query` materializes every `(:Test)-[:COVERS]->(:File)` edge for the ref
  into a Python list, then `load_topology` builds a second full list of `CoverageTopologyEdge` objects
  (`graph.py:96-126`). Coverage topology is inherently quadratic-ish — a monorepo with 20k tests each
  touching 200 files is 4M edges — and the whole set is loaded on every nightly message even though
  `plan_impacted_tests` only ever consults edges whose `file_path` is in `changed_sources`
  (`impact.py:97`). Combined with the 300 s visibility timeout (`consumers.py:38`), a large tenant both
  OOMs and redelivers.
- **Fix:** push the filter into Cypher — pass `changed_paths` as a parameter and add
  `AND file.path IN $changed_paths` — and add an explicit `LIMIT` with a fail-closed full-suite fallback
  when the cap is hit (the `ImpactPlan` already has a `missing_coverage_topology` reason for exactly this).

---

### [SEVERITY: MEDIUM] Prometheus endpoint binds `0.0.0.0` with no auth and every series is labelled with `org_id`

- **File:** `services/workers/sayre_workers/config/config.py:55` and `telemetry/otel.py:191-192`
- **Code:**
```python
"METRICS_ADDR": "0.0.0.0",
...
readers.append(PrometheusMetricReader())
start_http_server(resolved_port, resolved_addr)
```
- **Why it's wrong:** `prometheus_client.start_http_server` serves `/metrics` with no authentication, and
  the default address is all interfaces. Every instrument in the fleet carries `org_id` as an attribute
  (`retrieval/metrics.py:71`, `telemetry/vector_metrics.py:86`, `graph_metrics.py:138`), and
  `onboarding_metrics.py:39` adds `repo_id` on top. Anyone who can reach port 9464 — a co-tenant pod, a
  misconfigured LB, an SSRF from any service in the VPC — enumerates the complete tenant list, their
  repository ids, their query volume, their context sizes, and their onboarding timings. That is
  cross-tenant metadata disclosure from a service whose stated posture is structural tenant isolation.
  Secondary problem: `org_id` (and `org_id × repo_id` for TTFC) is unbounded-cardinality by construction —
  a Prometheus cardinality bomb that grows linearly with customer count across nine instruments.
- **Fix:** default `METRICS_ADDR` to `127.0.0.1` and require an explicit opt-in to bind wider; scrape via
  a sidecar or an authenticated path. For cardinality, either hash/bucket `org_id` or move per-tenant
  breakdown to exemplars/logs and keep the exported series aggregate.

---

### [SEVERITY: MEDIUM] The dynamic-coverage consumer has no worker mode — it cannot be started by the fleet entrypoint

- **File:** `services/workers/sayre_workers/cli.py:39-53`
- **Code:**
```python
WorkerMode = Literal[
    "ingestion",
    "enrichment-default",
    "onboarding-priority",
    "embedding",
]
```
- **Why it's wrong:** `dynamic_coverage/consumers.py:33` defines `run_coverage_consumer`, the SQS queue
  exists (`messaging/sqs_client.py:46` + `infra/localstack/init/ready.d/01-create-sqs-queues.sh:80`), the
  producer exists (`scripts/schedule_dynamic_coverage.py`), and `docs/dynamic-coverage.md:49-51` promises a
  "long-running process wiring `run_coverage_consumer` (started the same way the ingestion/enrichment
  consumer processes are started)". It cannot be — `cli.py` has no such mode, so
  `python -m sayre_workers dynamic-coverage` fails argparse validation. `schedule_dynamic_coverage.py:15`
  quietly concedes this, suggesting operators hand-roll `poetry run python -c "..."`. In practice the
  nightly scheduler publishes to a queue that nothing drains, messages age out to the DLQ, and COVERS
  edges silently stay at `status = "inferred"` forever — which then makes `plan_impacted_tests` return
  `full_suite`/`stale_coverage_topology` (`impact.py:110`) on every run, defeating the whole feature.
- **Fix:** add `"dynamic-coverage"` to `WorkerMode`/`WORKER_MODES`, a `_run_coverage` runner, a builder
  wiring `Neo4jCoverageGraphStore.from_config()` + `CommandCoverageRunExecutor`, and a `_definition`
  branch. Note the builder must also close the Neo4j driver on shutdown — `Neo4jCoverageGraphStore.close`
  (`graph.py:82`) currently has no caller outside tests.

---

### [SEVERITY: MEDIUM] Every worker crash is reported as one fixed string with the exception discarded entirely

- **File:** `services/workers/sayre_workers/cli.py:205-211`
- **Code:**
```python
except Exception:
    print(
        f"{mode} worker FAILED: {WORKER_FAILURE}",
        file=sys.stderr,
        flush=True,
    )
    return 1
```
- **Why it's wrong:** the exception object is never bound, never logged, never counted — not even its
  class name. The secret-hygiene motivation (module docstring, `cli.py:6-8`) is legitimate, but the
  implementation over-corrects into zero observability: a missing `NEO4J_PASSWORD`, an unreachable
  Postgres, a poison message, and a genuine bug all produce the identical byte-for-byte line "The worker
  process could not be completed." Operators cannot triage a production outage, and there is no metric or
  structured event either. Note the fleet's own error types are already sanitized by construction
  (`config/secrets.py:108-123` deliberately maps everything to fixed-text `SecretResolutionError`), so
  logging `type(error).__name__` would leak nothing.
- **Fix:** log `type(error).__name__` (and the sanitized `str(error)` for the fleet's own error classes)
  via the `logging` module, and increment a `worker_crash_total{mode, error_type}` counter. Keep
  tracebacks out of stdout if desired, but record enough to distinguish failure classes.

---

### [SEVERITY: LOW] Resolved secrets are cached for the process lifetime with no invalidation

- **File:** `services/workers/sayre_workers/config/secrets.py:99, 138-169`
- **Code:**
```python
_cache: dict[str, Future[str]] = {}
...
resolution = _cache.get(canonical)
```
- **Why it's wrong:** once a secret resolves successfully it is pinned for the life of the process — only
  failures are evicted (`_evict_if_current`, `:132-135`). That is fine for the MVP `env://` backend, but
  CLAUDE.md commits to a KMS-backed manager with rotation at PM-07. After that, rotating a leaked
  credential requires restarting every long-running worker, and the workers are explicitly designed as
  long-lived queue drainers (`cli.py:159-167`). The cache is the thing that will need TTL/versioning, and
  there is no hook for it today.
- **Fix:** add a TTL or a `refresh_secret(ref)` invalidation entry point before the KMS backend lands, so
  rotation does not require a fleet restart.

---

### [SEVERITY: LOW] Full-suite fallback prefix match is broader than intended

- **File:** `services/workers/sayre_workers/dynamic_coverage/impact.py:68`
- **Code:**
```python
or normalized.startswith("scripts/test")
```
- **Why it's wrong:** unanchored prefix, so `scripts/testimonials.ts`, `scripts/tester-notes.md`, and
  `scripts/testdata/fixture.json` all force a full-suite run. Fail-safe rather than unsafe, but it
  needlessly discards targeted execution — the entire point of the feature — for unrelated files. Same
  class of issue as `build/` matching `build/docs/`.
- **Fix:** use `normalized == "scripts/test"` or `normalized.startswith("scripts/test/")`, and apply the
  trailing-slash form consistently to the other prefixes at `:66-69`.

---

## Checked and clean

- **Config insecure defaults:** none. `config/config.py:45-56` `_DEFAULTS` contains only non-secret
  values (region, API base URL, Neo4j URI/user, metrics knobs). Secrets are a separate closed catalog
  (`secrets.py:15-41`) resolved through a strict `env://NAME` grammar (`:44`) with an allowlist check
  (`:141-142`) — no `os.getenv("SECRET", "dev-fallback")` pattern anywhere in scope. Missing values raise
  `MissingConfigError`/`SecretNotFoundError` rather than defaulting. Empty-string values are rejected
  explicitly (`config.py:117-118`, `secrets.py:93-95`).
- **Telemetry leakage:** no prompt text, source code, embedding vector, secret, token, or request body is
  ever recorded. Metrics carry only numeric measurements plus id-shaped attributes. The one log statement
  in scope (`onboarding_metrics.py:41-47`) emits `org_id`/`repo_id`/duration only. Nothing is shipped to a
  third party — `otel.py` is the sole exporter-aware module and defaults to a local Prometheus scrape
  endpoint (the exposure concern is the bind address, MEDIUM above, not the payload).
- **No broad `except Exception: pass`** in scope. The two blanket handlers found are deliberate and
  documented: `secrets.py:121-122` (sanitizes to fixed-text error, re-raises) and `cli.py:150-156` (signal
  handler restore during teardown). `cli.py:205` is a blanket catch but re-raises as an exit code — logged
  as MEDIUM above for the observability loss, not for swallowing control flow.
- **Timeouts:** `command_runner.py:73-76` bounds the CI adapter at 7,200 s; `consumers.py:38` sets a 300 s
  visibility timeout. No unbounded `await` found in scope.
- **Blocking I/O in async:** none found. `psycopg.AsyncConnection` and `neo4j.AsyncDriver` are used
  throughout; `consumers.py:24-30` and `cli.py:58-62` correctly install a `SelectorEventLoop` on Windows
  for psycopg. The `_loop_factory` duplication across three modules is cosmetic.
- **Envelope tenant binding:** `dynamic_coverage/models.py:168-192` — both `parse_nightly_envelope` and
  `parse_report_envelope` overwrite any payload-supplied `org_id` with `envelope.org_id`, and
  `service.py:52-53` re-checks that the runner's report scope equals the job scope. Correct.
- **Path traversal:** `models.py:30-41` `_canonical_path` rejects absolute paths, `..`, `.`, empty
  segments, NUL, and non-canonical forms. Correct.
- **`dynamic_coverage` arithmetic:** no division at all in `impact.py`, so no divide-by-zero. Empty-input
  behavior is explicit and fail-safe: empty `changed_paths` → `missing_changed_paths` full suite
  (`impact.py:90-91`); empty resulting test set → `missing_coverage_topology` full suite (`:113-114`);
  naive datetimes rejected up front (`:84-85`) and per-edge (`graph.py:110-117`). Freshness comparison at
  `:103-109` uses the correct strict-less-than against a UTC-normalized boundary. No off-by-one found.
- **Vector search correctness (adjacent file):** metric, opclass, index, and dimension all agree — see the
  verdict section above.
