# Dependency Inventory — Codebase Visualizer Product

This file inventories every third-party dependency pinned for the product runtimes under W0-00
(Dependency & Environment Baseline). It does **not** cover the marketing site's own manifest
(`apps/site/package.json`, PL-15) — that is a separate, unrelated package and out of scope for this
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
| `@sigma/node-border` | apps/web (dep) | Sigma node-border rendering program (`createNodeBorderProgram`, used by `SigmaCanvas.tsx`) for the approved graph visual language | Not named in PRD; Sigma rendering support | — |
| `graphology` | apps/web (dep) | Client-side graph data structure backing Sigma + local algorithms | `docs/prd.md` §2.2; `docs/migration-triggers.md` (Client Rendering boundary) | — |
| `graphology-layout` | apps/web (dep) | Client-side layout algorithms (local pre-processing only, never RBAC/traversal) | `.claude/rules/security-multitenancy.md` | — |
| `@sayre/config` | apps/web (dep) | Shared non-secret config / secret-reference loader consumed by the web client (server routes under `app/api/**`) | W0-07; `docs/wave0-foundation-contracts.md` | — |
| `@sayre/shared-types` | apps/web (dep) | Cross-package wire/type contracts, imported directly by `apps/web`'s workspace/provider-settings/realtime modules | W0-01 D-4 | — |
| `@sayre/workspace-packs` | apps/web (dep) | Contract-based Workspace Pack runtime (versioned pack manifests, shape/renderer registry) backing the product workspace and its visual editor | FE-ARCH-01/01R/02; `.sdd/ledger/20260806T212025975Z-e7d473d-PR_DELTA-4d53ce/` | — |
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
| `react-test-renderer` | apps/web (devDep) | React component test renderer backing `apps/web`'s vitest component tests | Not named in PRD; build/test support | — |
| `@types/react-test-renderer` | apps/web (devDep) | Type defs for `react-test-renderer` | Not named in PRD; build/test support | — |

## `packages/shared-types` — cross-package TypeScript contracts

| Package | Runtime/Location | Purpose | Reference | Future swap |
|---|---|---|---|---|
| `typescript` | packages/shared-types (devDep) | Type checking / `tsc` build to `dist/` | `CLAUDE.md` Stack | — |

`@sayre/shared-types` (the package itself, `version 0.1.0`, `private`) defines the `HealthStatus`/
`ServiceName` contract, and by now (this W0-00 re-derivation) both `apps/web` and `services/core`
declare and directly import `@sayre/shared-types` themselves (`services/workers` still doesn't,
mirroring it by convention only, due to the Node/Python split). Introduced by W0-01 (D-4) as the
first npm-workspace member alongside `apps/web` and `services/core`; resolved via plain npm
workspace symlinking (`"@sayre/shared-types": "^0.1.0"`), not a `file:` path — see W0-01 D-3.
`packages/graph-schema` is explicitly **not** created this ticket (D-4) — it belongs to a future
graph-specific ticket.

## `packages/config` — shared non-secret config / secret-reference loader

| Package | Runtime/Location | Purpose | Reference | Future swap |
|---|---|---|---|---|
| `@types/node` | packages/config (devDep) | Node type defs (Node 20 LTS target) | `.nvmrc` | — |
| `typescript` | packages/config (devDep) | Type checking / `tsc` build | `CLAUDE.md` Stack | — |
| `vitest` | packages/config (devDep) | Test runner | `CLAUDE.md` Commands (`npm run test`) | — |

`@sayre/config` (the package itself, `version 0.1.0`, `private`) is the single non-secret
config / secret-reference loader called for by the MVP secrets posture, consumed directly by
`apps/web`, `services/core`, and `services/gateway`. Reference: W0-07;
`.claude/rules/security-multitenancy.md`.

## `services/core` — Node/TypeScript API, service layer, Graph Query Service, BullMQ integration workers

