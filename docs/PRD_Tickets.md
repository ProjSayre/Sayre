# **Ticket Backlog v3** 

Codebase Ontology, Visualization, Agent Context & Model Provider Platform — derived from PRD v5 (Unified Edition) · July 2026 

## **How to read this** 

Tickets are grouped into waves, but the dependency table—not wave membership—controls readiness. A ticket starts only when its listed dependencies have landed. Tickets in the same wave may therefore require sequencing; independent tickets may run in parallel after their prerequisites land.

“Executor” is a suggestion, not a rule: **AI agent** = well-specified, low-ambiguity, easy to verify by tests or diffing against the spec; **Human** = needs a judgment call, touches production infra, or has security/cost consequences; **Pair** = an agent can draft it but a human should review before merge. 

**What changed in v2:** five gap-fix tickets added (W0-07 secrets convention, W0-08 graph-DB instrumentation, W1-06 GitHub App flow, W2-08 onboarding priority lane, PM-07 secrets cutover); one new capability ticket (W4-06 MCP Server surface) implementing the Agent Context Layer; W4-02 amended to make Agent/Skill MD a dual-surface contract; W3-04 amended with the provider-generic hard criterion; W4-04 expanded to audit the MCP surface and moved to Wave 5; PM02 now owns defining concrete threshold numbers; PM-06 reframed; PM-08 added for the trigger-gated MCP write path. 

**What changed in v3 (this edition — corrects an omission):** four tickets implementing PRD v5’s Pluggable Model Provider Layer and Local-Model Interoperability were previously drafted in a standalone amendment document but never actually merged into this backlog — that omission is fixed here. Added: **W3-07** (Model Provider adapter interface — Anthropic/OpenAI/self-hosted), **W3-08** (circuit breaker & degraded states for self-hosted endpoints), **W3-09** (provider settings UI), **W4-07** (MCP local-model client interoperability verification). W3-07’s acceptance criteria are also extended in v3 to cover the structural data-sovereignty guarantee (PRD v5 §2.7/§4.2): a network-isolated test proving zero outbound calls to any third-party model endpoint when an org is configured for self-hosted. Ticket IDs are stable across all editions; wave assignment is authoritative from the table at the end, not from the ID prefix. 

## **Wave 0 — Foundations (dependency-gated; not all nine start together)**

### **W0-00 — Dependency & environment baseline** 

#### **Depends on:** none · **Executor:** AI agent 

The one ticket every other ticket implicitly assumes is already done. Pins every third-party dependency named in the PRD to a specific version, in one place, so no two parallel Wave 0/1 tickets pick incompatible versions of the same library. 

#### **What it should look like:** 

|apps/web/package.json<br> <br>services/core/package.json<br> <br>|next, react, @xyflow/react 12.11.x, sigma, graphology,<br>graphology-layout, tailwindcss, typescript<br>express, bullmq, ioredis, neo4j-driver, pg, jsonwebtoken,<br>@modelcontextprotocol/sdk 1.29.x, zod 4.4.x,<br>@aws-sdk/client-sqs, @aws-sdk/client-sns,<br>@opentelemetry/api, sdk-metrics, exporter-prometheus|
|---|---|
|services/workers/pyproject.toml<br> <br> <br>|fastapi, uvicorn, tree-sitter + language grammars,<br>langchain, langgraph, base graphifyy==0.9.16,<br>openai 2.45.*, boto3 (SQS/SNS), psycopg[binary],<br>pgvector, anthropic|
|infra/<br>|docker-compose service images pinned to specific<br>tags (postgres:16, redis:7, neo4j:5-community)|



DEPENDENCIES.md records each package and known future swap. Graphify is installed base-only and is reachable only through Sayre's `GraphifyAdapter`; it never replaces W1-01's structural Tree-sitter parser. Model SDK construction is owned by `ModelProvider`, and no LangChain provider-adapter package is added in this baseline. Node remains 20 and Python remains 3.12.

**Acceptance criteria:** a fresh clone installs every dependency with zero version-resolution warnings/conflicts across apps/web, services/core, and services/workers; DEPENDENCIES.md lists every package plus its PRD section reference. 

### **W0-01 — Monorepo and local-dev skeleton** 

#### **Depends on:** W0-00 · **Executor:** AI agent 

Scaffold the repo: apps/web (Next.js + TypeScript), services/core (Node.js API), services/workers (Python FastAPI), shared packages/ for types. Docker Compose for local Postgres, Redis, and a Neo4j container. Base CI (lint, typecheck, test) on every push. 

**Acceptance criteria:** fresh clone -> docker compose up -> all three services boot and health-check green; GitHub Actions runs lint + test on PR. 

### **W0-02 — Graph DB schema & openCypher migrations** 

**Depends on:** W0-00 · **Executor:** AI agent (schema review by human before merge) 

Define the logical graph schema per PRD §4.3: node labels Project, Repo, Folder, File, Function, Class, Module, Person, Commit, Feature, Ticket, EnvStep, Test; edge types CONTAINS, CONNECTS_TO, IMPORTS, CALLS, INHERITS, OWNS, AUTHORED, MODIFIED, REFERENCES, PART_OF, REQUIRES, DEPENDS_ON, COVERS. Logical schema, data migrations, and application queries use portable openCypher-compatible constructs. Constraints, indexes, and other physical DDL are target-specific, versioned per graph target, and must not be represented as Neo4j DDL that replays unmodified on Neptune.

**Identity and node properties:** Repository identity is stable, ref identity is mutable, and revision identity is an immutable commit SHA. Repository-scoped data carries server-resolved org_id/repo_id; ref-scoped data also carries ref_name; revision-bearing data records revision_sha. Stable node UIDs include repository/ref scope and canonical path/symbol identity. Feature: description, team. Folder: codingStyle and commentStyle as distinct properties. File/Folder: agentSkillMd, an API-stable MCP contract. Commit: sha, message, timestamp, author. Person: name, email/GitHub identity. Ticket: externalId, system, status. EnvStep: sequence, command. Test: coverage_status (`pass`, `fail`, or `unknown`).

**Edge properties:** COVERS links Test to a covered graph node only when both endpoints share authorized org/repository/ref/revision scope. It carries nullable last_run and status (`inferred` or `measured`); AUTHORED/MODIFIED carry timestamps.

#### **What it should look like:** 

services/workers/graph-migrations/ 001_init_node_labels.cypher 002_init_edge_types.cypher 003_constraints_and_indexes.cypher 004_test_covers_contract.cypher

Logical data migrations are idempotent (`MERGE`, not `CREATE`) with org_id on every node label. Target-specific physical migrations are independently idempotent for that target.

**Acceptance criteria:** replaying logical data migrations produces no duplicate data; replaying each target's physical migrations produces no duplicate constraints/indexes; migration history is tracked by logical/physical layer and graph target; identity and same-scope COVERS invariants are tested.

### **W0-03 — Service-layer convention & REST scaffold** 

#### **Depends on:** W0-00 · **Executor:** AI agent 

Establish the Route -> Service -> Graph Query Service pattern from PRD §4.2 before any real endpoint exists. **v2 note:** this pattern now has three thin-wrapper consumers, not two — REST routes (now), GraphQL resolvers (later, PM-05), and MCP tool handlers (W4-06). The example pair and the lint rule should mention all three so nobody writes logic into an MCP handler either. 

#### **What it should look like:** 

##### services/core/ 

src/services/         # plain functions, no req/res, no Express types src/routes/           # thin — parse req, call service, res.json() src/graph-query/      # placeholder client, filled in by W2-02 src/mcp/              # empty placeholder dir + README pointing at W4-06 

A services/exampleService.ts + routes/example.ts pair, plus a lint rule (or code-review checklist item) that flags business logic written directly in src/routes/ or src/mcp/. 

