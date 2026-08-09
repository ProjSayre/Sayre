# Ticket Backlog — Organized by Feature
## Codebase Ontology, Visualization, Agent Context & Model Provider Platform — derived from PRD v8 (Unified Edition) · July 2026

### How to read this

This is the same 69 tickets as the wave-based backlog (Ticket-Backlog-v3 through the Wave 6–10 addenda, plus W3-10 — the Jira OAuth connect flow, previously only referenced as a dependency and now given its own entry), regrouped by feature area for readability instead of by build wave. **Wave numbers and dependencies are preserved on every ticket — actual build sequencing still follows the wave/dependency rules, not the order tickets appear in this document.** A combined dependency table is included at the end for planning purposes.

"Executor" — **AI agent** = well-specified, low-ambiguity, easy to verify by tests or diffing against spec; **Human** = judgment call, production infra, or security/cost consequences; **Pair** = an agent can draft it but a human should review before merge.

---

## 1. Foundations & Environment

### W0-00 — Dependency & environment baseline
**Wave 0 · Depends on:** none · **Executor:** AI agent

Pins every third-party dependency named in the PRD to a specific version in one place (`apps/web/package.json`, `services/core/package.json`, `services/workers/requirements.txt`, pinned Docker images) so no two parallel tickets pick incompatible versions. `DEPENDENCIES.md` records known future swaps (neo4j-driver→Neptune, pgvector client→OpenSearch, REST→GraphQL).

**Acceptance:** fresh clone installs with zero version-resolution conflicts; `DEPENDENCIES.md` lists every package plus its PRD section reference.

### W0-01 — Monorepo and local-dev skeleton
**Wave 0 · Depends on:** W0-00 · **Executor:** AI agent

Scaffolds `apps/web` (Next.js+TS), `services/core` (Node API), `services/workers` (Python FastAPI), shared `packages/`. Docker Compose for local Postgres/Redis/Neo4j. Base CI (lint, typecheck, test).

**Acceptance:** fresh clone → `docker compose up` → all services boot green; CI runs lint+test on PR.

### W0-03 — Service-layer convention & REST scaffold
**Wave 0 · Depends on:** W0-00 · **Executor:** AI agent

Establishes Route → Service → Graph Query Service pattern, with three thin-wrapper consumer types (REST, GraphQL later, MCP tool handlers). Example service/route pair plus a lint rule flagging business logic in `routes/`/`mcp/`.

**Acceptance:** CI fails if a route file exceeds ~15 lines; a new engineer can read one example and know where new logic goes.

### W0-04 — SQS + BullMQ wiring
**Wave 0 · Depends on:** W0-00 · **Executor:** AI agent

Stands up both queues with local equivalents (LocalStack for SQS, Redis for BullMQ), base publisher/consumer wrappers per language, and a priority-lane mechanism (tier or separate queue).

**Acceptance:** cross-language test messages consumed correctly; a priority message demonstrably drains ahead of a backlog of default messages.

### W0-05 — PostgreSQL schema & migrations
**Wave 0 · Depends on:** W0-00 · **Executor:** AI agent

Organizations, users, repositories, permissions (org/repo/branch/path-scoped), ticket cache, style rules, onboarding steps, GitHub App installation records, MCP client credentials. RLS enabled from the start.

**Acceptance:** an automated RLS test proves one org's session can't see another's rows; `mcp_client_keys` carries org scoping, revocation, and audit columns.

### W0-06 — Vector-store concurrency instrumentation
**Wave 0 · Depends on:** W0-00 · **Executor:** AI agent

Wraps every pgvector query with timing + concurrency counters (`vector_query_duration_ms`, `vector_query_concurrent_count`), tagged by `org_id`, feeding the pgvector→OpenSearch migration trigger.

**Acceptance:** 50 concurrent synthetic queries produce visible concurrency/latency metrics.

### W0-07 — Secrets convention & loader
**Wave 0 · Depends on:** W0-00 · **Executor:** Pair

A single `getSecret(name)` loader per language (`packages/config/secrets.ts`, `services/workers/config/secrets.py`) — the only code paths allowed to read a secret. Committed `.env.example`, gitignored `.env*`, CI grep failing on raw `process.env.`/`os.environ[` reads outside the loader, `SECRETS.md`.

**Acceptance:** a PR reading a secret outside the loader fails CI; `SECRETS.md` names every secret Waves 1–3 will need.

### W0-08 — Graph DB concurrency instrumentation
**Wave 0 · Depends on:** W0-00 · **Executor:** AI agent

Mirrors W0-06 for Neo4j: `graph_query_duration_ms`, `graph_query_concurrent_count`, `graph_query_result_node_count`, tagged by `org_id` and query shape, feeding the Neo4j→Neptune migration trigger.

**Acceptance:** 50 concurrent synthetic Cypher queries produce visible metrics matching W0-06's tag conventions.

