// W3-04 gapfill (GAP-1, AC-2). Static, no-infra pin between the Node ownership writer's
// File MATCH key and the Python ingestion writer's File node key, so a rename on either
// side is caught without needing a live Neo4j. The real cross-service *behavioral* proof
// (seeding File nodes with the Python writer's own query text, then applying the Node
// write against a real Neo4j) lives in ownershipGraph.integration.test.ts.
//
// Each test below asserts the Python side (already correct today) AND the Node side
// (OWNERSHIP_FILE_MATCH_KEYS, not yet exported) together, so the test genuinely fails
// today on the Node gap rather than passing vacuously on the already-correct half.
//
// Broker-free: reads source files as text only.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const GRAPH_PY_PATH = resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  'workers',
  'sayre_workers',
  'ingestion',
  'graph.py',
);

function pythonFileQuery(): string {
  const source = readFileSync(GRAPH_PY_PATH, 'utf8');
  const match = /"File":\s*"""([\s\S]*?)"""/.exec(source);
  if (!match) {
    throw new Error('Could not locate the File node query in ingestion/graph.py');
  }
  return match[1];
}

describe('cross-service File node key (GAP-1, AC-2)', () => {
  // @spec AC-2
  it(
    "the Node writer's OWNERSHIP_FILE_MATCH_KEYS equals ['org_id','repo_id','ref_name','path'], " +
      'and the Python ingestion writer MERGEs File on {org_id, uid} and SETs every one of those properties',
    async () => {
      const query = pythonFileQuery();
      expect(query).toMatch(/MERGE\s*\(node:File\s*\{org_id:\s*\$org_id,\s*uid:\s*item\.uid\}\)/);
      expect(query).toMatch(/node\.repo_id\s*=\s*\$repo_id/);
      expect(query).toMatch(/node\.ref_name\s*=\s*\$ref_name/);
      expect(query).toMatch(/node\.path\s*=\s*item\.path/);

      const { OWNERSHIP_FILE_MATCH_KEYS } = await import('../graphOwnershipStore');
      expect(OWNERSHIP_FILE_MATCH_KEYS).toEqual(['org_id', 'repo_id', 'ref_name', 'path']);
    },
  );

  // @spec AC-2
  it("APPLY_OWNERSHIP_CYPHER's File MATCH clause uses exactly OWNERSHIP_FILE_MATCH_KEYS's property names", async () => {
    const { APPLY_OWNERSHIP_CYPHER, OWNERSHIP_FILE_MATCH_KEYS } = await import(
      '../graphOwnershipStore'
    );
    const matchClause = /MATCH\s*\(file:File\s*\{([\s\S]*?)\}\)/.exec(APPLY_OWNERSHIP_CYPHER);
    expect(matchClause, 'APPLY_OWNERSHIP_CYPHER must contain a MATCH (file:File {...}) clause').not
      .toBeNull();
    const propertyNames = [...matchClause![1].matchAll(/(\w+):/g)].map((m) => m[1]);
    expect(propertyNames.sort()).toEqual([...OWNERSHIP_FILE_MATCH_KEYS].sort());
  });
});
