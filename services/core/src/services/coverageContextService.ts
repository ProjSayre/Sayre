import type { AuthContext } from '../auth/context';
import { graphQueryService } from '../graph-query';
import type {
  CoveringTestsGraphQueryService,
  CoveringTestsSnapshot,
} from '../graph-query/types';

/** Shared service-layer read used by the MCP adapter. */
export async function getCoveringTests(
  nodeId: string,
  ctx: AuthContext,
  graph: CoveringTestsGraphQueryService = graphQueryService,
): Promise<CoveringTestsSnapshot | null> {
  const requestedNodeId = nodeId.trim();
  if (
    requestedNodeId.length === 0 ||
    requestedNodeId.length > 512 ||
    requestedNodeId !== nodeId
  ) {
    return null;
  }
  return graph.getCoveringTests(requestedNodeId, ctx);
}
