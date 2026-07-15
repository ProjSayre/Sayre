// Business logic lives here (service-layer rule — .claude/rules/service-layer.md).
// Plain function, no Express/req/res types — this must remain callable
// identically from a REST route today and a GraphQL resolver later (§4.10).

import { graphQueryService } from '../graph-query';
import type { GraphEdge, GraphNode, GraphQueryService, Viewport } from '../graph-query/types';

export interface TechnicalTree {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export async function getTechnicalTree(
  repoId: string,
  orgId: string,
  viewport: Viewport,
  graph: GraphQueryService = graphQueryService,
): Promise<TechnicalTree> {
  const nodes = await graph.getNodesInViewport(repoId, orgId, viewport);
  const edges = await graph.getStructuralEdges(repoId, orgId, nodes);
  return { nodes, edges };
}
