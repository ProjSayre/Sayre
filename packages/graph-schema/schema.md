# Graph Schema Reference

Canonical human-readable catalog of every node label, relationship type, direction,
and property in the Codebase Visualizer graph (Neo4j today, Amazon Neptune-compatible
later — `docs/migration-triggers.md`). This is the doc `.claude/rules/graph-schema.md`
points every future label/edge change at — **any schema change must update this file**,
per that rule.

This file is the reference; the openCypher migrations that implement it live at
`services/workers/graph-migrations/` (`001_init_node_labels.cypher`,
`002_init_edge_types.cypher`, `003_constraints_and_indexes.cypher`,
`004_test_covers_contract.cypher`, and `005_scope_identity_indexes.cypher`),
applied/tracked by `services/workers/sayre_workers/graph_migrations/runner.py`. No
query-builder code lives here yet — that is a later ticket (W2-02, Graph Query
Service).

Non-goals of this ticket (see `docs/product/Ticket-Backlog-by-Feature-2.md` W0-02 and
`docs/wave0-foundation-contracts.md`): no Tree-sitter parsing / real node+edge
population (W1-01/W1-05), no Graph Query Service / RBAC node-stripping / query
builders (W2-02), no risk & health signal properties beyond the minimal
coverage/status fields named below (W3-07), no `CONNECTS_TO` cross-repo inference
(PM-01).

## Conventions

- **Property keys are snake_case** (`coding_style`, `comment_style`, `agent_skill_md`,
  `external_id`, `last_run`, etc.) — matches the cross-boundary wire convention in
  `services/core/src/queue/envelope.ts` and Postgres column names.
- Every node carries `org_id` (string; UUID form of the Postgres `organizations.id`)
  and `uid` (string; stable globally-unique node id — see "Scope & identity" below for
  its derivation). `org_id` is stamped on every graph write and injected server-side on
  every read — **never** accepted from client input
  (`.claude/rules/security-multitenancy.md`).
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

## Scope & identity

`docs/product/Ticket-Backlog-by-Feature-2.md`'s identity contract (repository identity stable / ref mutable /
revision an immutable SHA) is carried on every scope-bearing node and edge:

- `repo_id` (string) — the repository's stable identity (mirrors the Postgres
  `repositories.id` the ingestion job resolves server-side).
- `ref_name` (string) — the mutable ref (e.g. `refs/heads/main`) this projection was
  built against.
- `revision_sha` (string) — the immutable commit SHA that produced this projection.
  Nulled during a full rebuild (`sayre_workers/ingestion/graph.py:213`) until the new
  head lands, so a reader can distinguish "stale but present" from "mid-rebuild".

The scope-bearing node labels — the ones the Python ingestion/enrichment/dynamic-
coverage writers stamp with all three of `repo_id`/`ref_name`/`revision_sha` — are
`Folder`, `File`, `Function`, `Class`, `Test`, `Feature`, `EnvStep`. These are also the
labels `005_scope_identity_indexes.cypher` indexes (see "Constraints and indexes"
below). `COVERS` edges carry the same triple (`dynamic_coverage/graph.py`), backing the
same-scope invariant below.