---

## 2. Graph Schema & Repository Parsing

### W0-02 — Graph DB schema & openCypher migrations
**Wave 0 · Depends on:** W0-00 · **Executor:** AI agent (schema review by human before merge)

Initial Neo4j schema: node labels Project, Repo, Folder, File, Function, Class, Module, Person, Commit, Feature, Ticket, EnvStep, Test (later extended with Bucket, §7 below); edge types CONTAINS, CONNECTS_TO, IMPORTS, CALLS, INHERITS, OWNS, AUTHORED, MODIFIED, REFERENCES, PART_OF, REQUIRES, DEPENDS_ON, COVERS. `org_id` on every node from day one. Versioned, idempotent (`MERGE`) openCypher-only migrations.

**Acceptance:** migrations run twice produce no duplicate nodes/constraints; a migration-runner tracks applied versions in Postgres.

### W1-01 — Multi-language Tree-sitter parsing module
**Wave 1 · Depends on:** W0-02 · **Executor:** AI agent

Incremental + full-parse AST extraction (JS/TS/Py/Go to start) producing structural relationships behind a common `ParseResult` interface, callable as full parse (cold start) or diff parse (changed files only).

**Acceptance:** parsing a fixture repo produces the expected function/class/import graph, verified by a snapshot test.

### W1-05 — Ingestion/Delta Worker core
**Wave 1 · Depends on:** W1-01, W0-02, W0-04 · **Executor:** AI agent

Clones/diffs a repo, runs Tree-sitter, writes node/edge upserts, writes embeddings to pgvector, publishes `graph.updated`. Operates against a scratch clone destroyed after parsing. Handles `repo.initial_parse` (cold start) and webhook-triggered delta jobs.

**Acceptance:** pushing to a fixture repo produces correct nodes and a `graph.updated` event within the sync target; a `repo.initial_parse` job triggers the full-parse path.

---

## 3. GitHub Integration & Real-Time Sync

### W1-02 — GitHub webhook receiver
**Wave 1 · Depends on:** W0-04, W0-07 · **Executor:** AI agent

Signature-validated (`X-Hub-Signature-256`) webhook endpoint normalizing GitHub events onto SQS/BullMQ as a `{provider, type, repo, ref, payload}` envelope, shared with the provider-generic sync worker. Webhook secrets read exclusively via the W0-07 loader.

**Acceptance:** replayed fixtures produce correct queue messages; a tampered payload is rejected (401) and never reaches a queue.

### W1-06 — GitHub App: registration, install flow & initial-parse trigger
**Wave 1 · Depends on:** W0-05, W0-07 · **Executor:** Pair (OAuth is security-sensitive)

App manifest, `GET /integrations/github/install`, `GET /integrations/github/callback` storing the installation ID against the org and enqueueing `repo.initial_parse`, uninstall webhook handling.

**Acceptance:** callback stores installation records and enqueues the correctly shaped `repo.initial_parse` message; revoked installations halt further sync; credentials never read outside the W0-07 loader.

### W3-04 — Git sync integration worker (provider-generic)
**Wave 3 · Depends on:** W1-02, W0-04, W0-02 · **Executor:** AI agent

BullMQ-backed worker updating ownership/PR/commit metadata on Graph DB node properties. Provider-generic from v1 (provider field, normalized event schema, pluggable auth) so a second git-hosting provider is a plug-in, not a rewrite.

**Acceptance:** merging a PR updates File node ownership/recent-edit metadata within the sync target; a mock "fakehub" provider registers via configuration + one adapter module with no pipeline changes.

### W7-01 — GitHub paginated reconciliation (removes the 25-repo cap)
**Wave 7 · Depends on:** W1-06 · **Executor:** AI agent

Replaces the hard 25-repository install-callback cap with paginated, async reconciliation against the GitHub API, with a visible partial-sync state on the canvas for large installations.

**Acceptance:** an installation with >25 repos has every repo registered and queued within a bounded window; UI shows partial-sync indicator until complete; verified against a 100+ repo fixture install.

### W7-02 — GitHub repo org-exclusivity enforcement
**Wave 7 · Depends on:** W1-06, W2-06 · **Executor:** Pair (security-sensitive)

Binds a repository to exactly one org's installation, enforced server-side on every ingestion write and read. A second org attempting to register an already-bound repo is rejected outright.

**Acceptance:** a duplicate-bind attempt is rejected; a penetration-style test confirms no ingestion path writes nodes tagged with a foreign `org_id`, symmetric with W2-06's tenant-isolation test.

### W7-03 — Sub-5-second GitHub delta sync
**Wave 7 · Depends on:** W1-05, W2-03 · **Executor:** AI agent

Tightens the sync-latency target from 15s to <5s: profiles/reduces latency across webhook receipt → delta parse → graph write → WebSocket fan-out.

