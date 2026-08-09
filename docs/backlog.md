# SUPERSEDED — historical PRD v3 backlog

> **Do not use this file for current scope, status, dependencies, scheduling, or implementation.**
> The authoritative product requirements are `docs/product/PRD-V1.md` (PRD v8, Unified Edition), and the authoritative ticket
> backlog is `docs/product/Ticket-Backlog-by-Feature-2.md`. Everything below is retained only as a
> historical record of the older PRD v3 plan and may intentionally contradict current requirements.

**How to read this — scheduling contract (v3, corrected):** the **Quick-reference dependency table at the bottom is the single source of scheduling truth.** A ticket may start when every ticket it depends on has landed — nothing more, nothing less. (The v2 claim that "every ticket within a wave has no dependency on any other ticket in that same wave" was false — e.g. W1-05→W1-01, W2-04→W2-01/W2-02, W3-02→W3-01, W4-04→W4-01 — and has been removed. Waves remain as loose phase groupings only.)

**Parallel-work caution:** several Wave 0/1 tickets touch the same files (`infra/docker-compose.yml`, `infra/.env.example`, `services/core/package.json`, `DEPENDENCIES.md`). Parallel branches will conflict on them; keep those edits append-scoped and expect trivial merge resolution, or serialize the merges.

**Executor legend:** **AI agent** = well-specified, verifiable by tests/spec-diff. **Human** = judgment call, production infra, or security/cost consequences. **Pair** = agent drafts, human reviews before merge.

---

## Wave 0 — Foundations

