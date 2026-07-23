import type { AuthContext } from '../auth/context';
import { graphQueryService } from '../graph-query';
import type {
  ResolvedStyleRules,
  StyleRuleGraphQueryService,
} from '../graph-query/types';

/**
 * Shared service-layer entry point for the canvas and W4-06 get_style_rules MCP
 * handler. Callers supply the complete server-derived auth context; inheritance and
 * RBAC remain inside the Graph Query Service.
 */
export async function getStyleRules(
  nodeId: string,
  ctx: AuthContext,
  graph: StyleRuleGraphQueryService = graphQueryService,
): Promise<ResolvedStyleRules | null> {
  const requestedNodeId = nodeId.trim();
  if (
    requestedNodeId.length === 0 ||
    requestedNodeId.length > 512 ||
    requestedNodeId !== nodeId
  ) {
    return null;
  }
  return graph.resolveStyleRules(requestedNodeId, ctx);
}
