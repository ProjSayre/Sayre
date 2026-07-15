// 001_init_node_labels.cypher
// W0-02 — Graph DB schema & openCypher migrations
//
// Purpose: declare all 13 node labels in the graph schema (packages/graph-schema/schema.md
// is the canonical reference this file implements). A graph DB has no DDL to "declare a
// label" without either a node bearing it or a constraint referencing it, so this file
// MERGEs exactly one reserved schema-anchor node per label under a reserved sentinel
// org_id. This satisfies:
//   - "MERGE, not CREATE" (idempotent — re-running matches the existing anchor, no
//     duplicates: MERGE keys on the full {uid, org_id} map).
//   - "every node label tagged with org_id from day one" (org_id is present on every
//     anchor, same as every real tenant node will carry).
//   - Neptune replayability — pure MERGE/MATCH statements replay unmodified against
//     Amazon Neptune's openCypher implementation (unlike 003, which is Neo4j-only DDL).
//
// Reserved schema-anchor org_id — the all-zero UUID is never issued to a real tenant
// (Postgres gen_random_uuid() never returns it). All tenant queries filter by a real
// org_id server-side (.claude/rules/security-multitenancy.md), so these anchors are
// invisible to every canvas/RBAC/RAG read. uid '__schema_anchor__' is likewise reserved
// and never assigned to a real node.
//
// Neptune-replayable: YES (pure MERGE, no Neo4j-proprietary functions/procedures).
//
// Node labels (13, closed set — see .claude/rules/graph-schema.md):
// Project, Repo, Folder, File, Function, Class, Module, Person, Commit, Feature,
// Ticket, EnvStep, Test.

MERGE (:Project {uid: '__schema_anchor__', org_id: '00000000-0000-0000-0000-000000000000'});
MERGE (:Repo    {uid: '__schema_anchor__', org_id: '00000000-0000-0000-0000-000000000000'});
MERGE (:Folder  {uid: '__schema_anchor__', org_id: '00000000-0000-0000-0000-000000000000'});
MERGE (:File    {uid: '__schema_anchor__', org_id: '00000000-0000-0000-0000-000000000000'});
MERGE (:Function {uid: '__schema_anchor__', org_id: '00000000-0000-0000-0000-000000000000'});
MERGE (:Class   {uid: '__schema_anchor__', org_id: '00000000-0000-0000-0000-000000000000'});
MERGE (:Module  {uid: '__schema_anchor__', org_id: '00000000-0000-0000-0000-000000000000'});
MERGE (:Person  {uid: '__schema_anchor__', org_id: '00000000-0000-0000-0000-000000000000'});
MERGE (:Commit  {uid: '__schema_anchor__', org_id: '00000000-0000-0000-0000-000000000000'});
MERGE (:Feature {uid: '__schema_anchor__', org_id: '00000000-0000-0000-0000-000000000000'});
MERGE (:Ticket  {uid: '__schema_anchor__', org_id: '00000000-0000-0000-0000-000000000000'});
MERGE (:EnvStep {uid: '__schema_anchor__', org_id: '00000000-0000-0000-0000-000000000000'});
MERGE (:Test    {uid: '__schema_anchor__', org_id: '00000000-0000-0000-0000-000000000000'});
