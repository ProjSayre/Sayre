import type { WorkspaceCollectionPayload, WorkspaceTreePayload } from '../../../../../packages/workspace-packs/src/runtime';
import type { Feature, GraphNode } from '../types';

/** Only Folder/File nodes are ever rendered on canvas; graph-internal kinds never reach a payload. */
const RENDERABLE_NODE_KINDS = new Set<GraphNode['kind']>(['Folder', 'File']);

export function structureTreePayload(nodes: readonly GraphNode[]): WorkspaceTreePayload {
  return {
    shape: 'tree',
    nodes: nodes
      .filter((node) => RENDERABLE_NODE_KINDS.has(node.kind))
      .map((node) => ({ id: node.id, parentId: node.parentId, label: node.name, kind: node.kind })),
  };
}

export function featuresCollectionPayload(
  features: readonly Feature[],
  nodePaths: ReadonlyMap<string, string>,
): WorkspaceCollectionPayload {
  return {
    shape: 'collection',
    items: features.map((feature) => {
      const memberPaths = feature.memberIds
        .map((id) => nodePaths.get(id))
        .filter((path): path is string => path !== undefined);
      return {
        id: feature.id,
        title: feature.name,
        subtitle: feature.description ?? (memberPaths.length > 0 ? memberPaths.join(', ') : undefined),
        group: feature.team ?? undefined,
        ref: { kind: 'feature' as const, id: feature.id },
      };
    }),
  };
}
