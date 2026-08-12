import { describe, expect, it, vi } from 'vitest';
import type { GraphWriteExecutor } from '../../graph-write/neo4j';
import {
  APPLY_OWNERSHIP_CYPHER,
  Neo4jOwnershipGraphStore,
} from './graphOwnershipStore';

const edit = {
  path: 'src/a.ts',
  commitSha: 'commit-1',
  commitMessage: 'Ship it',
  editedAt: '2026-07-22T12:00:00Z',
  author: { name: 'Ada', email: 'ada@example.test', login: 'ada' },
  pullRequest: {
    number: 17,
    title: 'Ship it',
    url: 'https://example.test/pr/17',
    mergedAt: '2026-07-22T12:00:00Z',
  },
};

describe('Neo4jOwnershipGraphStore', () => {
  // @spec AC-4 EC-7
  it('returns matchedPaths alongside updatedFiles, reflecting the Cypher collect(DISTINCT file.path)', async () => {
    const run = vi.fn(async () => ({
      records: [
        {
          get: (key: string) =>
            key === 'updated_files' ? 1 : key === 'matched_paths' ? ['src/a.ts'] : null,
        },
      ],
    }));
    const executor: GraphWriteExecutor = { run, close: vi.fn(async () => undefined) };
    const store = new Neo4jOwnershipGraphStore(executor);

    await expect(
      store.apply({
        orgId: 'org-server-derived',
        provider: 'github',
        repositoryId: 'repo-server-derived',
        refName: 'refs/heads/main',
        edits: [edit],
      }),
    ).resolves.toEqual({ updatedFiles: 1, matchedPaths: ['src/a.ts'] });

    expect(APPLY_OWNERSHIP_CYPHER).toMatch(
      /RETURN count\(DISTINCT file\) AS updated_files, collect\(DISTINCT file\.path\) AS matched_paths/,
    );
  });

  it('writes tenant/repository/ref-scoped Person, Commit and File metadata', async () => {
    // W3-04 gapfill (GAP-1b): adapted to the always-present matchedPaths field —
    // Neo4jOwnershipGraphStore.apply now returns matchedPaths alongside updatedFiles
    // (see graphOwnershipStore.ts's OwnershipApplyResult), so this mock and its strict
    // toEqual must account for it too, per spec.md's Modified-files table.
    const run = vi.fn(async () => ({
      records: [
        {
          get: (key: string) =>
            key === 'updated_files' ? 1 : key === 'matched_paths' ? ['src/a.ts'] : null,
        },
      ],
    }));
    const executor: GraphWriteExecutor = { run, close: vi.fn(async () => undefined) };
    const store = new Neo4jOwnershipGraphStore(executor);

    await expect(store.apply({
      orgId: 'org-server-derived',
      provider: 'github',
      repositoryId: 'repo-server-derived',
      refName: 'refs/heads/main',
      edits: [edit],
    })).resolves.toEqual({ updatedFiles: 1, matchedPaths: ['src/a.ts'] });

    expect(run).toHaveBeenCalledWith(
      'org-server-derived',
      APPLY_OWNERSHIP_CYPHER,
      expect.objectContaining({
        org_id: 'org-server-derived',
        provider: 'github',
        repo_id: 'repo-server-derived',
        ref_name: 'refs/heads/main',
        edits: [expect.objectContaining({
          path: 'src/a.ts',
          author_login: 'ada',
          pr_number: 17,
        })],
      }),
      'updated_files',
    );
    expect(APPLY_OWNERSHIP_CYPHER).toContain('MATCH (file:File');
    expect(APPLY_OWNERSHIP_CYPHER).toContain('MERGE (person:Person');
    expect(APPLY_OWNERSHIP_CYPHER).toContain('[authored:AUTHORED]');
    expect(APPLY_OWNERSHIP_CYPHER).toContain('[modified:MODIFIED]');
    expect(APPLY_OWNERSHIP_CYPHER).toContain('[owns:OWNS]');
    expect(APPLY_OWNERSHIP_CYPHER).toContain('person.provider_login');
    expect(APPLY_OWNERSHIP_CYPHER).not.toMatch(/\bCREATE\b/);
  });

  it('does not invent a Person when an edit carries no identity', async () => {
    const executor: GraphWriteExecutor = {
      run: vi.fn(),
      close: vi.fn(async () => undefined),
    };
    const store = new Neo4jOwnershipGraphStore(executor);
    const anonymous = { ...edit, author: { name: null, email: null, login: null } };

    await expect(store.apply({
      orgId: 'org',
      provider: 'fakehub',
      repositoryId: 'repo',
      refName: 'refs/heads/main',
      edits: [anonymous],
    })).resolves.toEqual({ updatedFiles: 0, matchedPaths: [] });
    expect(executor.run).not.toHaveBeenCalled();
  });
});