**Acceptance:** a fixture push patches a connected client within 5s at the 95th percentile across a benchmark suite of realistic diffs; existing 15s-target tests updated to assert the new bound.

---

## 4. Authentication, Login & Identity

### W1-03 — AuthN/AuthZ middleware
**Wave 1 · Depends on:** W0-05, W0-03 · **Executor:** Pair (security-sensitive)

JWT/session validation + RBAC middleware (`authenticate()` → `authorize(requiredScope)`) attaching `{ userId, orgId, roles }` to `req.context` — designed so the MCP Gateway later attaches an equivalent `{ agentKeyId, orgId, roles }` shape through the same checks.

**Acceptance:** unauthenticated requests rejected before any service function runs; a request scoped to org A cannot fetch org B's data.

### W6-01 — Login OAuth browser-binding & CSRF fix
**Wave 6 · Depends on:** W1-03 · **Executor:** Pair (security-sensitive)

Sets an `httpOnly`, `SameSite=Lax` state-binding cookie at login-start and verifies it at callback before minting a session, closing the session-injection-via-login-CSRF gap. Adds `X-Frame-Options`/`frame-ancestors` to login start/callback responses.

**Acceptance:** a captured fresh code + state replayed against a victim's browser is rejected at callback; login responses cannot be framed; the install flow (already admin-gated) is confirmed unaffected.

### W6-02 — Auth-route input hardening & cache hygiene
**Wave 6 · Depends on:** W6-01 · **Executor:** AI agent

Fixes the duplicate-`?code=` 500 crash (clean 400 instead) and adds `Cache-Control: no-store` to every login-flow response.

**Acceptance:** duplicate-param callback returns a clean 400; every login response carries `Cache-Control: no-store`.

### W6-03 — resolveUserByExternalAuthId production hardening
**Wave 6 · Depends on:** W1-03 · **Executor:** Pair (security-sensitive)

Replaces the superuser-RLS-bypass query with a `resolve_user_by_external_auth_id` `SECURITY DEFINER` function + a narrowly-scoped `NOLOGIN`/`NOBYPASSRLS` role, mirroring the existing installation-resolver migration.

**Acceptance:** login under a production-shaped (`NOBYPASSRLS`) role correctly resolves an existing user rather than minting a duplicate org.

### W9-01 — Google OAuth2 login provider
**Wave 9 · Depends on:** W6-01 · **Executor:** Pair (security-sensitive: new OAuth provider)

Adds `GET /auth/google/login`/`callback` following W6-01's browser-binding pattern, issuing the same session shape. Account-linking rule: a Google login on a verified email matching an existing GitHub user attaches to that user rather than duplicating.

**Acceptance:** the Google flow is rejected under the same browser-binding attack test as W6-01; a matching-email login resolves to the same user/org; credentials read via the W0-07 loader only.

### W9-02 — Dedicated /login page
**Wave 9 · Depends on:** W9-01, W6-01 · **Executor:** AI agent

A polished, dedicated login page with both "Sign in with GitHub" and "Sign in with Google" as equally-weighted entry points.

**Acceptance:** both providers reachable from one page with no dead-end states (cancelled consent/denied scope/provider error all resolve to a clear retry path).

---

## 5. Canvas & Visualization (Technical / Product Trees)

### W1-04 — Next.js shell + React Flow base renderer
**Wave 1 · Depends on:** W0-01, W0-03 · **Executor:** AI agent

Application shell, auth screens, React Flow canvas rendering a mock node-edge payload — the foundation W2-01 extends.

**Acceptance:** loading the app renders a mock graph of ~20 nodes with pan/zoom working.

### W2-01 — Sigma.js + graphology at-scale rendering
**Wave 2 · Depends on:** W1-04 · **Executor:** AI agent

Sigma.js (WebGL) above the ~500-node threshold; graphology for client-side filtering/subgraph extraction only — never RBAC or deep traversal.

**Acceptance:** a 2,000-node fixture graph renders smoothly; a checklist confirms no traversal/RBAC logic in the graphology layer.

### W2-02 — Graph Query Service
**Wave 2 · Depends on:** W1-03, W0-02, W1-05 · **Executor:** Pair (security-sensitive: RBAC node stripping)

Translates viewport/view-filter requests into Cypher, with server-side RBAC node stripping. `getNodesInViewport`/`getStructuralEdges` take the auth context; interface-driven so REST and (later) MCP calls are indistinguishable to this layer.

**Acceptance:** a user without Folder access never receives that node, verified with two differently scoped users against the same repo.

### W2-03 — WebSocket gateway + Redis pub/sub
**Wave 2 · Depends on:** W1-03, W1-05 · **Executor:** AI agent

Realtime Service fanning out `graph.updated` events, re-filtered per client's RBAC scope on every fan-out message, not just initial load.