**Acceptance criteria:** a new engineer can read one example pair and know exactly where new logic goes; CI fails if a route file exceeds ~15 lines. 

### **W0-04 — SQS + BullMQ wiring** 

#### **Depends on:** W0-00 · **Executor:** AI agent 

Stand up the approved local messaging topology: LocalStack for SQS/SNS (Python worker/event fleet) and Redis for BullMQ (Node integration workers). Repository ingestion uses an SQS FIFO queue grouped by org/repository/ref. After an idempotent graph transaction commits, the accepted `graph.updated` event is published to SNS and fanned out to independent realtime and enrichment subscriptions. W0-04 also provisions a physical `embedding-upserts` SQS work queue so W1-05 can dispatch vector work only after the accepted structural event. Enrichment uses separate physical `enrichment-onboarding-priority` and `enrichment-default` queues with priority-only capacity plus bounded weighted polling. Every work queue, including `embedding-upserts`, has a DLQ (five receives, 14-day retention); long-running consumers extend visibility with a heartbeat, and durable idempotency/graph-version checks protect all at-least-once deliveries.

**Acceptance criteria:** local tests prove Python FIFO publish/consume ordering, SNS fanout to independent subscriptions, `embedding-upserts` publication/consumption, priority work draining ahead of default backlog without permanent starvation, DLQ redrive, visibility heartbeat, durable duplicate suppression, and a Node BullMQ round trip.

### **W0-05 — PostgreSQL schema & migrations** 

#### **Depends on:** W0-00 · **Executor:** AI agent 

Per PRD §4.3: organizations, users, repositories, permissions (scoped by org/repo/ref/path), ticket cache, style rules, onboarding steps, and the following foundation datasets: `github_app_installations`; audited org-scoped `mcp_client_keys`; purpose-keyed `model_provider_configs` for generation and embedding, storing endpoint/model and a pre-provisioned credential reference but never a raw credential; `repository_refs` recording each mutable ref's accepted revision and graph version; bounded tenant `code_chunks`; and `code_embeddings` keyed to their originating graph node/chunk. Embeddings are `vector(1024)` values compared with cosine distance and record provider, model, and dimension metadata. Row-level security is enabled from the start.

`mcp_client_keys` use a public key ID/prefix and a 256-bit cryptographically random secret returned only once. Rows store only an HMAC-SHA-256 digest made with a server-held pepper plus `pepper_version`, `created_by_user_id`, `created_at`, `expires_at`, `last_used_at`, `revoked_at`, and `revoked_by_user_id`; the raw secret is never persisted. Key scope reuses existing `permissions` rows with an agent-key subject. Creation rejects any requested scope broader than the issuer's effective org/repo/ref/path scope, and effective key scope remains the intersection of the key permissions, the recorded issuance ceiling, and the issuer's current scope.

**Acceptance criteria:** an automated test using the actual non-owner, non-superuser, `NOBYPASSRLS` runtime role proves that one org cannot see or mutate another org's rows across every tenant table. MCP tests prove 256-bit issuance, public ID/prefix lookup, HMAC-SHA-256 verification by pepper version, expiry/last-use/revocation audit behavior, permission reuse, and rejection of issuer-scope escalation; no raw key or provider credential is stored. Repository/ref/version and chunk/embedding tenant-consistency constraints, provider/model/dimension metadata, `vector(1024)`, and cosine-distance behavior are tested.

### **W0-06 — Vector-store concurrency instrumentation** 

#### **Depends on:** W0-00 · **Executor:** AI agent 

Per PRD §4.10, the pgvector -> OpenSearch migration trigger must be a measured number, not a guess. Wrap every pgvector query with timing + concurrency counters emitting vector_query_duration_ms and 

vector_query_concurrent_count , tagged by org_id, to the chosen metrics backend (pick one now: Prometheus/Grafana, Datadog, or CloudWatch — document the choice, W0-08 must use the same one). 

**Acceptance criteria:** 50 concurrent synthetic queries locally produce visible concurrency + latency metrics in the chosen backend. 

### **W0-07 — Secrets convention & loader** **_(new in v2)_** 

**Depends on:** W0-00 · **Executor:** Pair (security-adjacent even at MVP) 

PRD v4 §4.5 defines a staged secrets posture: env files for MVP behind a single loader, KMS-backed manager on customer trigger (PM-07). This ticket establishes the convention once, before W1-02, W1-06, W3-04, and W3-05 each start consuming GitHub App keys and Jira/Linear OAuth tokens. 

**What it should look like:** a single packages/config/secrets.ts (Node) and services/workers/config/secrets.py (Python)—the only code paths allowed to resolve a secret, shaped as getSecret(reference) so PM-07's backend swap touches no call sites. Credential references are pre-provisioned and server-controlled; local references may resolve to a gitignored environment value. A committed .env.example lists placeholders; CI rejects secret reads outside the loaders; SECRETS.md names each secret, consumer, reference, and PM-07 cutover plan. Provider settings through W3-09 select a reference and cannot submit raw credentials.

**Acceptance criteria:** a fresh clone with a populated .env boots all three services; a PR reading a secret outside the loader fails CI; SECRETS.md names every secret Waves 1-3 will need. 

### **W0-08 — Graph DB concurrency instrumentation** **_(new in v2)_** 

#### **Depends on:** W0-00 · **Executor:** AI agent 

Mirror of W0-06 for the graph store. PM-03’s Neo4j -> Neptune cutover is gated on measured multi-tenant concurrent load against Neo4j; without this ticket that trigger can never fire on data. A thin wrapper around every Neo4j driver call, emitting graph_query_duration_ms , graph_query_concurrent_count , graph_query_result_node_count , tagged by org_id and query shape (viewport read / write / traversal), to the same backend W0-06 chose, with matching naming conventions so PM-02’s dashboard renders both stores side by side. 

**Acceptance criteria:** 50 concurrent synthetic Cypher queries against local Neo4j produce visible metrics tagged by org and query shape; metric names and tags match W0-06’s conventions. 

## **Wave 1 — Core pipelines (needs Wave 0)** 

### **W1-01 — Multi-language Tree-sitter parsing module** 

**Depends on:** W0-02 · **Executor:** AI agent 

Incremental + full-parse AST extraction (JS/TS/Py/Go to start) producing structural relationships (calls, inheritance, imports) as intermediate data ready to write to the graph. One grammar adapter per language behind a common ParseResult interface ({functions, classes, imports, calls, inherits}), callable as “full parse” (cold start) and “diff parse” (changed files only). 

**Acceptance criteria:** parsing a small fixture repo produces the expected function/class/import graph, verified by a snapshot test. 

### **W1-02 — GitHub webhook receiver** 

**Depends on:** W0-04, W0-07 · **Executor:** AI agent 

Signature-validated webhook endpoint that normalizes GitHub events (push, PR, branch) onto SQS for the Ingestion Worker and BullMQ for the ownership pipeline. POST /webhooks/github validates X-Hub-Signature-256, publishes a normalized {provider, type, repo, ref, payload} envelope (note the provider field — the normalized schema is shared with W3-04’s provider-generic requirement). Webhook secrets are read exclusively via the W0-07 loader. 

**Acceptance criteria:** replayed GitHub webhook fixtures produce the correct queue messages; a tampered payload is rejected with 401 and never reaches a queue; no secret is read outside the loader. 

### **W1-03 — AuthN/AuthZ middleware** 

**Depends on:** W0-05, W0-03 · **Executor:** Pair (security-sensitive) 

JWT/session validation plus RBAC middleware filtering every request before it reaches a service function. Express/Next.js middleware chain — authenticate() then authorize(requiredScope) — attaching { userId, orgId, roles } to req.context. **v2 note:** design the context shape so W4-06’s MCP Gateway can attach an equivalent { agentKeyId, orgId, roles } context and flow through the same service-layer checks — one permission model, two front doors. 

