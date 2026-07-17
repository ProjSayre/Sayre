// 002_init_edge_types.cypher
// W0-02 — Graph DB schema & openCypher migrations
//
// Purpose: declare all 13 relationship types in the graph schema by MERGEing one
// representative anchor edge per type between the reserved schema-anchor nodes created
// in 001, using the canonical directions/endpoint-labels documented in
// packages/graph-schema/schema.md. MERGE keys on the full pattern (endpoints + type +
// property map), so re-running this file matches the existing anchor edge — no
// duplicates. Where an edge type's canonical endpoints are the same label (CONNECTS_TO,
// IMPORTS, CALLS, INHERITS, REQUIRES, DEPENDS_ON), only one anchor node exists per
// label, so the anchor edge is necessarily a self-loop on that single anchor — this is
// a declaration artifact only (real tenant data will connect distinct nodes) and does
// not affect the constraint/index shape in 003.
//
// Depends on 001 having already run (anchor nodes must exist before anchor edges can
// MATCH them).
//
// Extra edge properties use plain literals (no function calls, e.g. no datetime()),
// keeping this file pure MERGE/MATCH and Neptune-replayable. `timestamp`/`last_run`
// are documented as `datetime` typed in schema.md; the anchor value below is an
// illustrative ISO-8601 string placeholder, not a type constraint (Cypher/openCypher
// have no schema-enforced property types on MERGE-created data).
//
// Neptune-replayable: YES (pure MERGE/MATCH, no Neo4j-proprietary functions/procedures).
//
// Edge types (13, closed set — see .claude/rules/graph-schema.md):
// CONTAINS, CONNECTS_TO, IMPORTS, CALLS, INHERITS, OWNS, AUTHORED, MODIFIED,
// REFERENCES, PART_OF, REQUIRES, DEPENDS_ON, COVERS.

// CONTAINS — canonical representative: Folder -> File (also Project->Repo, Folder->Folder
// in real data; see schema.md for the full direction set).
MATCH (a:Folder {uid:'__schema_anchor__', org_id:'00000000-0000-0000-0000-000000000000'}),
      (b:File   {uid:'__schema_anchor__', org_id:'00000000-0000-0000-0000-000000000000'})
MERGE (a)-[:CONTAINS {org_id:'00000000-0000-0000-0000-000000000000'}]->(b);

// CONNECTS_TO — Repo -> Repo (cross-repo, Macro View; declared only, PM-01 populates).
MATCH (a:Repo {uid:'__schema_anchor__', org_id:'00000000-0000-0000-0000-000000000000'}),
      (b:Repo {uid:'__schema_anchor__', org_id:'00000000-0000-0000-0000-000000000000'})
MERGE (a)-[:CONNECTS_TO {org_id:'00000000-0000-0000-0000-000000000000', kind:'import'}]->(b);

// IMPORTS — File -> File.
MATCH (a:File {uid:'__schema_anchor__', org_id:'00000000-0000-0000-0000-000000000000'}),
      (b:File {uid:'__schema_anchor__', org_id:'00000000-0000-0000-0000-000000000000'})
MERGE (a)-[:IMPORTS {org_id:'00000000-0000-0000-0000-000000000000'}]->(b);

// CALLS — Function -> Function.
MATCH (a:Function {uid:'__schema_anchor__', org_id:'00000000-0000-0000-0000-000000000000'}),
      (b:Function {uid:'__schema_anchor__', org_id:'00000000-0000-0000-0000-000000000000'})
MERGE (a)-[:CALLS {org_id:'00000000-0000-0000-0000-000000000000'}]->(b);

// INHERITS — Class -> Class.
MATCH (a:Class {uid:'__schema_anchor__', org_id:'00000000-0000-0000-0000-000000000000'}),
      (b:Class {uid:'__schema_anchor__', org_id:'00000000-0000-0000-0000-000000000000'})
MERGE (a)-[:INHERITS {org_id:'00000000-0000-0000-0000-000000000000'}]->(b);

// OWNS — Person -> File (primary code owner).
MATCH (a:Person {uid:'__schema_anchor__', org_id:'00000000-0000-0000-0000-000000000000'}),
      (b:File   {uid:'__schema_anchor__', org_id:'00000000-0000-0000-0000-000000000000'})
MERGE (a)-[:OWNS {org_id:'00000000-0000-0000-0000-000000000000'}]->(b);

// AUTHORED — Person -> Commit. `timestamp` on the edge itself.
MATCH (a:Person {uid:'__schema_anchor__', org_id:'00000000-0000-0000-0000-000000000000'}),
      (b:Commit {uid:'__schema_anchor__', org_id:'00000000-0000-0000-0000-000000000000'})
MERGE (a)-[:AUTHORED {org_id:'00000000-0000-0000-0000-000000000000', timestamp:'1970-01-01T00:00:00Z'}]->(b);

// MODIFIED — Commit -> File. `timestamp` on the edge itself.
MATCH (a:Commit {uid:'__schema_anchor__', org_id:'00000000-0000-0000-0000-000000000000'}),
      (b:File   {uid:'__schema_anchor__', org_id:'00000000-0000-0000-0000-000000000000'})
MERGE (a)-[:MODIFIED {org_id:'00000000-0000-0000-0000-000000000000', timestamp:'1970-01-01T00:00:00Z'}]->(b);

// REFERENCES — Ticket -> File.
MATCH (a:Ticket {uid:'__schema_anchor__', org_id:'00000000-0000-0000-0000-000000000000'}),
      (b:File   {uid:'__schema_anchor__', org_id:'00000000-0000-0000-0000-000000000000'})
MERGE (a)-[:REFERENCES {org_id:'00000000-0000-0000-0000-000000000000'}]->(b);

// PART_OF — File -> Feature (Files Included list).
MATCH (a:File    {uid:'__schema_anchor__', org_id:'00000000-0000-0000-0000-000000000000'}),
      (b:Feature {uid:'__schema_anchor__', org_id:'00000000-0000-0000-0000-000000000000'})
MERGE (a)-[:PART_OF {org_id:'00000000-0000-0000-0000-000000000000'}]->(b);

// REQUIRES — EnvStep -> EnvStep (prerequisite ordering).
MATCH (a:EnvStep {uid:'__schema_anchor__', org_id:'00000000-0000-0000-0000-000000000000'}),
      (b:EnvStep {uid:'__schema_anchor__', org_id:'00000000-0000-0000-0000-000000000000'})
MERGE (a)-[:REQUIRES {org_id:'00000000-0000-0000-0000-000000000000'}]->(b);

// DEPENDS_ON — Module -> Module.
MATCH (a:Module {uid:'__schema_anchor__', org_id:'00000000-0000-0000-0000-000000000000'}),
      (b:Module {uid:'__schema_anchor__', org_id:'00000000-0000-0000-0000-000000000000'})
MERGE (a)-[:DEPENDS_ON {org_id:'00000000-0000-0000-0000-000000000000'}]->(b);

// COVERS — Test -> File. `source`/`last_run` back the coverage-freshness computation
// (last_run intentionally omitted here — nullable for source='static', and Cypher
// property maps cannot carry an explicit null; absence reads as null).
MATCH (a:Test {uid:'__schema_anchor__', org_id:'00000000-0000-0000-0000-000000000000'}),
      (b:File {uid:'__schema_anchor__', org_id:'00000000-0000-0000-0000-000000000000'})
MERGE (a)-[:COVERS {org_id:'00000000-0000-0000-0000-000000000000', source:'static'}]->(b);
