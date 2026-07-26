import type { AuthContext } from '../../auth/context';
import type { McpToolServices } from '../toolServices';

export function getRecentChangesHandler(
  nodeId: string,
  ctx: AuthContext,
  services: McpToolServices,
): Promise<unknown> {
  return services.getRecentChanges(nodeId, ctx);
}