`Project`, `Repo`, `Module`, `Person` carry no scope triple. `Commit` and `Ticket` are
written by the Node-side integration stores rather than the Python ingestion fleet and
are documented per-label below, including one naming discrepancy flagged for follow-up
rather than fixed under this ticket (see the `Commit` row's Notes).

### `uid` derivation

`uid` is a stable, globally-unique node id derived by
`sayre_workers.ingestion.projection.stable_uid`:

    uid = sha256(repository_id \0 ref_name \0 label \0 identity)

Where `\0` is the literal NUL-byte field separator, `label` is the node's label
(`"File"`, `"Function"`, etc.), and `identity` is:

- the canonical repository-relative path for `Folder`/`File`/`Test`, or
- `"<file_path>\0<qualified_name>"` for `Function`/`Class` — so two identically-named
  functions/classes in different files (or two overloads sharing a short name) still
  get distinct UIDs.

`hashlib.sha256(...).hexdigest()` of the UTF-8-encoded joined string is the resulting
`uid`. Because `repository_id`/`ref_name` are part of the hash, the same logical file
in two different repositories, or on two different refs of the same repository, never
collides — this is "Stable node UIDs include repository/ref scope and canonical
path/symbol identity" (`docs/product/Ticket-Backlog-by-Feature-2.md`) implemented.

### COVERS same-scope invariant

A `COVERS` edge is only ever created when its `Test` and covered-node endpoints share
the full `(org_id, repo_id, ref_name, revision_sha)` scope tuple — enforced by both
writers matching all four components on *both* endpoints before `MERGE`ing the edge
(`sayre_workers/ingestion/graph.py:96-106`,
`sayre_workers/dynamic_coverage/graph.py:227-239`), proven against a real Neo4j by
`test_real_covers_edge_is_created_only_when_both_endpoints_share_scope`
(`services/workers/tests/test_graph_migrations_audit.py`).

## Node labels (13)

| Label | Properties beyond `org_id`, `uid` | Notes |
|---|---|---|
| `Project` | `name` | Top of the containment tree; `CONTAINS` a `Repo`. No scope triple. |
| `Repo` | `name`, `provider`, `default_branch`, `external_id` | Mirrors the Postgres `repositories` row. No scope triple. |
| `Folder` | `path`, `name`, `coding_style`, `comment_style`, `agent_skill_md`, `repo_id`, `ref_name`, `revision_sha` | Drawable (canvas). `coding_style`/`comment_style` are two **distinct** style properties (not one merged field). |
| `File` | `path`, `name`, `language`, `coding_style`, `comment_style`, `agent_skill_md`, `last_structural_change_at`, `primary_owner_name`, `primary_owner_email`, `primary_owner_provider`, `primary_owner_login`, `last_edited_at`, `recent_pr_number`, `recent_pr_title`, `recent_pr_url`, `recent_pr_merged_at`, `repo_id`, `ref_name`, `revision_sha` | Drawable (canvas). `last_structural_change_at` is the trusted ingestion-envelope time for the latest changed-file projection and makes coverage freshness independent of ownership-sync timing. Optional `coding_style`/`comment_style` values are explicit File overrides; otherwise W3-06 resolves the nearest authorized ancestor Folder independently for each style. Ownership/recent-edit fields are denormalized overlays derived from canonical Person/Commit relationships. |
| `Function` | `name`, `signature`, `file_path`, `qualified_name`, `start_line`, `end_line`, `repo_id`, `ref_name`, `revision_sha` | Graph-internal only — never rendered on canvas. `qualified_name` (with `file_path`) forms the `uid` identity component; `start_line`/`end_line` back source-range lookups. |
| `Class` | `name`, `file_path`, `qualified_name`, `start_line`, `end_line`, `repo_id`, `ref_name`, `revision_sha` | Graph-internal only — never rendered on canvas. Same `qualified_name`/`start_line`/`end_line` role as `Function`. |
| `Module` | `name` | No scope triple. |
| `Person` | `name`, `email`, `provider`, `provider_login`, `github_login` | Provider-neutral identity; `github_login` remains as a compatibility alias for GitHub-backed people. No scope triple (a person is not repo/ref-scoped). |
| `Commit` | `sha`, `message`, `timestamp`, `author_name`, `author_email` | `author_name`/`author_email` are a denormalized cache; the canonical author link is the `AUTHORED` edge to a `Person`. **Notes (flagged, not fixed here):** `services/core/src/integrations/git/graphOwnershipStore.ts` additionally sets `commit.repository_id` (not `repo_id` — a naming inconsistency with every other scope-bearing label, discovered during the W0-02 audit) plus `commit.ref_name`/`commit.revision_sha`. Out of this ticket's scope to change (it does not own that file's Cypher); raised for a follow-up ticket rather than silently documented as if it were the canonical `repo_id` convention. |
| `Feature` | `description`, `team`, `name`, `repo_id`, `ref_name`, `revision_sha` | Cached fields for the Product tree view. |
| `Ticket` | `external_id`, `system` (`'jira'` \| `'linear'`), `title`, `status`, `url`, `synced_at`, `repo_id`, `ref_name` | Mirror pointer to the Jira/Linear system of record. `repo_id`/`ref_name` are set by `services/core/src/integrations/tickets/graphTicketStore.ts` (consistent with the canonical naming, unlike `Commit`'s `repository_id`); no `005` composite index exists for `Ticket` yet, since `005`'s index set is derived from the Python ingestion fleet's label scans (`docs/product/Ticket-Backlog-by-Feature-2.md` finding D2) and `Ticket` is written by the Node-side store instead — noted here rather than silently added to `005`'s scope. |
| `EnvStep` | `sequence` (int), `command`, `repo_id`, `ref_name`, `revision_sha` | Onboarding steps, ordered by `sequence`. |
| `Test` | `path`, `name`, `coverage_status` (`'pass'` \| `'fail'` \| `'unknown'`), `repo_id`, `ref_name`, `revision_sha` | Statically discovered tests begin as `unknown`; W4-03 updates measured results. |

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
| `REFERENCES` | `Ticket->File`, `Ticket->Feature` | — | Drives the Specific Tickets overlay for either structural or product nodes. |
| `PART_OF` | `File->Feature` | — | Backs a Feature's "Files Included" list. |
| `REQUIRES` | `EnvStep->EnvStep` | — | Onboarding prerequisite ordering. |
| `DEPENDS_ON` | `Module->Module` | — | |
| `COVERS` | `Test->File` | `status` (`'inferred'` \| `'measured'`), `last_run` (datetime, nullable), `repo_id`, `ref_name`, `revision_sha` | Static import inference writes `status='inferred'` with `last_run` unset; W4-03 may replace it with measured freshness. **Same-scope invariant (tested):** both endpoints must share authorized `(org_id, repo_id, ref_name, revision_sha)` scope — see "COVERS same-scope invariant" above. |

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
- **COVERS anchor (W0-02 audit correction):** `002`'s COVERS anchor edge carries
  `status:'inferred'` (matching the post-`004` contract), not the legacy
  `source:'static'` it originally shipped with. `MERGE` on a relationship keys on
  endpoints + type + the full property map, so once `004` has stripped `source` from
  real data, re-applying the old `002` against a graph that already ran `004` (e.g. the
  Postgres version tracker was dropped/reset while Neo4j persisted) created a *second*
  COVERS anchor edge — a literal duplicate, in violation of this migration set's
  idempotency contract. Fixed by making `002` agree with `004`'s shape directly, so the
  two files can never disagree again regardless of tracker state; guarded by
  `test_real_rerun_with_an_emptied_tracker_creates_no_duplicate_anchors` and
  `test_no_migration_statement_writes_a_source_property_on_covers`
  (`services/workers/tests/test_graph_migrations_audit.py`). This changes `002`'s
  checksum: any environment that already recorded `002` as applied under the old bytes
  will raise `MigrationChecksumMismatchError` on the next run (by design — the fix is
  not to weaken the checksum check). Operator remedy, also stated in `002`'s own file
  header: delete the stale anchor edge in Neo4j, then run
  `DELETE FROM graph_migrations WHERE target='neo4j' AND layer='logical' AND version=2;`
  (adjust `target` for any other target `002` was applied to) and re-run the
  migrations.

## Constraints and indexes (`003_constraints_and_indexes.cypher`,
`005_scope_identity_indexes.cypher`)

