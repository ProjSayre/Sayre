## Project
Codebase Visualizer — an AI-powered codebase ontology and visualization platform. Parses repos into a graph (Neo4j), then renders Technical / Product / Onboarding tree views for different stakeholders (engineers, architects, PMs, new hires).

## Stack
- Frontend: Next.js (React) + TypeScript, Tailwind CSS
- Graph rendering: React Flow below ~500 visible nodes; Sigma.js (WebGL) + graphology above that threshold — graphology is limited to client-side algorithm gaps (local filter/subgraph/layout); heavy graph computation stays server-side in the Graph Query Service
- Core API: Node.js/TypeScript — REST facade now, GraphQL later (see docs/migration-triggers.md)
- Async workers: Python/FastAPI + Tree-sitter structural parsing + LangChain/LangGraph orchestration; semantic shaping, generation, and embedding calls go through separate Sayre-owned `GraphifyAdapter`, `ModelProvider`, and `EmbeddingProvider` boundaries
- Integration workers: Node.js + BullMQ (GitHub, Jira, Linear)
- Relational DB: PostgreSQL (Amazon RDS) — system of record for permissions
- Graph DB: Neo4j (launch) → Amazon Neptune (scale)
- Vector store: pgvector (launch) → Amazon OpenSearch (scale)
- Realtime: WebSocket gateway + Redis pub/sub

## Structure
- `apps/web/` — Next.js visualization client
- `services/core/` — Node.js API + service layer + Graph Query Service + BullMQ integration jobs
- `services/core/src/mcp/` — thin MCP tool handlers over the same service layer; no business logic or direct data access
- `services/gateway/` — WebSocket gateway for realtime fan-out (Redis pub/sub)
- `services/workers/` — Python/FastAPI async fleet (ingestion, semantic enrichment, retrieval/RAG)
- `packages/graph-schema/` — shared openCypher schema + query builders
- `infra/` — docker-compose, pinned service images
- `docs/` — architecture reference and migration-trigger detail

## Commands
- Dev: `npm run dev` (turbo: web + core + gateway)
- Build: `npm run build`
- Test: `npm run test`
- Lint: `npm run lint`
- Python workers: `poetry run pytest` (from `services/workers/`)

## Verification
After every change, run in this order:
1. `npx tsc --noEmit` — fix type errors
2. `npm run test` (or `poetry run pytest` for `services/workers/` changes) — fix failing tests
3. `npm run lint` — fix lint errors

## Architecture rules (non-negotiable)
- IMPORTANT: The graph is the source of truth, not the raw git checkout. All reads (canvas, AI retrieval, integrations) hit Postgres/Neo4j/pgvector — never a live repo clone.
- Only Folder and File nodes are ever rendered on canvas, in any of the three tree views. Function/Class nodes are graph-internal only.
- Business logic lives in the service layer, never in a route handler or resolver directly — see `.claude/rules/service-layer.md`.
- Any graph traversal or RBAC-based node filtering happens server-side in the Graph Query Service — NEVER duplicate this in client-side graphology code. See `.claude/rules/security-multitenancy.md`.

## Conventions
- Logical graph schema, data migrations, and application queries target openCypher-compatible syntax. Constraints, indexes, and other physical DDL remain target-specific — see `.claude/rules/graph-schema.md` and `docs/wave0-foundation-contracts.md`.
- SQS/SNS are for the Python worker/event fleet; BullMQ is for Node integration workers. Ingestion is FIFO, accepted `graph.updated` events fan out through SNS before bounded chunks enter `embedding-upserts`, enrichment uses separate physical priority/default lanes, and consumers require DLQs, visibility heartbeats, and durable idempotency. This is a permanent fleet split, not a migration path — see `.claude/rules/async-messaging.md`.
- For scaling/migration trigger thresholds (Neo4j→Neptune, pgvector→OpenSearch, REST→GraphQL), see `docs/migration-triggers.md`.
- Secrets: MVP resolves pre-provisioned credential references through one loader per language; local references may resolve from gitignored `.env` files (committed `*.env.example` templates hold placeholders only). W3-09 never accepts raw provider credentials; PM-07 adds the KMS-backed write/rotation phase before the first external customer — see `.claude/rules/security-multitenancy.md`.
- Persistence: bounded, tenant-scoped code/document chunks and 1024-dimensional cosine embeddings may persist for retrieval, with provider/model/dimension metadata; repository checkouts and source trees never do. Scratch clones are destroyed after parsing. A force-push/non-fast-forward ref update triggers a full scoped head-projection rebuild, never a changed-file delta.
- MCP keys: issue a public ID/prefix plus a one-time 256-bit secret; store only a pepper-versioned HMAC-SHA-256 digest and audit fields. Agent-key grants reuse `permissions` and cannot exceed the issuer's recorded ceiling or current effective scope.

## Don't
- Don't render Function/Class nodes on canvas — fold them into File node metadata instead.
- Don't call the Graph DB directly from a route handler — go through the service layer and Graph Query Service.
- Don't add a new queue system for an integration. Provider integrations remain BullMQ job types/queues on the Node fleet; the approved Python FIFO/fanout/physical-priority topology is defined in `docs/wave0-foundation-contracts.md`.

## Agent pipeline
Run `/pipeline <ticket description or path to ticket file>` to chain the full pipeline. Related commands:
- `/spec-only <ticket>` — runs just `planner`, stops for human review/editing of `spec.md` before any code is touched
- `/pipeline-status` — reports which stage a run is currently at, without running anything
- `/security-recheck` — re-runs just `security-checker` against current disk state, for a fast check after a hand-edit (doesn't redo tester/review)

Feature/ticket work runs through five subagents in sequence, coordinating via shared files in `.pipeline/` (not `.claude/`, gitignored):

1. `planner` (Opus) — turns a vague ticket into a detailed spec with exact file paths/signatures/edge cases, writes `.pipeline/spec.md`
2. `dev` (Sonnet) — reads spec.md, implements (can spawn its own subagents for independent sub-tasks), writes `.pipeline/changes.md`
3. `tester` — reads changes.md, writes/runs tests for happy path + edge cases, writes `.pipeline/test-results.md`
4. `review` — **read-only, cannot edit code** (enforced by hook) — checks the diff against spec.md/PRD alignment and test-results.md's coverage, writes `.pipeline/review.md` with verdict `PASS` or `NEEDS_FIXES`
5. `security-checker` — **read-only, cannot edit code** (enforced by hook) — runs only after review.md is `PASS`; checks tenant isolation/RBAC/secrets/webhooks, writes `.pipeline/security-report.md` with verdict `PASS` or `BLOCKED`

If review returns `NEEDS_FIXES` (or security returns `BLOCKED`), the pipeline routes back to `dev` with the fix list, then re-runs the downstream stages — capped at 3 loops before stopping to ask a human.

Each stage reads the previous stage's file before starting. Don't skip a stage or let `dev` invent its own spec — if `.pipeline/spec.md` is missing, run `planner` first.

Note: `planner`/`dev` model fields use the `opus`/`sonnet` aliases so they always resolve to Anthropic's current models for that tier — pin an exact model string (e.g. `claude-opus-4-8`) in their frontmatter instead if you need a fixed version.
