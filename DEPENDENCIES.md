# Dependency Inventory — Codebase Visualizer Product

This file inventories every third-party dependency pinned for the product runtimes under W0-00
(Dependency & Environment Baseline). It does **not** cover the root Vite marketing site
(`package.json` at repo root) — that is a separate, unrelated package and out of scope for this
ticket (see `.pipeline/spec.md` O-1).

Version policy: each manifest below pins to a minor line (or an exact patch where the ticket
specified one); the committed lockfile (`package-lock.json` / `poetry.lock`) freezes the exact
resolved graph. See `.pipeline/changes.md` for install verification notes (what was actually
resolved on this machine).

When a support package is not named by a PRD section, its Reference cell says **Not named in PRD;
build/test support** rather than using an ambiguous dash.

> **Authority:** `docs/prd.md` (PRD v5) and `docs/PRD_Tickets.md` (Ticket Backlog v3) are the
> current product and scheduling sources. `docs/wave0-foundation-contracts.md` summarizes the
> approved cross-ticket identities, persistence, queue, adapter, and secrets contracts. The older
> `docs/backlog.md` is historical only.

## `apps/web` — Next.js product visualization client

| Package | Runtime/Location | Purpose | Reference | Future swap |
|---|---|---|---|---|
| `next` | apps/web (dep) | App framework/router/build for the visualization shell | `docs/prd.md` §3 (Frontend Framework), `CLAUDE.md` Stack | — |
| `react` | apps/web (dep) | UI library | `docs/prd.md` §3, `CLAUDE.md` Stack | — |
| `react-dom` | apps/web (dep) | React DOM renderer | `docs/prd.md` §3 | — |
| `@xyflow/react` | apps/web (dep) | React Flow renderer for fewer than about 500 visible nodes | `docs/prd.md` §2.2, §3; `docs/architecture.md` | Permanent dual-renderer boundary with Sigma.js |
| `sigma` | apps/web (dep) | WebGL renderer above the ~500-visible-node threshold | `docs/prd.md` §2.2, §3; `docs/architecture.md`; `docs/migration-triggers.md` | Permanent dual-renderer boundary with React Flow |
| `graphology` | apps/web (dep) | Client-side graph data structure backing Sigma + local algorithms | `docs/prd.md` §2.2; `docs/migration-triggers.md` (Client Rendering boundary) | — |
| `graphology-layout` | apps/web (dep) | Client-side layout algorithms (local pre-processing only, never RBAC/traversal) | `.claude/rules/security-multitenancy.md` | — |
| `typescript` | apps/web (devDep) | Type checking | `CLAUDE.md` Stack | — |
| `@types/react` | apps/web (devDep) | React type defs | Not named in PRD; build/test support | — |
| `@types/react-dom` | apps/web (devDep) | React-DOM type defs | Not named in PRD; build/test support | — |
| `@types/node` | apps/web (devDep) | Node type defs (Node 20 LTS target) | `.nvmrc` | — |
| `graphology-types` | apps/web (devDep) | Type defs peer for graphology/sigma | Not named in PRD; build/test support | — |
| `tailwindcss` | apps/web (devDep) | Utility CSS for dashboard/inspector layouts | `docs/prd.md` §3 (Styling) | — |
| `postcss` | apps/web (devDep) | Tailwind's CSS transform pipeline | Not named in PRD; build/test support | — |
| `autoprefixer` | apps/web (devDep) | Vendor-prefixing for Tailwind output | Not named in PRD; build/test support | — |
| `eslint` | apps/web (devDep) | Lint engine | `CLAUDE.md` Commands (`npm run lint`) | — |
| `eslint-config-next` | apps/web (devDep) | Next.js lint ruleset (pinned to `next`'s 14.2 minor) | Not named in PRD; build/test support | — |
| `vitest` | apps/web (devDep) | Test runner for `apps/web` (W0-01 D-6) | `.pipeline/spec.md` W0-01 D-6; `CLAUDE.md` Commands (`npm run test`) | — |

## `packages/shared-types` — cross-package TypeScript contracts

| Package | Runtime/Location | Purpose | Reference | Future swap |
|---|---|---|---|---|
| `typescript` | packages/shared-types (devDep) | Type checking / `tsc` build to `dist/` | `CLAUDE.md` Stack | — |

`@sayre/shared-types` (the package itself, `version 0.1.0`, `private`) defines the `HealthStatus`/
`ServiceName` contract consumed by `services/core` (and mirrored by convention in `apps/web` and
`services/workers`, which don't import it directly due to the Node/Python split). Introduced by
W0-01 (D-4) as the first npm-workspace member alongside `apps/web` and `services/core`; resolved
into `services/core` via plain npm workspace symlinking (`"@sayre/shared-types": "^0.1.0"`), not a
`file:` path — see W0-01 D-3. `packages/graph-schema` is explicitly **not** created this ticket
(D-4) — it belongs to a future graph-specific ticket.

## `services/core` — Node/TypeScript API, service layer, Graph Query Service, BullMQ integration workers

| Package | Runtime/Location | Purpose | Reference | Future swap |
|---|---|---|---|---|
| `express` | services/core (dep) | REST facade for the Core App Service | `docs/prd.md` §3 (Core API), §4.2 (API Gateway/Core App Service) | REST → GraphQL; see below |
| `@modelcontextprotocol/sdk` | services/core (dep) | MCP streamable-HTTP server primitives for thin MCP handlers | `docs/prd.md` §2.6, §4.2; W0-00/W4-06 | — |
| `zod` | services/core (dep) | Runtime schema validation for MCP and message boundaries | W0-00; `docs/wave0-foundation-contracts.md` | — |
| `@aws-sdk/client-sqs` | services/core (dep) | Typed access to approved SQS event/queue boundaries from Node-owned orchestration points | W0-04; `docs/wave0-foundation-contracts.md` | — |
| `@aws-sdk/client-sns` | services/core (dep) | Typed access to accepted `graph.updated` SNS fanout | W0-04; `docs/wave0-foundation-contracts.md` | — |
| `@opentelemetry/api` | services/core (dep) | Stable metrics API for sanctioned graph calls | W0-08; `docs/migration-triggers.md` | Exporter remains swappable |
| `@opentelemetry/sdk-metrics` | services/core (dep) | Node metrics SDK paired with the pinned API | W0-08 | — |
| `@opentelemetry/exporter-prometheus` | services/core (dep) | Local Prometheus reader/exporter paired with the metrics SDK | W0-08 | Production exporter may change without call-site changes |
| `bullmq` | services/core (dep) | Queue for Node integration workers (GitHub/Jira/Linear) | `docs/prd.md` §2.4; `.claude/rules/async-messaging.md` | No consolidation planned (permanent split) |
| `ioredis` | services/core (dep) | Redis client required by BullMQ | `.claude/rules/async-messaging.md` | — |
| `neo4j-driver` | services/core (dep) | Driver for the Graph Query Service (server-side traversal/RBAC filtering only) | `docs/prd.md` §4.2, §4.3 (Graph Store); `.claude/rules/security-multitenancy.md`, `.claude/rules/graph-schema.md` | Neo4j → Amazon Neptune; see below |
| `pg` | services/core (dep) | Postgres client — org/user/permission system of record | `docs/prd.md` §4.3 (Relational Store) | — |
| `jsonwebtoken` | services/core (dep) | JWT AuthN for the API Gateway/AuthZ middleware | `docs/prd.md` §4.2 (API Gateway) | — |
| `drizzle-orm` | services/core (dep) | ORM/query builder + migrator for the Postgres system-of-record tables (org/user/repo/permission/ticket_cache/style_rules/onboarding_steps), layered on the pinned `pg` driver. Manifest pins `0.38.x`; resolved `0.38.4` (see `.pipeline/W0-05/changes.md`). | `docs/prd.md` §4.3, §4.5 (RLS); `.pipeline/W0-05/spec.md` | — |
| `typescript` | services/core (devDep) | Type checking | `CLAUDE.md` Stack | — |
| `tsx` | services/core (devDep) | Dev/runtime TS execution (`dev` script; unused until a later ticket implements `src/`) | Not named in PRD; build/test support | — |
| `vitest` | services/core (devDep) | Test runner (`npm run test`/`test:integration`) — none existed before W0-04; required for the BullMQ round-trip integration test | `CLAUDE.md` Commands (`npm run test`); W0-04 spec R1 | — |
| `@types/node` | services/core (devDep) | Node type defs (Node 20 LTS target) | `.nvmrc` | — |
| `@types/express` | services/core (devDep) | Express type defs | Not named in PRD; build/test support | — |
| `@types/jsonwebtoken` | services/core (devDep) | JWT type defs | Not named in PRD; build/test support | — |
| `@types/pg` | services/core (devDep) | Postgres client type defs | Not named in PRD; build/test support | — |
| `@sayre/shared-types` | services/core (dep) | Cross-package `HealthStatus`/`ServiceName` contract, resolved via npm workspace symlinking (W0-01 D-3/D-4) | `.pipeline/spec.md` W0-01 D-3, D-4; `.claude/rules/service-layer.md` | — |
| `eslint` | services/core (devDep) | Lint engine, pinned to `apps/web`'s 8.57 minor to avoid cross-runtime drift | `.pipeline/spec.md` W0-01 D-6 | — |
| `@typescript-eslint/parser` | services/core (devDep) | TypeScript parser for eslint | `.pipeline/spec.md` W0-01 D-6 | — |
| `@typescript-eslint/eslint-plugin` | services/core (devDep) | TypeScript-aware lint rules | `.pipeline/spec.md` W0-01 D-6 | — |
| `drizzle-kit` | services/core (devDep) | Migration generator/runner CLI (`db:generate`) — produces the versioned `.sql` migrations under `services/core/drizzle/` from `src/db/schema.ts`. Manifest pins `0.30.x`; resolved `0.30.6` (see `.pipeline/W0-05/changes.md`). | `docs/prd.md` §4.3, §4.5; `.pipeline/W0-05/spec.md` | — |

Note: no direct Graph DB/pgvector convenience dependency was added here — per
`.claude/rules/service-layer.md`, the graph is only ever reached through the service layer /
Graph Query Service, and the vector store client belongs to the Python fleet, not `services/core`.

## `services/workers` — Python/FastAPI async worker fleet

| Package | Runtime/Location | Purpose | Reference | Future swap |
|---|---|---|---|---|
| `fastapi` | services/workers (dep) | Async worker HTTP framework | `docs/prd.md` §2.1, §4.2 (Async Worker Fleet); `CLAUDE.md` Stack | — |
| `uvicorn[standard]` | services/workers (dep) | ASGI server for FastAPI | `docs/prd.md` §4.2 | — |
| `tree-sitter` | services/workers (dep) | Incremental AST parsing core | `docs/prd.md` §2.1 (Multi-Language AST Parsing) | — |
| `tree-sitter-language-pack` | services/workers (dep) | Bundled multi-language grammars for Tree-sitter | `docs/prd.md` §2.1 | Individual per-language grammar packages deferred to the Ingestion Worker ticket (O-8) |
| `graphifyy` | services/workers (dep) | Base Graphify distribution, reachable only through Sayre's future `GraphifyAdapter`; semantic output shaping only, never the W1-01 parser | `docs/prd.md` §2.1; W0-00/W2-05/W3-07 | No provider extras |
| `openai` | services/workers (dep) | OpenAI-compatible SDK reserved for generation `ModelProvider` adapters and W1-05's separate `EmbeddingProvider` adapter | `docs/prd.md` §2.7; W1-05/W3-07 | No direct use outside provider adapters |
| `langchain` | services/workers (dep) | LLM workflow orchestration above Sayre's provider boundary | `docs/prd.md` §2.1 (Semantic Relationship Extraction), §4.2 | Provider selection and SDK construction remain in `ModelProvider` |
| `langgraph` | services/workers (dep) | Graph-based agent orchestration (Graph-Guided RAG) | `docs/prd.md` §2.5, §4.2, §4.4 (AI Query flow) | — |
| `boto3` | services/workers (dep) | AWS SDK — SQS/SNS client for FIFO ingestion, fanout subscriptions, priority lanes, and `embedding-upserts` | `docs/prd.md` §2.1, §4.1; W0-04 | — |
| `psycopg[binary]` | services/workers (dep) | Postgres client (metadata/style-rule reads from the worker fleet; also backs the `graph_migrations` version-tracking table written by the graph migration runner, W0-02) | `docs/prd.md` §4.3 | — |
| `pgvector` | services/workers (dep) | Vector store client for 1024-dimensional cosine embeddings with provider/model/dimension metadata | `docs/prd.md` §2.5 (Hybrid Storage Engine), §4.3 (Vector Store); W0-05/W1-05 | pgvector → Amazon OpenSearch; see below |
| `neo4j` | services/workers (dep) | Python Bolt driver used by `sayre_workers/graph_migrations/runner.py` and later ingestion writers. The runner applies shared portable files from `graph-migrations/logical/` plus only `physical/neo4j/`; target/layer/version history is independent. There is no version skip list. | `docs/prd.md` §4.3/§4.10; `.claude/rules/graph-schema.md`; W0-02 | PM-03 owns the real Neptune adapter/cutover and any future `physical/neptune/` operation. |
| `anthropic` | services/workers (dep) | Anthropic SDK reserved for the concrete Anthropic `ModelProvider` adapter | `docs/prd.md` §2.7; W3-07 | No direct use outside provider adapters |
| `pydantic` | services/workers (dep) | Data validation (FastAPI 0.115 requires Pydantic v2) | Not named in PRD; build/test support | — |
| `pytest` | services/workers (dev group) | Test runner | `CLAUDE.md` Commands (`poetry run pytest`) | — |
| `pytest-asyncio` | services/workers (dev group) | Async test support for FastAPI/async code paths | Not named in PRD; build/test support | — |
| `ruff` | services/workers (dev group) | Lint (W0-01 D-6) | `.pipeline/spec.md` W0-01 D-6; `CLAUDE.md` Commands (`poetry run ruff check .`) | — |
| `mypy` | services/workers (dev group) | Typecheck (W0-01 D-6) | `.pipeline/spec.md` W0-01 D-6; `CLAUDE.md` Verification | — |
| `httpx` | services/workers (dev group) | Required transitively by Starlette's `TestClient` (used in `tests/test_health.py`) | `.pipeline/spec.md` W0-01 (Affected files, `services/workers`) | — |
| `opentelemetry-api` | services/workers (dep) | Vendor-neutral metrics API — the only surface `vector_metrics.py` and future call sites import (resolved `1.29.0`) | `docs/migration-triggers.md` (Vector Store trigger); W0-06 spec | — (this *is* the swap point's stable surface) |
| `opentelemetry-sdk` | services/workers (dep) | MeterProvider/View/Resource implementation behind the API — same minor as `opentelemetry-api` (resolved `1.29.0`) | W0-06 spec (`sayre_workers/telemetry/otel.py`) | — |
| `opentelemetry-exporter-prometheus` | services/workers (dep) | Pull-based Prometheus exporter for `/metrics` — pinned to the release paired with the `1.29.x` api/sdk minor (resolved `0.50b0`, which also pins `opentelemetry-semantic-conventions==0.50b0` transitively) | W0-06 spec | Swapped for an OTLP/vendor reader in prod — see `otel.py`'s `init_metrics()` docstring; zero call-site changes |
| `prometheus-client` | services/workers (dep) | Arrives transitively via the exporter; pinned explicitly (resolved `0.25.0`) because `otel.py` calls `start_http_server()` directly | W0-06 spec | — |

`Qwen3-Embedding-0.6B` is the local-compatible embedding-model default, served behind the
OpenAI-compatible endpoint consumed by W1-05's `EmbeddingProvider`; Sayre does not bundle a model
runtime in this dependency baseline. CI uses a deterministic network-free fake that emits stable
1024-dimensional vectors.

**O-10 (LocalStack/SQS emulator for local dev) — resolved by W0-04.** See
`infra/docker-compose.yml` (`localstack` service) and the pinned image row below.

## Root workspace — monorepo orchestration (W0-01)

| Package | Runtime/Location | Purpose | Reference | Future swap |
|---|---|---|---|---|
| `turbo` | root (devDep) | Orchestrates build/lint/typecheck/test across the npm-workspace packages (`apps/web`, `services/core`, `packages/shared-types`); `build` task's `dependsOn: ["^build"]` builds `packages/shared-types` before `services/core` automatically | `.pipeline/spec.md` W0-01 D-3 | — |

Root `package.json` (the marketing site's, `sayre-site`) gained a `"workspaces"` field this ticket
(`["apps/web", "services/core", "packages/*"]`) plus a `packageManager` field (required by turbo
2.x to resolve the workspace unambiguously — discovered mid-implementation, not anticipated by the
spec text; see `.pipeline/changes.md`). The marketing site's own `dev`/`build`/`preview`/`og`/
`test:waitlist` scripts and dependencies are unchanged; new `dev:workspaces`/`build:workspaces`/
`lint:workspaces`/`typecheck:workspaces`/`test:workspaces` scripts drive the workspace packages
via `turbo` instead. `services/workers` (Poetry) is **not** part of this npm workspace at all — see
`.pipeline/spec.md` W0-01 D-3.

## `infra/docker-compose.yml` — pinned datastore images

| Image | Purpose | Reference | Future swap |
|---|---|---|---|
| `node:20.19.5-bookworm-slim` | Reproducible Debian-slim build/runtime base for the product web and core Compose targets | W0-01; `.nvmrc` | Keep on Node 20 LTS for the current workspace engine contract |
| `python:3.12.13-slim-bookworm` | Reproducible Debian-slim runtime base for the Python worker Compose target | W0-01; `services/workers/pyproject.toml` | Keep on Python 3.12 for the current worker contract |
| `alpine:3.20` | One-shot, local-only generator for independent Postgres and Neo4j development passwords stored in a Docker volume | W0-01; `.claude/rules/security-multitenancy.md` | Remove when local secret provisioning is replaced by managed development infrastructure |
| `pgvector/pgvector:pg16` | Postgres + `vector` extension — relational system of record *and* vector store backing | `docs/prd.md` §4.3 (Relational Store, Vector Store); `docs/architecture.md` | pgvector → Amazon OpenSearch; see below. **Deviation note:** the ticket's literal text said `postgres:16`; this is deliberately `pgvector/pgvector:pg16` instead because plain `postgres:16` does not ship the `vector` extension required by the Vector Store component. See `.pipeline/changes.md`. |
| `redis:7.4-alpine` | Redis — BullMQ backing store + Realtime Service pub/sub | `docs/prd.md` §4.2 (Realtime Service); `.claude/rules/async-messaging.md` | — |
| `neo4j:5.24-community` | Graph DB — codebase ontology (major 5, matching `neo4j-driver` 5.x) | `docs/prd.md` §4.3 (Graph Store) | Neo4j → Amazon Neptune; see below |
| `localstack/localstack:3.8` | SQS/SNS emulator for the Python worker/event fleet (local dev only; real AWS services in production) | `docs/prd.md` §2.1, §4.2; W0-04 | Not a future swap; production provisioning/IAM remains separate infra work |
| `prom/prometheus:v3.1.0` | Locally-run Prometheus — scrapes the `sayre-workers` `/metrics` endpoint (`sayre_workers/telemetry/otel.py`) for the pgvector → OpenSearch trigger metrics (`vector_query_duration_ms`, `vector_query_concurrent_count`) | W0-06 spec; `docs/prd.md` §4.10; `docs/migration-triggers.md` (Vector Store trigger) | Dashboards/Grafana/alert rules are a later, non-blocking ticket (see W0-06 spec Open Questions) |

The worker image and the GitHub Actions worker job both pin Poetry to `2.2.0`, matching
the version recorded in the generated `services/workers/poetry.lock` header.

## Known future swaps (PRD migration triggers)

Sourced from `docs/migration-triggers.md` and PRD v5 §4.10:

- **`neo4j-driver` (Neo4j) → Amazon Neptune-compatible driver.** Trigger: sustained concurrent,
  multi-tenant query load — not raw data size. Stays a data-store swap behind the Graph Query
  Service. Logical schema, data migrations, and application queries stay openCypher-compatible;
  constraints/indexes and other physical DDL are versioned for each target.
- **`pgvector` (Python fleet) → Amazon OpenSearch client.** Trigger: instrumented concurrent
  vector-query load (sustained queries/sec under concurrent multi-tenant access) and/or a p95/p99
  latency bound — not candidate-set size, corpus size, or customer count. The instrumentation that
  measures this trigger (`vector_query_duration_ms`, `vector_query_concurrent_count`, both tagged
  by `org_id`) shipped in W0-06 via `sayre_workers/telemetry/` — ahead of any real pgvector call
  site, since none exist yet; see W0-06 spec for the harness/convention split.
- **`express` / REST facade → GraphQL server libs + DataLoader batching.** Trigger: client
  data-shape divergence across the Technical/Product/Onboarding views reaching the point where
  REST forces overfetching or a proliferation of bespoke endpoints. Touches only the routing
  layer — business logic stays in the service layer (`.claude/rules/service-layer.md`).

## Deliberate non-migrations

So nobody mistakes these permanent splits for pending future swaps:

- **React Flow / Sigma.js + graphology client boundary** — React Flow renders fewer than about
  500 visible nodes; Sigma.js renders above that threshold. graphology is scoped to documented
  client-side algorithm gaps only—never RBAC or deep traversal. This is a permanent boundary, not
  a migration.
- **AWS SQS/SNS (Python worker/event fleet) vs. `bullmq` (Node integration workers)** — a
  permanent messaging split. The AWS side includes FIFO ingestion, SNS fanout, physical
  priority/default enrichment lanes, DLQs, heartbeats, and durable idempotency.

## Infra image deviation summary

`infra/docker-compose.yml` pins Postgres to `pgvector/pgvector:pg16` rather than the ticket's
literal `postgres:16`, because the Vector Store component requires the `vector` Postgres
extension, which the stock image does not ship. This is a Sprint-0 baseline decision, not a
future migration — the swap-to-OpenSearch item above is unrelated to this image choice. See
`.pipeline/changes.md` for the full deviation record and O-11 in `.pipeline/spec.md`.
