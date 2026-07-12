# Scaling & Migration Triggers

Every migration below is gated by an instrumented, numeric trigger — never a calendar date or business milestone.

## Graph DB: Neo4j → Amazon Neptune
Trigger: sustained concurrent, multi-tenant query load — not raw data size. Neo4j's single-cluster model is fine while load is modest; Neptune is the managed, high-concurrency-capable target. Schema and Cypher stay openCypher-compatible from Sprint 0 so this is a data-store swap behind the Graph Query Service, not an application rewrite.

## Vector Store: pgvector → Amazon OpenSearch
Trigger: instrumented concurrent query load against the vector store (queries/sec sustained under concurrent multi-tenant access, plus p95/p99 latency), not candidate-set size, corpus size, or customer count. A concrete numeric threshold (e.g. sustained concurrent queries/sec, or a p95 latency bound) initiates the migration — tracked from day one.

## API Layer: REST → GraphQL
Trigger: client data-shape divergence across the Technical/Product/Onboarding views reaching the point where REST forces overfetching or a proliferation of bespoke endpoints. Because business logic lives in the service layer, this migration only ever touches the routing layer — but DataLoader-style batching must be added at that point for nested cross-node queries.

## Client Rendering: Sigma.js + graphology boundary
Not a migration — a permanent boundary. Sigma.js handles WebGL rendering at every scale used by this product. graphology is scoped strictly to client-side algorithms supporting interaction (local filtering, subgraph extraction, layout pre-processing) — never anything requiring full-graph traversal or RBAC enforcement, which always routes server-side.

## Async Messaging: SQS + BullMQ
Not a migration — a permanent split. SQS backs the Python worker fleet; BullMQ backs the Node integration workers. No consolidation planned.
