# DataLoader readiness review

Status: Wave 4 design review
Scope: Core GraphQL resolvers and read-only MCP tools
Decision: introduce request-scoped batching only after the service interfaces
listed below exist; never cache an authorization decision across requests.

## Executive summary

The current service boundary is ready for request-scoped loaders because routes
already call plain service functions and every graph read receives the complete,
server-resolved `AuthContext`. The main N+1 risk is not a single technical-tree
load. It is a collection response whose children independently resolve graph
metadata such as style rules, recent edits, tickets, tests, or Agent/Skill MD.

Loaders must sit between a resolver/tool-composition layer and the service
layer. They must not sit in routes, bypass a service, query Neo4j or Postgres
directly, or move RBAC filtering to the client. A loader is an execution
optimization, not an authorization boundary.

## Existing callable reads

| Read | Current service entry point | Graph Query operation | N+1 risk |
| --- | --- | --- | --- |
| Technical Tree | `getTechnicalTree` | `getNodesInViewport`, `getStructuralEdges` | Low for one viewport; high if child metadata is resolved per returned node |
| Product Tree | `getProductTree` | `getFeatureClusters` | Medium when multiple feature cards separately request members or recent edits |
| Retrieval search | `resolveAnchorNodes` | `resolveRetrievalAnchors` | Low for one search; medium across an MCP prompt that repeats equivalent searches |
| Node retrieval | `resolveAnchorNodeById` | `resolveRetrievalAnchors` | High when called once for every selected node |
| Context traversal | `traverseFrom` | `traverseRetrievalContext` | Medium; expensive duplicate traversals can occur within one composed response |
| Style inheritance | `getStyleRules` | `resolveStyleRules` | High when rendered for a list of files |

The following Wave 4 reads should be born batchable even if their first
implementation exposes only a scalar service function:

| Planned read | Scalar service contract | Recommended batch contract |
| --- | --- | --- |
| Node overlay | `getNodeOverlay(nodeId, refName, ctx)` | `getNodeOverlays([{ nodeId, refName }], ctx)` |
| Agent/Skill MD | `getAgentSkillMd(nodeId, refName, ctx)` | `getAgentSkillMdBatch([{ nodeId, refName }], ctx)` |
| Covering tests | `getCoveringTests(nodeId, refName, ctx)` | `getCoveringTestsBatch([{ nodeId, refName }], ctx)` |
| Feature cluster | `getFeatureCluster(featureId, refName, ctx)` | `getFeatureClustersById([{ featureId, refName }], ctx)` |
| Recent changes | `getRecentChanges(nodeId, refName, ctx)` | `getRecentChangesBatch([{ nodeId, refName }], ctx)` |

Batch methods remain Graph Query Service operations. They receive one
server-derived `AuthContext`, inject `org_id` server-side, apply the complete
permission scope in Cypher, and return results in the same order as their input
keys. They must not accept tenant or subject fields from a resolver argument or
MCP tool payload.

## Request boundary

Create a loader registry once for each GraphQL operation or MCP JSON-RPC
request:

```text
authenticated request
  -> server-derived AuthContext
  -> request LoaderRegistry
  -> service functions
  -> Graph Query Service / tenant-scoped Postgres stores
```

Dispose of the registry when that operation finishes. An MCP connection,
transport session, HTTP keep-alive socket, or authenticated API key is not a
cache lifetime. A long-lived MCP session can observe revocation, permission
changes, graph revision changes, and key expiry between calls, so it creates a
new registry for every tool call.

Within one GraphQL operation, mutations must clear affected keys before a
subsequent field is resolved. Within MCP v1 all tools are read-only, so a call
can safely retain its loader entries until its response is complete.

## Key design

Every cache key must identify both the data snapshot and the authority under
which it was read. Use a canonical tuple, not string concatenation:

```text
[
  service-name,
  org-id,
  subject-type,
  subject-id,
  permission-scope-fingerprint,
  repository-id,
  normalized-ref,
  graph-revision,
  resource-id-or-query,
  normalized-options
]
```

Requirements:

- `org-id`, subject identity, and permission-scope fingerprint come from
  server state. They never come from resolver or MCP input.
- The permission fingerprint is a stable digest of the effective allow/deny
  rows relevant to the request, including repo, branch, path prefix, action,
  and effect. For agent keys it includes only the key's own permission rows;
  role rows are deliberately excluded.
- Repository, ref, and revision must all be present. A cache entry for
  `refs/heads/main` is unsafe after a new projection unless its immutable graph
  revision is also part of the key.
- Viewport keys contain normalized `x`, `y`, `width`, `height`, and `zoom`.
  Retrieval keys contain normalized, de-duplicated terms and the service's
  bounded hop/node limits.
- Node-overlay keys include the exact requested layers only if the server
  supports partial reads. The Wave 4 overlay fetches all six layers once, so
  its initial key should not vary with client visibility toggles.
- Options are serialized with a canonical encoder that sorts object keys and
  preserves array order where order has semantic meaning.

Do not include bearer tokens, MCP raw secrets, Markdown content, ticket bodies,
or query results in keys or logs.

