import type { AuthContext } from '../../auth/context';
import type { McpToolServices } from '../toolServices';

export function getStyleRulesHandler(
  nodeId: string,
  ctx: AuthContext,
  services: McpToolServices,
): Promise<unknown> {
  return services.getStyleRules(nodeId, ctx);
}
