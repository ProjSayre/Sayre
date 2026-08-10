# Wave 0 Foundation Contracts

This document is the concise cross-ticket contract for Wave 0. The product requirements in
`docs/product/PRD-V1.md` and the ticket definitions in `docs/product/Ticket-Backlog-by-Feature-2.md` remain authoritative; this file
records the shared decisions that foundation and downstream tickets must preserve.

## Runtime and dependency baseline

- Product Node packages target Node 20 only; Python workers target Python 3.12 only. Lockfiles
  freeze the exact resolved dependency graph.
- The product web app uses `@xyflow/react` 12.11.x for fewer than about 500 visible nodes and
  Sigma.js plus graphology above that threshold.
- The core service uses `@modelcontextprotocol/sdk` 1.29.x, Zod 4.4.x, mutually compatible AWS
  SQS/SNS clients, and one compatible OpenTelemetry API/metrics/Prometheus set.
- Python workers use base `graphifyy==0.9.16` with no provider extras and `openai` 2.45.*.
  LangChain provider-adapter packages are not part of this baseline.
- Graphify is reachable only through a Sayre-owned `GraphifyAdapter`. It shapes semantic
  enrichment output and never replaces or changes W1-01's structural Tree-sitter parser.

## Graph identity and migration layers

- A repository has a stable repository identity, one or more mutable ref identities, and
  immutable revision identities. Repository-scoped graph data carries server-resolved `org_id`
  and `repo_id`; ref-scoped data also carries `ref_name`; revision-bearing data records the
  immutable `revision_sha` that produced it.
- Stable node UIDs incorporate the repository/ref scope plus the node kind and canonical
  path/symbol identity. A `repository_refs` row records each mutable ref's accepted revision and
  graph version so stale or replayed work cannot move a ref backward.
- Before applying a changed-file delta, ingestion verifies that the accepted revision is an
  ancestor of the incoming revision. A force-push or any other non-fast-forward divergence triggers
  a full rebuild of that organization/repository/ref head projection; the worker must not apply a
  delta to the abandoned history or retain structural nodes that are no longer in the ref.
- `COVERS` is a Test-to-covered-node relationship. Both endpoints must share the authorized
  `org_id`, repository, ref, and revision scope. `COVERS.status` is `inferred` or `measured`, and
  `COVERS.last_run` is nullable until a measured run exists. `Test.coverage_status` is `pass`,
  `fail`, or `unknown`.
- The portable logical schema, data migrations, and application queries use openCypher-compatible
  constructs. Constraints, indexes, and other physical DDL are target-specific and versioned per
  graph target. Neo4j physical DDL is not represented as replayable Neptune DDL.

## Ingestion, events, and background work

- Repository ingestion uses an SQS FIFO queue. Its message-group identity serializes work for an
  organization/repository/ref while allowing unrelated refs to progress concurrently.
- After an idempotent graph transaction commits, ingestion publishes the accepted
  `graph.updated` event to SNS. SNS fans out to independent realtime and enrichment subscriptions;
  one competing-consumer queue is never treated as broadcast.
- W0-04 provisions a physical `embedding-upserts` SQS work queue and its DLQ. The structural event
  is accepted before W1-05 publishes bounded chunk/embedding work to that queue. Technical Tree
  availability therefore does not wait for embedding inference, vector writes, or LLM enrichment.
- Enrichment has separate physical `enrichment-onboarding-priority` and `enrichment-default`
  queues. Priority-only capacity plus bounded weighted polling preserves priority without starving
  default work. W2-08 activates the onboarding workload on the already-provisioned lane after the
  accepted structural event and records cold-start-to-ready latency by server-derived org/repo.
- Every work queue has a DLQ with a five-receive redrive policy and 14-day retention. Long-running
  consumers extend visibility with a heartbeat and stop extending it during graceful shutdown.
- Delivery is at least once. Handlers use durable idempotency keys and repository/ref graph-version
  checks; temporary FIFO/SNS deduplication is not the source of correctness.
- SQS/SNS belong to the Python worker/event fleet. BullMQ on Redis remains the permanent Node
  integration-worker transport for GitHub, Jira, and Linear.
- BullMQ (W0-04, GAP-3a) mirrors the SQS priority split above with two named job lanes,
  `priority` and `default`, selected via `enqueue()`'s `lane` option
  (`services/core/src/queue/bullmq.ts`). Both lanes map to a non-zero BullMQ `priority` value on
  purpose: BullMQ routes an unprioritized job (priority `0`/`undefined`) to a separate list that
  drains completely before any prioritized job is considered, so a zero-mapped default lane would
  invert the intended guarantee. No job type is assigned the priority lane by policy yet — the
  three existing `enqueue()` call sites (GitHub/Jira/Linear sync) stay on the default lane; which
  jobs should use the priority lane is a separate, later decision.