| Package | Runtime/Location | Purpose | Reference | Future swap |
|---|---|---|---|---|
| `express` | services/core (dep) | REST facade for the Core App Service | `docs/prd.md` §3 (Core API), §4.2 (API Gateway/Core App Service) | REST → GraphQL; see below |
| `@modelcontextprotocol/sdk` | services/core (dep) | MCP streamable-HTTP server primitives for thin MCP handlers | `docs/prd.md` §2.6, §4.2; W0-00/W4-06 | — |
| `zod` | services/core (dep) | Runtime schema validation for MCP and message boundaries. Manifest pins `4.4.x`, matching the PRD's named `zod 4.4.x` line (W0-00 re-derivation bumped this from a stale `3.25.76` pin — see `.pipeline/changes.md`). | `docs/prd.md` W0-00 (`zod 4.4.x`); `docs/wave0-foundation-contracts.md` | — |
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
| `@sayre/config` | services/core (dep) | Shared non-secret config / secret-reference loader — same loader package as `services/gateway` | W0-07; `docs/wave0-foundation-contracts.md` | — |
| `eslint` | services/core (devDep) | Lint engine, pinned to `apps/web`'s 8.57 minor to avoid cross-runtime drift | `.pipeline/spec.md` W0-01 D-6 | — |
| `@typescript-eslint/parser` | services/core (devDep) | TypeScript parser for eslint | `.pipeline/spec.md` W0-01 D-6 | — |
| `@typescript-eslint/eslint-plugin` | services/core (devDep) | TypeScript-aware lint rules | `.pipeline/spec.md` W0-01 D-6 | — |
| `drizzle-kit` | services/core (devDep) | Migration generator/runner CLI (`db:generate`) — produces the versioned `.sql` migrations under `services/core/drizzle/` from `src/db/schema.ts`. Manifest pins `0.30.x`; resolved `0.30.6` (see `.pipeline/W0-05/changes.md`). | `docs/prd.md` §4.3, §4.5; `.pipeline/W0-05/spec.md` | — |

Note: no direct Graph DB/pgvector convenience dependency was added here — per
`.claude/rules/service-layer.md`, the graph is only ever reached through the service layer /
Graph Query Service, and the vector store client belongs to the Python fleet, not `services/core`.

**W2-03:** `services/core`'s `package.json` gained `"main": "dist/lib.js"` / `"types": "dist/lib.d.ts"`,
pointing at a new `src/lib.ts` library entry point (NOT `src/index.ts`, which has the side effect of
starting the HTTP listener at import time). This is what lets `services/gateway` import
`verifySessionToken`/`SessionClaims`/`assertValidEnvelope`/`MessageEnvelope` as a real `@sayre/core`
package dependency instead of re-implementing JWT verification or envelope validation a second time
(`.pipeline/spec.md` O-4). No other package resolves `@sayre/core` by its `main` field yet — `core`
is still run directly via `tsx watch src/index.ts` / `node dist/index.js`, unaffected by this change.

## `services/gateway` — Realtime Service (WebSocket gateway + Redis pub/sub fan-out)

Introduced by W2-03: the "Realtime Service" box in `docs/architecture.md`. Fans out accepted
`graph.updated` SQS events (`graph-updated-realtime`, provisioned since W0-04 and unconsumed until
this ticket) to connected canvas clients as RBAC-filtered Folder/File node patches, re-checking
authorization via a new Core-internal endpoint on every push, not just at WS-subscribe time
(`.claude/rules/security-multitenancy.md`).

