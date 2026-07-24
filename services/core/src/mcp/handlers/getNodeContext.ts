import type { AuthContext } from '../../auth/context';
import type { McpToolServices } from '../toolServices';

export function getNodeContextHandler(
  nodeId: string,
  ctx: AuthContext,
  services: McpToolServices,
): Promise<unknown> {
  return services.getNodeContext(nodeId, ctx);
}