**Acceptance:** a delta push patches only affected nodes within the sync target; an unauthorized client never receives a patch for a node it can't see.

### W2-04 — Technical Tree end-to-end
**Wave 3 · Depends on:** W2-01, W2-02 · **Executor:** AI agent

Wires the real Technical Tree (Folder/File + IMPORTS/CALLS/INHERITS) from Graph Query Service through to the canvas, replacing mock data.

**Acceptance:** opening a real ingested repo shows its actual file structure/import edges; also the integration checkpoint proving W1-06's install flow end-to-end.

### W3-02 — Product Tree UI + Feature Cluster metadata panel
**Wave 3 · Depends on:** W3-01, W2-01 · **Executor:** AI agent

Dashed-boundary rendering around Feature Cluster members with a metadata panel: Description, Team, Files Included, Recent Edits.

**Acceptance:** clicking a dashed boundary opens a panel with all four fields populated from real graph data.

---

## 6. Semantic Enrichment, Retrieval & Model Provider Layer

### W2-05 — Semantic Enrichment Worker skeleton
**Wave 2 · Depends on:** W1-05, W0-04 · **Executor:** AI agent

Consumes newly parsed nodes off a separate queue so LLM latency never blocks structural sync. Calls Graphify + LangChain/LangGraph + the Model Provider Adapter; Graphify constrains output to graph primitives written straight back to Neo4j. Consumes default and priority lanes, draining priority first.

**Acceptance:** enrichment runs asynchronously and visibly after structural sync, never blocking the Technical Tree; output lands as graph writes.

### W3-01 — Feature clustering
**Wave 3 · Depends on:** W2-05 · **Executor:** AI agent

Groups Folder/File nodes into Feature nodes via PART_OF/REFERENCES edges, independent of folder structure — also the seed data for auto-generated Onboarding Buckets (§7 below).

**Acceptance:** a fixture feature spanning an API route, a shared util, and a frontend component produces one Feature node referencing all three.

### W3-03 — Graph-Guided RAG service
**Wave 3 · Depends on:** W2-02, W0-06 · **Executor:** AI agent

Retrieval Service: anchor node → bounded hop traversal → in-scope vector chunks only → bounded prompt via the Model Provider Adapter → logs tokens-used vs. hypothetical full-repo count (70x KPI). Anchor resolution and traversal exposed as standalone service functions for MCP's `find_relevant_nodes`/`traverse_from`.

**Acceptance:** an AI query returns an answer using demonstrably fewer tokens than a full-repo baseline, ratio logged; anchor/traversal functions callable standalone with the auth context.

### W3-06 — Coding/comment style tagging + folder inheritance
**Wave 3 · Depends on:** W2-05, W2-02 · **Executor:** AI agent

LLM classification tags Coding Style/Comment Style on Folder nodes (tracked separately); Graph Query Service resolves inheritance top-down at query time. Exposed as a standalone, context-taking service function so the `get_style_rules` MCP tool returns the identical resolved answer.

**Acceptance:** a File with no override reports its nearest ancestor's style; an override reports its own.

### W3-07 — Model Provider adapter interface
**Wave 3 · Depends on:** W2-05, W0-07 · **Executor:** AI agent

One adapter interface (`generate()`, `generateStructured()`) with three implementations — Anthropic, OpenAI, OpenAI-compatible (covers self-hosted). Enrichment Worker and Retrieval Service refactored to call the adapter exclusively. Includes a release-blocking network-isolated test proving zero outbound calls for a self-hosted-configured org.

**Acceptance:** the same fixture run produces valid structured output against Claude and a local OpenAI-compatible endpoint; switching provider requires config only; no SDK client instantiated outside the adapter module; network-isolated self-hosted test passes.

### W3-08 — Provider failure handling: circuit breaker & degraded states
**Wave 3 · Depends on:** W3-07 · **Executor:** AI agent

Configurable timeout/circuit-breaker around every adapter call, with a per-org fallback: retry-with-backoff, degrade to a visible "generating" state, or fail the specific job without affecting the rest of ingestion.

**Acceptance:** a synthetic slow/unresponsive endpoint triggers the configured fallback within timeout without blocking unrelated jobs; degraded state is visibly surfaced on the canvas.

### W3-09 — Chatbot & enrichment provider settings UI
**Wave 3 · Depends on:** W3-07 · **Executor:** AI agent

Org-admin settings surface for choosing Claude/GPT/self-hosted, with endpoint/credential prompts for self-hosted and in-product tradeoffs messaging.

**Acceptance:** switching providers takes effect on the next enrichment run/chatbot query with no deploy; the self-hosted form validates endpoint reachability before saving.

---

## 7. Onboarding Tree & Buckets

### W2-08 — Onboarding-priority queue lane
**Wave 2 · Depends on:** W0-04, W1-05 · **Executor:** AI agent

