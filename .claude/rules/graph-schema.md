---
paths:
  - "packages/graph-schema/**/*"
  - "services/core/**/*.ts"
---

# Graph Schema Rules

- Write all Cypher against openCypher syntax only — no Neo4j-only extensions. This is what keeps the future Neptune migration a data-store swap, not a rewrite.
- Node labels are fixed: Project, Repo, Folder, File, Function, Class, Module, Person, Commit, Feature, Ticket, EnvStep, Test. Don't introduce a new label without updating `packages/graph-schema/schema.md`.
- Function and Class nodes exist only to derive IMPORTS/CALLS/INHERITS edges and node metadata — NEVER add a canvas renderer for them. Only Folder and File are drawable.
- `org_id` must be stamped on every write and injected server-side on every read. Never trust an `org_id` passed from the client.
- New edge types need an explicit rationale in the PR description — the edge list (CONTAINS, CONNECTS_TO, IMPORTS, CALLS, INHERITS, OWNS, AUTHORED, MODIFIED, REFERENCES, PART_OF, REQUIRES, DEPENDS_ON, COVERS) is deliberately closed, not open-ended.