### W0-00 — Dependency & environment baseline ✅ LANDED
**Depends on:** none · **Executor:** AI agent · **Status: merged to main** (PR #1)

Pins every third-party dependency named in the PRD. As landed: `services/workers` uses **Poetry** (`pyproject.toml` + `poetry.lock`), not `requirements.txt` as v2's ticket text said; `infra/docker-compose.yml` pins `pgvector/pgvector:pg16` (not plain `postgres:16` — the vector extension is required), `redis:7.4-alpine`, `neo4j:5.24-community`. `DEPENDENCIES.md` records every package, its PRD section reference, and known future swaps.

### W0-01 — Monorepo & local-dev skeleton (remainder)
**Depends on:** W0-00 · **Executor:** AI agent

Partially landed with W0-00 (compose + `services/core` + `services/workers` baselines exist). Remaining scope: `apps/web` (Next.js + TS) scaffold, shared `packages/` for types, "hello world" boot for all three services, GitHub Actions CI (lint + typecheck + test on PR).
**Acceptance:** fresh clone → `docker compose up` → all services boot and health-check green; CI runs on PR.

### W0-02 — Graph DB schema & openCypher migrations
**Depends on:** W0-00 *(needs the compose Postgres running for the migration-version tracker)* · **Executor:** AI agent (schema review by human before merge)

Node labels and edge types per PRD §4.3 (including Test + COVERS, §5). Versioned, idempotent (`MERGE`) openCypher-only migrations under `services/workers/graph-migrations/`; `org_id` property placeholder on every label from day one (§4.5); applied versions tracked in Postgres.
**Acceptance:** running all migrations twice produces no duplicates; version tracking works.

### W0-03 — Service-layer convention & REST scaffold
**Depends on:** W0-00 · **Executor:** AI agent

`Route → Service → Graph Query Service` pattern per PRD §4.2 (v3 now includes reference implementations). `src/services/` (plain functions, no req/res), `src/routes/` (thin), `src/graph-query/` placeholder; one example pair.
**Acceptance (v3, reworded):** a new engineer can read one example pair and know exactly where new logic goes; a lint rule (or CI check) flags route files whose **statement count** exceeds a small threshold — the v2 "route file > ~15 lines fails CI" gate was too brittle (imports + types alone can exceed it).

### W0-04 — SQS + BullMQ wiring 🔄 IN FLIGHT (agent pipeline, 2026-07-12)
**Depends on:** W0-00 *(reuses the compose Redis; adds a pinned LocalStack service)* · **Executor:** AI agent

As specified in v2, plus locked decisions: LocalStack for SQS; typed job definitions with **exactly three queues** (`github-sync`, `jira-sync`, `linear-sync`) — future git providers (e.g. Cursor Origin) are a provider-keyed **job type** on `github-sync`, per the async-messaging rule; a standard **tenant-scoped message envelope** carrying server-resolved `org_id` in both languages (snake_case wire keys — `graph.updated` crosses the Python↔Node boundary); ingestion and enrichment on separate SQS queues so structural sync never blocks on LLM latency.
**Acceptance:** Python→Python SQS roundtrip and Node→Node BullMQ roundtrip proven by local integration tests.

### W0-05 — PostgreSQL schema & migrations 🔄 IN FLIGHT (agent pipeline, 2026-07-12)
**Depends on:** W0-00 *(needs the compose Postgres)* · **Executor:** AI agent

Tool locked: **Drizzle** (drizzle-orm + drizzle-kit) on the already-pinned `pg` driver. RLS policies, `set_config('app.org_id', …)` transaction-scoped session context, and org/repo/branch/path prefix indexing authored as explicit raw-SQL migration steps. RLS is `org_id` tenant isolation only (defense-in-depth, §4.5) — the full org/repo/branch/path RBAC stays in the Graph Query Service. Tenant traffic runs as a non-superuser `NOBYPASSRLS` role (superuser connections bypass RLS silently — the test must not pass vacuously).
**Acceptance:** automated RLS test proves one org's session cannot see another org's rows, under the non-superuser role.

### W0-06 — Vector-store concurrency instrumentation 🔄 IN FLIGHT (agent pipeline, 2026-07-12)
**Depends on:** W0-00 *(needs the compose Postgres; adds Prometheus/OTel services)* · **Executor:** AI agent

Backend locked: **OpenTelemetry → Prometheus** (exporter swappable to Datadog/CloudWatch without touching call sites). `vector_query_duration_ms` (histogram) + `vector_query_concurrent_count` (up/down counter), tagged by server-side `org_id`. This is the data source for §4.10's pgvector→OpenSearch trigger and PM-02's dashboard.
**Acceptance:** 50 concurrent synthetic queries locally produce visible concurrency + latency metrics in Prometheus.

### W0-07 — Embedding provider decision & pin *(NEW in v3 — closes a blocking gap)*
**Depends on:** W0-00 · **Executor:** Pair (decision: human; pin + doc: agent)

W1-05 "writes embeddings to pgvector" and §2.5's RAG depends on them — but no embedding library exists in the dependency baseline (the Anthropic API does not provide embeddings). Choose the provider (recommendation: **Voyage AI** `voyage-code-3`, Anthropic's recommended embeddings partner, code-optimized; alternatives: OpenAI `text-embedding-3-*`, local sentence-transformers), pin the client in `services/workers` deps + `DEPENDENCIES.md`, and document vector dimensions + chunking implications for the pgvector schema.
**Acceptance:** provider chosen and recorded; client pinned; a fixture chunk embeds and round-trips through pgvector locally.

---

## Wave 1 — Core pipelines

### W1-01 — Multi-language Tree-sitter parsing module
**Depends on:** W0-02 · **Executor:** AI agent — *(unchanged from v2)*

### W1-02 — GitHub webhook receiver
**Depends on:** W0-04 · **Executor:** AI agent

**Envelope corrected (v3):** normalized events publish as `{provider, type, repo, ref, org_id, payload}` — the `provider` field per §6.2's provider-generic mandate (v2's envelope omitted it, then PM-06 assumed it), and `org_id` **server-resolved** from the App-installation→org mapping, never read from the payload. `X-Hub-Signature-256` validated before anything touches a queue; invalid signatures → 401, never enqueued.
**Acceptance:** replayed fixtures produce correct queue messages; tampered payloads rejected; a payload attempting to smuggle `org_id` gets the server-resolved value, not the smuggled one.

