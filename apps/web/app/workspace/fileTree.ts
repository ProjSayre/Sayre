import type { GraphNode } from './types';

export interface FileTreeModel {
  byId: ReadonlyMap<string, GraphNode>;
  childrenById: ReadonlyMap<string, readonly GraphNode[]>;
  parentById: ReadonlyMap<string, string>;
  roots: readonly GraphNode[];
}

export interface FileTreeRow {
  node: GraphNode;
  depth: number;
  parentId: string | null;
  hasChildren: boolean;
  positionInSet: number;
  setSize: number;
}

function compareNodes(left: GraphNode, right: GraphNode): number {
  return (
    Number(left.kind === 'File') - Number(right.kind === 'File') ||
    left.name.localeCompare(right.name, undefined, {
      numeric: true,
      sensitivity: 'base',
    }) ||
    left.path.localeCompare(right.path) ||
    left.id.localeCompare(right.id)
  );
}

/**
 * Builds an explorer model from the authorized projection already returned by
 * the graph service. Missing parents become roots, which preserves the
 * service's RBAC behavior instead of attempting to reconstruct hidden paths.
 */
export function buildFileTreeModel(nodes: readonly GraphNode[]): FileTreeModel {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const childrenById = new Map<string, GraphNode[]>(
    nodes.map((node) => [node.id, []]),
  );
  const parentById = new Map<string, string>();
  const roots: GraphNode[] = [];

  for (const node of nodes) {
    const parent =
      node.parentId === null || node.parentId === node.id
        ? undefined
        : byId.get(node.parentId);
    if (parent === undefined) {
      roots.push(node);
      continue;
    }
    childrenById.get(parent.id)?.push(node);
    parentById.set(node.id, parent.id);
  }

  roots.sort(compareNodes);
  for (const children of childrenById.values()) children.sort(compareNodes);

  // A malformed cycle has no natural root. Keep every authorized node
  // reachable while the row traversal's visited set prevents repetition.
  const reachable = new Set<string>();
  const markReachable = (node: GraphNode): void => {
    if (reachable.has(node.id)) return;
    reachable.add(node.id);
    for (const child of childrenById.get(node.id) ?? []) {
      markReachable(child);
    }
  };
  for (const root of roots) markReachable(root);
  for (const node of [...nodes].sort(compareNodes)) {
    if (reachable.has(node.id)) continue;
    roots.push(node);
    markReachable(node);
  }

  return { byId, childrenById, parentById, roots };
}

export function initialFileTreeExpansion(
  model: FileTreeModel,
): ReadonlySet<string> {
  return new Set(
    model.roots
      .filter(
        (node) =>
          node.kind === 'Folder' &&
          (model.childrenById.get(node.id)?.length ?? 0) > 0,
      )
      .map((node) => node.id),
  );
}

export function fileTreeAncestorFolders(
  model: FileTreeModel,
  nodeId: string,
): ReadonlySet<string> {
  const ancestors = new Set<string>();
  const visited = new Set<string>([nodeId]);
  let parentId = model.parentById.get(nodeId);

  while (parentId !== undefined && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = model.byId.get(parentId);
    if (parent === undefined) break;
    if (parent.kind === 'Folder') ancestors.add(parent.id);
    parentId = model.parentById.get(parent.id);
  }

  return ancestors;
}

export function visibleFileTreeRows(
  model: FileTreeModel,
  expandedIds: ReadonlySet<string>,
): FileTreeRow[] {
  const rows: FileTreeRow[] = [];
  const visited = new Set<string>();

  const append = (
    siblings: readonly GraphNode[],
    depth: number,
  ): void => {
    siblings.forEach((node, index) => {
      if (visited.has(node.id)) return;
      visited.add(node.id);
      const children = model.childrenById.get(node.id) ?? [];
      rows.push({
        node,
        depth,
        parentId: model.parentById.get(node.id) ?? null,
        hasChildren: children.length > 0,
        positionInSet: index + 1,
        setSize: siblings.length,
      });
      if (expandedIds.has(node.id)) append(children, depth + 1);
    });
  };

  append(model.roots, 0);
  return rows;
}
