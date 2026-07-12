# Dependency Inventory — Codebase Visualizer Product

This file inventories every third-party dependency pinned for the product runtimes under W0-00
(Dependency & Environment Baseline). It does **not** cover the root Vite marketing site
(`package.json` at repo root) — that is a separate, unrelated package and out of scope for this
ticket (see `.pipeline/spec.md` O-1).

Version policy: each manifest below pins to a minor line (or an exact patch where the ticket
specified one); the committed lockfile (`package-lock.json` / `poetry.lock`) freezes the exact
resolved graph. See `.pipeline/changes.md` for install verification notes (what was actually
resolved on this machine).

> **PRD section note:** `docs/prd.md` (the readable PRD conversion) numbers its System Design
> Architecture section 4.1 through 4.9, then jumps straight to Section 6 (Cursor Origin) — there
> is no literal "Section 4.10" in the document, and a "Section 5" is referenced once in-line
> (§4.3, re: the Test node) but no such heading exists in the file. This mirrors the kind of
> pre-existing path/numbering inconsistency already flagged in `.pipeline/spec.md` O-2/O-4. Per
> `.pipeline/spec.md` O-5, real section numbers are cited below rather than inventing "4.10" —
> future-swap content is sourced from the closest real PRD sections (3, 4.3, 4.5) and, primarily,
> from `docs/migration-triggers.md`, which is the authoritative source for trigger thresholds.

## `apps/web` — Next.js product visualization client

