import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../auth/context';
import type {
  RetrievalGraphNode,
  RetrievalGraphQueryService,
  RetrievalTraversal,
} from '../graph-query/types';
import {
  RETRIEVAL_ANCHOR_LIMIT,
  RETRIEVAL_MAX_HOPS,
  RETRIEVAL_NODE_LIMIT,
  RetrievalContextInputError,
  resolveAnchorNodeById,
  resolveAnchorNodes,
  traverseFrom,
} from './retrievalContextService';

const AUTH: AuthContext = {
  subjectType: 'user',
  userId: 'user-1',
  orgId: '11111111-1111-4111-8111-111111111111',
  roles: ['member'],
};

const NODE: RetrievalGraphNode = {
  id: 'node-1',
  label: 'File',
  name: 'authenticate.ts',
  path: '/src/auth/authenticate.ts',
  repositoryId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  refName: 'refs/heads/main',
  revisionSha: 'a'.repeat(40),
  distance: 0,
};

function fakeGraph(
  anchors: RetrievalGraphNode[] = [NODE],
  traversal: RetrievalTraversal | null = { anchor: NODE, nodes: [NODE] },
): RetrievalGraphQueryService & {
  resolveRetrievalAnchors: ReturnType<typeof vi.fn>;
  traverseRetrievalContext: ReturnType<typeof vi.fn>;
} {
  return {
    resolveRetrievalAnchors: vi.fn(async () => anchors),
    traverseRetrievalContext: vi.fn(async () => traversal),
  };
}

describe('retrieval context service functions', () => {
  it('normalizes and bounds public anchor resolution with the complete auth context', async () => {
    const graph = fakeGraph();

    await expect(
      resolveAnchorNodes('  AUTH auth Middleware!!! ', AUTH, graph),
    ).resolves.toEqual([NODE]);
    expect(graph.resolveRetrievalAnchors).toHaveBeenCalledWith(
      ['auth', 'middleware'],
      null,
      RETRIEVAL_ANCHOR_LIMIT,
      AUTH,
    );
  });

  it('resolves an exact node id without turning it into a search term', async () => {
    const graph = fakeGraph();

    await expect(resolveAnchorNodeById(' node-1 ', AUTH, graph)).resolves.toEqual(NODE);
    expect(graph.resolveRetrievalAnchors).toHaveBeenCalledWith([], 'node-1', 1, AUTH);
  });

  it('exposes W4-06-compatible traverseFrom(nodeId, intent, auth) with fixed bounds', async () => {
    const graph = fakeGraph();

    await expect(
      traverseFrom('node-1', 'follow imports for login', AUTH, graph),
    ).resolves.toEqual({ anchor: NODE, nodes: [NODE] });
    expect(graph.traverseRetrievalContext).toHaveBeenCalledWith(
      'node-1',
      ['follow', 'imports', 'for', 'login'],
      RETRIEVAL_MAX_HOPS,
      RETRIEVAL_NODE_LIMIT,
      AUTH,
    );
  });

  it.each(['', '   ', 'bad\0query'])(
    'rejects malformed query %j before the graph boundary',
    async (query) => {
      const graph = fakeGraph();

      await expect(resolveAnchorNodes(query, AUTH, graph)).rejects.toBeInstanceOf(
        RetrievalContextInputError,
      );
      expect(graph.resolveRetrievalAnchors).not.toHaveBeenCalled();
    },
  );

  it('caps unique normalized search terms at twelve', async () => {
    const graph = fakeGraph();
    const query = Array.from({ length: 20 }, (_, index) => `term${index}`).join(' ');

    await resolveAnchorNodes(query, AUTH, graph);

    const terms = graph.resolveRetrievalAnchors.mock.calls[0]?.[0] as string[];
    expect(terms).toHaveLength(12);
    expect(new Set(terms).size).toBe(12);
  });
});