Neo4j `5.24-community` supports only uniqueness constraints and indexes — **not**
existence/NOT-NULL or node-key constraints (Enterprise-only). So `org_id` NOT-NULL is
enforced by server-side write stamping (`.claude/rules/security-multitenancy.md`), not
a database constraint.

- **Per label (13x, `003`):** a composite `(org_id, uid)` uniqueness constraint
  (tenant-safe — the same `uid` may recur across different orgs, only the pair must be
  globally unique) + an `org_id` index (tenant-scoped scan support).
- **Secondary lookup indexes (natural keys, `003`):** `Commit(org_id, sha)`,
  `File(org_id, path)`, `Folder(org_id, path)`, `Ticket(org_id, external_id)`,
  `Person(org_id, email)`.
- **Relationship property indexes (`003`):** `COVERS.last_run`, `AUTHORED.timestamp`,
  `MODIFIED.timestamp` — back freshness/timeline queries.
- **Scope composite indexes (7x, `005`, W0-02 audit addition):** an
  `(org_id, repo_id, ref_name)` index for each scope-bearing label —
  `Folder`, `File`, `Function`, `Class`, `Test`, `Feature`, `EnvStep`. Nearly every
  ingestion, delete/rebuild, and Graph Query Service statement matches on exactly this
  triple (e.g. `sayre_workers/ingestion/graph.py:220,232,241,250,261,271,339`); without
  it, every one of those was a label scan filtered in memory. Deliberately **not**
  added for `Project`, `Repo`, `Module`, `Person`, `Commit`, `Ticket` — none of these
  carry the scope triple from the Python writers' side (see "Scope & identity" above
  for the `Commit`/`Ticket` caveats), and an index over a property a node never has is
  dead weight.

