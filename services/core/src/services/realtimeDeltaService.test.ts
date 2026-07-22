import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../auth/context';
import { getRealtimeGraphDelta } from './realtimeDeltaService';
import type { AffectedNodes, GraphNode, GraphQueryService } from '../graph-query/types';

const AUTH_CONTEXT: AuthContext = {
  subjectType: 'user',
  userId: 'user-1',
  orgId: 'org-1',
  roles: ['member'],
};

function makeFakeGraph(overrides: Partial<GraphQueryService> = {}): GraphQueryService {
  return {
    getNodesInViewport: vi.fn(async () => []),
    getStructuralEdges: vi.fn(async () => []),
    getAffectedNodes: vi.fn(async (): Promise<AffectedNodes> => ({ visible: [], removed: [] })),
    ...overrides,
  };
}

describe('getRealtimeGraphDelta', () => {
  it('maps already-filtered visible/removed results onto the wire contract', async () => {
    const visible: GraphNode[] = [
      { id: 'folder', label: 'Folder', name: 'src', path: '/src', parentId: null },
      { id: 'file', label: 'File', name: 'index.ts', path: '/src/index.ts', parentId: 'folder' },
    ];
    const graph = makeFakeGraph({
      getAffectedNodes: vi.fn(async () => ({ visible, removed: ['deleted-file'] })),
    });

    const delta = await getRealtimeGraphDelta(
      'repo-1',
      { changedPaths: ['/src', '/src/index.ts'], fullRebuild: false, graphVersion: 3 },
      AUTH_CONTEXT,
      graph,
    );

    expect(delta.upserts.map((node) => node.path)).toEqual(['/src', '/src/index.ts']);
    expect(delta.removals).toEqual(['deleted-file']);
    expect(delta.resyncRequired).toBe(false);
  });

  it('full_rebuild=true short-circuits to a resync-only delta', async () => {
    const getAffectedNodes = vi.fn(async (): Promise<AffectedNodes> => ({ visible: [], removed: [] }));
    const graph = makeFakeGraph({ getAffectedNodes });

    const delta = await getRealtimeGraphDelta(
      'repo-1',
      { changedPaths: ['/ignored'], fullRebuild: true, graphVersion: 7 },
      AUTH_CONTEXT,
      graph,
    );

    expect(delta).toEqual({
      repoId: 'repo-1',
      graphVersion: 7,
      upserts: [],
      removals: [],
      resyncRequired: true,
    });
    expect(getAffectedNodes).not.toHaveBeenCalled();
  });

  it('changed_paths=[] yields an empty, non-erroring delta', async () => {
    const graph = makeFakeGraph();
    const delta = await getRealtimeGraphDelta(
      'repo-1',
      { changedPaths: [], fullRebuild: false, graphVersion: 1 },
      AUTH_CONTEXT,
      graph,
    );

    expect(delta.upserts).toEqual([]);
    expect(delta.removals).toEqual([]);
    expect(delta.resyncRequired).toBe(false);
  });

  it('threads repoId, paths, and the complete auth context to getAffectedNodes', async () => {
    const getAffectedNodes = vi.fn(async (): Promise<AffectedNodes> => ({ visible: [], removed: [] }));
    const graph = makeFakeGraph({ getAffectedNodes });

    await getRealtimeGraphDelta(
      'repo-42',
      { changedPaths: ['/a', '/b'], fullRebuild: false, graphVersion: 5 },
      AUTH_CONTEXT,
      graph,
    );

    expect(getAffectedNodes).toHaveBeenCalledWith('repo-42', ['/a', '/b'], AUTH_CONTEXT);
  });
});
