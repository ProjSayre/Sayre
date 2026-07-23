// Business logic lives here (service-layer rule — .claude/rules/service-layer.md).
// Turns a `graph.updated` change set into an RBAC-filtered, per-context delta of
// Folder/File nodes for the Realtime Service (services/gateway) to fan out.
//
// `ctx` is resolved server-side by the caller (the internal route uses
// requireAuthContext(req)) — identity is NEVER read from the request body
// (.claude/rules/security-multitenancy.md, W2-03 AC5).

import type { CanvasNode, RealtimeGraphDelta } from '@sayre/shared-types';
import type { AuthContext } from '../auth/context';
import { graphQueryService } from '../graph-query';
import type { GraphNode, GraphQueryService } from '../graph-query/types';

export interface RealtimeGraphChange {
  changedPaths: string[];
  fullRebuild: boolean;
  graphVersion: number;
}

function toCanvasNode(node: GraphNode): CanvasNode {
  return {
    id: node.id,
    label: node.label,
    name: node.name,
    path: node.path,
    parentId: node.parentId,
  };
}

/**
 * Full rebuild → a resync signal only (no granular delta; the client re-fetches
 * the tree over REST — AC6). Otherwise delegates to the Graph Query Service's
 * `getAffectedNodes` and maps its result onto the wire contract. Never returns a
 * non-Folder/File node (guaranteed by GraphNode.label's closed union).
 */
export async function getRealtimeGraphDelta(
  repoId: string,
  change: RealtimeGraphChange,
  ctx: AuthContext,
  graph: GraphQueryService = graphQueryService,
): Promise<RealtimeGraphDelta> {
  if (change.fullRebuild) {
    return {
      repoId,
      graphVersion: change.graphVersion,
      upserts: [],
      removals: [],
      resyncRequired: true,
    };
  }

  const { visible, removed } = await graph.getAffectedNodes(repoId, change.changedPaths, ctx);

  return {
    repoId,
    graphVersion: change.graphVersion,
    upserts: visible.map(toCanvasNode),
    removals: removed,
    resyncRequired: false,
  };
}
