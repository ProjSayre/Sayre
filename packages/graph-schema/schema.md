# Graph Schema Reference

Canonical human-readable catalog of every node label, relationship type, direction,
and property in the Codebase Visualizer graph (Neo4j today, Amazon Neptune-compatible
later — `docs/migration-triggers.md`). This is the doc `.claude/rules/graph-schema.md`
points every future label/edge change at — **any schema change must update this file**,
per that rule.

This file is the reference; the openCypher migrations that implement it live at
`services/workers/graph-migrations/` (`001_init_node_labels.cypher`,
`002_init_edge_types.cypher`, `003_constraints_and_indexes.cypher`), applied/tracked by
`services/workers/sayre_workers/graph_migrations/runner.py`. No query-builder code
lives here yet — that is a later ticket (W2-02, Graph Query Service).

Non-goals of this ticket (see `.pipeline/spec.md` W0-02 Scope/Out): no Tree-sitter
parsing / real node+edge population (W1-01/W1-05), no Graph Query Service / RBAC
node-stripping / query builders (W2-02), no risk & health signal properties beyond the
minimal coverage/status fields named below (W3-07), no `CONNECTS_TO` cross-repo
inference (PM-01).

## Conventions

- **Property keys are snake_case** (`coding_style`, `comment_style`, `agent_skill_md`,
  `external_id`, `last_run`, etc.) — matches the cross-boundary wire convention in
  `services/core/src/queue/envelope.ts` and Postgres column names.
- Every node carries `org_id` (string; UUID form of the Postgres `organizations.id`)
  and `uid` (string; stable globally-unique node id). `org_id` is stamped on every
  graph write and injected server-side on every read — **never** accepted from client
  input (`.claude/rules/security-multitenancy.md`).
- Every relationship also carries `org_id`, consistent with "`org_id` stamped on every
  graph write"; it doubles as the indexable key that registers each relationship type
  in `002_init_edge_types.cypher`.
- Only `Folder` and `File` nodes are ever rendered on canvas, in any of the three tree
  views (Technical / Product / Onboarding). `Function` and `Class` nodes are
  graph-internal only — they exist solely to derive `IMPORTS`/`CALLS`/`INHERITS` edges
  and node metadata; **never** add a canvas renderer for them
  (`.claude/rules/graph-schema.md`, `CLAUDE.md`).
- The node-label set (13) and relationship-type set (13) below are both **closed
  sets**. A new label or edge type needs an explicit rationale in the PR description
  and an update to this file (`.claude/rules/graph-schema.md`).
- Node-level RBAC filtering and graph traversal happen ONLY in the server-side Graph
  Query Service (a later ticket, W2-02) — never duplicated in client-side graphology
  code (`.claude/rules/security-multitenancy.md`).

## Node labels (13)

| Label | Properties beyond `org_id`, `uid` | Notes |
|---|---|---|
| `Project` | `name` | Top of the containment tree; `CONTAINS` a `Repo`. |
| `Repo` | `name`, `provider`, `default_branch`, `external_id` | Mirrors the Postgres `repositories` row. |
| `Folder` | `path`, `name`, `coding_style`, `comment_style`, `agent_skill_md` | Drawable (canvas). `coding_style`/`comment_style` are two **distinct** style properties (not one merged field). |
| `File` | `path`, `name`, `language`, `agent_skill_md` | Drawable (canvas). |
| `Function` | `name`, `signature`, `file_path` | Graph-internal only — never rendered on canvas. |
| `Class` | `name`, `file_path` | Graph-internal only — never rendered on canvas. |
| `Module` | `name` | |
| `Person` | `name`, `email`, `github_login` | Identity via name, email, or GitHub login. |
| `Commit` | `sha`, `message`, `timestamp`, `author_name`, `author_email` | `author_name`/`author_email` are a denormalized cache; the canonical author link is the `AUTHORED` edge to a `Person`. |
| `Feature` | `description`, `team`, `name` | Cached fields for the Product tree view. |
| `Ticket` | `external_id`, `system` (`'jira'` \| `'linear'`), `status` | Mirror pointer to the Jira/Linear system of record. |
| `EnvStep` | `sequence` (int), `command` | Onboarding steps, ordered by `sequence`. |
| `Test` | `path`, `name`, `last_run_status` (`'pass'` \| `'fail'` \| `'unknown'`), `last_run_at` (datetime, nullable) | Backs the pass/fail badge (W4-03). Coverage **freshness** (covered/uncovered/stale) is computed from the `COVERS` edge properties, not a `Test` node property. |

## Relationship types (13)

Every relationship carries `org_id`. Direction below is canonical (source -> target).