- Ask Sayre conversation turns use a separate physical `chat-turns.fifo` SQS FIFO queue with its
  own `chat-turns-dlq.fifo` dead-letter queue on the same five-receive redrive policy and 14-day
  retention. Its message-group identity is the conversation id, so turns within one conversation
  are processed in order while unrelated conversations progress concurrently. The core service
  commits the user turn and its pending assistant turn before publishing; the consumer supplies
  durable idempotency keyed on the envelope, and this queue is never subscribed to the
  `graph.updated` topic.

## Persistence and tenant enforcement

W0-05 owns tenant-scoped persistence for `github_app_installations`, `mcp_client_keys`,
purpose-keyed `model_provider_configs`, `repository_refs`, `code_chunks`, and `code_embeddings`, in
addition to the existing relational entities. Generation and embedding configuration are separate
purposes; configuration stores an endpoint and credential reference, never a raw credential.

`mcp_client_keys` use a public key identifier/prefix plus a 256-bit cryptographically random secret
that is returned only at issuance. The raw secret is never stored. Authentication stores and
compares an HMAC-SHA-256 digest made with a server-held pepper; each row records the pepper version,
creator, creation/expiry timestamps, `last_used_at`, and revocation timestamp/actor. Agent-key scope
reuses the existing `permissions` model with the public key identifier as its subject. At issuance,
the requested org/repository/ref/path scope must be a subset of the issuing administrator's
effective scope, and subsequent permission changes cannot allow the key to exceed that ceiling.

Runtime row-level security is mandatory defense in depth. Acceptance tests execute through the
actual non-owner, non-superuser, `NOBYPASSRLS` runtime role; service-layer filtering does not
substitute for RLS, and RLS does not substitute for Graph Query Service RBAC.

CH-01 adds a second `mcp_client_keys` credential family, discriminated by a `kind` column
(`'agent'` | `'chat_ephemeral'`) rather than a new table, so the ceiling-intersection model above
applies unchanged. A `chat_ephemeral` row is a short-lived (<=600s), conversation-bound, digest-only
bearer credential minted for a signed-in user by the first-party "Ask Sayre" chat loop; its ceiling
is a mint-time snapshot of the issuing user's effective read scope, written as ordinary `permissions`
rows with `subject_type = 'agent_key'` and `subject_id = <key prefix>` — the same rows an agent key
would get. Because resolution always intersects that ceiling with the issuer's *current* scope, the
credential can only narrow after mint, never widen, and a revoked or narrowed issuer takes effect on
the credential's very next use with no separate revocation path required. Rate-limit and metrics
bucketing for this family key on `chat:<issuing user id>` rather than the (re-mintable) key prefix, so
minting a fresh credential mid-conversation cannot reset the caller's per-minute budget.

The system may persist bounded, tenant-scoped code chunks and document chunks required for RAG,
their embeddings, and structural metadata. It must not persist a repository checkout, source tree,
or any derivative that reconstructs one. Scratch clones are destroyed after parsing.

`code_embeddings` stores 1024-dimensional pgvector values using cosine distance, keyed to the
tenant, repository/ref/revision, graph node, and chunk. Every record also stores provider, model,
and dimension metadata so incompatible vectors are never compared. A dimension other than 1024 is
rejected at the provider boundary and persistence boundary in this baseline.

## Provider and secret boundaries

- `ModelProvider` owns generation-model selection and SDK/client construction. `GraphifyAdapter`
  owns semantic output shaping. Enrichment and retrieval call those interfaces from their first
  implementation; they never hardcode Claude, OpenAI, or a self-hosted vendor.
- `EmbeddingProvider` is a separate Sayre-owned interface; generation `ModelProvider` must not
  acquire an embedding method. W1-05 owns its first concrete OpenAI-compatible embeddings adapter,
  the `embedding-upserts` consumer, and validation that every result contains exactly 1024 finite
  values. The local-compatible default model is `Qwen3-Embedding-0.6B`. CI uses a deterministic,
  network-free fake that emits stable 1024-dimensional vectors for repeatable assertions.
- W3-07 supplies concrete provider and Graphify adapter implementations for interfaces already in
  use; it does not introduce or absorb `EmbeddingProvider`. A self-hosted generation configuration
  must pass a network-isolated zero-third-party-egress test.
- Through W3-09, org administrators select provider, endpoint, model, and a pre-provisioned
  credential reference. They do not submit or store raw provider credentials.
- W0-07 centralizes secret resolution. MVP references may resolve through the loader to local
  environment values; PM-07 supplies the later KMS-backed write, issuance, rotation, and revocation
  phase without changing consumers.

## Observability boundary

W0-06 and W0-08 use OpenTelemetry with Prometheus locally and share naming and low-cardinality tag
conventions. Every sanctioned vector and graph-store call is measured. Org identity used for metric
scope is server-resolved; raw Cypher, source, prompts, tokens, credentials, and unbounded paths are
not metric labels.