| Package | Runtime/Location | Purpose | Reference | Future swap |
|---|---|---|---|---|
| `next` | apps/web (dep) | App framework/router/build for the visualization shell | `docs/prd.md` §3 (Frontend Framework), `CLAUDE.md` Stack | — |
| `react` | apps/web (dep) | UI library | `docs/prd.md` §3, `CLAUDE.md` Stack | — |
| `react-dom` | apps/web (dep) | React DOM renderer | `docs/prd.md` §3 | — |
| `sigma` | apps/web (dep) | WebGL canvas renderer at every scale (Technical/Product/Onboarding trees) — single renderer, no node-count cutover (PRD v3 §4.10; `@xyflow/react` dropped 2026-07-12) | `docs/prd.md` §2.2, §3, §4.10; `docs/architecture.md`; `docs/migration-triggers.md` (Client Rendering boundary) | See "Deliberate non-migrations" below |
| `graphology` | apps/web (dep) | Client-side graph data structure backing Sigma + local algorithms | `docs/prd.md` §2.2; `docs/migration-triggers.md` (Client Rendering boundary) | — |
| `graphology-layout` | apps/web (dep) | Client-side layout algorithms (local pre-processing only, never RBAC/traversal) | `.claude/rules/security-multitenancy.md` | — |
| `typescript` | apps/web (devDep) | Type checking | `CLAUDE.md` Stack | — |
| `@types/react` | apps/web (devDep) | React type defs | — | — |
| `@types/react-dom` | apps/web (devDep) | React-DOM type defs | — | — |
| `@types/node` | apps/web (devDep) | Node type defs (Node 20 LTS target) | `.nvmrc` | — |
| `graphology-types` | apps/web (devDep) | Type defs peer for graphology/sigma | — | — |
| `tailwindcss` | apps/web (devDep) | Utility CSS for dashboard/inspector layouts | `docs/prd.md` §3 (Styling) | — |
| `postcss` | apps/web (devDep) | Tailwind's CSS transform pipeline | — | — |
| `autoprefixer` | apps/web (devDep) | Vendor-prefixing for Tailwind output | — | — |
| `eslint` | apps/web (devDep) | Lint engine | `CLAUDE.md` Commands (`npm run lint`) | — |
| `eslint-config-next` | apps/web (devDep) | Next.js lint ruleset (pinned to `next`'s 14.2 minor) | — | — |

## `services/core` — Node/TypeScript API, service layer, Graph Query Service, BullMQ integration workers

| Package | Runtime/Location | Purpose | Reference | Future swap |
|---|---|---|---|---|
| `express` | services/core (dep) | REST facade for the Core App Service | `docs/prd.md` §3 (Core API), §4.2 (API Gateway/Core App Service) | REST → GraphQL; see below |
| `bullmq` | services/core (dep) | Queue for Node integration workers (GitHub/Jira/Linear) | `docs/prd.md` §2.4; `.claude/rules/async-messaging.md` | No consolidation planned (permanent split) |
| `ioredis` | services/core (dep) | Redis client required by BullMQ | `.claude/rules/async-messaging.md` | — |
| `neo4j-driver` | services/core (dep) | Driver for the Graph Query Service (server-side traversal/RBAC filtering only) | `docs/prd.md` §4.2, §4.3 (Graph Store); `.claude/rules/security-multitenancy.md`, `.claude/rules/graph-schema.md` | Neo4j → Amazon Neptune; see below |
| `pg` | services/core (dep) | Postgres client — org/user/permission system of record | `docs/prd.md` §4.3 (Relational Store) | — |
| `jsonwebtoken` | services/core (dep) | JWT AuthN for the API Gateway/AuthZ middleware | `docs/prd.md` §4.2 (API Gateway) | — |
| `drizzle-orm` | services/core (dep) | ORM/query builder + migrator for the Postgres system-of-record tables (org/user/repo/permission/ticket_cache/style_rules/onboarding_steps), layered on the pinned `pg` driver. Manifest pins `0.38.x`; resolved `0.38.4` (see `.pipeline/W0-05/changes.md`). | `docs/prd.md` §4.3, §4.5 (RLS); `.pipeline/W0-05/spec.md` | — |
| `typescript` | services/core (devDep) | Type checking | `CLAUDE.md` Stack | — |
| `tsx` | services/core (devDep) | Dev/runtime TS execution (`dev` script; unused until a later ticket implements `src/`) | — | — |
| `vitest` | services/core (devDep) | Test runner (`npm run test`/`test:integration`) — none existed before W0-04; required for the BullMQ round-trip integration test | `CLAUDE.md` Commands (`npm run test`); W0-04 spec R1 | — |
| `@types/node` | services/core (devDep) | Node type defs (Node 20 LTS target) | `.nvmrc` | — |
| `@types/express` | services/core (devDep) | Express type defs | — | — |
| `@types/jsonwebtoken` | services/core (devDep) | JWT type defs | — | — |
| `@types/pg` | services/core (devDep) | Postgres client type defs | — | — |
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
| `langchain` | services/workers (dep) | LLM orchestration for Semantic Enrichment | `docs/prd.md` §2.1 (Semantic Relationship Extraction), §4.2 | — |
| `langgraph` | services/workers (dep) | Graph-based agent orchestration (Graph-Guided RAG) | `docs/prd.md` §2.5, §4.2, §4.4 (AI Query flow) | — |
| `boto3` | services/workers (dep) | AWS SDK — SQS client for the Python fleet | `docs/prd.md` §2.1 (Delta Processing queue); `.claude/rules/async-messaging.md` | — |
| `psycopg[binary]` | services/workers (dep) | Postgres client (metadata/style-rule reads from the worker fleet) | `docs/prd.md` §4.3 | — |
| `pgvector` | services/workers (dep) | Vector store client (semantic chunk embeddings) | `docs/prd.md` §2.5 (Hybrid Storage Engine), §4.3 (Vector Store) | pgvector → Amazon OpenSearch; see below |
| `anthropic` | services/workers (dep) | Claude API client for semantic enrichment + Graph-Guided RAG | `docs/prd.md` §2.3, §2.5, §4.4 (AI Query flow) | — |
| `pydantic` | services/workers (dep) | Data validation (FastAPI 0.115 requires Pydantic v2) | — | — |
| `pytest` | services/workers (dev group) | Test runner | `CLAUDE.md` Commands (`poetry run pytest`) | — |
| `pytest-asyncio` | services/workers (dev group) | Async test support for FastAPI/async code paths | — | — |

Not included in this ticket (see `.pipeline/spec.md` open questions): `graphify` (O-9 — named in
`CLAUDE.md`'s stack list but not enumerated by this ticket; confirm exact package identity when
the Semantic Enrichment Worker ticket comes up).

**O-10 (LocalStack/SQS emulator for local dev) — resolved by W0-04.** See
`infra/docker-compose.yml` (`localstack` service) and the pinned image row below.

## `infra/docker-compose.yml` — pinned datastore images

| Image | Purpose | Reference | Future swap |
|---|---|---|---|
| `pgvector/pgvector:pg16` | Postgres + `vector` extension — relational system of record *and* vector store backing | `docs/prd.md` §4.3 (Relational Store, Vector Store); `docs/architecture.md` | pgvector → Amazon OpenSearch; see below. **Deviation note:** the ticket's literal text said `postgres:16`; this is deliberately `pgvector/pgvector:pg16` instead because plain `postgres:16` does not ship the `vector` extension required by the Vector Store component. See `.pipeline/changes.md`. |
| `redis:7.4-alpine` | Redis — BullMQ backing store + Realtime Service pub/sub | `docs/prd.md` §4.2 (Realtime Service); `.claude/rules/async-messaging.md` | — |
| `neo4j:5.24-community` | Graph DB — codebase ontology (major 5, matching `neo4j-driver` 5.x) | `docs/prd.md` §4.3 (Graph Store) | Neo4j → Amazon Neptune; see below |
| `localstack/localstack:3.8` | SQS emulator for the Python worker fleet (local dev only — real AWS SQS in prod) | `docs/prd.md` §2.1 (Delta Processing queue), §4.2; `.claude/rules/async-messaging.md`; W0-04 spec R5 (O-10 resolved) | Not a future swap — LocalStack is dev-only tooling; real AWS SQS provisioning/IAM/Terraform is separate, out-of-scope infra work |

## Known future swaps (PRD migration triggers)

Sourced from `docs/migration-triggers.md`, the authoritative source for trigger thresholds
(closest real PRD sections cited above are §3 and §4.3/§4.5, since `docs/prd.md` has no literal
"Section 4.10" — see note at the top of this file):

- **`neo4j-driver` (Neo4j) → Amazon Neptune-compatible driver.** Trigger: sustained concurrent,
  multi-tenant query load — not raw data size. Stays a data-store swap behind the Graph Query
  Service because Cypher is written openCypher-only from day one (`.claude/rules/graph-schema.md`),
  not an application rewrite.
- **`pgvector` (Python fleet) → Amazon OpenSearch client.** Trigger: instrumented concurrent
  vector-query load (sustained queries/sec under concurrent multi-tenant access) and/or a p95/p99
  latency bound — not candidate-set size, corpus size, or customer count.
- **`express` / REST facade → GraphQL server libs + DataLoader batching.** Trigger: client
  data-shape divergence across the Technical/Product/Onboarding views reaching the point where
  REST forces overfetching or a proliferation of bespoke endpoints. Touches only the routing
  layer — business logic stays in the service layer (`.claude/rules/service-layer.md`).

## Deliberate non-migrations

So nobody mistakes these permanent splits for pending future swaps:

- **`sigma` + `graphology` client boundary** — Sigma.js is the single WebGL renderer at every
  scale (the earlier React Flow/`@xyflow/react` dual-renderer split was dropped in PRD v3 §4.10,
  2026-07-12). graphology is scoped to client-side algorithm gaps only — local filtering,
  subgraph extraction, layout pre-processing — never RBAC or deep traversal, which stay
  server-side in the Graph Query Service. A permanent boundary, not a migration
  (`docs/migration-triggers.md`, "Client Rendering: Sigma.js + graphology boundary").
- **`boto3`/SQS (Python fleet) vs. `bullmq` (Node integration workers)** — a permanent messaging
  split; SQS backs the Python worker fleet, BullMQ backs Node integration workers (GitHub/Jira/
  Linear). No consolidation planned (`docs/migration-triggers.md`, "Async Messaging: SQS +
  BullMQ"; `.claude/rules/async-messaging.md`).

## Infra image deviation summary

`infra/docker-compose.yml` pins Postgres to `pgvector/pgvector:pg16` rather than the ticket's
literal `postgres:16`, because the Vector Store component requires the `vector` Postgres
extension, which the stock image does not ship. This is a Sprint-0 baseline decision, not a
future migration — the swap-to-OpenSearch item above is unrelated to this image choice. See
`.pipeline/changes.md` for the full deviation record and O-11 in `.pipeline/spec.md`.
