import { describe, expect, it, vi } from 'vitest';
import { getRealtimeGraphDelta } from './realtimeDeltaService';
import type { AffectedNodes, GraphNode, GraphQueryService } from '../graph-query/types';

function makeFakeGraph(overrides: Partial<GraphQueryService> = {}): GraphQueryService {
  return {
    getNodesInViewport: vi.fn(async () => []),
    getStructuralEdges: vi.fn(async () => []),
    getAffectedNodes: vi.fn(async (): Promise<AffectedNodes> => ({ visible: [], removed: [] })),
    ...overrides,
  };
}

describe('getRealtimeGraphDelta', () => {
  it('happy path: uses the default fixture stub and maps visible/removed onto upserts/removals', async () => {
    const delta = await getRealtimeGraphDelta('repo-1', 'org-1', {
      changedPaths: ['/src', '/src/index.ts', '/does/not/exist.ts'],
      fullRebuild: false,
      graphVersion: 3,
    });

    expect(delta.repoId).toBe('repo-1');
    expect(delta.graphVersion).toBe(3);
    expect(delta.resyncRequired).toBe(false);
    expect(delta.upserts.map((n) => n.path)).toEqual(['/src', '/src/index.ts']);
    expect(delta.removals).toEqual(['/does/not/exist.ts']);
  });

  it('full_rebuild=true short-circuits to a resync-only delta (AC6), never calling getAffectedNodes', async () => {
    const getAffectedNodes = vi.fn(async (): Promise<AffectedNodes> => ({ visible: [], removed: [] }));
    const fakeGraph = makeFakeGraph({ getAffectedNodes });

    const delta = await getRealtimeGraphDelta(
      'repo-1',
      'org-1',
      { changedPaths: ['/ignored'], fullRebuild: true, graphVersion: 7 },
      fakeGraph,
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
    const delta = await getRealtimeGraphDelta('repo-1', 'org-1', {
      changedPaths: [],
      fullRebuild: false,
      graphVersion: 1,
    });

    expect(delta.upserts).toEqual([]);
    expect(delta.removals).toEqual([]);
    expect(delta.resyncRequired).toBe(false);
  });

  it('never surfaces a non-Folder/File node (AC4) — injected fake graph proves the mapping is total, not filtering', async () => {
    const nodes: GraphNode[] = [
      { id: 'f1', label: 'Folder', name: 'root', path: '/root', parentId: null },
      { id: 'file1', label: 'File', name: 'a.ts', path: '/root/a.ts', parentId: 'f1' },
    ];
    const fakeGraph = makeFakeGraph({
      getAffectedNodes: vi.fn(async (): Promise<AffectedNodes> => ({ visible: nodes, removed: [] })),
    });

    const delta = await getRealtimeGraphDelta(
      'repo-1',
      'org-1',
      { changedPaths: ['/root', '/root/a.ts'], fullRebuild: false, graphVersion: 1 },
      fakeGraph,
    );

    for (const node of delta.upserts) {
      expect(['Folder', 'File']).toContain(node.label);
    }
    expect(delta.upserts).toHaveLength(2);
  });

  it('threads repoId/orgId/changedPaths verbatim to getAffectedNodes', async () => {
    const getAffectedNodes = vi.fn(async (): Promise<AffectedNodes> => ({ visible: [], removed: [] }));
    const fakeGraph = makeFakeGraph({ getAffectedNodes });

    await getRealtimeGraphDelta(
      'repo-42',
      'org-super-secret',
      { changedPaths: ['/a', '/b'], fullRebuild: false, graphVersion: 5 },
      fakeGraph,
    );

    expect(getAffectedNodes).toHaveBeenCalledWith('repo-42', 'org-super-secret', ['/a', '/b']);
  });
});
