import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../auth/context';
import type {
  FeatureCluster,
  GraphQueryService,
} from '../graph-query/types';
import {
  getProductTree,
  normalizeProductTreeRef,
} from './productTreeService';

const AUTH_CONTEXT: AuthContext = {
  subjectType: 'user',
  userId: 'user-1',
  orgId: 'org-server-derived',
  roles: ['member'],
};

function graphWith(clusters: FeatureCluster[]): GraphQueryService {
  return {
    getNodesInViewport: vi.fn(async () => []),
    getStructuralEdges: vi.fn(async () => []),
    getAffectedNodes: vi.fn(async () => ({ visible: [], removed: [] })),
    getFeatureClusters: vi.fn(async () => clusters),
  };
}

function cluster(
  id: string,
  members: FeatureCluster['members'],
  overrides: Partial<FeatureCluster> = {},
): FeatureCluster {
  return {
    id,
    name: id === 'checkout' ? 'Checkout' : 'Cart',
    description: 'Feature description',
    team: 'Commerce',
    revisionSha: 'a'.repeat(40),
    members,
    ...overrides,
  };
}

const sharedMember: FeatureCluster['members'][number] = {
  id: 'shared',
  label: 'File',
  name: 'shared.ts',
  path: '/src/shared.ts',
  parentId: null,
  recentEdit: {
    fileId: 'shared',
    filePath: '/src/shared.ts',
    editedAt: '2026-07-22T12:00:00Z',
    editorName: 'Ada',
    editorLogin: 'ada',
    pullRequestTitle: 'Share checkout',
    pullRequestUrl: 'https://example.test/pull/17',
  },
};

describe('getProductTree', () => {
  it('deduplicates overlapping visible Files and keeps per-Feature metadata', async () => {
    const apiMember: FeatureCluster['members'][number] = {
      id: 'api',
      label: 'File',
      name: 'route.ts',
      path: '/src/api/route.ts',
      parentId: null,
      recentEdit: {
        ...sharedMember.recentEdit!,
        fileId: 'api',
        filePath: '/src/api/route.ts',
        editedAt: '2026-07-23T12:00:00Z',
      },
    };
    const graph = graphWith([
      cluster('checkout', [apiMember, sharedMember]),
      cluster('cart', [sharedMember], { team: null }),
    ]);

    const result = await getProductTree(' repo-1 ', 'main', AUTH_CONTEXT, graph);

    expect(result.authorization).toBe('server-filtered');
    expect(result.repoId).toBe('repo-1');
    expect(result.refName).toBe('refs/heads/main');
    expect(result.visibleNodeCount).toBe(2);
    expect(result.nodes.map(({ id }) => id)).toEqual(['api', 'shared']);
    expect(result.features).toHaveLength(2);
    expect(result.features[0]).toMatchObject({
      id: 'checkout',
      memberIds: ['api', 'shared'],
      filesIncluded: [
        { id: 'api', path: '/src/api/route.ts' },
        { id: 'shared', path: '/src/shared.ts' },
      ],
    });
    expect(result.features[0]?.recentEdits.map(({ fileId }) => fileId)).toEqual([
      'api',
      'shared',
    ]);
    expect(graph.getFeatureClusters).toHaveBeenCalledWith(
      'repo-1',
      'refs/heads/main',
      AUTH_CONTEXT,
    );
  });

  it('returns an honest empty authorized projection', async () => {
    await expect(
      getProductTree('repo-1', 'refs/heads/release', AUTH_CONTEXT, graphWith([])),
    ).resolves.toEqual({
      authorization: 'server-filtered',
      repoId: 'repo-1',
      refName: 'refs/heads/release',
      visibleNodeCount: 0,
      nodes: [],
      features: [],
    });
  });

  it('preserves missing optional metadata without synthesizing it', async () => {
    const member = { ...sharedMember, recentEdit: null };
    const result = await getProductTree(
      'repo-1',
      'main',
      AUTH_CONTEXT,
      graphWith([cluster('checkout', [member], { description: null, team: null })]),
    );

    expect(result.features[0]).toMatchObject({
      description: null,
      team: null,
      recentEdits: [],
    });
  });

  it('fails closed if one stable File identity resolves to conflicting resources', async () => {
    const conflicting = {
      ...sharedMember,
      name: 'secret.ts',
      path: '/private/secret.ts',
    };

    await expect(
      getProductTree(
        'repo-1',
        'main',
        AUTH_CONTEXT,
        graphWith([
          cluster('checkout', [sharedMember]),
          cluster('cart', [conflicting]),
        ]),
      ),
    ).rejects.toThrow('inconsistent File identity');
  });
});

describe('normalizeProductTreeRef', () => {
  it('accepts canonical refs and normalizes branch names', () => {
    expect(normalizeProductTreeRef('refs/heads/release')).toBe('refs/heads/release');
    expect(normalizeProductTreeRef(' release ')).toBe('refs/heads/release');
  });

  it('rejects blank and control-character refs', () => {
    expect(() => normalizeProductTreeRef(' ')).toThrow(RangeError);
    expect(() => normalizeProductTreeRef('main\u0000other')).toThrow(RangeError);
  });
});