An `enrichment.onboarding_priority` lane drained ahead of `enrichment.default`; cold-start publishes `onboarding.generate` onto it; logs `ttfc_cold_start_to_onboarding_ready_ms`.

**Acceptance:** cold-start ingestion produces the onboarding-ready signal before general feature-cluster enrichment completes; TTFC metric appears for every cold start.

### W4-01 — Onboarding Tree + sandboxed setup exec
**Wave 4 · Depends on:** W3-01, W0-05, W2-08 · **Executor:** Pair (sandboxed exec is security-sensitive)

EnvStep nodes ordered by sequence; executable setup commands run in a sandboxed/containerized runner, never on the host. Generation consumes from the priority lane during cold start.

**Acceptance:** onboarding steps execute only inside the sandbox; on cold start, tree generation is served from the priority lane.

### W10-01 — Bucket data model & CRUD service layer
**Wave 10 · Depends on:** W0-02, W4-01 · **Executor:** AI agent

Bucket node label, BUCKET_CONTAINS/BUCKET_MEMBER edges, and service-layer functions (`createBucket`, `updateBucketMembership`, `addBucketMember`, `removeBucketMember`, `getBucket`). Write paths restricted to the Technical Lead role or org admin.

**Acceptance:** a Technical Lead can create a bucket and manage membership via the service layer; a non-authorized write is rejected; reads respect tenant isolation.

### W10-02 — Drag-and-drop bucket builder UI
**Wave 10 · Depends on:** W10-01, W2-01 · **Executor:** Pair (RBAC-gated authoring surface)

Drag-and-drop panel on the Technical Tree canvas; dropping a Folder adds everything beneath it. Bucket card shows member avatars top-right (Team Lead first, visually distinguished), file list, and an editable description. Read-only preview for non-authorized roles.

**Acceptance:** dragging a Folder adds every File beneath it; Team Lead avatar renders first and distinguished; non-authorized roles can view but not edit; changes persist without a reload.

### W10-03 — Bucket-scoped onboarding flow
**Wave 10 · Depends on:** W10-01, W4-01, W2-08 · **Executor:** AI agent

Adds a Global-vs-Bucket choice before the Onboarding Tree walkthrough starts; adds `scope` (global|bucketId) to EnvStep; reuses W4-01's sandboxed runner unchanged.

**Acceptance:** selecting a bucket shows only that bucket's EnvStep sequence; Global shows the full sequence unchanged; a bucket with no steps shows a clear empty state.

### W10-06 — Auto-generate onboarding buckets from Feature Clusters
**Wave 10 · Depends on:** W3-01, W10-01 · **Executor:** AI agent

On Feature Clustering completion during cold start, creates one real Bucket per Feature cluster — name/description/files seeded from the cluster, `origin: auto-generated` set, Team Lead best-effort inferred from ownership metadata (left unset if ambiguous).

**Acceptance:** ingesting a fixture repo with N Feature clusters produces exactly N buckets, each immediately usable for bucket onboarding with no Technical Lead action required; ambiguous-owner clusters leave Team Lead unset with a visible "assign" prompt.

### W10-07 — Decline action for auto-generated buckets
**Wave 10 · Depends on:** W10-02, W10-06 · **Executor:** AI agent

A Technical-Lead/admin-only "Decline" action on auto-generated-badged bucket cards; declining hard-deletes the bucket and its edges (no soft-archive state). Editing an auto-generated bucket otherwise works exactly like a manual one.

**Acceptance:** auto-generated cards show the badge and Decline action manual buckets lack; declining removes the node and edges from the graph immediately; non-Technical-Leads can't see or trigger it.

---

## 8. Live Presence (Technical Tree)

### W10-04 — Live-presence ingestion (open-branch activity)
**Wave 10 · Depends on:** W1-02, W3-04 · **Executor:** AI agent

Extends the webhook receiver and ownership worker to handle open-branch push events: writes/refreshes a WORKING_ON edge (`branchName`, `lastActivityAt`, `status`), marks it stale after an inactivity window, removes it on merge/close. Flags files/folders present only on the open branch (not yet on default) for W10-05 to render as tentative.

**Acceptance:** a fixture branch push produces a WORKING_ON edge within the <5s sync target; inactivity produces `stale`; merge/close removes the edge; a branch-only new file is flagged correctly.

### W10-05 — Live-presence rendering on the Technical Tree
**Wave 10 · Depends on:** W10-04, W2-01, W2-03 · **Executor:** AI agent

Recolors/highlights nodes and edges with an active WORKING_ON edge, distinguishable per simultaneously-active contributor, with avatar/name on hover. Branch-only files render as dashed "tentative" nodes attached to their real parent, updating live over WebSocket.

**Acceptance:** two contributors active on different files render two distinguishable colors simultaneously; hover shows contributor identity; a branch-only file renders tentative and converts to normal on merge; an unauthorized viewer never sees WORKING_ON data they lack RBAC access to.