### W1-03 — AuthN/AuthZ middleware
**Depends on:** W0-05, W0-03, **W1-06** *(needs issued sessions to validate)* · **Executor:** Pair (security-sensitive) — *(otherwise unchanged from v2)*

### W1-04 — Next.js shell + Sigma.js base renderer *(retooled in v3)*
**Depends on:** W0-01, W0-03 · **Executor:** AI agent

Application shell, auth screens, and a **Sigma.js (WebGL)** canvas rendering a static/mock node-edge payload. React Flow is dropped per §4.10 — Sigma.js is the single renderer at every scale, so the mock canvas is built on the real renderer from day one (no throwaway dual-renderer work, no W2 cutover).
**Acceptance:** loading the app renders a mock graph of ~20 nodes with pan/zoom working, in Sigma.js.

### W1-05 — Ingestion/Delta Worker core
**Depends on:** W1-01, W0-02, W0-04, **W0-07** *(embedding provider must exist before the embedding pass)* · **Executor:** AI agent — *(otherwise unchanged from v2: scratch clone destroyed after parsing, §4.5)*

### W1-06 — Auth issuance & org bootstrap *(NEW in v3 — closes a blocking gap)*
**Depends on:** W0-05, W0-03 · **Executor:** Pair (security-sensitive)

v2 had W1-03 *validating* JWTs and W1-04 building "auth screens" with **nothing that issues a session or creates an org/user**. Scope: signup/login (GitHub OAuth for MVP), organization creation/bootstrap, JWT/session issuance consumed by W1-03, `users`/`organizations` rows per the W0-05 schema.
**Acceptance:** a new user can sign up, create an org, and receive a session that W1-03 validates; a second org's user cannot see the first org's data (ties into the W0-05 RLS test).

### W1-07 — GitHub App installation & cold-start onboarding *(NEW in v3 — closes a blocking gap)*
**Depends on:** W1-06, W0-04 · **Executor:** Pair

§4.4's cold-start flow ("user authorizes the GitHub App → full-parse job runs") had no ticket: W1-02 handles push webhooks, W3-04 syncs metadata — nothing installed the App or dispatched the initial parse. Scope: App install/callback/token exchange, repo selection UI hook, installation→org mapping (the table W1-02's `org_id` resolution reads), dispatch of the initial full-parse job onto SQS, "generating" states per §4.4.
**Acceptance:** authorizing the App against a fixture org dispatches exactly one full-parse job with the correct server-resolved `org_id` and surfaces the generating state.

---

## Wave 2 — Canvas & query layer

### W2-01 — At-scale rendering hardening *(retooled in v3)*
**Depends on:** W1-04 · **Executor:** AI agent

Sigma.js is already the base renderer (W1-04), so this becomes the at-scale pass: 2,000-node fixture performance, layout pre-processing, and a **documented graphology operation allowlist** (e.g. `subgraph()`, local `filterNodes()`) — never RBAC or deep traversal, which stay server-side (§4.2/§4.10).
**Acceptance:** a 2,000-node fixture renders smoothly; code-review checklist confirms no traversal/RBAC logic in the graphology layer.

### W2-02 — Graph Query Service
**Depends on:** W1-03, W0-02, W1-05 · **Executor:** Pair (security-sensitive) — *(unchanged from v2)*

### W2-03 — WebSocket gateway + Redis pub/sub
**Depends on:** W1-03, W1-05 · **Executor:** AI agent — *(unchanged from v2)*

### W2-04 — Technical Tree end-to-end
**Depends on:** W2-01, W2-02 · **Executor:** AI agent — *(unchanged from v2)*

### W2-05 — Semantic Enrichment Worker skeleton
**Depends on:** W1-05, W0-04 · **Executor:** AI agent — *(unchanged from v2)*