| Package | Runtime/Location | Purpose | Reference | Future swap |
|---|---|---|---|---|
| `ws` | services/gateway (dep) | WebSocket server implementation for client connections | `docs/prd.md` §4.2 (Realtime Service); `.pipeline/spec.md` W2-03 O-6 | — |
| `ioredis` | services/gateway (dep) | Redis pub/sub client — fan-out across gateway instances, same connection pattern as `services/core/src/queue/bullmq.ts` | `.claude/rules/async-messaging.md`; `.pipeline/spec.md` W2-03 | — |
| `@aws-sdk/client-sqs` | services/gateway (dep) | Long-poll consumer of the `graph-updated-realtime` SQS queue — the first Node consumer of a Python-fleet SQS queue (`.pipeline/spec.md` W2-03 O-1) | `docs/architecture.md`; `.claude/rules/async-messaging.md` | — |
| `@sayre/config` | services/gateway (dep) | Shared non-secret config / secret-reference loaders — same `GATEWAY_*`/`REDIS_*`/`AWS_*`/`SQS_*` names as `services/core` | `.pipeline/spec.md` W2-03 | — |
| `@sayre/core` | services/gateway (dep) | Reuses Core's single `verifySessionToken`/`SessionClaims` (WS connection auth) and `assertValidEnvelope`/`MessageEnvelope` (SQS payload validation) implementations via `services/core`'s new `src/lib.ts` library entry point — avoids a second, divergent implementation of either. **Not listed in spec.md's literal Affected-files dependency list; added per O-4's resolution** (see `.pipeline/changes.md` deviation note). | `.pipeline/spec.md` W2-03 O-4 | — |
| `@sayre/shared-types` | services/gateway (dep) | Cross-package wire contracts (`GraphUpdatedPayload`, `CanvasNode`, `RealtimeGraphDelta`, `RealtimeDeltaRequest`, `ClientToGatewayMessage`, `GatewayToClientMessage`, `OrgRole`) | `.pipeline/spec.md` W2-03 | — |
| `@types/ws` | services/gateway (devDep) | Type defs for `ws` | `.pipeline/spec.md` W2-03 O-6 | — |
| `@types/node` | services/gateway (devDep) | Node type defs (Node 20 LTS target) | `.nvmrc` | — |
| `typescript` | services/gateway (devDep) | Type checking, pinned to the same minor as `services/core` | `CLAUDE.md` Stack | — |
| `tsx` | services/gateway (devDep) | Dev/runtime TS execution (`dev` script) | Not named in PRD; build/test support | — |
| `vitest` | services/gateway (devDep) | Test runner (`npm run test`) | `CLAUDE.md` Commands | — |
| `eslint` | services/gateway (devDep) | Lint engine, pinned to the same 8.57 minor as `services/core`/`apps/web` | `.pipeline/spec.md` W0-01 D-6 | — |
| `@typescript-eslint/parser` | services/gateway (devDep) | TypeScript parser for eslint | `.pipeline/spec.md` W0-01 D-6 | — |
| `@typescript-eslint/eslint-plugin` | services/gateway (devDep) | TypeScript-aware lint rules | `.pipeline/spec.md` W0-01 D-6 | — |