**Acceptance criteria:** an unauthenticated request is rejected before any service function runs; a request scoped to org A cannot fetch org B’s data; the context type is documented as the single auth contract for REST and (future) MCP entry points. 

### **W1-04 — Next.js shell + React Flow base renderer** 

**Depends on:** W0-01, W0-03 · **Executor:** AI agent 

Application shell, auth screens, and a React Flow canvas rendering a static/mock node-edge payload — the foundation the Sigma.js work (W2-01) extends. 

**Acceptance criteria:** loading the app renders a mock graph of ~20 nodes with pan/zoom working. 

### **W1-05 — Ingestion/Delta Worker core** 

**Depends on:** W1-01, W0-02, W0-04, W0-05, W0-06, W0-07 · **Executor:** AI agent

Clones/diffs a repo, runs Tree-sitter (full on cold start, changed-file delta thereafter), and applies idempotent node/edge upserts for the next accepted repository/ref/revision. Before a delta, it verifies that the accepted revision is an ancestor of the incoming revision; a force-push or other non-fast-forward divergence triggers a full rebuild of that organization/repository/ref head projection instead of applying a changed-file delta. After the graph transaction commits, it publishes the accepted `graph.updated` event through W0-04's SNS fanout, making structural data available. Only then does it dispatch bounded chunks to W0-04's asynchronous `embedding-upserts` queue; embedding latency is never inside the 15-second structural target. W1-05 owns the first Sayre `EmbeddingProvider` implementation, separate from generation `ModelProvider`: an OpenAI-compatible embeddings adapter using local-compatible `Qwen3-Embedding-0.6B` by default, with exactly 1024 finite dimensions, plus a deterministic network-free 1024-dimensional CI fake. The embedding consumer persists cosine vectors with provider/model/dimension metadata. It recognizes `repo.initial_parse` and delta jobs, uses W0-05 repository-ref version state, and destroys the scratch clone after parsing. Bounded tenant code/document chunks may persist for RAG, but a checkout or source tree may not.

**Acceptance criteria:** a fixture initial parse and fast-forward delta produce correct scoped Folder/File/Function nodes and deletes; stale/replayed revisions are harmless; a force-push fixture performs a full scoped rebuild and removes structural nodes from the abandoned head; the graph commit and accepted `graph.updated` event complete within 15 seconds before `embedding-upserts` publication. The deterministic fake proves stable 1024-dimensional output and the concrete adapter rejects non-1024/non-finite output; stored vectors use cosine distance and provider/model/dimension metadata. The scratch checkout is removed and cannot be reconstructed from persisted chunks.

### **W1-06 — GitHub App: registration, install flow & initial-parse trigger** **_(new in v2)_** 

**Depends on:** W0-05, W0-07 · **Executor:** Pair (OAuth is security-sensitive) 

The cold-start walkthrough (§4.4) begins “user installs the GitHub App”—this ticket owns that entry point: the App manifest, install/OAuth callback, installation metadata plus a pre-provisioned credential reference, and enqueueing the first full-parse job. It never stores a raw installation credential. The end-to-end proof that a fresh install produces graph nodes requires W1-05 and is verified later rather than folding that dependency into this ticket.

**What it should look like:** a GitHub App manifest checked into infra/github-app/ so the App is recreatable per environment; GET /integrations/github/install starting the flow; GET /integrations/github/callback storing the installation ID in Postgres against the org (credentials via the W0-07 loader) and enqueueing repo.initial_parse onto the SQS queue W1-05 consumes; uninstall webhook marking the installation revoked without erroring on later inbound events. 

**Acceptance criteria:** the callback stores installation records and enqueues the correctly shaped repo.initial_parse message (verified against a queue fixture); revoked installations halt further sync processing; installation credentials are never read outside the W0-07 loader. 

## **Wave 2 — Canvas & query layer (needs Wave 1)** 

### **W2-01 — Sigma.js + graphology at-scale rendering** 

**Depends on:** W1-04 · **Executor:** AI agent 

Sigma.js (WebGL) as the renderer above the ~500-node threshold, with graphology handling client-side filtering/subgraph extraction — never RBAC or deep traversal, which stay server-side (§4.2). The node-count signal from the backend switches renderers automatically; graphology usage is limited to a documented allowlist. 

**Acceptance criteria:** a 2,000-node fixture graph renders smoothly in Sigma.js; a code-review checklist confirms no traversal/RBAC logic in the graphology layer. 

### **W2-02 — Graph Query Service** 

**Depends on:** W1-03, W0-02, W1-05 · **Executor:** Pair (security-sensitive: RBAC node stripping) 

Translates viewport/view-filter requests into Cypher queries, with RBAC-based node stripping happening server-side before any data leaves the server. getNodesInViewport(repoId, viewport, ctx) , getStructuralEdges(nodeIds, ctx) — every method takes the auth context and filters results before returning. **v2 note:** these same methods back W4-06’s MCP tools; keep signatures interface-driven so an MCP call and a REST call are indistinguishable to this layer. 

**Acceptance criteria:** a user without access to a given Folder never receives that node, verified with two differently scoped users against the same repo. 

### **W2-03 — WebSocket gateway + Redis pub/sub** 

**Depends on:** W1-03, W1-05 · **Executor:** AI agent 

Realtime Service fanning out graph.updated events, re-filtered per client’s RBAC scope on every fan-out message, not just initial load. 

**Acceptance criteria:** a delta push patches only the affected nodes on a connected client within the 15s target; an unauthorized client never receives a patch for a node it can’t see. 

### **W2-05 — Semantic Enrichment Worker skeleton** 

**Depends on:** W1-05, W0-04 · **Executor:** AI agent 

Consumes accepted structural events from queues separate from ingestion, so LLM latency never blocks structural sync. From day one it calls Sayre-owned `GraphifyAdapter` and `ModelProvider` interfaces; orchestration may use LangChain/LangGraph, but no worker path hardcodes Claude or any other vendor or imports a vendor SDK directly. `GraphifyAdapter` constrains semantic output to graph primitives and never replaces W1-01's Tree-sitter parser. It consumes the physical default and onboarding-priority lanes W0-04 provisioned.

**Acceptance criteria:** fake `GraphifyAdapter` and `ModelProvider` implementations prove enrichment starts only after structural sync, never blocks Technical Tree availability, and writes valid graph primitives; tests fail on direct vendor SDK construction outside adapter implementations.

### **W2-06 — Tenant isolation enforcement** 

**Depends on:** W0-02, W0-05, W1-03 · **Executor:** Human (security-critical) 

Structural tenant isolation per §4.5: org_id stamped on every graph write, injected server-side on every query (never client-supplied), Postgres RLS as defense-in-depth, per-tenant vector-store namespaces. 

**Acceptance criteria:** a penetration-style test attempting to pass a forged org_id from the client is rejected; isolation 

holds even if RBAC middleware is bypassed at a lower layer. 

### **W2-07 — Test node type + static COVERS inference** 

**Depends on:** W1-01, W0-02 · **Executor:** AI agent 

Parse test files as Test nodes during Tree-sitter ingestion; infer COVERS edges statically from imports, setting `status` to `inferred` and leaving nullable `last_run` unset so W4-03’s measured refresh can distinguish them.

**Acceptance criteria:** a fixture repo with test files produces correct Test nodes and COVERS edges pointing at the modules they import. 

### **W2-08 — Onboarding-priority queue lane** **_(new in v2)_** 

**Depends on:** W0-04, W1-05 · **Executor:** AI agent 

§4.6 names the lever behind the 40% TTFC target: Onboarding Tree generation prioritized on initial ingestion. W0-04 already provisions the physical lane; this ticket activates the onboarding workload, routing and TTFC measurement on that existing topology rather than adding or retrofitting a queue.

