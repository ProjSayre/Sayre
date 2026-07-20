# Graph Schema Reference

This is the canonical logical graph contract for Neo4j today and Amazon Neptune
later. Logical data and application queries use portable openCypher. Physical DDL is
versioned separately per target under `services/workers/graph-migrations/`.

## Invariants

- Node labels and relationship types are the closed 13-item sets below.
- Every write carries a server-resolved `org_id`; clients never choose tenant scope.
- Repository/ref/revision-bound relationships carry the same `org_id`, `repo_id`,
  `ref_name`, and `revision_sha` envelope as their endpoints.
- Only `Folder` and `File` render. `Function` and `Class` remain graph-internal.
- RBAC traversal and node stripping belong to the server-side Graph Query Service.
- The all-zero organization and `uid='__schema_anchor__'` are reserved migration
  sentinels and are never visible to a real tenant query.

## Scope and identity

Repository identity is stable, a ref name identifies a mutable projection, and
`revision_sha` records the immutable accepted commit that produced that projection.

| Scope | Labels | Required identity beyond `uid` |
|---|---|---|
| Organization | `Project`, `Person`, `Ticket` | `org_id` |
| Repository | `Repo` | `org_id`, `repo_id` |
| Ref + revision | `Folder`, `File`, `Function`, `Class`, `Module`, `Feature`, `EnvStep`, `Test` | `org_id`, `repo_id`, `ref_name`, `revision_sha` |
| Immutable commit | `Commit` | `org_id`, `repo_id`, `sha` |

The proposed scope matrix is a human merge-review flag, especially `Ticket` and
`Feature` scope. W0-02 implements the table above for downstream writers.

### Stable UID v1

`sayre_workers.graph_schema.stable_node_uid` returns
`v1:<lowercase-sha256-hex>` over compact UTF-8 JSON with sorted keys:

```json
{"canonical_path":"src/example.py","node_kind":"File","ref_name":"refs/heads/main","repo_id":"repo-id"}
```

The optional `symbol` key carries a parser-supplied qualified symbol identity.
`repo_id`, `ref_name`, node kind, canonical path, and optional symbol affect the hash;
`org_id` and `revision_sha` deliberately do not. Uniqueness remains `(org_id, uid)`,
while excluding revision lets the same ref-scoped entity be upserted at a new accepted
revision. Paths are case-sensitive, Unicode NFC, relative POSIX paths and reject
empty/absolute paths, backslashes, NUL, empty segments, `.`, and `..`. Folder/File
use path identity; Function/Class require a qualified symbol identity. NFC and symbol
conventions remain human schema-review flags.

The reserved schema-anchor UID is an explicit exception and is not produced by the
v1 helper.

## Node labels (13)

Every node carries `org_id` and `uid`, plus the scope fields above.

| Label | Additional properties | Notes |
|---|---|---|
| `Project` | `name` | Contains repositories. |
| `Repo` | `repo_id`, `name`, `provider`, `default_branch`, `external_id` | Mirrors a stable repository identity. |
| `Folder` | `path`, `name`, `coding_style`, `comment_style`, `agent_skill_md` | Drawable. |
| `File` | `path`, `name`, `language`, `agent_skill_md` | Drawable. |
| `Function` | `name`, `signature`, `file_path` | Graph-internal. |
| `Class` | `name`, `file_path` | Graph-internal. |
| `Module` | `name` | Ref/revision scoped. |
| `Person` | `name`, `email`, `github_login` | Organization scoped. |
| `Commit` | `sha`, `message`, `timestamp`, `author_name`, `author_email` | Immutable SHA identity; not ref scoped. |
| `Feature` | `description`, `team`, `name` | Ref/revision scoped proposed default. |
| `Ticket` | `external_id`, `system`, `status` | Organization scoped proposed default. |
| `EnvStep` | `sequence`, `command` | Ref/revision scoped. |
| `Test` | `path`, `name`, `coverage_status` (`pass` \| `fail` \| `unknown`) | Ref/revision scoped. |

## Relationship types (13)

Every relationship carries `org_id`; repository/ref/revision-bound relationships also
carry the matching scope envelope.

| Relationship | Direction | Extra properties |
|---|---|---|
| `CONTAINS` | `Project->Repo`, `Folder->Folder`, `Folder->File` | — |
| `CONNECTS_TO` | `Repo->Repo` | `kind` |
| `IMPORTS` | `File->File` | — |
| `CALLS` | `Function->Function` | — |
| `INHERITS` | `Class->Class` | — |
| `OWNS` | `Person->File` | — |
| `AUTHORED` | `Person->Commit` | `timestamp` |
| `MODIFIED` | `Commit->File` | `timestamp` |
| `REFERENCES` | `Ticket->File` | — |
| `PART_OF` | `File->Feature` | — |
| `REQUIRES` | `EnvStep->EnvStep` | — |
| `DEPENDS_ON` | `Module->Module` | — |
| `COVERS` | `Test->File|Function|Class|Module` | `status` (`inferred` \| `measured`), nullable `last_run` |

The COVERS endpoint set is closed for the MVP and remains a human merge-review flag.
Both endpoints must have exactly equal `org_id`, `repo_id`, `ref_name`, and
`revision_sha`; sanctioned writers call `require_same_covers_scope` before writing.
`last_run` is absent/null until measured. The legacy `COVERS.source`,
`Test.last_run_status`, and `Test.last_run_at` fields are not part of v5.

## Schema anchors and migrations

Logical migrations use the all-zero sentinel organization and reserved repository,
ref, and revision values only to declare the schema. They never backfill real tenant
data. The layered plan is:

```text
graph-migrations/
  logical/
    001_init_node_labels.cypher
    002_init_edge_types.cypher
    003_v5_identity_and_covers.cypher
  physical/
    neo4j/
      003_constraints_and_indexes.cypher
      004_v5_scope_indexes.cypher
    neptune/
      README.md
```

Published 001/002 and Neo4j 003 remain byte-preserving moves. Logical 003 uses only
portable MATCH/MERGE/SET/REMOVE operations. Neptune currently has no user-replayable
physical DDL; PM-03 owns its real adapter and future physical operations.

Neo4j physical 003 retains the 13 `(org_id, uid)` uniqueness constraints, per-label
tenant indexes, natural-key indexes, and relationship timestamp indexes. Physical 004
adds scope-aware indexes for Repo; Folder/File paths; Function/Class symbols;
Module/Feature names; EnvStep sequence; Test path; Commit SHA; and COVERS status.
These are performance aids, not authorization or existence constraints. Neo4j
Community does not support enterprise-only existence/node-key constraints.

## Migration history

Postgres stores global, intentionally non-tenant migration bookkeeping:

```sql
PRIMARY KEY (graph_target, layer, version)
```

`graph_target` is `neo4j|neptune`, `layer` is `logical|physical`, and filename plus
canonical LF checksum must match. The runner transactionally upgrades only exact
known legacy 001/002/003 history, preserves `applied_at`, and fails closed otherwise.
Logical and target-specific physical versions may reuse the same number.
