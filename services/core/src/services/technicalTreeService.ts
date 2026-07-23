// Business logic lives here (service-layer rule — .claude/rules/service-layer.md).
// Plain function, no Express/req/res types — this must remain callable
// identically from a REST route today and a GraphQL resolver later (§4.10).

import { graphQueryService } from '../graph-query';
import type { AuthContext } from '../auth/context';
import type { GraphEdge, GraphNode, GraphQueryService, Viewport } from '../graph-query/types';

export interface TechnicalTree {
  authorization: 'server-filtered';
  visibleNodeCount: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export async function getTechnicalTree(
  repoId: string,
  viewport: Viewport,
  ctx: AuthContext,
  graph: GraphQueryService = graphQueryService,
): Promise<TechnicalTree> {
  const nodes = await graph.getNodesInViewport(repoId, viewport, ctx);
  const edges = await graph.getStructuralEdges(nodes.map((node) => node.id), ctx);
  return {
    authorization: 'server-filtered',
    visibleNodeCount: nodes.length,
    nodes,
    edges,
  };
}