---

## 9. Task Management Integration & Ticket Intelligence

### W3-05 — Jira/Linear sync integration worker
**Wave 3 · Depends on:** W0-04, W0-05, W0-02 · **Executor:** AI agent

Scheduled + webhook-driven bidirectional sync mapping ticket IDs to file/feature nodes. Secrets via the W0-07 loader only. (Superseded in real-time behavior by W7-04 below.)

**Acceptance:** creating a ticket referencing a known file/feature results in a linked Ticket mirror node; no secret read outside the loader.

### W3-10 — Jira OAuth connect flow (per-org, 3LO)
**Wave 3 · Depends on:** W0-05, W0-07 · **Executor:** Pair (OAuth is security-sensitive)

Replaces global single-value env secrets (`JIRA_ACCESS_TOKEN`/`JIRA_REFRESH_TOKEN`, which supported only one Jira workspace platform-wide with no in-product connect flow) with a proper per-org OAuth 3LO connect flow: a `jira_connections` table extending W0-05's schema, a `getOrgSecret` helper for per-org credential resolution, and a Settings-page connect/disconnect UI.

**Acceptance:** an org admin connects a Jira account via OAuth from Settings with no env var involved; two different orgs can each connect distinct Jira workspaces simultaneously without collision; disconnecting revokes the stored credential; tokens are read exclusively via the per-org `getOrgSecret` pattern, consistent with the W0-07 loader convention.

### W7-04 — Jira ticket-sync pipeline re-run & real-time sync
**Wave 7 · Depends on:** W3-05, W3-10 (Jira OAuth connect flow) · **Executor:** Pair (security-critical: SECURITY DEFINER boundary)

Re-derives the previously hand-built poll loop through a proper planner/review/security-checker pass, and replaces polling with real-time, webhook-driven sync targeting <5s. Adversarially re-verifies the `0017_jira_active_org_resolver.sql` SECURITY DEFINER boundary; redesigns away the original O(repos)-per-sync fan-out.

**Acceptance:** a ticket create/update on a connected project appears as a graph write within 5s; the SECURITY DEFINER boundary passes adversarial review; sync is no longer O(repos) per ticket.

### W7-05 — Jira space/project org-scoping
**Wave 7 · Depends on:** W3-10 (Jira OAuth connect flow) · **Executor:** AI agent

Extends the per-org OAuth connect flow so an admin selects an explicit allow-list of Jira projects/spaces at connect time (editable later), rather than the whole connected site being in scope.

**Acceptance:** a ticket from a non-allow-listed project is never ingested; editing the allow-list takes effect on the next sync without reconnecting OAuth.

### W8-01 — AI ticket-to-file matching: pipeline re-run & threshold tuning
**Wave 8 · Depends on:** W3-05, W2-05 · **Executor:** Pair (security-critical)

Re-derives the previously hand-built embedding-based ticket-to-file matcher through the full pipeline; tunes `SIMILARITY_THRESHOLD` against a real ticket/code evaluation set (first resolving the blocking embedding-provider gap); security-checker assesses whether the tuned threshold and single-best-match-only design are safe given a wrong link is worse than no link; reviews the new Node→Python SQS fleet-split exception; adds a cost/rate-limit design pass.

**Acceptance:** the tuned threshold is documented with methodology/results; security-checker signs off on the SECURITY DEFINER/RLS-adjacent surfaces and the SQS exception; matches are visibly AI-inferred and user-correctable.

### W8-02 — Ticket Inbox view
**Wave 8 · Depends on:** W3-05, W3-10, W8-01 · **Executor:** AI agent

Org-wide view of every synced ticket regardless of node linkage; filterable by status, project/space, linkage state (explicit/AI-inferred/unmatched), and inferred-match confidence band.

**Acceptance:** every synced ticket appears regardless of linkage state; an unmatched/below-threshold ticket is visible here even though absent from any node's overlay; filtering works across a fixture org with all three linkage states; RBAC/tenant-scoped identically to every other graph-adjacent surface.

---

## 10. Agent Context Layer (MCP) & Node Overlay

### W4-02 — Interactive Node Overlay Panel + Agent/Skill MD dual-surface contract
**Wave 4 · Depends on:** W3-04, W3-05, W3-06, W3-01 · **Executor:** Pair (authoring surface + contract semantics warrant human review)

Six independently toggleable layers (Dependencies, Recent Changes, Specific Features, Agent/Skill MD, Description, Specific Tickets). Agent/Skill MD promoted to a dual-surface contract: canvas is the RBAC-gated, versioned authoring surface; two runtime consumers (Retrieval Service, and external agents via `get_agent_skill_md`) read through one identical service-layer function.

