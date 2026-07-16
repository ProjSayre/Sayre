# Logical Architecture

```text
Browser (Next.js; React Flow <~500 nodes, Sigma.js + graphology above)
        |
API Gateway / MCP Gateway -- AuthN + server-resolved tenant/RBAC context
        |
Core App Service (Node.js) -- Service Layer -- Graph Query Service
        |                                           |
Realtime Service                                   data reads
(WebSocket + Redis)                                 |
        ^                         PostgreSQL -- Neo4j/Neptune -- pgvector/OpenSearch
        |
graph-events SQS subscription <--- SNS graph.updated fanout
                                      ^
                                      | after graph commit
GitHub webhook ---> ingestion FIFO SQS ---> Ingestion/Delta Worker (Python)
                                                |
                         +----------------------+----------------------+
                         |                                             |
               embedding-upserts SQS                  enrichment-onboarding-priority SQS
                         |                                     + enrichment-default SQS
                 EmbeddingProvider                                      |
                         |                                    Semantic Enrichment Worker
               pgvector cosine vectors

GitHub / Jira / Linear integration jobs ---> BullMQ on Redis ---> Node workers
```

SQS/SNS remain the Python worker/event transport; BullMQ remains the Node integration-worker
transport. SNS fanout gives realtime, enrichment, and later consumers independent delivery rather
than making them compete on one queue. Ingestion is FIFO by organization/repository/ref. Every work
queue has a DLQ, long jobs extend visibility with a heartbeat, and durable idempotency/version checks
make at-least-once delivery safe. Enrichment has separate physical priority and default queues, and
bounded chunks enter the separate physical `embedding-upserts` work queue only after the accepted
structural event.

## Three tree views, one schema

Technical, Product, and Onboarding are authorized query shapes over one graph, not separate
datasets:

- **Technical Tree** — Folder/File nodes plus structural IMPORTS/CALLS/INHERITS relationships.
- **Product Tree** — Feature nodes plus PART_OF/REFERENCES relationships, projected over the same
  Folder/File data.
- **Onboarding Tree** — EnvStep data ordered by sequence and projected onto Folder/File nodes.

Only Folder and File nodes render on canvas. Function and Class nodes remain graph-internal. The
Macro View (Project to Repo and cross-repo edges) is post-MVP.

Repository identity is stable, refs are mutable, and revisions are immutable. Repository/ref scoped
graph entities carry server-resolved `org_id`, `repo_id`, `ref_name`, and the `revision_sha` that
produced them. `COVERS` links a Test to a covered node only within the same authorized
organization/repository/ref/revision scope. The portable logical schema, data migrations, and
queries are openCypher-compatible; physical constraints/index DDL is versioned per graph target.
Changed-file deltas require the accepted revision to be an ancestor of the incoming revision. A
force-push or other non-fast-forward divergence causes a full rebuild of that scoped ref head
projection so structural nodes from abandoned history cannot survive.

## Key flows

- **Cold start:** GitHub App authorization enqueues an initial job on the ingestion FIFO queue. A
  scratch clone is fully parsed with Tree-sitter, then the graph transaction commits. The accepted
  `graph.updated` event is published through SNS, making the Technical Tree available. Bounded
  tenant chunks enter `embedding-upserts`, and semantic/onboarding enrichment begins asynchronously
  afterward; the priority lane lets onboarding finish ahead of general enrichment. The separate
  `EmbeddingProvider` writes 1024-dimensional cosine vectors with provider/model/dimension metadata.
  The scratch checkout is destroyed and never persisted.
- **Steady-state push (15-second structural target):** the webhook is validated, changed files are
  parsed only for a fast-forward, and graph upserts/deletes commit idempotently for the next accepted
  ref revision. Force-push/non-fast-forward divergence runs a full scoped rebuild. `graph.updated`
  then fans out through SNS before `embedding-upserts`; embedding and LLM latency is outside the
  structural target.
- **AI query (Graph-Guided RAG):** the Retrieval Service resolves an anchor node, performs an
  authorized bounded-hop traversal, fetches only bounded tenant chunks for that subgraph, and calls
  the configured Sayre generation `ModelProvider`. `GraphifyAdapter` shapes semantic graph output;
  the separate `EmbeddingProvider` owns vector inference. None permits a hardcoded model vendor.

PostgreSQL is the auditable source for organizations, permissions, repository refs, MCP keys,
provider configuration, bounded chunks, and embedding records. Tenant tables enforce RLS through
the actual non-owner runtime role in addition to service-layer authorization. Provider rows refer
only to pre-provisioned credentials until PM-07 supplies the KMS-backed write/rotation phase. MCP
keys use a public ID/prefix plus a one-time 256-bit secret; only a pepper-versioned HMAC-SHA-256
digest and expiry/last-use/revocation audit data persist. Their grants reuse `permissions`, bounded
by both the issuance ceiling and the issuer's current effective scope.

For the complete cross-ticket contract, see `wave0-foundation-contracts.md`. For measured migration
thresholds, see `migration-triggers.md`.
