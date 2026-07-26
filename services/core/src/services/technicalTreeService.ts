// Business logic lives here (service-layer rule — .claude/rules/service-layer.md).
// Plain function, no Express/req/res types — this must remain callable
// identically from a REST route today and a GraphQL resolver later (§4.10).

import { graphQueryService } from '../graph-query';
import type { AuthContext } from '../auth/context';
import type { GraphEdge, GraphNode, GraphQueryService, Viewport } from '../graph-query/types';
import { canonicalRefName } from '../refName';

export const DEFAULT_TECHNICAL_TREE_REF = 'refs/heads/main';

export interface TechnicalTree {
  authorization: 'server-filtered';
  repoId: string;
  refName: string;
  visibleNodeCount: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export async function getTechnicalTree(
  repoId: string,
  refName: string,
  viewport: Viewport,
  ctx: AuthContext,
  graph: GraphQueryService = graphQueryService,
): Promise<TechnicalTree> {
  const normalizedRepoId = repoId.trim();
  const normalizedRefName = canonicalRefName(refName);
  if (!normalizedRepoId || normalizedRefName === null) {
    throw new RangeError('A repository ID and canonical refName are required.');
  }
  const nodes = await graph.getNodesInViewport(
    normalizedRepoId,
    normalizedRefName,
    viewport,
    ctx,
  );
  const edges = await graph.getStructuralEdges(
    normalizedRepoId,
    normalizedRefName,
    nodes.map((node) => node.id),
    ctx,
  );
  return {
    authorization: 'server-filtered',
    repoId: normalizedRepoId,
    refName: normalizedRefName,
    visibleNodeCount: nodes.length,
    nodes,
    edges,
  };
}