### W2-06 — Tenant isolation enforcement
**Depends on:** W0-02, W0-05, W1-03 · **Executor:** Human (security-critical) — *(unchanged from v2)*

### W2-07 — Test node type + static COVERS inference
**Depends on:** W1-01, W0-02 · **Executor:** AI agent — *(now specified by §5.1)*

---

## Wave 3 — Semantic layer & integrations

### W3-01 — Feature clustering — **Depends on:** W2-05 · AI agent *(unchanged)*
### W3-02 — Product Tree UI + Feature Cluster metadata panel — **Depends on:** W3-01, W2-01 · AI agent *(unchanged)*
### W3-03 — Graph-Guided RAG service — **Depends on:** W2-02, W0-06, **W0-07** · AI agent *(embedding dep added)*
### W3-04 — GitHub sync integration worker — **Depends on:** W1-02, W0-04, W0-02 · AI agent *(unchanged; provider-generic interface per §6.2 — the envelope's `provider` field arrives from W1-02)*
### W3-05 — Jira/Linear sync integration worker — **Depends on:** W0-04, W0-05, W0-02 · AI agent *(unchanged)*
### W3-06 — Coding/comment style tagging + folder inheritance — **Depends on:** W2-05, W2-02 · AI agent *(unchanged)*

### W3-07 — Node Risk & Health Signals computation *(NEW in v3 — implements §4.11)*
**Depends on:** W1-05, W2-07, W3-04 · **Executor:** AI agent

Compute and maintain the four §4.11 signals as graph node properties: **fan-in** (inbound CALLS/IMPORTS aggregated to File, rolled up to Folder) at ingestion + delta; **coverage state** (covered/uncovered/stale) from COVERS edges + §5.3 freshness; **churn/recency** (90-day commit frequency + last-touched) from GitHub sync data; **ownership** (primary owner + recent editors) from OWNS/AUTHORED/MODIFIED.
**Acceptance:** a fixture repo yields correct fan-in counts verified against a hand-computed sample; signals update on a delta push within the 15s sync budget (excluding the nightly coverage refresh).

---

## Wave 4 — Onboarding, overlay & hardening

