import type { AuthContext } from '../../auth/context';
import type { McpToolServices } from '../toolServices';

export function checkLivenessHandler(
  nodeId: string,
  ctx: AuthContext,
  services: McpToolServices,
): Promise<unknown> {
  return services.checkLiveness(nodeId, ctx);
}
