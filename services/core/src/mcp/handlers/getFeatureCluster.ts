import type { AuthContext } from '../../auth/context';
import type { McpToolServices } from '../toolServices';

export function getFeatureClusterHandler(
  nodeId: string,
  ctx: AuthContext,
  services: McpToolServices,
): Promise<unknown> {
  return services.getFeatureCluster(nodeId, ctx);
}