**Acceptance:** toggling a layer never triggers a graph re-query; an authorized edit is visible via the read function immediately, with version history; an unauthorized role can't save; an invalid document is rejected with a useful error.

### W4-05 — DataLoader-readiness review
**Wave 4 · Depends on:** all Wave 0–3 API tickets · **Executor:** AI agent (doc-only)

A written plan for where DataLoader-style batching will be needed once GraphQL sits on the service layer, including MCP tool handlers (`get_node_context` in a loop has the same N+1 shape as nested GraphQL resolution).

**Acceptance:** a doc lists every service-layer function likely called redundantly, with a proposed batching key for each.

### W4-06 — MCP Server surface (Agent Context Layer, read-only v1)
**Wave 4 · Depends on:** W2-02, W2-06, W1-03, W3-01, W3-06, W2-07, W3-04 · **Executor:** Pair (new externally reachable surface)

MCP Gateway (streamable HTTP) exposing `find_relevant_nodes`, `traverse_from`, `get_node_context`, `get_agent_skill_md`, `get_style_rules`, `get_covering_tests`, `get_feature_cluster`, `get_recent_changes` — each a thin wrapper over an existing service-layer function. Per-org scoped API keys resolving to the same `{orgId, roles}` context as REST. Every response passes the identical server-side RBAC/tenant-isolation applied to canvas queries. Metering and rate limiting from day one.

**Acceptance:** a scoped key receives RBAC-filtered results for every tool; a key scoped to org A receives zero org-B data; a revoked key fails on its next call; an Agent/Skill MD edit is reflected immediately; metering metrics appear for every call.

### W4-07 — MCP local-model client interoperability verification
**Wave 4 · Depends on:** W4-06 · **Executor:** AI agent

Verifies and documents that the MCP Gateway requires no new authorization path to serve a locally-modeled agent: a reference MCP client driven by a local open-weight model exercises every v1 read-only tool. Publishes `MCP_TOOL_CONTRACT.md`.

**Acceptance:** the local-model client receives identical, correctly RBAC-filtered results to an equivalent Claude Code call for every v1 tool; the contract doc is complete enough for an unfamiliar reviewer to implement a client from it; no MCP Gateway code changes were required.

---

## 11. Security, Multi-Tenancy & Rate Limiting

### W2-06 — Tenant isolation enforcement
**Wave 2 · Depends on:** W0-02, W0-05, W1-03 · **Executor:** Human (security-critical)

`org_id` stamped on every graph write, injected server-side on every query (never client-supplied); Postgres RLS as defense-in-depth; per-tenant vector-store namespaces.

**Acceptance:** a penetration-style test forging a client-supplied `org_id` is rejected; isolation holds even if RBAC middleware is bypassed at a lower layer.

### W6-04 — Structural org-scoped Cypher query enforcement
**Wave 6 · Depends on:** W2-06 · **Executor:** Human (security-critical)

Replaces the textual/regex Neo4j tenant guard (which a legitimate-looking projection could satisfy with zero real filtering effect) with either real openCypher grammar parsing confirming `org_id` sits in an actual filtering position, or a query-builder API that can't express an org-less query. Also closes the chokepoint import-detection gaps for reassigned `require` and `export *` re-exports.

**Acceptance:** the specific known bypass is rejected by the new guard; a fourth adversarial audit round finds no structurally-equivalent bypass; the import-detection gaps are independently covered.

### W6-05 — Platform-wide rate limiting
**Wave 6 · Depends on:** W1-03 · **Executor:** AI agent

Shared rate-limiting middleware at the API Gateway, MCP Gateway, webhook receivers, and login routes — per-IP for unauthenticated routes, per-key/per-org for authenticated ones, configurable per org.

**Acceptance:** exceeding the configured limit on each surface returns 429 with `Retry-After`; per-org limits take effect without a deploy.

### W4-04 — Full RBAC & multi-tenancy hardening pass
**Wave 5 · Depends on:** W2-06, W2-04, W3-02, W4-01, W4-02, W4-06 · **Executor:** Human

Cross-cutting security review across every surface: Technical/Product/Onboarding views, WebSocket fan-out, overlay panels, Agent/Skill MD authoring, and the MCP surface as the platform's first non-browser, credential-bearing external entry point.

**Acceptance:** an independent security review signs off; no view, overlay, WebSocket push, or MCP tool response leaks a node/edge/property to an unauthorized org, role, or agent key.

---

## 12. Test Coverage & CI Impact

### W2-07 — Test node type + static COVERS inference
**Wave 2 · Depends on:** W1-01, W0-02 · **Executor:** AI agent

Parses test files as Test nodes during Tree-sitter ingestion; infers COVERS edges statically from imports, stamping `lastRun`/`status` as "inferred."

**Acceptance:** a fixture repo with tests produces correct Test nodes and COVERS edges pointing at the modules they import.

