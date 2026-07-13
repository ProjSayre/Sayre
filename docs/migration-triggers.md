# Scaling & Migration Triggers

Every migration below is gated by an instrumented, numeric trigger — never a calendar date or business milestone. This file mirrors PRD §4.10 (Annotated Edition v3) — keep the two in sync.

**Initial numeric thresholds** (working values set 2026-07, ahead of real load; recalibrated by the first 30 days of W0-06 / PM-02 baseline data — the principle is fixed even while the numbers are provisional):

| Migration | Initial trigger (either condition) |
|---|---|
| pgvector → OpenSearch | Sustained ≥ 30 concurrent tenant queries/sec against the vector store for ≥ 10 consecutive minutes; **or** p95 `vector_query_duration_ms` > 250 ms sustained over a 1-hour window at ≥ 10 concurrent queries |
| Neo4j → Neptune | Sustained ≥ 50 concurrent multi-tenant graph queries/sec for ≥ 10 consecutive minutes; **or** p95 graph-query latency > 300 ms under concurrent load sustained over a 1-hour window |
| REST → GraphQL | Qualitative gate: a third bespoke per-view endpoint variant for the same underlying data, or sustained overfetch ratio > 3× on canvas queries |

## Graph DB: Neo4j → Amazon Neptune
Trigger: sustained concurrent, multi-tenant query load — not raw data size. Neo4j's single-cluster model is fine while load is modest; Neptune is built by AWS to absorb variable, high-concurrency, multi-tenant load without a single fixed instance being the ceiling. Schema and Cypher stay openCypher-compatible from Sprint 0 so this is a data-store swap behind the Graph Query Service, not an application rewrite.

## Vector Store: pgvector → Amazon OpenSearch
Trigger: instrumented concurrent query load against the vector store (queries/sec sustained under concurrent multi-tenant access, plus p95/p99 latency), not candidate-set size, corpus size, or customer count. Concurrency and latency are instrumented from day one (W0-06: `vector_query_duration_ms`, `vector_query_concurrent_count`, tagged by `org_id`, via OpenTelemetry → Prometheus with a swappable exporter). The numeric threshold above is the actual trigger to migrate — "we signed our 200th customer" is explicitly not one.

## API Layer: REST → GraphQL
Trigger: client data-shape divergence across the Technical/Product/Onboarding views reaching the point where REST forces overfetching or a proliferation of bespoke endpoints. Because business logic lives in the service layer, this migration only ever touches the routing layer — but DataLoader-style batching must be added at that point for nested cross-node queries.

## Client Rendering: Sigma.js + graphology boundary
Not a migration — a permanent boundary. Sigma.js handles WebGL rendering at every scale used by this product. graphology is scoped strictly to client-side algorithms supporting interaction (local filtering, subgraph extraction, layout pre-processing) — never anything requiring full-graph traversal or RBAC enforcement, which always routes server-side.

## Async Messaging: SQS + BullMQ
Not a migration — a permanent split. SQS backs the Python worker fleet; BullMQ backs the Node integration workers. No consolidation planned.

## Secrets: `.env` files → KMS-backed secrets manager
Event-gated rather than metric-gated: MVP development uses gitignored local `.env` files (placeholder-only `*.env.example` templates committed). The migration to a KMS-backed secrets manager fires when the product is first pitched to or used by an external customer — from that point the manager is the only allowed store. See PRD §4.5 and `.claude/rules/security-multitenancy.md`.