**Neptune caveat:** Amazon Neptune does not implement openCypher `CREATE CONSTRAINT` /
`CREATE INDEX` DDL (Neptune auto-indexes and has no user schema DDL). `003` and `005`
are the **only** files in this migration set that are Neo4j-specific (`Targets: neo4j`
only); `001`, `002`, and `004` (portable data statements, `Targets: neo4j, neptune`)
replay unmodified against Neptune. The migration runner's `--target neptune` flag skips
any file whose `// Targets:` header does not list `neptune` — currently `003` and
`005` — rather than sending Neo4j-only DDL to Neptune.

## Migration layers and version tracking

Every `.cypher` file under `services/workers/graph-migrations/` declares two
machine-readable header directives, parsed by `discover_migrations` (not a hardcoded
version list):

```
// Layer: logical | physical
// Targets: neo4j, neptune   (or just: neo4j)
```

- **`logical`** — portable data migrations (`001`, `002`, `004`): pure `MERGE`/`MATCH`,
  `Targets: neo4j, neptune`.
- **`physical`** — target-specific DDL (`003`, `005`): constraint/index creation,
  `Targets: neo4j` (Neptune has no such DDL to send it to).

A file missing either header is a hard discovery-time error naming the file, not a
silent default (`MigrationHeaderError`).

Applied migrations are recorded in the Postgres `graph_migrations` table (created and,
if needed, reshaped in place idempotently by `ensure_tracking_table`):

```sql
CREATE TABLE IF NOT EXISTS graph_migrations (
  target      text        NOT NULL DEFAULT 'neo4j',   -- 'neo4j' | 'neptune'
  layer       text        NOT NULL DEFAULT 'logical',  -- 'logical' | 'physical'
  version     integer     NOT NULL,
  filename    text        NOT NULL,
  checksum    text        NOT NULL,          -- sha256 hex of the .cypher file bytes
  applied_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (target, layer, version)
);
```

The primary key is `(target, layer, version)`, not `version` alone (W0-02 audit
correction): history is now tracked **per logical/physical layer and per graph
target**, per `docs/product/Ticket-Backlog-by-Feature-2.md`'s acceptance line. With a single-column `version`
key, applying the logical files to `neo4j` first and then running `--target neptune`
against the same Postgres would report every logical file as "already applied" and
apply nothing to Neptune — the exact scenario the Neptune cutover (PM-03) needs to
work. Under the composite key, a second target's run applies (and records under its
own `target`) every file whose `// Targets:` header lists it, independent of what any
other target has already recorded.

No `org_id`, no Row-Level Security — this is global infra bookkeeping (graph schema
versions are cross-tenant), analogous to Drizzle's own `__drizzle_migrations` table.
It is deliberately **not** a tenant-scoped domain table and must not gain one.
