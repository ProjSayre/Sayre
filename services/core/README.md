# @sayre/core

Node/TypeScript API — REST facade now, MCP tools in W4-06, and GraphQL later
(`docs/migration-triggers.md`).

## Where does my code go?

This package follows a strict layering so business logic never leaks into a
protocol handler and so REST routes, future GraphQL resolvers, and MCP tools can
reuse it unchanged
(`§4.2` / `.claude/rules/service-layer.md`):

```
REST route (src/routes/) ─┐
GraphQL resolver (later)  ├─> Service (src/services/) -> Graph Query Service (src/graph-query/) -> Neo4j/Neptune
MCP handler (src/mcp/)  ──┘
```

- **`src/routes/`** — thin Express wrappers only. A route parses the request
  (query/params/body), resolves tenant context, calls exactly one service
  function, and serializes the result with `res.json(...)`. No branching on
  domain data, no data assembly, no direct DB/graph/queue calls.
- **`src/mcp/`** — reserved for W4-06's thin MCP tool handlers. A handler
  validates/adapts tool input, uses server-resolved auth context, calls one
  service, and serializes the protocol result. It never owns business logic or
  imports graph, database, vector, or queue clients. See `src/mcp/README.md`.
- **`src/services/`** — plain functions, no `req`/`res`/Express types. This is
  where business logic and data assembly live. A service function is
  `(inputs) => Promise<data>` so the same function is callable from a REST
  route today, an MCP tool in W4-06, and a GraphQL resolver later with zero
  changes.
- **`src/graph-query/`** — the only layer that talks to the graph store. Right
  now it's a typed, fixture-returning stub (see `src/graph-query/README.md`);
  W2-02 replaces it with a real openCypher client against Neo4j. `org_id` is
  threaded through every method here because this is the layer that will
  inject it server-side and perform RBAC node-stripping
  (`.claude/rules/security-multitenancy.md`).
- **`src/http/`** — supporting HTTP-adapter helpers (`viewport.ts`,
  `tenantContext.ts`, `express.ts`) used by routes to stay genuinely thin:
  request parsing/validation, server-side tenant resolution, and generic
  Express plumbing (`asyncHandler`, `errorHandler`). Request adaptation only —
  no domain logic.

See `src/routes/technicalTree.ts` -> `src/services/technicalTreeService.ts` ->
`src/graph-query/index.ts` for the worked example.

## Enforcement: thin-handler lint gates

`.eslintrc.json` scopes one identical `overrides` block to
`src/routes/**/*.ts` and `src/mcp/**/*.ts` (tests excluded):

- `max-lines` — a handler file exceeding 15 effective lines fails; blank and
  comment-only lines do not count.
- `max-statements: ["error", 10]` — a handler function exceeding 10
  statements fails `eslint . --ext .ts` (and therefore the `core — lint` CI
  step).
- `no-restricted-imports` — handlers may not import Neo4j, Postgres/Drizzle,
  vector storage, BullMQ/Redis, SQS/SNS, or internal graph/DB/queue modules.
  Protocol adapters call `src/services/`; REST routes may additionally use
  request adapters from `src/http/`.

If a route, resolver, or MCP handler needs more room, that is the boundary
telling you the logic belongs in a shared service function.
