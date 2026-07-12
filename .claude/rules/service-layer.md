---
paths:
  - "services/core/**/*.ts"
  - "services/gateway/**/*.ts"
---

# Service Layer Rules

- Business logic is a plain function in `services/core/src/services/`, never inline in a route handler or (later) a GraphQL resolver. The route/resolver is a thin wrapper that calls the service function.
- NEVER query the Graph DB, Vector Store, or Postgres directly from a route handler — go through the service layer, which calls the Graph Query Service.
- When adding a GraphQL resolver later, it must call the existing service function — don't duplicate logic into the resolver. Add DataLoader-style batching at that point; don't assume the service layer alone prevents redundant calls on nested queries.
- Async work (parsing, enrichment, AI calls) is kicked off onto SQS or BullMQ from the service layer — never awaited inline in a request handler.
