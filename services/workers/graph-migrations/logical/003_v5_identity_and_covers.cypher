// 003_v5_identity_and_covers.cypher
// W0-02 v5 — repository/ref/revision identity and COVERS contract anchors.
//
// Purpose: enrich only the reserved schema anchors with representative v5 scope
// properties and declare all approved COVERS endpoint shapes. Real tenant data is
// never matched or backfilled by this migration.
//
// Neptune-replayable: YES (portable MATCH/MERGE/SET/REMOVE data operations only).

MATCH (n:Repo {uid:'__schema_anchor__', org_id:'00000000-0000-0000-0000-000000000000'})
SET n.repo_id = '__schema_repo__';

MATCH (n:Folder {uid:'__schema_anchor__', org_id:'00000000-0000-0000-0000-000000000000'})
SET n.repo_id = '__schema_repo__', n.ref_name = '__schema_ref__', n.revision_sha = '0000000000000000000000000000000000000000';
MATCH (n:File {uid:'__schema_anchor__', org_id:'00000000-0000-0000-0000-000000000000'})
SET n.repo_id = '__schema_repo__', n.ref_name = '__schema_ref__', n.revision_sha = '0000000000000000000000000000000000000000';
MATCH (n:Function {uid:'__schema_anchor__', org_id:'00000000-0000-0000-0000-000000000000'})
SET n.repo_id = '__schema_repo__', n.ref_name = '__schema_ref__', n.revision_sha = '0000000000000000000000000000000000000000';
MATCH (n:Class {uid:'__schema_anchor__', org_id:'00000000-0000-0000-0000-000000000000'})
SET n.repo_id = '__schema_repo__', n.ref_name = '__schema_ref__', n.revision_sha = '0000000000000000000000000000000000000000';
MATCH (n:Module {uid:'__schema_anchor__', org_id:'00000000-0000-0000-0000-000000000000'})
SET n.repo_id = '__schema_repo__', n.ref_name = '__schema_ref__', n.revision_sha = '0000000000000000000000000000000000000000';
MATCH (n:Feature {uid:'__schema_anchor__', org_id:'00000000-0000-0000-0000-000000000000'})
SET n.repo_id = '__schema_repo__', n.ref_name = '__schema_ref__', n.revision_sha = '0000000000000000000000000000000000000000';
MATCH (n:EnvStep {uid:'__schema_anchor__', org_id:'00000000-0000-0000-0000-000000000000'})
SET n.repo_id = '__schema_repo__', n.ref_name = '__schema_ref__', n.revision_sha = '0000000000000000000000000000000000000000';
MATCH (n:Test {uid:'__schema_anchor__', org_id:'00000000-0000-0000-0000-000000000000'})
SET n.repo_id = '__schema_repo__', n.ref_name = '__schema_ref__', n.revision_sha = '0000000000000000000000000000000000000000', n.coverage_status = 'unknown'
REMOVE n.last_run_status, n.last_run_at;

MATCH (n:Commit {uid:'__schema_anchor__', org_id:'00000000-0000-0000-0000-000000000000'})
SET n.repo_id = '__schema_repo__', n.sha = '0000000000000000000000000000000000000000';

MATCH (a:Test {uid:'__schema_anchor__', org_id:'00000000-0000-0000-0000-000000000000'}),
      (b:File {uid:'__schema_anchor__', org_id:'00000000-0000-0000-0000-000000000000'})
MERGE (a)-[r:COVERS {org_id:'00000000-0000-0000-0000-000000000000'}]->(b)
SET r.repo_id = '__schema_repo__', r.ref_name = '__schema_ref__', r.revision_sha = '0000000000000000000000000000000000000000', r.status = 'inferred'
REMOVE r.source, r.last_run;

MATCH (a:Test {uid:'__schema_anchor__', org_id:'00000000-0000-0000-0000-000000000000'}),
      (b:Function {uid:'__schema_anchor__', org_id:'00000000-0000-0000-0000-000000000000'})
MERGE (a)-[r:COVERS {org_id:'00000000-0000-0000-0000-000000000000'}]->(b)
SET r.repo_id = '__schema_repo__', r.ref_name = '__schema_ref__', r.revision_sha = '0000000000000000000000000000000000000000', r.status = 'inferred'
REMOVE r.source, r.last_run;

MATCH (a:Test {uid:'__schema_anchor__', org_id:'00000000-0000-0000-0000-000000000000'}),
      (b:Class {uid:'__schema_anchor__', org_id:'00000000-0000-0000-0000-000000000000'})
MERGE (a)-[r:COVERS {org_id:'00000000-0000-0000-0000-000000000000'}]->(b)
SET r.repo_id = '__schema_repo__', r.ref_name = '__schema_ref__', r.revision_sha = '0000000000000000000000000000000000000000', r.status = 'inferred'
REMOVE r.source, r.last_run;

MATCH (a:Test {uid:'__schema_anchor__', org_id:'00000000-0000-0000-0000-000000000000'}),
      (b:Module {uid:'__schema_anchor__', org_id:'00000000-0000-0000-0000-000000000000'})
MERGE (a)-[r:COVERS {org_id:'00000000-0000-0000-0000-000000000000'}]->(b)
SET r.repo_id = '__schema_repo__', r.ref_name = '__schema_ref__', r.revision_sha = '0000000000000000000000000000000000000000', r.status = 'inferred'
REMOVE r.source, r.last_run;