**What it should look like:** W1-05’s cold-start path publishes `onboarding.generate` to `enrichment-onboarding-priority` after the accepted `graph.updated` event; priority-only capacity plus bounded weighted polling drains it ahead of `enrichment-default` without permanently starving default work. A logged `ttfc_cold_start_to_onboarding_ready_ms` metric tagged by org_id/repo_id is the measurement side of the TTFC KPI, matching W3-03’s treatment of the 70x token KPI.

**Acceptance criteria:** a cold-start ingestion produces the onboarding-ready signal before general feature-cluster enrichment completes for the same repo; the TTFC metric appears in the metrics backend for every cold start. 

### **W2-09 — GitHub `installation_repositories` handling + Configure-page reconciliation** **_(new — gap identified during hands-on testing after W1-06 shipped)_**

**Depends on:** W1-06, W1-05, W0-04 · **Executor:** Pair (webhook handling is AI-agent-gradable; the reconciliation-on-poll fallback needed human sign-off on trigger/bound/destructive-direction tradeoffs)

W1-06 lands installation-level lifecycle handling (install/uninstall/suspend), but a user adding or removing individual repositories from an existing installation via GitHub's own Configure page never redirects the browser back to Sayre — the `installation_repositories` webhook is subscribed in the App manifest but was left unhandled (falling through to the normalizer's ignored path) once W1-06 shipped. This ticket closes that gap: `added`/`removed` webhook handling, plus a manual "Refresh installations" reconciliation endpoint as a backstop for missed or out-of-order webhook deliveries. No fresh install required.

**What it should look like:** an `installation_repositories` branch in the existing `POST /webhooks/github` receiver, signature-validated identically to every other event and intercepted the same way the sibling `installation` event already is; `added` resolves each repo's default-branch HEAD via the GitHub App client (the webhook payload itself carries no HEAD/`default_branch`) and enqueues `repo.initial_parse` reusing W1-06's exact envelope/outbox/dispatcher path unchanged, against the *existing* installation (no new `github_app_installations` row); `removed` marks the repository revoked (a new `repositories.revoked_at` column) without deleting graph history; a new authenticated, admin-or-owner-gated, org-scoped `POST /integrations/github/reconcile` endpoint that lists an installation's GitHub-accessible repos (bounded at 25, matching W1-06's callback cap) and registers/enqueues any repo GitHub reports that we don't hold active. Reconcile is deliberately additive-repair-only for MVP — it never revokes a repository based on an inferred absence from a GitHub API diff; the only path that revokes a repository is the real `removed` webhook itself, a direct signal from GitHub (a missed `removed` delivery is an accepted, documented MVP limitation, not something reconcile routes around).

