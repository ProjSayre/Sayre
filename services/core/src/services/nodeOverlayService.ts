import type { AuthContext } from '../auth/context';
import { agentSkillMdStore, type AgentSkillMdStore } from '../db/agentSkillMdStore';
import { graphQueryService } from '../graph-query';
import type {
  NodeOverlayGraphQueryService,
  NodeOverlayGraphSnapshot,
} from '../graph-query/types';
import {
  readAgentSkillMdForAuthorizedNode,
  type AgentSkillMdRead,
} from './agentSkillMdService';

export interface NodeOverlay {
  authorization: 'server-filtered';
  node: NodeOverlayGraphSnapshot['node'];
  dependencies: NodeOverlayGraphSnapshot['dependencies'];
  recentChanges: NodeOverlayGraphSnapshot['recentChanges'];
  specificFeatures: NodeOverlayGraphSnapshot['features'];
  agentSkillMd: AgentSkillMdRead['document'];
  description: NodeOverlayGraphSnapshot['description'];
  specificTickets: NodeOverlayGraphSnapshot['tickets'];
}

export async function getNodeOverlay(
  nodeId: string,
  ctx: AuthContext,
  graph: NodeOverlayGraphQueryService = graphQueryService,
  store: AgentSkillMdStore = agentSkillMdStore,
): Promise<NodeOverlay | null> {
  const snapshot = await graph.getNodeOverlay(nodeId, ctx);
  if (!snapshot) return null;
  const agentSkillMd = await readAgentSkillMdForAuthorizedNode(
    snapshot.node,
    ctx,
    store,
  );
  return {
    authorization: 'server-filtered',
    node: snapshot.node,
    dependencies: snapshot.dependencies,
    recentChanges: snapshot.recentChanges,
    specificFeatures: snapshot.features,
    agentSkillMd: agentSkillMd.document,
    description: snapshot.description,
    specificTickets: snapshot.tickets,
  };
}
