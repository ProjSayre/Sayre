import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../auth/context';
import { getTechnicalTree } from './technicalTreeService';
import type { GraphEdge, GraphNode, GraphQueryService, Viewport } from '../graph-query/types';

const VIEWPORT: Viewport = { x: 0, y: 0, width: 100, height: 100, zoom: 1 };
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
    getAffectedNodes: vi.fn(async () => ({ visible: [], removed: [] })),
    getFeatureClusters: vi.fn(async () => []),
    ...overrides,
  };
}

describe('getTechnicalTree', () => {
  it('returns only Folder/File nodes with non-dangling structural edges', async () => {
    const nodes: GraphNode[] = [
      { id: 'folder', label: 'Folder', name: 'src', path: '/src', parentId: null },
      { id: 'file', label: 'File', name: 'index.ts', path: '/src/index.ts', parentId: 'folder' },
    ];
    const graph = makeFakeGraph({
      getNodesInViewport: vi.fn(async () => nodes),
      getStructuralEdges: vi.fn(async () => [
        { id: 'CONTAINS:folder:file', type: 'CONTAINS', source: 'folder', target: 'file' },
      ]),
    });

    const tree = await getTechnicalTree('repo-1', VIEWPORT, AUTH_CONTEXT, graph);

    const ids = new Set(tree.nodes.map((node) => node.id));
    expect(tree.authorization).toBe('server-filtered');
    expect(tree.visibleNodeCount).toBe(nodes.length);
    expect(tree.nodes).toEqual(nodes);
    for (const edge of tree.edges) {
      expect(['CONTAINS', 'IMPORTS']).toContain(edge.type);
      expect(ids.has(edge.source)).toBe(true);
      expect(ids.has(edge.target)).toBe(true);
    }
  });

  it('empty graph returns empty arrays and asks for no edges', async () => {
    const getStructuralEdges = vi.fn(async (): Promise<GraphEdge[]> => []);
    const graph = makeFakeGraph({ getStructuralEdges });

    const tree = await getTechnicalTree('repo-1', VIEWPORT, AUTH_CONTEXT, graph);

    expect(tree).toEqual({
      authorization: 'server-filtered',
      visibleNodeCount: 0,
      nodes: [],
      edges: [],
    });
    expect(getStructuralEdges).toHaveBeenCalledWith([], AUTH_CONTEXT);
  });

  it('composes the two context-taking graph-query methods', async () => {
    const nodes: GraphNode[] = [
      { id: 'f1', label: 'Folder', name: 'root', path: '/root', parentId: null },
    ];
    const getNodesInViewport = vi.fn(async () => nodes);
    const getStructuralEdges = vi.fn(async (): Promise<GraphEdge[]> => []);
    const graph = makeFakeGraph({ getNodesInViewport, getStructuralEdges });

    await getTechnicalTree('repo-9', VIEWPORT, AUTH_CONTEXT, graph);

    expect(getNodesInViewport).toHaveBeenCalledWith('repo-9', VIEWPORT, AUTH_CONTEXT);
    expect(getStructuralEdges).toHaveBeenCalledWith(['f1'], AUTH_CONTEXT);
  });

  it('is reusable unchanged from a resolver-shaped caller', async () => {
    type ResolverArgs = { repoId: string; viewport: Viewport };
    type ResolverContext = { auth: AuthContext };
    const graph = makeFakeGraph();
    const resolver = (_parent: unknown, args: ResolverArgs, ctx: ResolverContext) =>
      getTechnicalTree(args.repoId, args.viewport, ctx.auth, graph);

    await expect(
      resolver({}, { repoId: 'repo-1', viewport: VIEWPORT }, { auth: AUTH_CONTEXT }),
    ).resolves.toEqual({
      authorization: 'server-filtered',
      visibleNodeCount: 0,
      nodes: [],
      edges: [],
    });
  });
});