**Acceptance criteria:** replaying a captured `installation_repositories` `added` webhook delivery results in exactly one `repo.initial_parse` outbox row per added repo with a resolvable HEAD, is idempotent on redelivery (no duplicate repository row, no second outbox row), and never creates a second `github_app_installations` row; replaying a `removed` delivery revokes each named repo without deleting its graph history and is a no-op on redelivery; `POST /integrations/github/reconcile` requires an authenticated admin-or-owner session (a member is 403, unauthenticated is 401), resolves `org_id` only from the session, and repairs a simulated missed-webhook gap (a repo GitHub reports that we don't hold) without ever writing revocation state.

## **Wave 3 — Semantic layer, integrations & real canvas (needs Wave 2)** 

### **W2-04 — Technical Tree end-to-end** **_(moved from Wave 2 in v2 — it depends on two Wave 2 tickets, violating the intra-wave parallelism rule as previously placed)_** 

**Depends on:** W2-01, W2-02 · **Executor:** AI agent 

Wire the real Technical Tree view (Folder/File + IMPORTS/CALLS/INHERITS) from Graph Query Service through to the Sigma.js/React Flow canvas, replacing W1-04’s mock data. 

**Acceptance criteria:** opening a real ingested repo shows its actual file structure and import edges, matching what W105 wrote to the graph; this is also the integration checkpoint proving W1-06’s install flow end-to-end (fresh install -> full parse -> rendered tree). 

### **W3-01 — Feature clustering** 

**Depends on:** W2-05 · **Executor:** AI agent 

Semantic Enrichment Worker groups Folder/File nodes into Feature nodes via PART_OF/REFERENCES edges, independent of folder structure. 

**Acceptance criteria:** a fixture repo with a feature spanning an API route, a shared util, and a frontend component produces one Feature node referencing all three. 

### **W3-02 — Product Tree UI + Feature Cluster metadata panel** 

**Depends on:** W3-01, W2-01 · **Executor:** AI agent 

Dashed-boundary rendering around Feature Cluster members (§4.7) with a metadata panel: Description, Team, Files Included, Recent Edits. 

**Acceptance criteria:** clicking a dashed boundary opens a panel with all four fields populated from real graph data. 

### **W3-03 — Graph-Guided RAG service** 

**Depends on:** W2-02, W0-06 · **Executor:** AI agent 

Retrieval Service: resolve anchor node -> bounded hop traversal -> in-scope bounded tenant chunks only -> bounded prompt through the configured `ModelProvider` -> log tokens-used vs. hypothetical full-repo count for the 70x KPI. Expose anchor resolution and bounded traversal as service-layer functions (not private internals)—W4-06's find_relevant_nodes and traverse_from MCP tools wrap these same functions.

**Acceptance criteria:** an AI query against a node returns an answer using demonstrably fewer tokens than a full-repo baseline, with the ratio logged; anchor resolution and traversal are callable as standalone service functions with the auth context parameter. 

### **W3-04 — Git sync integration worker (provider-generic)** **_(amended in v2)_** 

**Depends on:** W1-02, W0-04, W0-02 · **Executor:** AI agent 

BullMQ-backed worker updating ownership/PR/commit metadata directly on Graph DB node properties. **Amended:** the worker is provider-generic from v1 — provider field on every event, normalized event schema (shared with W1-02’s envelope), pluggable auth per provider — so PM-06 (Cursor Origin) is a new provider plug-in, not a pipeline rewrite (§2.4, §6.2). 

**Acceptance criteria:** merging a PR against a fixture repo updates the corresponding File nodes’ ownership/recent-edit metadata within the sync target; a second mock provider can be registered via configuration + one adapter module, without touching the pipeline core — proven by a test registering a “fakehub” provider; secrets via the W0-07 loader only. 

### **W3-05 — Jira/Linear sync integration worker** 

**Depends on:** W0-04, W0-05, W0-02 · **Executor:** AI agent 

Scheduled + webhook-driven bidirectional sync mapping ticket IDs to file/feature nodes. Secrets via the W0-07 loader only. 

**Acceptance criteria:** creating a ticket referencing a known file/feature results in a Ticket mirror node linked via the correct edge, visible from that node’s overlay; no secret read outside the loader. 

### **W3-06 — Coding/comment style tagging + folder inheritance** 

**Depends on:** W2-05, W2-02 · **Executor:** AI agent 

LLM classification tags Coding Style and Comment Style on Folder nodes (tracked separately, §4.9); Graph Query Service resolves inheritance top-down at query time — nearest ancestor Folder’s rule wins unless overridden. **v2 note:** the resolution function is service-layer and context-taking, because W4-06’s get_style_rules MCP tool calls it directly — agents must receive the same resolved answer the canvas displays, from the same code path. 

**Acceptance criteria:** a File with no explicit override reports its nearest ancestor Folder’s style; a File with an override reports its own; resolution is exposed as a standalone service function. 

### **W3-07 — Concrete Model Provider and Graphify adapters** **_(new in v3)_**

**Depends on:** W2-05, W0-07 · **Executor:** AI agent 

Implements concrete adapters for the Sayre-owned generation `ModelProvider` and `GraphifyAdapter` interfaces already consumed by W2-05. `ModelProvider` exposes generate and generateStructured operations. Concrete implementations are Anthropic-native and OpenAI-compatible-endpoint; the latter covers hosted OpenAI and the large majority of self-hosted servers (Ollama, vLLM, TGI). The Graphify implementation wraps base `graphifyy` strictly for semantic graph-output shaping and never parses structural source. Enrichment and retrieval already call these interfaces, so this ticket adds implementations rather than introducing or retrofitting the boundary. The separate `EmbeddingProvider` and its first concrete adapter already belong to W1-05 and are not absorbed into this ticket.

#### **What it should look like:** 

services/workers/model_provider/ protocol.py anthropic_adapter.py openai_compatible_adapter.py<br>services/workers/enrichment/graphify_adapter.py

A purpose-keyed per-org `model_provider_configs` row from W0-05 is resolved once per job and passed to the selected adapter. Endpoint credentials are pre-provisioned references resolved exclusively through W0-07.

**Acceptance criteria:** 

- The same enrichment fixture produces schema-valid structured output against Anthropic and one OpenAI-compatible local endpoint.

Switching an org’s provider setting requires no code change, only configuration. 

- No vendor SDK client is instantiated outside a concrete `ModelProvider`, and Graphify is not imported outside `GraphifyAdapter` (enforced by lint).

- **(v3 addition — structural data-sovereignty verification, PRD v5 §2.7):** with an org configured for a selfhosted provider, a network-isolated test run (no route to any Anthropic, OpenAI, or other third-party endpoint) completes the same enrichment fixture successfully, proving zero outbound calls leave the customer’s network for that org’s traffic. This is a release-blocking test for the self-hosted path, not an optional check — it is the verified property the platform’s data-sovereignty claim rests on. 

### **W3-08 — Provider failure handling: circuit breaker & degraded states** **_(new in v3)_** 

#### **Depends on:** W3-07 · **Executor:** AI agent 

Self-hosted endpoints are the customer’s infrastructure, not the platform’s — this ticket ensures a flaky or slow selfhosted provider degrades gracefully rather than blocking ingestion or the chatbot. A configurable timeout and circuitbreaker wrapper around every adapter call, with a per-org configurable fallback: retry with backoff, degrade the affected view to a visible “generating” state (reusing the existing cold-start UI pattern from §4.4), or fail the specific job while leaving the rest of ingestion unaffected. 

**Acceptance criteria:** a synthetic slow/unresponsive local endpoint triggers the configured fallback within the configured timeout, without blocking unrelated ingestion jobs or crashing the worker process; the degraded state is visibly surfaced on the canvas rather than silently failing. 

### **W3-09 — Chatbot & enrichment provider settings UI** **_(new in v3)_** 

#### **Depends on:** W3-07 · **Executor:** AI agent 

Org-admin settings surface for choosing provider, endpoint, and model by purpose, and selecting a pre-provisioned credential reference. Generation-purpose settings configure `ModelProvider`; embedding-purpose settings configure the separate `EmbeddingProvider`. Through this phase the UI never accepts or stores a raw provider credential; PM-07 supplies that later secret-manager/write path. The self-hosted path validates the endpoint server-side and presents PRD v5 §2.7's quality/latency tradeoffs.

**Acceptance criteria:** an org admin can switch providers and select an authorized pre-provisioned reference, with the change taking effect on the next enrichment/chatbot job without a deploy; endpoint validation cannot probe arbitrary/internal addresses; no raw credential appears in request bodies, logs, or Postgres.

### **W3-10 — Jira OAuth connect flow: per-org credentials + Settings UI** **_(new in v4 — gap identified during hands-on testing after W3-05 shipped)_**

**Depends on:** W3-05, W0-05, W0-07 · **Executor:** Pair (OAuth is security-sensitive, same reasoning as W1-06)

W3-05 built the Jira/Linear sync worker assuming credentials already exist, but nothing in the product obtains them: no connect button, no OAuth flow, no Settings surface — the only path was an operator hand-pasting global `JIRA_ACCESS_TOKEN`/`JIRA_REFRESH_TOKEN`/`JIRA_OAUTH_CLIENT_SECRET` into `infra/.env`, which also limited the whole instance to a single Jira workspace. This ticket is the Jira equivalent of W1-06's GitHub connect flow: a per-org OAuth 3LO connect flow, a `jira_connections` table (scoped by `org_id`, mirroring `mcp_client_keys`), `GET /integrations/jira/connect` + `/callback` with a signed org-carrying state token, silent refresh + disconnect, a Settings connect/status/disconnect surface, and an org-scoped `getOrgSecret(orgId, name)` credential loader that W3-05's worker and PM-07's later KMS cutover both resolve through. Per-org access/refresh tokens live in Postgres (encrypted at rest), never in `.env`; the App-level `JIRA_OAUTH_CLIENT_SECRET` stays global.

**Acceptance criteria:** an org admin can Connect in Settings, complete Jira's consent screen, and land back on Settings showing an active connection with no manual token/`.env` step; two orgs can each connect their own distinct Jira site simultaneously, proven by a test that org A's sync never reads/writes org B's credentials; disconnecting one org halts its sync without affecting others; no Jira credential is read outside `getOrgSecret`, enforced by a CI gate; the post-mvp-backlog note on this gap is closed with a pointer here.

## **Wave 4 — Onboarding, overlay, agent surface (needs Wave 3)** 

### **W4-01 — Onboarding Tree + sandboxed setup exec** 

**Depends on:** W3-01, W0-05, W2-08 · **Executor:** Pair (sandboxed exec is security-sensitive) 

EnvStep nodes ordered by sequence; executable local-environment setup commands run in a sandboxed/containerized runner, never directly on the host. Generation consumes from W2-08’s priority lane during cold start. 

**Acceptance criteria:** running a fixture repo’s onboarding steps executes only inside the sandbox, with no path for an EnvStep command to touch the host filesystem; on cold start, tree generation is served from the priority lane. 

### **W4-02 — Interactive Node Overlay Panel + Agent/Skill MD dual-surface contract** **_(amended in v2)_** 

**Depends on:** W3-04, W3-05, W3-06, W3-01 · **Executor:** Pair (was AI agent; the authoring surface and contract semantics warrant human review) 

All six overlay layers per §4.8: Dependencies, Recent Changes, Specific Features, Agent/Skill MD, Description, Specific Tickets — each independently toggleable, re-rendering only its own section, never re-querying the graph. 

#### **Amended scope — Agent/Skill MD is promoted from passive display to a dual-surface contract (PRD v4 §4.8):** 

**Authoring:** the canvas panel becomes the editing surface for agentSkillMd — editable by authorized roles only 

(RBAC-gated write), with versioning and author attribution stored so a bad rule can be traced and reverted. 

- **Two runtime consumers:** the platform’s own Retrieval Service (W3-03) reads it before proposing any change; external agents read it via W4-06’s get_agent_skill_md tool. Reads go through one service-layer function so both consumers always see identical content. 

- **Propagation:** an edit saved on the canvas is immediately visible to both consumers — no cache staleness window longer than a normal request cycle. 

- **Validation:** saves are validated against a documented structure (sections for allowed tools, required context, guardrails) so agents can parse it predictably; free-form Markdown is allowed within sections. 

**Acceptance criteria:** toggling any one layer never triggers a graph re-query; all six layers show real data once a fixture repo is fully ingested; an authorized user’s Agent/Skill MD edit is visible via the service-layer read function immediately after save, with version history recorded; an unauthorized role cannot save; a structurally invalid document is rejected with a useful error. 

### **W4-03 — Dynamic COVERS refresh + test badges** 

**Depends on:** W2-07, W2-04 · **Executor:** AI agent 

Nightly coverage-instrumented run refreshing COVERS edges dynamically (stamping `last_run` and setting `status` to `measured`); pass/fail badge overlay on the Technical Tree; safe-fallback-to-full-suite logic when impact analysis is inconclusive.

**Acceptance criteria:** a code change without corresponding test updates shows a stale/failing badge; the fallback path runs the full suite when the impacted-test set can’t be determined with confidence. 

### **W4-05 — DataLoader-readiness review** 

**Depends on:** all Wave 0-3 API tickets · **Executor:** AI agent (doc-only) 

Not a GraphQL migration — a written plan for where DataLoader-style batching will be needed once GraphQL resolvers sit on the service layer (§4.2), so PM-05 isn’t a surprise. **v2 note:** include the MCP tool handlers in the audit — get_node_context called in a loop by an agent has the same N+1 shape as nested GraphQL resolution, and the same batching keys likely apply. 

**Acceptance criteria:** a short doc lists every service-layer function likely to be called redundantly by nested GraphQL field resolution or repeated agent tool calls, with a proposed batching key for each. 

### **W4-06 — MCP Server surface (Agent Context Layer, read-only v1)** **_(new in v2)_** 

**Depends on:** W2-02, W2-06, W1-03, W3-01, W3-06, W2-07, W3-04 · **Executor:** Pair (security-sensitive: a new externally reachable surface) 

Implements PRD v4 §2.6/§4.2: an MCP Gateway (streamable HTTP) exposing the graph as a live context layer to external MCP-compatible agents — Claude Code, Cursor’s IDE agent, and any future client including Cursor Origin. Strictly readonly at MVP; write/propose tools are PM-08, trigger-gated. 

#### **What it should look like:** 

- services/core/src/mcp/ — the gateway plus one thin handler per tool, each a wrapper over an existing service-layer function (W0-03 pattern; the lint rule from W0-03 applies here). No business logic in handlers. 

- **v1 tool set:** find_relevant_nodes(query) and traverse_from(node_id, intent) wrapping W3-03’s anchorresolution/traversal functions; get_node_context(node_id) wrapping the sidebar metadata assembly; 

- get_agent_skill_md(node_id) wrapping W4-02’s read function; get_style_rules(node_id) wrapping W3-06’s 

- resolution function; get_covering_tests(node_id) reading W2-07/W4-03’s COVERS topology with freshness status; get_feature_cluster(node_id) from W3-01; get_recent_changes(node_id) from W3-04’s ownership metadata. 

- **Auth:** per-org scoped API keys (schema from W0-05), created/revoked by org admins from a settings surface on the canvas, resolving to the same { orgId, roles } context shape as W1-03 — one permission model, two front doors. Keys are scoped no wider than the issuing admin’s own scope. 

- **Isolation:** every tool response passes through the identical server-side RBAC node-stripping (W2-02) and tenant isolation (W2-06) applied to canvas queries. No parallel authorization path exists. 

- **Metering from day one:** per-key, per-tool call counts and context-tokens-served logged to the metrics backend ( mcp_tool_call_count , mcp_context_tokens_served , tagged by org/key/tool) — this feeds the Agent Context Adoption and Efficiency metrics (§4.6) and is the measurement source for PM-08’s trigger. 

- **Rate limiting** per key, configurable per org. 

**Acceptance criteria:** Claude Code (or any MCP client) connecting with a scoped key can call every v1 tool and receives 

RBAC-filtered results; a key scoped to org A receives zero data from org B, verified by a penetration-style test symmetric with W2-06’s; a key revoked on the canvas fails on its next call; a node hidden from a user role is equally hidden from an agent key with that role; an Agent/Skill MD edit saved on the canvas is returned by get_agent_skill_md immediately after; every tool handler passes the thin-wrapper lint; metering metrics appear for every call. 

### **W4-07 — MCP local-model client interoperability verification** **_(new in v3)_** 

#### **Depends on:** W4-06 · **Executor:** AI agent 

Implements PRD v5 §4.11. Verifies and documents that the existing MCP Gateway (W4-06) requires no new authorization path to serve a customer’s own locally-modeled agent. A real interoperability test: a minimal reference MCP client, driven by a locally served open-weight model (e.g., Llama or Mistral via an OpenAI-compatible local server) rather than Claude or a Cursor product, connects with a scoped org key and exercises every v1 read-only tool from §2.6. 

**What it should look like:** a test harness under services/core/test/mcp-interop/ running a minimal open-source MCP client against a local model, plus a published MCP_TOOL_CONTRACT.md documenting each tool’s schema clearly enough for a customer engineering team to build their own client unassisted. 

**Acceptance criteria:** the reference local-model client receives identical, correctly RBAC-filtered results to an equivalent Claude Code call against the same fixture repo and key scope, for every v1 tool; MCP_TOOL_CONTRACT.md is complete enough that a reviewer unfamiliar with the codebase could implement a client from it alone; no code changes were required in the MCP Gateway to pass this ticket (a failing acceptance criterion here would indicate an accidental Anthropic/Cursor-specific dependency that needs fixing, not documenting). 

## **Wave 5 — Closeout (needs Wave 4)** 

### **W4-04 — Full RBAC & multi-tenancy hardening pass** **_(moved to Wave 5 and expanded in v2)_** 

**Depends on:** W2-06, W2-04, W3-02, W4-01, W4-02, W4-06 · **Executor:** Human 

Cross-cutting security review across every surface built so far: Technical, Product, and Onboarding views, WebSocket fanout, overlay panels, the Agent/Skill MD authoring path, **and the MCP surface** — with particular attention to the MCP Gateway as the platform’s first non-browser, credential-bearing external entry point (key handling, rate limiting, scope escalation attempts, tool-response leakage). 

**Acceptance criteria:** an independent security review signs off; no view, overlay, WebSocket push, or MCP tool response leaks a node/edge/property to an unauthorized org, role, or agent key. 

## **Post-MVP — Trigger-gated (gated by their own metrics/events, per PRD v4 §4.10)** 

### **PM-01 — Macro View: Project entity + cross-repo edges** 

**Depends on:** W0-02, W3-04 · **Executor:** AI agent 

Project-to-Repo mapping and CONNECTS_TO cross-repo edge inference from API contracts, shared package versions, cross-repo imports (§1.2). 

### **PM-02 — Migration-trigger dashboard** **_(amended in v2)_** 

**Depends on:** W0-06, W0-08 · **Executor:** AI agent 

Surfaces W0-06’s vector-store metrics and W0-08’s graph-DB metrics side by side so the Neo4j -> Neptune and pgvector -> OpenSearch decisions are a measured go/no-go. **Amended:** this ticket owns defining and documenting the concrete threshold values — the “X” in “sustained >X concurrent tenant queries/sec” — for PM-03 and PM-04. A dashboard without stated thresholds is a chart, not a trigger. 

**Acceptance criteria:** both stores’ concurrency/latency render side by side with matching tag schemas; the threshold numbers for PM-03 and PM-04 are stated on the dashboard itself and in a linked doc, each with a rationale. 

### **PM-03 — Neo4j -> Amazon Neptune cutover** 

**Gated by:** W0-08 metrics, rendered on PM-02, crossing PM-02’s defined threshold · **Executor:** Human (infra-critical) 

Executed only once sustained multi-tenant concurrent load is measured against Neo4j—never on a calendar date or customer count. W0-02's portable logical contract and data migrations are reused; Neptune-specific physical DDL is applied through the target-specific migration layer.

### **PM-04 — pgvector -> Amazon OpenSearch cutover** 

**Gated by:** W0-06 metrics crossing PM-02’s defined threshold · **Executor:** Human (infra-critical) 

### **PM-05 — GraphQL layer + DataLoader batching** 

**Gated by:** view-specific data-shape divergence making REST force overfetching or endpoint proliferation · **Executor:** Pair (decision: human; implementation: AI agent using W4-05’s plan) 

Resolvers are thin wrappers over the same service layer as REST and MCP; W4-05’s batching keys applied at the resolver layer. 

### **PM-06 — Cursor Origin** **_(reframed in v2 per PRD v4 §6)_** 

**Gated by:** Cursor Origin publishing public API/webhook documentation (ingestion side); no gate on the MCP side · **Executor:** AI agent, once gated 

Two halves with opposite directions. **Ingestion (gated):** Origin as a git provider feeding the graph — a new provider plug-in against W3-04’s provider-generic interface, not a pipeline rewrite. **Context provision (no work required):** Origin’s agents consuming this platform’s MCP surface (W4-06) are ordinary MCP clients; verify compatibility when Origin ships MCP client capability, but build nothing Origin-specific. 

### **PM-07 — Env-file -> KMS-backed secrets manager cutover** **_(new in v2)_** 

**Gated by:** first external customer or first production pitch, whichever comes first · **Executor:** Human (security-critical) 

Executes the later secret-manager/write phase W0-07's loader was designed for: the chosen manager is provisioned per environment; getSecret swaps from local-reference resolution to manager fetch with a short-lived cache; every existing secret is rotated; and audited issuance, rotation, revocation, and self-service credential provisioning become available without changing consumers. W0-07's CI lint stays in force.

**Acceptance criteria:** no service reads any secret from an environment variable in production; every previously issued secret rotated; a runbook exists for issuing, rotating, and revoking a secret without a code deploy. 

### **PM-08 — MCP write/propose tool surface** **_(new in v2)_** 

**Gated by:** sustained Agent Context Adoption baseline (W4-06 metering) plus explicit customer demand, plus a defined reliability bar for agent-proposed changes · **Executor:** Pair (decision and safety design: human; implementation: AI agent) 

Extends the MCP surface beyond read-only context: tools letting agents propose changes back through the platform (e.g., draft a change plan validated against Agent/Skill MD guardrails, style rules, and covering tests before any code is written). Deliberately post-MVP: agents making wrong routing decisions ship wrong code, so this waits for measured adoption, demand, and a reliability standard — not enthusiasm. 

## **Platform & methodology** **_(new 2026-07-31 — from the SDD/TDAD design session; see `docs/sdd-tdad-design.md`)_**

Tickets in this section are not product features. They are the apparatus that lets a small team
operate what it builds (D-017's framing) plus four findings about shipped contracts that surfaced
while designing the methodology. PL-01 and PL-02 are prerequisites for onboarding a nontechnical
cofounder at all.

### **PL-01 — Containerize the four services, hardened** **_(from D-016 — the blocking gap)_**

**Depends on:** none · **Executor:** Pair (build design: agent; base-image and registry decisions: human)

`git ls-files | grep -i dockerfile` returns nothing. `infra/docker-compose.yml` runs only dependencies (postgres, redis, localstack, prometheus); `apps/web`, `services/core`, `services/gateway`, and `services/workers` have never been containerized and run via `npm run dev` / `poetry run`. Everything is blocked on this: D-011 Phase 2 (Render), D-013's Helm chart, BYOC, image scanning, reproducible builds, and — newly — a nontechnical cofounder being able to run the stack at all. Build hardened from the start rather than shipping naive images and retrofitting: multi-stage, non-root, no build toolchain in the runtime layer, base images pinned **by digest not tag** (`pgvector/pgvector:pg16` is mutable), security errata patched at build time, setuid/setgid stripped, app content owned by GID 0 with group perms for arbitrary-UID safety, docs/man/locales stripped.

**Acceptance criteria:** all four services build and run as containers; no image runs as root; every base image is digest-pinned; `docker compose up` from a fresh clone boots the full stack with health checks green; image sizes and a Trivy HIGH/CRITICAL scan are recorded as the baseline for PL-01's follow-on gate.

### **PL-02 — BOOTSTRAP.md + devcontainer: clone-to-running with no human in the loop** **_(from D-014, D-016 #8, D-004)_**

**Depends on:** PL-01 · **Executor:** Pair

D-014's acceptance test — *"can a new cofounder go `git clone` → running stack using only their own credentials, with no human in the loop?"* — fails today. Manual steps are scattered: GitHub App registration, Doppler setup, and the `DEV_ORG_ID` seeding SQL buried in an `.env.example` comment. Genesis's gitops repo keeps "the definitive record of the manual prerequisites and every gotcha that caused a real failure"; this is that document, plus the devcontainer D-004 recommended, which stops being a nice-to-have and becomes the delivery mechanism for a cofounder's environment. Note the Python dependency is unavoidable even for frontend work: the PL-03 impact resolver needs the workers' Poetry environment with Tree-sitter's native grammars.

**Acceptance criteria:** a cofounder on macOS with no prior context reaches a running stack using only credentials they can obtain themselves; every manual prerequisite is named in `BOOTSTRAP.md` with its failure symptom; the devcontainer produces an identical Linux environment on macOS and Windows hosts; onboarding acceleration being the product, this test is re-run on every change to setup.

### **PL-03 — SDD/TDAD methodology: `.sdd/` layer, impact resolver, `red` stage, `pr-review` agent**

**Depends on:** PL-01, PL-02 · **Executor:** Pair (methodology: human-directed; implementation: AI agent)

Implements `docs/sdd-tdad-design.md` in five steps: the tracked runtime-neutral `.sdd/` layer plus shim generator (closing the drift between `.claude/` and `.agents/`, and the fact that `AGENTS.md`/`.agents/`/`.codex/` are excluded via `.git/info/exclude` and therefore reach no one who clones); the `affected_tests.py` impact resolver over the pure `sayre_workers.parsing` modules; a `red` stage authoring all behavioral tests from spec before `dev` runs; `tester` rewired off `changes.md` (D-018's finding that tests currently ratify the implementation); and a `pr-review` agent with deterministic lane-bounds checking. Also closes D-005's action item — `review` and `security-checker` are documented read-only but carry `Bash` with no matcher, so `sed -i`, `tee`, and `python -c` write past the guard.

**Acceptance criteria:** a fresh clone gives a Codex user a working pipeline with no machine-local setup; regenerating shims produces no diff in CI; the resolver reports truncation, unanalyzable files, and no-adapter files as three distinct outcomes; a behavioral test with no `@spec` reference fails review; a diff touching a path outside the ticket's declared lane is reported by a script, not an LLM judgment; a run's ledger entry survives in git after `.pipeline/` is cleared.

### **PL-04 — COVERS edge weighting + ranked, bounded `get_covering_tests`** **_(contract fix)_**

**Depends on:** W2-07, W4-03, W4-06 · **Executor:** AI agent (contract change reviewed by human)

`get_covering_tests` returns *all* authorized tests connected through `COVERS`, with no weight, no ranking, and no limit. On a hub file that is a large fraction of the suite. An MCP tool that hands an agent 80 test references burns the context budget the product exists to conserve — it is anti-70x, in the single asset D-002 calls both strongest and most fragile. TDAD (arXiv 2603.17973) additionally measured *unranked* test context as the configuration that made regressions worse than no intervention at all. Add call-depth/coupling weight to `COVERS`, rank the response, apply a bounded default, and state truncation explicitly rather than silently capping. Fix this before the D-002 benchmark exists to expose it.

**Acceptance criteria:** `COVERS` carries a weight derived from call depth and coupling; `get_covering_tests` returns ranked results with a documented default limit; any truncation is stated in the response with the omitted count and reason; a hub-file query returns a bounded, ordered set rather than an unordered dump; the MCP tool contract is versioned to reflect the change (see PL-06's note on §4.11 clients).

### **PL-05 — First measured edge as an onboarding milestone + time-to-first-measured-edge metric**

**Gated by:** PL-04 · **Executor:** Pair (metric definition: human; instrumentation: AI agent)

`inferred` COVERS edges are import resolution — any agent can reproduce them locally with a parser in seconds, for free. On day one a new customer's `get_covering_tests` therefore returns something they could compute themselves. The edge becomes non-reproducible only at `measured`, which requires W4-03's nightly against an operator-configured coverage-instrumented CI adapter — a nontrivial setup step currently framed as optional background hygiene. This is D-021's commoditization warning one layer deeper: the structural tier of COVERS is commodity, the measured tier is not. If that holds, reaching the first measured edge is the moment the product stops being reproducible by a script, and it belongs in onboarding rather than in a nightly. §4.6 measures TTFC (time to first *context*); this adds time-to-first-*measured*-edge. It also carries a packaging implication for the GTM cofounder: do not build the business case on the tier that is free elsewhere.

**Acceptance criteria:** connecting a coverage-instrumented CI adapter is a first-class step in the onboarding flow, not a post-setup task; time-to-first-measured-edge is instrumented alongside TTFC; the distinction between `inferred` and `measured` is legible in the product surface, not only in the API response.

### **PL-06 — MCP tool audit: every tool states why it beats grep**

**Depends on:** W4-06 · **Executor:** Pair

A deliberate pass asking, for each MCP tool, what the graph knows that a local static analyzer does not. First-pass reading: `get_agent_skill_md` (human-authored, versioned, RBAC-gated) is unreproducible and strongest; `find_relevant_nodes` and `get_feature_cluster` earn it through semantics; `get_covering_tests` earns it only at `measured` (PL-04, PL-05); `get_recent_changes` earns it only via RBAC filtering and cross-repo scope, since `git log` covers the rest. This operationalizes D-022's Position B thesis at the tool level — **enrichment and governance are the moat, structure is commodity** — so every tool description should lead with the first two. Also the natural place to settle D-017 #5: §4.11 commits to an MCP contract good enough for customers to build their own clients, and those clients need to know when it changes, but the repo has no version, changelog, or tags at 218 commits.

**Acceptance criteria:** each tool in `MCP_TOOL_CONTRACT.md` carries a one-line statement of what it provides that local analysis cannot; any tool that cannot answer it is either changed or documented as a convenience rather than a differentiator; the contract carries a version and a changelog.

### **PL-07 — Uniform freshness/confidence envelope across the MCP contract**

**Depends on:** W4-06 · **Executor:** AI agent

`get_covering_tests` already returns `freshness: inferred|fresh|stale` — the right instinct, currently reinvented per tool. D-015 reached the same rule independently for the secrets feature: *"report confidence, not certainty, and name the files that defeated analysis."* Make it a standard envelope field across every tool that derives an answer from analysis rather than reading a stored fact. The dangerous output in a governance-adjacent product is a quiet false "you're covered," and a uniform field is what makes its absence conspicuous.

**Acceptance criteria:** a documented envelope shape carrying freshness/confidence plus a named list of inputs that defeated analysis; every analysis-derived tool populates it; a tool that cannot determine confidence says so rather than omitting the field.

### **PL-08 — Investigation: is the ingestion pipeline earning its cost over the parsing modules it wraps?** **_(open question, not a build ticket)_**

**Gated by:** PL-01 · **Executor:** Human (architecture judgment)

D-021 asked whether maintaining Sayre's own Tree-sitter structural tier is the best use of founder time. The SDD/TDAD design pushed the opposite way: `sayre_workers.parsing` is pure, in-memory, graph-free, already covers Python/JS/TS/Go, and turned out to be directly reusable standalone — a useful tool was designed around it while skipping the graph entirely. The expensive and still-unproven part is the distributed pipeline wrapped around it (D-017 #1: no end-to-end test across webhook → SQS → parse → Neo4j → SNS → WebSocket). So the sharper question is not whether to outsource structural parsing but whether the ingestion pipeline earns its cost relative to the modules it wraps. Multi-tenancy, incremental delta updates, and scale probably justify it — but for a single-tenant BYOC deployment (D-013) a much thinner path may exist, and that is worth knowing before quoting a BYOC deal rather than during one.

**Acceptance criteria:** a written answer naming which pipeline capabilities are load-bearing for multi-tenant SaaS and which are not required for single-tenant BYOC; either a recorded decision that the current architecture stands, or a scoped follow-up ticket; the answer lands in the founder decision log, not only here.

## **Quick-reference dependency table** 

|**Ticket**|**Depends on**|**Wave**|
|---|---|---|
|W0-00|—|0|
|W0-01 … W0-08|W0-00|0|
|W1-01|W0-02|1|
|W1-02|W0-04, W0-07|1|
|W1-03|W0-05, W0-03|1|
|W1-04|W0-01, W0-03|1|
|W1-05|W1-01, W0-02, W0-04, W0-05, W0-06,<br>W0-07|1|
|W1-06|W0-05, W0-07|1|
|W2-01|W1-04|2|
|W2-02|W1-03, W0-02, W1-05|2|
|W2-03|W1-03, W1-05|2|
|W2-05|W1-05, W0-04|2|
|W2-06|W0-02, W0-05, W1-03|2|
|W2-07|W1-01, W0-02|2|
|W2-08|W0-04, W1-05|2|
|W2-09|W1-06, W1-05, W0-04|2_(new)_|
|W2-04|W2-01, W2-02|3_(moved)_|
|W3-01|W2-05|3|
|W3-02|W3-01, W2-01|3|
|W3-03|W2-02, W0-06|3|
|W3-04|W1-02, W0-04, W0-02|3|
|W3-05|W0-04, W0-05, W0-02|3|
|W3-06|W2-05, W2-02|3|
|W3-07|W2-05, W0-07|3_(new in v3)_|
|W3-08|W3-07|3_(new in v3)_|
|W3-09|W3-07|3_(new in v3)_|
|W3-10|W3-05, W0-05, W0-07|3_(new in v4)_|
|W4-01|W3-01, W0-05, W2-08|4|
|W4-02|W3-04, W3-05, W3-06, W3-01|4|
|W4-03|W2-07, W2-04|4|
|W4-05|Waves 0-3 API tickets|4|
|W4-06|W2-02, W2-06, W1-03, W3-01, W3-06,<br>W2-07, W3-04|4|
|W4-07|W4-06|4_(new in v3)_|
|W4-04|W2-06, W2-04, W3-02, W4-01, W4-02,<br>W4-06|5_(moved)_|
|PM-01|W0-02, W3-04|Post-MVP|
|PM-02|W0-06, W0-08|Post-MVP|
|PM-03|PM-02 (threshold crossed, W0-08 data)|Post-MVP|
|PM-04|PM-02 (threshold crossed, W0-06 data)|Post-MVP|
|PM-05|W4-05, product signal|Post-MVP|
|PM-06|W3-04 (ingestion, external event); W4-<br>06 (context, no gate)|Post-MVP|
|PM-07|W0-07 (external-customer trigger)|Post-MVP|
|PM-08|W4-06 (adoption baseline + demand +|Post-MVP|
||reliability bar)||
|PL-01|none|Platform|
|PL-02|PL-01|Platform|
|PL-03|PL-01, PL-02|Platform|
|PL-04|W2-07, W4-03, W4-06|Platform|
|PL-05|PL-04 (gate)|Platform|
|PL-06|W4-06|Platform|
|PL-07|W4-06|Platform|
|PL-08|PL-01 (gate)|Platform|



**Dependency integrity rule:** the table is authoritative. Same-wave dependencies are allowed and must be sequenced (for example W3-08/W3-09 after W3-07 and W4-07 after W4-06). Parallel work is safe only for tickets whose complete prerequisite sets have landed; wave labels alone never imply simultaneous readiness.

