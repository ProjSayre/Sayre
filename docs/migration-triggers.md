# Scaling & Migration Triggers

Every migration below is gated by an instrumented, numeric trigger—never a calendar date or a
customer-count milestone. This file mirrors PRD v5 §4.10. W0-06 supplies vector-store telemetry;
W0-08 supplies graph-store telemetry; PM-02 presents both and owns threshold recalibration.

**Initial numeric thresholds** are working values set in July 2026 and recalibrated from the first
30 days of W0-06/W0-08/PM-02 data. The measured-gate principle remains fixed.

| Migration | Initial trigger (either condition) |
|---|---|
| pgvector → OpenSearch | Sustained ≥30 concurrent tenant queries/sec for ≥10 minutes; or p95 `vector_query_duration_ms` >250 ms for one hour at ≥10 concurrent queries |
| Neo4j → Neptune | Sustained ≥50 concurrent multi-tenant graph queries/sec for ≥10 minutes; or p95 graph-query latency >300 ms under concurrent load for one hour |
| REST → GraphQL | A third bespoke per-view endpoint variant for the same data; or sustained canvas overfetch ratio >3× |

## Graph DB: Neo4j → Amazon Neptune

The trigger is sustained concurrent multi-tenant query load, not raw graph size. Logical graph
schema, data migrations, and application queries remain openCypher-compatible from Wave 0. Physical
constraints, indexes, and other DDL are target-specific and versioned per graph target, so a Neptune
cutover reuses the logical contract while applying Neptune-specific physical provisioning; Neo4j DDL
is not claimed to replay unmodified.

W0-08 instruments every sanctioned Neo4j driver call with `graph_query_duration_ms`,
`graph_query_concurrent_count`, and `graph_query_result_node_count`, tagged by `org_id` and
`query_shape` (`viewport_read` | `write` | `traversal`), using the same server-resolved bounded
metric attributes and OpenTelemetry → Prometheus setup as W0-06.

## Vector Store: pgvector → Amazon OpenSearch

The trigger is instrumented concurrent query load and latency, not candidate-set size, corpus size,
or customer count. W0-06 instruments every sanctioned query with
`vector_query_duration_ms` and `vector_query_concurrent_count`, using server-resolved bounded metric
attributes and OpenTelemetry → Prometheus locally. The exporter remains swappable without changing
call sites.

The launch contract remains 1024-dimensional pgvector values with cosine distance and explicit
provider/model/dimension metadata. `EmbeddingProvider` is separate from generation `ModelProvider`;
W1-05 owns its first OpenAI-compatible adapter, local-compatible `Qwen3-Embedding-0.6B` default, and
deterministic network-free 1024-dimensional CI fake. A store migration must preserve that logical
provider boundary and reject cross-model or cross-dimension comparisons.

## API Layer: REST → GraphQL

The trigger is client data-shape divergence across Technical, Product, and Onboarding views. Business
logic stays in the service layer; GraphQL resolvers become a third thin adapter beside REST routes and
MCP handlers, with DataLoader-style batching added at the resolver boundary.

## Client rendering boundary

This is not a migration. React Flow renders fewer than about 500 visible nodes; Sigma.js (WebGL)
takes over above that threshold. graphology is restricted to documented client-side filtering,
subgraph extraction, and layout operations. RBAC and deep traversal always remain server-side.

## Async messaging boundary

This is not a migration. SQS/SNS serve the Python worker/event fleet and BullMQ serves Node
integration workers. The permanent Python topology includes FIFO ingestion, accepted-event SNS
fanout, the physical `embedding-upserts` queue, physical onboarding-priority/default enrichment
queues, DLQ redrive, visibility heartbeats, and durable idempotency/version checks.

## Provider boundary

Provider selection is not a later migration. Generation `ModelProvider` and `GraphifyAdapter` are
application boundaries from the first enrichment implementation; W3-07 supplies their concrete
hosted and self-hosted implementations. The separate `EmbeddingProvider` boundary and first adapter
land in W1-05. An organization changes generation or embedding provider by audited configuration,
not by selecting a parallel pipeline.

## Secrets: local references → KMS-backed manager

This migration is event-gated: first external customer or first production pitch. Before PM-07,
services resolve pre-provisioned credential references through W0-07's loader; local development
references may map to gitignored environment values. W3-09 selects an existing reference and never
accepts a raw credential. PM-07 adds the KMS-backed write, issuance, rotation, revocation, and cache
phase without changing consumer call sites.
