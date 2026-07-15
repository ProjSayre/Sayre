import { describe, expect, it, vi } from 'vitest';
import { getTechnicalTree } from './technicalTreeService';
import type { GraphEdge, GraphNode, GraphQueryService, Viewport } from '../graph-query/types';

const VIEWPORT: Viewport = { x: 0, y: 0, width: 100, height: 100, zoom: 1 };

function makeFakeGraph(overrides: Partial<GraphQueryService> = {}): GraphQueryService {
  return {
    getNodesInViewport: vi.fn(async () => []),
    getStructuralEdges: vi.fn(async () => []),
    ...overrides,
  };
}

describe('getTechnicalTree', () => {
  it('happy path: uses the default fixture stub and returns only Folder/File nodes with non-dangling CONTAINS edges', async () => {
    const tree = await getTechnicalTree('repo-1', 'org-1', VIEWPORT);

    expect(tree.nodes.length).toBeGreaterThan(0);
    const ids = new Set(tree.nodes.map((n) => n.id));
    for (const node of tree.nodes) {
      expect(['Folder', 'File']).toContain(node.label);
    }
    for (const edge of tree.edges) {
      expect(edge.type).toBe('CONTAINS');
      expect(ids.has(edge.source)).toBe(true);
      expect(ids.has(edge.target)).toBe(true);
    }
  });

  it('empty graph: returns { nodes: [], edges: [] } and calls getStructuralEdges with []', async () => {
    const getStructuralEdges = vi.fn(async (): Promise<GraphEdge[]> => []);
    const fakeGraph = makeFakeGraph({
      getNodesInViewport: vi.fn(async (): Promise<GraphNode[]> => []),
      getStructuralEdges,
    });

    const tree = await getTechnicalTree('repo-1', 'org-1', VIEWPORT, fakeGraph);

    expect(tree).toEqual({ nodes: [], edges: [] });
    expect(getStructuralEdges).toHaveBeenCalledWith('repo-1', 'org-1', []);
  });

  it('injected fake: getTechnicalTree composes getNodesInViewport then getStructuralEdges with the returned nodes', async () => {
    const nodes: GraphNode[] = [
      { id: 'f1', label: 'Folder', name: 'root', path: '/root', parentId: null },
    ];
    const edges: GraphEdge[] = [];
    const getNodesInViewport = vi.fn(async () => nodes);
    const getStructuralEdges = vi.fn(async () => edges);
    const fakeGraph = makeFakeGraph({ getNodesInViewport, getStructuralEdges });

    const tree = await getTechnicalTree('repo-9', 'org-9', VIEWPORT, fakeGraph);

    expect(tree).toEqual({ nodes, edges });
    expect(getStructuralEdges).toHaveBeenCalledWith('repo-9', 'org-9', nodes);
  });

  it('threads orgId verbatim to both graph-query methods', async () => {
    const getNodesInViewport = vi.fn(async () => []);
    const getStructuralEdges = vi.fn(async () => []);
    const fakeGraph = makeFakeGraph({ getNodesInViewport, getStructuralEdges });

    await getTechnicalTree('repo-1', 'org-super-secret', VIEWPORT, fakeGraph);

    expect(getNodesInViewport).toHaveBeenCalledWith('repo-1', 'org-super-secret', VIEWPORT);
    expect(getStructuralEdges).toHaveBeenCalledWith('repo-1', 'org-super-secret', []);
  });

  it('resolver-shaped call: a GraphQL-resolver-like closure calls getTechnicalTree unchanged (AC3)', async () => {
    // No `graphql` dependency added (non-goal) — this proves the signature is
    // reusable by a resolver without a running GraphQL server.
    type ResolverArgs = { repoId: string; viewport: Viewport };
    type ResolverContext = { orgId: string };

    const resolver = (_parent: unknown, args: ResolverArgs, ctx: ResolverContext) =>
      getTechnicalTree(args.repoId, ctx.orgId, args.viewport);

    const tree = await resolver({}, { repoId: 'repo-1', viewport: VIEWPORT }, { orgId: 'org-1' });

    expect(tree.nodes.length).toBeGreaterThan(0);
  });
});
