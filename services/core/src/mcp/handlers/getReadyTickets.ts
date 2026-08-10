import type { AuthContext } from '../../auth/context';
import type { McpToolServices } from '../toolServices';

export function getReadyTicketsHandler(
  ctx: AuthContext,
  services: McpToolServices,
): Promise<unknown> {
  return services.getReadyTickets(ctx);
}
