// 005_scope_identity_indexes.cypher
// W0-02 — Graph DB schema & openCypher migrations (audit)
//
// Layer: physical
// Targets: neo4j
//
// Purpose: composite (org_id, repo_id, ref_name) indexes for every scope-bearing node
// label (finding D2). The PRD's identity contract (docs/PRD_Tickets.md, "Stable node
// UIDs include repository/ref scope and canonical path/symbol identity") means almost
// every ingestion, delete/rebuild, and Graph Query Service statement matches on exactly
// this triple (sayre_workers/ingestion/graph.py, sayre_workers/enrichment/
// enrichment_graph.py, sayre_workers/dynamic_coverage/graph.py) -- without this index
// every one of those was a label scan filtered in memory.
//
// Scope-bearing labels (7): Folder, File, Function, Class, Test, Feature, EnvStep --
// the labels the Python ingestion/enrichment/dynamic-coverage writers actually stamp
// with `repo_id`/`ref_name`/`revision_sha` (packages/graph-schema/schema.md "Scope &
// identity"). Deliberately NOT indexed here: Project, Repo, Module, Person, Commit,
// Ticket -- none of these carry the scope triple from the Python writers' side, and an
// index over a property a node never has is dead weight, not a performance win.
//
// (Note for a future ticket, not acted on here: services/core's Node-side integration
// stores separately stamp `repo_id`/`ref_name` onto `Ticket` (graphTicketStore.ts) and a
// differently-named `repository_id`/`ref_name`/`revision_sha` onto `Commit`
// (graphOwnershipStore.ts). That is outside this ticket's scope --
// "Any change to ... services/core/src/graph-query/ ... this ticket documents and
// indexes what [the Python writers] already write; it does not change their Cypher" --
// and is flagged in packages/graph-schema/schema.md and .pipeline/changes.md rather than
// changed here.)
//
// Idempotent via `IF NOT EXISTS` (the DDL equivalent of "MERGE not CREATE", same as 003).
// 005 runs after 003 in every apply order (`003 < 005` sorts before), so this is purely
// additive to 003's index/constraint set -- no name or shape collision (EC-14).
//
// Neptune-replayable: NO. Same reason as 003: Amazon Neptune does not implement
// openCypher index-creation DDL. The migration runner's `--target neptune` flag skips
// this file (it declares `Targets: neo4j` above) rather than sending this DDL to Neptune.

CREATE INDEX folder_scope_idx IF NOT EXISTS
  FOR (n:Folder) ON (n.org_id, n.repo_id, n.ref_name);

CREATE INDEX file_scope_idx IF NOT EXISTS
  FOR (n:File) ON (n.org_id, n.repo_id, n.ref_name);

CREATE INDEX function_scope_idx IF NOT EXISTS
  FOR (n:Function) ON (n.org_id, n.repo_id, n.ref_name);

CREATE INDEX class_scope_idx IF NOT EXISTS
  FOR (n:Class) ON (n.org_id, n.repo_id, n.ref_name);

CREATE INDEX test_scope_idx IF NOT EXISTS
  FOR (n:Test) ON (n.org_id, n.repo_id, n.ref_name);

CREATE INDEX feature_scope_idx IF NOT EXISTS
  FOR (n:Feature) ON (n.org_id, n.repo_id, n.ref_name);

CREATE INDEX env_step_scope_idx IF NOT EXISTS
  FOR (n:EnvStep) ON (n.org_id, n.repo_id, n.ref_name);