| Relationship | Canonical direction (representative) | Extra properties | Notes |
|---|---|---|---|
| `CONTAINS` | `Project->Repo`, `Folder->Folder`, `Folder->File` | — | Containment hierarchy; three valid endpoint-label pairs. |
| `CONNECTS_TO` | `Repo->Repo` | `kind` (`'import'` \| `'api'` \| `'shared_dep'`) | Cross-repo, Macro View. Declared only here — population is PM-01. |
| `IMPORTS` | `File->File` | — | |
| `CALLS` | `Function->Function` | — | Graph-internal (endpoints are graph-internal-only labels). |
| `INHERITS` | `Class->Class` | — | Graph-internal (endpoints are graph-internal-only labels). |
| `OWNS` | `Person->File` | — | Primary code owner. |
| `AUTHORED` | `Person->Commit` | `timestamp` (datetime) | |
| `MODIFIED` | `Commit->File` | `timestamp` (datetime) | |
| `REFERENCES` | `Ticket->File` | — | |
| `PART_OF` | `File->Feature` | — | Backs a Feature's "Files Included" list. |
| `REQUIRES` | `EnvStep->EnvStep` | — | Onboarding prerequisite ordering. |
| `DEPENDS_ON` | `Module->Module` | — | |
| `COVERS` | `Test->File` | `source` (`'static'` \| `'dynamic'`), `last_run` (datetime, nullable for `source='static'`) | `source`/`last_run` are what W4-03 reads to mark coverage `stale` when `source='dynamic' AND last_run < now() - 7 days`, or when only a static edge exists. |

**Direction note (non-blocking, flagged for awareness):** `AUTHORED`/`MODIFIED`/`OWNS`
directions above (`Person->Commit`, `Commit->File`, `Person->File`) are this schema's
choice for deriving ownership; PRD §4.11 does not pin exact directions. Downstream
tickets (W3-07) can extend without breaking these.

## Schema-anchor (sentinel) nodes and edges

`001_init_node_labels.cypher` and `002_init_edge_types.cypher` declare every label and
relationship type by `MERGE`ing one reserved schema-anchor node per label (and one
representative anchor edge per relationship type between those anchor nodes), keyed on
a reserved sentinel `org_id` (`'00000000-0000-0000-0000-000000000000'`, the all-zero
UUID — never issued to a real tenant by Postgres `gen_random_uuid()`) and a reserved
`uid` (`'__schema_anchor__'`).

- These anchors exist purely so the label/relationship-type physically exists in the
  graph (a schema-less graph DB has no other way to "declare" a label/type without
  data), and so 001/002 stay pure `MERGE`/`MATCH` — which replays unmodified against
  Amazon Neptune's openCypher implementation.
- Every real tenant query filters by a real (non-zero) `org_id` server-side, so these
  anchors are invisible to every canvas/RBAC/RAG read — the sentinel `org_id` never
  leaks into a tenant-scoped result.
- Where a relationship type's canonical endpoints share the same label
  (`CONNECTS_TO`, `IMPORTS`, `CALLS`, `INHERITS`, `REQUIRES`, `DEPENDS_ON`), the anchor
  edge is a self-loop on that label's single anchor node — a declaration artifact only;
  real tenant data connects distinct nodes.

## Constraints and indexes (`003_constraints_and_indexes.cypher`)

Neo4j `5.24-community` supports only uniqueness constraints and indexes — **not**
existence/NOT-NULL or node-key constraints (Enterprise-only). So `org_id` NOT-NULL is
enforced by server-side write stamping (`.claude/rules/security-multitenancy.md`), not
a database constraint.

- **Per label (13x):** a composite `(org_id, uid)` uniqueness constraint (tenant-safe —
  the same `uid` may recur across different orgs, only the pair must be globally
  unique) + an `org_id` index (tenant-scoped scan support).
- **Secondary lookup indexes (natural keys):** `Commit(org_id, sha)`,
  `File(org_id, path)`, `Folder(org_id, path)`, `Ticket(org_id, external_id)`,
  `Person(org_id, email)`.
- **Relationship property indexes:** `COVERS.last_run`, `AUTHORED.timestamp`,
  `MODIFIED.timestamp` — back freshness/timeline queries.

**Neptune caveat:** Amazon Neptune does not implement openCypher `CREATE CONSTRAINT` /
`CREATE INDEX` DDL (Neptune auto-indexes and has no user schema DDL). `003` is the
**only** file in this migration set that is Neo4j-specific; 001/002 (pure `MERGE`)
replay unmodified against Neptune. The migration runner's `--target neptune` flag
skips 003 rather than sending this DDL to Neptune.

## Version tracking

Applied migrations are recorded in the Postgres `graph_migrations` table (created
idempotently by the runner via `CREATE TABLE IF NOT EXISTS`):

```sql
CREATE TABLE IF NOT EXISTS graph_migrations (
  version    integer PRIMARY KEY,
  filename   text NOT NULL,
  checksum   text NOT NULL,          -- sha256 hex of the .cypher file bytes
  applied_at timestamptz NOT NULL DEFAULT now()
);
```

No `org_id`, no Row-Level Security — this is global infra bookkeeping (graph schema
versions are cross-tenant), analogous to Drizzle's own `__drizzle_migrations` table.
It is deliberately **not** a tenant-scoped domain table and must not gain one.
