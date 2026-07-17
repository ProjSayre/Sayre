// 004_v5_scope_indexes.cypher
// W0-02 v5 — scope-aware Neo4j lookup indexes.
//
// Purpose: accelerate sanctioned repository/ref/revision-scoped reads and writes.
// These indexes aid performance; server-side write stamping and query filtering remain
// the authorization boundary.
//
// Neptune-replayable: NO (Neo4j-only CREATE INDEX DDL).

CREATE INDEX repo_scope_idx IF NOT EXISTS
  FOR (n:Repo) ON (n.org_id, n.repo_id);
CREATE INDEX folder_scope_path_idx IF NOT EXISTS
  FOR (n:Folder) ON (n.org_id, n.repo_id, n.ref_name, n.revision_sha, n.path);
CREATE INDEX file_scope_path_idx IF NOT EXISTS
  FOR (n:File) ON (n.org_id, n.repo_id, n.ref_name, n.revision_sha, n.path);
CREATE INDEX function_scope_symbol_idx IF NOT EXISTS
  FOR (n:Function) ON (n.org_id, n.repo_id, n.ref_name, n.revision_sha, n.file_path, n.name);
CREATE INDEX class_scope_symbol_idx IF NOT EXISTS
  FOR (n:Class) ON (n.org_id, n.repo_id, n.ref_name, n.revision_sha, n.file_path, n.name);
CREATE INDEX module_scope_name_idx IF NOT EXISTS
  FOR (n:Module) ON (n.org_id, n.repo_id, n.ref_name, n.revision_sha, n.name);
CREATE INDEX feature_scope_name_idx IF NOT EXISTS
  FOR (n:Feature) ON (n.org_id, n.repo_id, n.ref_name, n.revision_sha, n.name);
CREATE INDEX env_step_scope_sequence_idx IF NOT EXISTS
  FOR (n:EnvStep) ON (n.org_id, n.repo_id, n.ref_name, n.revision_sha, n.sequence);
CREATE INDEX test_scope_path_idx IF NOT EXISTS
  FOR (n:Test) ON (n.org_id, n.repo_id, n.ref_name, n.revision_sha, n.path);
CREATE INDEX commit_scope_sha_idx IF NOT EXISTS
  FOR (n:Commit) ON (n.org_id, n.repo_id, n.sha);
CREATE INDEX covers_scope_status_idx IF NOT EXISTS
  FOR ()-[r:COVERS]-() ON (r.org_id, r.repo_id, r.ref_name, r.revision_sha, r.status);
