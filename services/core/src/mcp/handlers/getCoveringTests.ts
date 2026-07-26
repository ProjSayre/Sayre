import type { AuthContext } from '../../auth/context';
import type { McpToolServices } from '../toolServices';

export function getCoveringTestsHandler(
  nodeId: string,
  ctx: AuthContext,
  services: McpToolServices,
): Promise<unknown> {
  return services.getCoveringTests(nodeId, ctx);
}
