// 003_constraints_and_indexes.cypher
// W0-02 — Graph DB schema & openCypher migrations
//
// Purpose: constraint/index DDL for the 13 node labels + 3 relationship property
// indexes declared in 001/002. Idempotency uses `IF NOT EXISTS` (there is no
// `MERGE CONSTRAINT`/`MERGE INDEX` — `IF NOT EXISTS` is the DDL equivalent of the
// "MERGE not CREATE" rule that governs the data statements in 001/002).
//
// Neo4j 5.24-community supports only uniqueness constraints + indexes — NOT
// existence/NOT-NULL or node-key constraints (Enterprise-only features). So `org_id`
// NOT-NULL cannot be enforced by constraint here; it is enforced by server-side
// stamping at write time (.claude/rules/security-multitenancy.md) and by the org_id
// index below for tenant-scoped query performance.
//
// *** Neptune-replayable: NO. *** Amazon Neptune does not implement openCypher
// `CREATE CONSTRAINT` / `CREATE INDEX` DDL (Neptune auto-indexes and has no user
// schema DDL). This is the ONE file in this migration set that is Neo4j-specific —
// 001 and 002 (pure MERGE/MATCH) replay unmodified against Neptune, this file does
// not. The migration runner's `--target neptune` flag skips this file (version 3 is
// in `NEPTUNE_INCOMPATIBLE_VERSIONS`) rather than sending this DDL to Neptune.
//
// Composite (org_id, uid) uniqueness (not uid alone) is deliberate: it is
// tenant-safe — the same `uid` value may legitimately recur across different orgs,
// only the (org_id, uid) pair must be globally unique.

// --- Per-label uniqueness constraints (13) + org_id indexes (13) ---

CREATE CONSTRAINT project_uid_unique IF NOT EXISTS
  FOR (n:Project) REQUIRE (n.org_id, n.uid) IS UNIQUE;
CREATE INDEX project_org_id_idx IF NOT EXISTS
  FOR (n:Project) ON (n.org_id);

CREATE CONSTRAINT repo_uid_unique IF NOT EXISTS
  FOR (n:Repo) REQUIRE (n.org_id, n.uid) IS UNIQUE;
CREATE INDEX repo_org_id_idx IF NOT EXISTS
  FOR (n:Repo) ON (n.org_id);

CREATE CONSTRAINT folder_uid_unique IF NOT EXISTS
  FOR (n:Folder) REQUIRE (n.org_id, n.uid) IS UNIQUE;
CREATE INDEX folder_org_id_idx IF NOT EXISTS
  FOR (n:Folder) ON (n.org_id);

CREATE CONSTRAINT file_uid_unique IF NOT EXISTS
  FOR (n:File) REQUIRE (n.org_id, n.uid) IS UNIQUE;
CREATE INDEX file_org_id_idx IF NOT EXISTS
  FOR (n:File) ON (n.org_id);

CREATE CONSTRAINT function_uid_unique IF NOT EXISTS
  FOR (n:Function) REQUIRE (n.org_id, n.uid) IS UNIQUE;
CREATE INDEX function_org_id_idx IF NOT EXISTS
  FOR (n:Function) ON (n.org_id);

CREATE CONSTRAINT class_uid_unique IF NOT EXISTS
  FOR (n:Class) REQUIRE (n.org_id, n.uid) IS UNIQUE;
CREATE INDEX class_org_id_idx IF NOT EXISTS
  FOR (n:Class) ON (n.org_id);

CREATE CONSTRAINT module_uid_unique IF NOT EXISTS
  FOR (n:Module) REQUIRE (n.org_id, n.uid) IS UNIQUE;
CREATE INDEX module_org_id_idx IF NOT EXISTS
  FOR (n:Module) ON (n.org_id);

CREATE CONSTRAINT person_uid_unique IF NOT EXISTS
  FOR (n:Person) REQUIRE (n.org_id, n.uid) IS UNIQUE;
CREATE INDEX person_org_id_idx IF NOT EXISTS
  FOR (n:Person) ON (n.org_id);

CREATE CONSTRAINT commit_uid_unique IF NOT EXISTS
  FOR (n:Commit) REQUIRE (n.org_id, n.uid) IS UNIQUE;
CREATE INDEX commit_org_id_idx IF NOT EXISTS
  FOR (n:Commit) ON (n.org_id);

CREATE CONSTRAINT feature_uid_unique IF NOT EXISTS
  FOR (n:Feature) REQUIRE (n.org_id, n.uid) IS UNIQUE;
CREATE INDEX feature_org_id_idx IF NOT EXISTS
  FOR (n:Feature) ON (n.org_id);

CREATE CONSTRAINT ticket_uid_unique IF NOT EXISTS
  FOR (n:Ticket) REQUIRE (n.org_id, n.uid) IS UNIQUE;
CREATE INDEX ticket_org_id_idx IF NOT EXISTS
  FOR (n:Ticket) ON (n.org_id);

CREATE CONSTRAINT env_step_uid_unique IF NOT EXISTS
  FOR (n:EnvStep) REQUIRE (n.org_id, n.uid) IS UNIQUE;
CREATE INDEX env_step_org_id_idx IF NOT EXISTS
  FOR (n:EnvStep) ON (n.org_id);

CREATE CONSTRAINT test_uid_unique IF NOT EXISTS
  FOR (n:Test) REQUIRE (n.org_id, n.uid) IS UNIQUE;
CREATE INDEX test_org_id_idx IF NOT EXISTS
  FOR (n:Test) ON (n.org_id);

// --- Secondary lookup indexes (natural keys) ---

CREATE INDEX commit_sha_idx      IF NOT EXISTS FOR (n:Commit)  ON (n.org_id, n.sha);
CREATE INDEX file_path_idx       IF NOT EXISTS FOR (n:File)    ON (n.org_id, n.path);
CREATE INDEX folder_path_idx     IF NOT EXISTS FOR (n:Folder)  ON (n.org_id, n.path);
CREATE INDEX ticket_external_idx IF NOT EXISTS FOR (n:Ticket)  ON (n.org_id, n.external_id);
CREATE INDEX person_email_idx    IF NOT EXISTS FOR (n:Person)  ON (n.org_id, n.email);

// --- Relationship property indexes (Neo4j 5 rel-index syntax; back freshness/timeline queries) ---

CREATE INDEX covers_last_run_idx IF NOT EXISTS FOR ()-[r:COVERS]-()   ON (r.last_run);
CREATE INDEX authored_ts_idx     IF NOT EXISTS FOR ()-[r:AUTHORED]-() ON (r.timestamp);
CREATE INDEX modified_ts_idx     IF NOT EXISTS FOR ()-[r:MODIFIED]-() ON (r.timestamp);
