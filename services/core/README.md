# @sayre/core

Node/TypeScript API — REST facade now, GraphQL later (`docs/migration-triggers.md`).

## Where does my code go?

This package follows a strict layering so business logic never leaks into a
route handler and so a future GraphQL resolver can reuse it unchanged
(`§4.2` / `.claude/rules/service-layer.md`):

```
Route (src/routes/)  ->  Service (src/services/)  ->  Graph Query Service (src/graph-query/)  ->  Neo4j/Neptune
```

- **`src/routes/`** — thin Express wrappers only. A route parses the request
  (query/params/body), resolves tenant context, calls exactly one service
  function, and serializes the result with `res.json(...)`. No branching on
  domain data, no data assembly, no direct DB/graph/queue calls.
- **`src/services/`** — plain functions, no `req`/`res`/Express types. This is
  where business logic and data assembly live. A service function is
  `(inputs) => Promise<data>` so the same function is callable from a REST
  route today and a GraphQL resolver later with zero changes.
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

## Enforcement: the statement-count lint gate

`.eslintrc.json` scopes an `overrides` block to `src/routes/**/*.ts`:

- `max-statements: ["error", 10]` — a route *handler function* exceeding 10
  statements fails `eslint . --ext .ts` (and therefore the `core — lint` CI
  step). This is per-function, not per-file — it does not catch statements
  written at a route file's module top level (the import ban below covers the
  main residual risk there).
- `no-restricted-imports` — routes may not import `neo4j-driver`, `pg`,
  `drizzle-orm`, `bullmq`, `ioredis`, or the `graph-query`/`db` modules
  directly. A route only ever imports from `src/services/` and `src/http/`.

If a route needs more logic than 10 statements allow, that's the gate telling
you the logic belongs in a service function, not the route.