### W4-03 — Dynamic COVERS refresh + test badges
**Wave 4 · Depends on:** W2-07, W2-04 · **Executor:** AI agent

Nightly coverage-instrumented run refreshing COVERS edges dynamically (`lastRun`/`status` as "measured"); pass/fail badge overlay on the Technical Tree; safe fallback to the full suite when impact analysis is inconclusive.

**Acceptance:** a code change without test updates shows a stale/failing badge; the fallback runs the full suite when the impacted set can't be determined confidently.

---

## 13. Post-MVP / Trigger-Gated Migrations

*(Gated by measured metrics/events per PRD §4.10, not by calendar date or customer count.)*

### PM-01 — Macro View: Project entity + cross-repo edges
**Post-MVP · Depends on:** W0-02, W3-04 · **Executor:** AI agent

Project-to-Repo mapping and CONNECTS_TO cross-repo edge inference from API contracts, shared package versions, cross-repo imports.

### PM-02 — Migration-trigger dashboard
**Post-MVP · Depends on:** W0-06, W0-08 · **Executor:** AI agent

Surfaces W0-06/W0-08 metrics side by side; owns defining and documenting the concrete threshold numbers for PM-03/PM-04.

**Acceptance:** both stores' metrics render side by side with matching tag schemas; threshold numbers stated on the dashboard and in a linked doc with rationale.

### PM-03 — Neo4j → Amazon Neptune cutover
**Post-MVP · Gated by:** W0-08 metrics crossing PM-02's threshold · **Executor:** Human (infra-critical)

openCypher-only migrations replay unmodified.

### PM-04 — pgvector → Amazon OpenSearch cutover
**Post-MVP · Gated by:** W0-06 metrics crossing PM-02's threshold · **Executor:** Human (infra-critical)

### PM-05 — GraphQL layer + DataLoader batching
**Post-MVP · Gated by:** view-specific data-shape divergence · **Executor:** Pair (decision: human; implementation: AI agent using W4-05's plan)

Resolvers as thin wrappers over the same service layer as REST and MCP.

### PM-06 — Cursor Origin
**Post-MVP · Gated by:** Origin publishing public API/webhook docs (ingestion side only; no gate on MCP side) · **Executor:** AI agent, once gated

Ingestion: a new provider plug-in against W3-04's provider-generic interface. Context provision: Origin's agents are ordinary MCP clients against W4-06 — no Origin-specific work required.

### PM-07 — Env-file → KMS-backed secrets manager cutover
**Post-MVP · Gated by:** first external customer or first production pitch · **Executor:** Human (security-critical)

Chosen manager provisioned per environment; `getSecret` backend swapped with a short-lived in-memory cache; every existing secret rotated; W0-07's CI lint stays in force.

**Acceptance:** no service reads a secret from an environment variable in production; every previously issued secret rotated; a runbook exists for issuing/rotating/revoking without a deploy.

### PM-08 — MCP write/propose tool surface
**Post-MVP · Gated by:** sustained Agent Context Adoption baseline (W4-06 metering) + explicit customer demand + a defined reliability bar · **Executor:** Pair (decision/safety design: human; implementation: AI agent)

Tools letting agents propose changes back through the platform, validated against Agent/Skill MD guardrails, style rules, and covering tests before any code is written.

---

## Appendix: Combined Dependency & Wave Reference

Actual build order still follows the wave/dependency structure established across Ticket-Backlog-v3/v4 and the Wave 6–10 addenda — this appendix is the planning reference for that, independent of the feature grouping above.

| Wave | Tickets |
|---|---|
| 0 | W0-00, W0-01, W0-02, W0-03, W0-04, W0-05, W0-06, W0-07, W0-08 |
| 1 | W1-01, W1-02, W1-03, W1-04, W1-05, W1-06 |
| 2 | W2-01, W2-02, W2-03, W2-05, W2-06, W2-07, W2-08 |
| 3 | W2-04, W3-01, W3-02, W3-03, W3-04, W3-05, W3-06, W3-07, W3-08, W3-09, W3-10 |
| 4 | W4-01, W4-02, W4-03, W4-05, W4-06, W4-07 |
| 5 | W4-04 |
| 6 | W6-01, W6-02*, W6-03, W6-04, W6-05 |
| 7 | W7-01, W7-02, W7-03, W7-04, W7-05 |
| 8 | W8-01, W8-02* |
| 9 | W9-01, W9-02* |
| 10 | W10-01, W10-02, W10-03, W10-04, W10-05, W10-06, W10-07* |
| Post-MVP | PM-01 through PM-08 (trigger-gated, not wave-ordered) |

\* = flagged same-wave dependency exception (depends on another ticket in the same wave — hand off sequentially within that wave rather than assigning both on day one). Every other ticket within a wave has no dependency on another same-wave ticket and can be assigned to different developers/agents simultaneously once the wave's prerequisites have landed.
