import { describe, expect, it } from 'vitest';
import type { AuthContext } from '../auth/context';
import type { NodeOverlay } from './nodeOverlayService';
import { getNodeLiveness, isTestPath } from './livenessService';

const ctx = { orgId: 'org-1' } as unknown as AuthContext;

function importer(path: string, direction: 'inbound' | 'outbound') {
  return {
    id: `node:${path}`,
    label: 'File' as const,
    name: path.split('/').pop() ?? path,
    path,
    relationship: 'IMPORTS' as const,
    direction,
  };
}

function overlay(
  path: string,
  dependencies: NodeOverlay['dependencies'],
  recentChanges: NodeOverlay['recentChanges'] = [],
): NodeOverlay {
  return {
    authorization: 'server-filtered',
    node: {
      id: `node:${path}`,
      label: 'File',
      name: path.split('/').pop() ?? path,
      path,
      repositoryId: 'repo-1',
      refName: 'refs/heads/main',
      revisionSha: 'sha-1',
    },
    dependencies,
    recentChanges,
    specificFeatures: [],
    agentSkillMd: null,
    description: null,
    specificTickets: [],
  };
}

const loader = (value: NodeOverlay | null) => async () => value;

describe('isTestPath', () => {
  it('recognises the common test conventions', () => {
    for (const path of [
      'apps/web/app/lib/scaleGraph.test.ts',
      'apps/web/app/lib/scaleGraph.spec.tsx',
      'services/core/__tests__/thing.ts',
      'services/workers/tests/test_parsing.py',
      'services/workers/tests/parsing_test.py',
      'pkg/thing_test.go',
      'src/main/java/ThingTest.java',
    ]) {
      expect(isTestPath(path), path).toBe(true);
    }
  });

  it('does not flag production paths that merely contain the word', () => {
    for (const path of [
      'apps/web/app/lib/latest.ts',
      'services/core/src/contest/index.ts',
      'apps/web/app/testimonials/page.tsx',
    ]) {
      expect(isTestPath(path), path).toBe(false);
    }
  });

  it('normalises Windows separators', () => {
    expect(isTestPath('apps\\web\\__tests__\\thing.ts')).toBe(true);
  });
});

describe('getNodeLiveness', () => {
  it('returns null for a hidden or absent node', async () => {
    expect(await getNodeLiveness('missing', ctx, loader(null))).toBeNull();
  });

  it('reports production reachability when a non-test file imports it', async () => {
    const result = await getNodeLiveness(
      'node:a',
      ctx,
      loader(
        overlay('src/a.ts', [
          importer('src/b.ts', 'inbound'),
          importer('src/a.test.ts', 'inbound'),
        ]),
      ),
    );
    expect(result?.liveness).toBe('imported_by_production');
    expect(result?.inbound).toEqual({ production: 1, tests: 1 });
    expect(result?.productionImporters).toEqual(['src/b.ts']);
    expect(result?.testImporters).toEqual(['src/a.test.ts']);
  });

  it('flags the test-only twin', async () => {
    const result = await getNodeLiveness(
      'node:scaleGraph',
      ctx,
      loader(
        overlay('apps/web/app/lib/scaleGraph.ts', [
          importer('apps/web/app/lib/scaleGraph.test.ts', 'inbound'),
          importer('apps/web/app/lib/productTree.test.ts', 'inbound'),
        ]),
      ),
    );
    expect(result?.liveness).toBe('imported_by_tests_only');
    expect(result?.inbound).toEqual({ production: 0, tests: 2 });
    expect(result?.productionImporters).toEqual([]);
  });

  it('ignores outbound edges when judging reachability', async () => {
    const result = await getNodeLiveness(
      'node:entry',
      ctx,
      loader(
        overlay('apps/web/app/page.tsx', [
          importer('apps/web/app/lib/thing.ts', 'outbound'),
          importer('apps/web/app/lib/other.ts', 'outbound'),
        ]),
      ),
    );
    expect(result?.liveness).toBe('no_inbound_imports');
    expect(result?.inbound).toEqual({ production: 0, tests: 0 });
  });

  it('caps the sampled importer paths but keeps the full counts', async () => {
    const dependencies = Array.from({ length: 9 }, (_, index) =>
      importer(`src/importer${index}.ts`, 'inbound'),
    );
    const result = await getNodeLiveness(
      'node:hot',
      ctx,
      loader(overlay('src/hot.ts', dependencies)),
    );
    expect(result?.inbound.production).toBe(9);
    expect(result?.productionImporters).toHaveLength(5);
  });

  it('surfaces the most recent change timestamp when present', async () => {
    const result = await getNodeLiveness(
      'node:a',
      ctx,
      loader(
        overlay('src/a.ts', [], [
          {
            commitId: 'c1',
            sha: 'abc',
            message: 'Change it',
            timestamp: '2026-07-22T00:00:00.000Z',
            authorName: null,
            authorLogin: null,
            pullRequestTitle: null,
            pullRequestUrl: null,
          },
        ]),
      ),
    );
    expect(result?.lastChangedAt).toBe('2026-07-22T00:00:00.000Z');
  });

  it('reports a null timestamp when there is no commit history', async () => {
    const result = await getNodeLiveness(
      'node:a',
      ctx,
      loader(overlay('src/a.ts', [])),
    );
    expect(result?.lastChangedAt).toBeNull();
  });
});
