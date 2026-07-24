import type { AuthContext } from '../../auth/context';
import type { McpToolServices } from '../toolServices';

export function getAgentSkillMdHandler(
  nodeId: string,
  ctx: AuthContext,
  services: McpToolServices,
): Promise<unknown> {
  return services.getAgentSkillMd(nodeId, ctx);
}
