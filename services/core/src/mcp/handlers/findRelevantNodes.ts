import type { AuthContext } from '../../auth/context';
import type { McpToolServices } from '../toolServices';

export function findRelevantNodesHandler(
  query: string,
  ctx: AuthContext,
  services: McpToolServices,
): Promise<unknown> {
  return services.findRelevantNodes(query, ctx);
}