`ws`/`@types/ws` were not pinned by W0-00's dependency baseline (no WebSocket library was needed
before this ticket) — pinned here to the `8.18.x` minor line per O-6. `services/gateway` has no
`src/routes/**` lint-gate override (unlike `services/core`) — it has no Express routes at all, per
spec.md's Affected-files note.

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
| `neo4j` | services/workers (dep) | Python Bolt driver for the Graph Store — used only by `sayre_workers/graph_migrations/runner.py` (W0-02) to apply the openCypher migration scripts under `services/workers/graph-migrations/`; the Ingestion Worker (W1-01+) will reuse the same driver for real graph writes. Manifest pins `5.24.*` (matches the `neo4j:5.24-community` server image major.minor pinned in `infra/docker-compose.yml`); resolved `5.24.0`. Distinct from `neo4j-driver` (the Node/TS driver already pinned in `services/core`, used only by the Graph Query Service) — this is the Python-fleet driver, since the fleet owns all graph writes per `.claude/rules/async-messaging.md`/`CLAUDE.md` Structure. | `docs/prd.md` §4.3/§4.10 (Graph Store); `.claude/rules/graph-schema.md`; `.pipeline/spec.md` (W0-02) | Neo4j → Amazon Neptune; same trigger as `neo4j-driver` below — the Python runner's `--target neptune` flag already skips the one Neo4j-only DDL file (`003_constraints_and_indexes.cypher`) in anticipation |
| `anthropic` | services/workers (dep) | Anthropic SDK reserved for the concrete Anthropic `ModelProvider` adapter | `docs/prd.md` §2.7; W3-07 | No direct use outside provider adapters |
| `PyJWT[crypto]` | services/workers (dep) | JWT signing for GitHub App installation-token minting (`sayre_workers/ingestion/github_installation.py`) | W1-06 (GitHub App: registration, install flow & initial-parse trigger) | — |
| `httpx` | services/workers (dep) | Main `[project.dependencies]` entry — HTTP client for outbound calls (e.g. GitHub App installation-token requests in `github_installation.py`); also satisfies Starlette's `TestClient` in `tests/test_health.py`, but is no longer merely a dev-group transitive | `.pipeline/spec.md` W0-01 (Affected files, `services/workers`); W1-06 | — |
| `pydantic` | services/workers (dep) | Data validation (FastAPI 0.115 requires Pydantic v2) | Not named in PRD; build/test support | — |
| `pytest` | services/workers (dev group) | Test runner | `CLAUDE.md` Commands (`poetry run pytest`) | — |
| `pytest-asyncio` | services/workers (dev group) | Async test support for FastAPI/async code paths | Not named in PRD; build/test support | — |
| `ruff` | services/workers (dev group) | Lint (W0-01 D-6) | `.pipeline/spec.md` W0-01 D-6; `CLAUDE.md` Commands (`poetry run ruff check .`) | — |
| `mypy` | services/workers (dev group) | Typecheck (W0-01 D-6) | `.pipeline/spec.md` W0-01 D-6; `CLAUDE.md` Verification | — |
| `opentelemetry-api` | services/workers (dep) | Vendor-neutral metrics API — the only surface `vector_metrics.py` and future call sites import (resolved `1.29.0`) | `docs/migration-triggers.md` (Vector Store trigger); W0-06 spec | — (this *is* the swap point's stable surface) |
| `opentelemetry-sdk` | services/workers (dep) | MeterProvider/View/Resource implementation behind the API — same minor as `opentelemetry-api` (resolved `1.29.0`) | W0-06 spec (`sayre_workers/telemetry/otel.py`) | — |
| `opentelemetry-exporter-prometheus` | services/workers (dep) | Pull-based Prometheus exporter for `/metrics` — pinned to the release paired with the `1.29.x` api/sdk minor (resolved `0.50b0`, which also pins `opentelemetry-semantic-conventions==0.50b0` transitively) | W0-06 spec | Swapped for an OTLP/vendor reader in prod — see `otel.py`'s `init_metrics()` docstring; zero call-site changes |
| `prometheus-client` | services/workers (dep) | Arrives transitively via the exporter; pinned explicitly (resolved `0.25.0`) because `otel.py` calls `start_http_server()` directly | W0-06 spec | — |

`Qwen3-Embedding-0.6B` is the local-compatible embedding-model default, served behind the
OpenAI-compatible endpoint consumed by W1-05's `EmbeddingProvider`; Sayre does not bundle a model
runtime in this dependency baseline. CI uses a deterministic network-free fake that emits stable
1024-dimensional vectors.

**O-10 (LocalStack SQS/SNS emulator for local dev) — resolved by W0-04.** The checked-in
ready hook provisions FIFO `ingestion.fifo`, the `graph-updated` SNS topic with raw-message
subscriptions to `graph-updated-realtime` and `enrichment-default`, the separate
`enrichment-onboarding-priority` lane, and `embedding-upserts`. Every production queue has a
same-type DLQ with five-receive redrive and 14-day retention. Python consumers use visibility
heartbeats plus an injected durable delivery store; `SqliteDeliveryStore` is the local/shared-
volume reference only, not a multi-host exactly-once database. See `infra/docker-compose.yml`
(`localstack` service) and the pinned image row below.

## Root workspace — monorepo orchestration (W0-01)

| Package | Runtime/Location | Purpose | Reference | Future swap |
|---|---|---|---|---|
| `turbo` | root (devDep) | Orchestrates build/lint/typecheck/test across the npm-workspace packages (`apps/web`, `services/core`, `packages/shared-types`); `build` task's `dependsOn: ["^build"]` builds `packages/shared-types` before `services/core` automatically | `.pipeline/spec.md` W0-01 D-3 | — |

Root `package.json` (at the time still carrying the marketing site's own name and scripts directly)
gained a `"workspaces"` field this ticket (`["apps/web", "services/core", "packages/*"]`) plus a
`packageManager` field (required by turbo 2.x to resolve the workspace unambiguously — discovered
mid-implementation, not anticipated by the spec text; see `.pipeline/changes.md`). The marketing
site's own `dev`/`build`/`preview`/`og`/`test:waitlist` scripts and dependencies were unchanged at
the time; new `dev:workspaces`/`build:workspaces`/`lint:workspaces`/`typecheck:workspaces`/
`test:workspaces` scripts drive the workspace packages via `turbo` instead. `services/workers`
(Poetry) is **not** part of this npm workspace at all — see `.pipeline/spec.md` W0-01 D-3.

**W2-03:** `workspaces` gained `"services/gateway"` (`["apps/web", "services/core",
"services/gateway", "packages/*"]`), so `turbo run dev/build/lint/typecheck/test` (and the
`*:workspaces` root scripts) pick up the new Realtime Service package with no `turbo.json` change —
turbo derives its task graph from each package's own `package.json` scripts.

**PL-15:** the marketing site's manifest moved out of the workspace root entirely, into its own
`apps/*` workspace member (`@sayre/site`). Root `package.json` is now named `sayre`, carries no
`dependencies` key at all, and its `workspaces` array gained an `apps/*` glob so the relocated
member resolves the same way every other workspace package does. The site's runtime dependencies
and its own `dev`/`build`/`preview`/`og`/`hero:render`/`smoke`/`export-tree`/`test:waitlist`
scripts moved with it, at their same pinned version specs — nothing here was upgraded, only
relocated. Root `dev`/`build`/`preview` remain as thin delegating aliases so the external deploy
contract (repo-root `npm run build` → repo-root `dist/`) is unaffected. See
`docs/repo-structure.md` for the full shape and the deferred follow-ups.

## `infra/docker-compose.yml` — pinned datastore images

| Image | Purpose | Reference | Future swap |
|---|---|---|---|
| `pgvector/pgvector:pg16` | Postgres + `vector` extension — relational system of record *and* vector store backing | `docs/prd.md` §4.3 (Relational Store, Vector Store); `docs/architecture.md` | pgvector → Amazon OpenSearch; see below. **Deviation note:** the ticket's literal text said `postgres:16`; this is deliberately `pgvector/pgvector:pg16` instead because plain `postgres:16` does not ship the `vector` extension required by the Vector Store component. See `.pipeline/changes.md`. |
| `redis:7.4-alpine` | Redis — BullMQ backing store + Realtime Service pub/sub | `docs/prd.md` §4.2 (Realtime Service); `.claude/rules/async-messaging.md` | — |
| `neo4j:5.24-community` | Graph DB — codebase ontology (major 5, matching `neo4j-driver` 5.x) | `docs/prd.md` §4.3 (Graph Store) | Neo4j → Amazon Neptune; see below |
| `localstack/localstack:3.8` | SQS/SNS emulator for the Python worker/event fleet (local dev only; real AWS services in production) | `docs/prd.md` §2.1, §4.2; W0-04 | Not a future swap; production provisioning/IAM remains separate infra work |
| `prom/prometheus:v3.1.0` | Locally-run Prometheus — scrapes the `sayre-workers` `/metrics` endpoint (`sayre_workers/telemetry/otel.py`) for the pgvector → OpenSearch trigger metrics (`vector_query_duration_ms`, `vector_query_concurrent_count`) | W0-06 spec; `docs/prd.md` §4.10; `docs/migration-triggers.md` (Vector Store trigger) | Dashboards/Grafana/alert rules are a later, non-blocking ticket (see W0-06 spec Open Questions) |

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
