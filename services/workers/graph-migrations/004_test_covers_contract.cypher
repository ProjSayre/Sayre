// 004_test_covers_contract.cypher
// W2-07 — Test-node and inferred COVERS contract
//
// Layer: logical
// Targets: neo4j, neptune
//
// Purpose: migrate the legacy static/dynamic coverage fields to PRD v5's
// inferred/measured relationship status and Test coverage_status.
// Neptune-replayable: YES (portable MATCH/SET/REMOVE data statements only).

MATCH ()-[r:COVERS]->()
WHERE r.status IS NULL
SET r.status = CASE r.source WHEN 'dynamic' THEN 'measured' ELSE 'inferred' END;

MATCH ()-[r:COVERS]->()
REMOVE r.source;

MATCH (t:Test)
WHERE t.coverage_status IS NULL
SET t.coverage_status = CASE t.last_run_status
  WHEN 'pass' THEN 'pass'
  WHEN 'fail' THEN 'fail'
  ELSE 'unknown'
END;

MATCH (t:Test)
REMOVE t.last_run_status, t.last_run_at;
