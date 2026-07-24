import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('../../drizzle/0010_w4_02_agent_skill_md_versions.sql', import.meta.url),
  'utf8',
);

describe('W4-02 Agent/Skill MD persistence migration', () => {
  it('creates immutable, versioned content with a tenant-consistent repository FK', () => {
    expect(migration).toContain('CREATE TABLE agent_skill_md_versions');
    expect(migration).toMatch(
      /UNIQUE \(org_id, repo_id, ref_name, graph_node_id, version\)/u,
    );
    expect(migration).toMatch(
      /FOREIGN KEY \(org_id, repo_id\)[\s\S]*REFERENCES repositories\(org_id, id\)/u,
    );
    expect(migration).toContain(
      "CHECK (node_label IN ('Folder', 'File'))",
    );
    expect(migration).toContain('CHECK (version > 0)');
  });

  it('forces org RLS and rejects a cross-org editor attribution', () => {
    expect(migration).toContain(
      'ALTER TABLE agent_skill_md_versions ENABLE ROW LEVEL SECURITY',
    );
    expect(migration).toContain(
      'ALTER TABLE agent_skill_md_versions FORCE ROW LEVEL SECURITY',
    );
    expect(migration).toMatch(
      /CREATE POLICY org_isolation[\s\S]*current_setting\('app\.org_id', true\)/u,
    );
    expect(migration).toContain(
      'agent_skill_md_versions_same_org_editor',
    );
    expect(migration).toMatch(/editor_org <> NEW\.org_id/u);
  });

  it('makes history append-only for the runtime role', () => {
    expect(migration).toContain(
      'BEFORE UPDATE OR DELETE ON agent_skill_md_versions',
    );
    expect(migration).toContain(
      'GRANT SELECT, INSERT ON agent_skill_md_versions TO sayre_app',
    );
    expect(migration).not.toMatch(
      /GRANT[\s\S]*\bUPDATE\b[\s\S]*ON agent_skill_md_versions/u,
    );
    expect(migration).not.toMatch(
      /GRANT[\s\S]*\bDELETE\b[\s\S]*ON agent_skill_md_versions/u,
    );
  });
});
