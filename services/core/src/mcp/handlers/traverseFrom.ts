import type { AuthContext } from '../../auth/context';
import type { McpToolServices } from '../toolServices';

export function traverseFromHandler(
  nodeId: string,
  intent: string,
  ctx: AuthContext,
  services: McpToolServices,
): Promise<unknown> {
  return services.traverseFrom(nodeId, intent, ctx);
}