### W4-01 — Onboarding Tree + sandboxed setup exec
**Depends on:** **W2-05** *(corrected from v2's W3-01 — EnvStep generation comes from the Enrichment Worker, not feature clustering)*, W0-05 · **Executor:** Pair — *(otherwise unchanged)*

### W4-02 — Interactive Node Overlay Panel *(now seven layers)*
**Depends on:** W3-04, W3-05, W3-06, W3-01, **W3-07** · **Executor:** AI agent

All **seven** overlay layers per §4.8: Dependencies, Recent Changes, Specific Features, Agent/Skill MD, Description, Specific Tickets, **Risk Signals (§4.11)** — each independently toggleable, re-rendering only its own section.
**Acceptance:** toggling any layer never re-queries the graph; all seven show real data once a fixture repo is fully ingested.

### W4-03 — Dynamic COVERS refresh + test badges
**Depends on:** W2-07, W2-04 · **Executor:** AI agent

Per §5: nightly coverage-instrumented COVERS refresh; pass/fail + stale badges on the Technical Tree; **"inconclusive" is now defined** (§5.3: no COVERS edges / coverage > 7 days old / partial parse / build-config change) with hard fallback to the full suite.
**Acceptance:** per §5.3/§5.4 — including the fallback firing on each defined inconclusive condition.

### W4-04 — Full RBAC & multi-tenancy hardening pass — **Depends on:** W2-06, W2-04, W3-02, W4-01 · Human *(unchanged)*
### W4-05 — DataLoader-readiness review — **Depends on:** Waves 0–3 API tickets · AI agent, doc-only *(unchanged; feeds PM-05 per §4.2's batching caveat)*

---

## Post-MVP — Trigger-gated

| Ticket | Scope | Gate / Depends on | Executor |
|---|---|---|---|
| PM-01 | Macro View: Project entity + CONNECTS_TO cross-repo edges (§1.2) | W0-02, W3-04 | AI agent |
| PM-02 | Migration-trigger dashboard surfacing W0-06 + graph-load metrics against the §4.10 thresholds | W0-06 | AI agent |
| PM-03 | Neo4j → Neptune cutover | §4.10 threshold crossed (via PM-02) | Human (infra-critical) |
| PM-04 | pgvector → OpenSearch cutover | §4.10 threshold crossed (via W0-06/PM-02) | Human (infra-critical) |
| PM-05 | GraphQL layer + DataLoader batching | §4.10 REST→GraphQL gate; uses W4-05's plan | Pair |
| PM-06 | Cursor Origin connector (new provider plug-in on W1-02's envelope + W3-04's interface) | Origin publishes public API/webhook docs | AI agent |
| PM-07 *(new)* | Language coverage expansion (Go/Java/Rust grammars + fixtures) | W1-01 | AI agent |
| PM-08 *(new)* | Collaborative annotations on the graph | W2-04 | AI agent |
| PM-09 *(new)* | Admin billing/plan console (adds billing tables — deliberately absent from W0-05's MVP schema) | W1-06 | Pair |
| PM-10 *(new)* | TTFC + token-reduction KPI instrumentation (makes §4.6's TTFC-40% and 70x targets measurable; W3-03 logs the token ratio, nothing measured TTFC) | W4-01, W1-06 | AI agent |

---

## Historical quick-reference only — **not a scheduling source**

| Ticket | Depends on | Wave |
|---|---|---|
| W0-00 | — ✅ landed | 0 |
| W0-01 | W0-00 | 0 |
| W0-02 | W0-00 | 0 |
| W0-03 | W0-00 | 0 |
| W0-04 | W0-00 🔄 in flight | 0 |
| W0-05 | W0-00 🔄 in flight | 0 |
| W0-06 | W0-00 🔄 in flight | 0 |
| W0-07 | W0-00 | 0 |
| W1-01 | W0-02 | 1 |
| W1-02 | W0-04 | 1 |
| W1-03 | W0-05, W0-03, W1-06 | 1 |
| W1-04 | W0-01, W0-03 | 1 |
| W1-05 | W1-01, W0-02, W0-04, W0-07 | 1 |
| W1-06 | W0-05, W0-03 | 1 |
| W1-07 | W1-06, W0-04 | 1 |
| W2-01 | W1-04 | 2 |
| W2-02 | W1-03, W0-02, W1-05 | 2 |
| W2-03 | W1-03, W1-05 | 2 |
| W2-04 | W2-01, W2-02 | 2 |
| W2-05 | W1-05, W0-04 | 2 |
| W2-06 | W0-02, W0-05, W1-03 | 2 |
| W2-07 | W1-01, W0-02 | 2 |
| W3-01 | W2-05 | 3 |
| W3-02 | W3-01, W2-01 | 3 |
| W3-03 | W2-02, W0-06, W0-07 | 3 |
| W3-04 | W1-02, W0-04, W0-02 | 3 |
| W3-05 | W0-04, W0-05, W0-02 | 3 |
| W3-06 | W2-05, W2-02 | 3 |
| W3-07 | W1-05, W2-07, W3-04 | 3 |
| W4-01 | W2-05, W0-05 | 4 |
| W4-02 | W3-01, W3-04, W3-05, W3-06, W3-07 | 4 |
| W4-03 | W2-07, W2-04 | 4 |
| W4-04 | W2-06, W2-04, W3-02, W4-01 | 4 |
| W4-05 | Waves 0–3 API tickets | 4 |
| PM-01…PM-10 | see Post-MVP table | PM |

*Note: cross-wave dependencies (e.g. W1-05→W1-01, W2-04→W2-01/W2-02, W3-02→W3-01, W4-04→W4-01) are intentional and were always in the table — the table, not wave membership, decides start order.*
