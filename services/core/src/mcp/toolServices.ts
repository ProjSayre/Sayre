import type { AuthContext } from '../auth/context';
import { getAgentSkillMd } from '../services/agentSkillMdService';
import { getCoveringTests } from '../services/coverageContextService';
import { getNodeLiveness } from '../services/livenessService';
import { getNodeOverlay } from '../services/nodeOverlayService';
import {
  resolveAnchorNodes,
  traverseFrom,
} from '../services/retrievalContextService';
import { getStyleRules } from '../services/styleRulesService';

export interface McpToolServices {
  findRelevantNodes(query: string, ctx: AuthContext): Promise<unknown>;
  traverseFrom(
    nodeId: string,
    intent: string,
    ctx: AuthContext,
  ): Promise<unknown>;
  getNodeContext(nodeId: string, ctx: AuthContext): Promise<unknown>;
  getAgentSkillMd(nodeId: string, ctx: AuthContext): Promise<unknown>;
  getStyleRules(nodeId: string, ctx: AuthContext): Promise<unknown>;
  getCoveringTests(nodeId: string, ctx: AuthContext): Promise<unknown>;
  getFeatureCluster(nodeId: string, ctx: AuthContext): Promise<unknown>;
  getRecentChanges(nodeId: string, ctx: AuthContext): Promise<unknown>;
  checkLiveness(nodeId: string, ctx: AuthContext): Promise<unknown>;
}

export const mcpToolServices: McpToolServices = {
  findRelevantNodes: resolveAnchorNodes,
  traverseFrom,
  getNodeContext: getNodeOverlay,
  getAgentSkillMd,
  getStyleRules,
  getCoveringTests,
  async getFeatureCluster(nodeId, ctx) {
    const overlay = await getNodeOverlay(nodeId, ctx);
    return overlay
      ? {
          node: overlay.node,
          featureClusters: overlay.specificFeatures,
        }
      : null;
  },
  async getRecentChanges(nodeId, ctx) {
    const overlay = await getNodeOverlay(nodeId, ctx);
    return overlay
      ? {
          node: overlay.node,
          recentChanges: overlay.recentChanges,
        }
      : null;
  },
  checkLiveness: getNodeLiveness,
};