## Batch behavior

A batch function must:

1. Reject an empty, over-limit, or malformed batch before storage access.
2. De-duplicate identical canonical keys while preserving output positions.
3. Use one authorization rule set and one tenant-scoped graph transaction.
4. Bound both input count and result count.
5. Return one value or typed error for every original key in input order.
6. Treat a hidden resource exactly like a missing resource.
7. Record batch size, storage calls, duration, and result count with bounded
   labels; never record source content or raw credentials.

Recommended initial maximums:

- 128 node IDs for simple metadata reads.
- 32 node IDs for traversal or overlay reads.
- One viewport per technical-tree service call.
- 64 retrieval nodes and two hops, matching the current retrieval limits.

Batching must not turn one caller's malformed key into a failure for unrelated
keys. DataLoader-style per-key errors are appropriate for input validation and
version conflicts. Storage, tenant-context, or authorization-invariant errors
fail the whole batch closed.

## Cache and error policy

- Cache fulfilled values, including an authorized `null`, only for the current
  request. A hidden node and an absent node intentionally share that result.
- Do not cache transient storage, timeout, or rate-limit errors.
- Do not cache authentication, key-expiry, key-revocation, or permission-load
  results beyond the operation that performed them.
- Do not use process-global, Redis, browser, or CDN caches for Graph Query
  results until there is an explicit invalidation design keyed by immutable
  revision and permission version.
- Cap loader cardinality. Once a request exceeds the cap, reject it rather than
  allowing an unbounded in-memory map.
- Use a short deadline inherited from the request; a batch must not outlive the
  response that owns it.

## GraphQL composition risks

The first GraphQL schema is likely to expose the following N+1 shapes:

1. `technicalTree.nodes[].styleRules`
2. `technicalTree.nodes[].overlay`
3. `productTree.features[].recentChanges`
4. `productTree.features[].filesIncluded[].coveringTests`
5. `search.nodes[].context`

Resolvers for these fields should call loaders, which call batch-capable
service functions. A resolver must never import the Drizzle client, Neo4j
driver, permission store, or graph executor.

The top-level `getTechnicalTree` composition already performs two bounded graph
calls. Do not split it into one resolver per node or one resolver per edge.
Likewise, `getProductTree` already obtains authorized feature members and
recent edits as one Graph Query projection; preserve that coarse operation
unless measurement proves a smaller batch interface is needed.

## MCP composition and backpressure

Each MCP tool invocation creates a fresh loader registry. If a model emits
concurrent calls on one connection:

- authenticate and rate-limit every call independently;
- use a per-key concurrency semaphore in addition to the token bucket;
- batch only equivalent reads scheduled within the same tool invocation;
- never coalesce work across keys, orgs, sessions, or JSON-RPC requests;
- abort storage work when the client cancels or the request deadline expires.

`get_node_context` may compose an exact-node read, traversal, overlay, style,
and tests. Its internal reads can share that invocation's registry. Two
separate MCP calls cannot, even when their arguments are identical.

Rate-limit cost should reflect planned work before dispatch (tool base cost,
node count, and traversal limit). Result token counts are telemetry, not a
reason to refund or widen a limit after the call.

## Permission-change correctness

Postgres RLS provides tenant isolation, while Graph Query Service permission
rules provide repo/branch/path filtering. A request loader must preserve both:

- `withOrgContext` is established before tenant-scoped Postgres reads.
- Graph queries include the server-injected `org_id`.
- The effective permission scope is loaded once per operation at most, then
  passed only inside trusted service state.
- A deny rule wins before a result enters a loader cache.
- Agent-key permission rows are evaluated without user/role inheritance.

Because the cache ends with the operation, a revocation or permission change
is effective on the next GraphQL operation or MCP tool call.

## Rollout order

1. Add instrumentation to count scalar service calls per operation and record
   batch-size candidates.
2. Introduce a request `LoaderRegistry` type with no storage imports and tests
   proving separation by tenant, subject, scope fingerprint, and revision.
3. Add Graph Query batch operations for style rules, covering tests, recent
   changes, and Agent/Skill MD.
4. Move node-overlay composition to the registry while retaining one public
   service call.
5. Wire GraphQL child resolvers to the loaders.
6. Wire multi-read MCP tool composition to a fresh per-call registry.
7. Re-measure. Only batch retrieval traversal or whole technical trees if
   traces show repeated identical work.

## Acceptance checklist for a future loader change

- [ ] Loader lifetime is one GraphQL operation or one MCP tool call.
- [ ] Key contains org, subject, permission fingerprint, repo, ref, revision,
      resource, and options.
- [ ] Agent-key role inheritance is impossible.
- [ ] Hidden and missing resources are indistinguishable.
- [ ] Batch size, result size, time, and concurrency are bounded.
- [ ] Output order exactly matches input order.
- [ ] Per-key errors do not poison unrelated values.
- [ ] Routes and resolvers remain thin.
- [ ] Graph and Postgres reads remain behind service interfaces.
- [ ] Tests cover cross-org keys, two scopes in one org, permission change on
      the next request, revision change, cancellation, and over-limit batches.
