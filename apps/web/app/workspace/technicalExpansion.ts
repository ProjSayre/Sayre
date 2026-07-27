import { buildFileTreeModel } from './fileTree';
import type { GraphEdge, GraphNode } from './types';

export type TechnicalExpansionMode = 'balanced' | 'focus' | 'full';

export type TechnicalExpansionReason =
  | 'root'
  | 'focus-path'
  | 'manual'
  | 'pinned'
  | 'context'
  | 'transient';

export type TechnicalFolderState =
  | 'collapsed'
  | 'contextual'
  | 'expanded'
  | 'leaf';

export interface TechnicalExpansionPreferences {
  mode: TechnicalExpansionMode;
  manuallyExpanded: ReadonlySet<string>;
  manuallyCollapsed: ReadonlySet<string>;
  pinnedBranches: ReadonlySet<string>;
  /** Most recently opened branch first. */
  manualOrder: readonly string[];
}

export interface TechnicalTransientReveal {
  source:
    | 'search'
    | 'deep-link'
    | 'agent'
    | 'onboarding'
    | 'selection';
  nodeIds: ReadonlySet<string>;
}

export interface TechnicalExpansionIntent
  extends TechnicalExpansionPreferences {
  focusNodeId: string | null;
  transientReveal: TechnicalTransientReveal | null;
}

export interface TechnicalExpansionProjection {
  mode: TechnicalExpansionMode;
  nodes: GraphNode[];
  edges: GraphEdge[];
  visibleNodeIds: ReadonlySet<string>;
  expandedFolderIds: ReadonlySet<string>;
  foldedDescendantCount: ReadonlyMap<string, number>;
  hiddenImportCount: ReadonlyMap<string, number>;
  visibleChildCount: ReadonlyMap<string, number>;
  totalChildCount: ReadonlyMap<string, number>;
  folderStateById: ReadonlyMap<string, TechnicalFolderState>;
  reasonByNodeId: ReadonlyMap<string, TechnicalExpansionReason>;
  pinnedBranchIds: ReadonlySet<string>;
  budget: number;
  overBudgetBy: number;
  foldedBranchCount: number;
  transientMatchCount: number;
  visibleTransientMatchCount: number;
  key: string;
}

const REASON_PRIORITY: Record<TechnicalExpansionReason, number> = {
  context: 1,
  manual: 2,
  pinned: 3,
  transient: 4,
  'focus-path': 5,
  root: 6,
};

function isExpansionMode(value: unknown): value is TechnicalExpansionMode {
  return value === 'balanced' || value === 'focus' || value === 'full';
}

function stringSet(value: unknown): ReadonlySet<string> {
  if (!Array.isArray(value)) return new Set();
  return new Set(
    value.filter(
      (entry): entry is string =>
        typeof entry === 'string' && entry.trim().length > 0,
    ),
  );
}

function stringList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (
      typeof entry !== 'string' ||
      entry.trim().length === 0 ||
      seen.has(entry)
    ) {
      continue;
    }
    seen.add(entry);
    result.push(entry);
  }
  return result;
}

export function defaultTechnicalExpansionPreferences(): TechnicalExpansionPreferences {
  return {
    mode: 'balanced',
    manuallyExpanded: new Set(),
    manuallyCollapsed: new Set(),
    pinnedBranches: new Set(),
    manualOrder: [],
  };
}

export function parseTechnicalExpansionPreferences(
  serialized: string | null,
): TechnicalExpansionPreferences {
  if (!serialized) return defaultTechnicalExpansionPreferences();

  try {
    const value = JSON.parse(serialized) as Record<string, unknown>;
    if (typeof value !== 'object' || value === null) {
      return defaultTechnicalExpansionPreferences();
    }
    return {
      mode: isExpansionMode(value.mode) ? value.mode : 'balanced',
      manuallyExpanded: stringSet(value.manuallyExpanded),
      manuallyCollapsed: stringSet(value.manuallyCollapsed),
      pinnedBranches: stringSet(value.pinnedBranches),
      manualOrder: stringList(value.manualOrder),
    };
  } catch {
    return defaultTechnicalExpansionPreferences();
  }
}

export function serializeTechnicalExpansionPreferences(
  preferences: TechnicalExpansionPreferences,
): string {
  return JSON.stringify({
    mode: preferences.mode,
    manuallyExpanded: [...preferences.manuallyExpanded].sort(),
    manuallyCollapsed: [...preferences.manuallyCollapsed].sort(),
    pinnedBranches: [...preferences.pinnedBranches].sort(),
    manualOrder: [...preferences.manualOrder],
  });
}

export function pruneTechnicalExpansionPreferences(
  preferences: TechnicalExpansionPreferences,
  nodes: readonly GraphNode[],
): TechnicalExpansionPreferences {
  const folderIds = new Set(
    nodes.filter((node) => node.kind === 'Folder').map((node) => node.id),
  );
  const filterSet = (values: ReadonlySet<string>): Set<string> =>
    new Set([...values].filter((id) => folderIds.has(id)));

  const manuallyExpanded = filterSet(preferences.manuallyExpanded);
  const manuallyCollapsed = filterSet(preferences.manuallyCollapsed);
  const pinnedBranches = filterSet(preferences.pinnedBranches);
  for (const nodeId of manuallyCollapsed) manuallyExpanded.delete(nodeId);
  for (const nodeId of pinnedBranches) {
    manuallyExpanded.add(nodeId);
    manuallyCollapsed.delete(nodeId);
  }
  const manualOrder = preferences.manualOrder.filter(
    (id, index, values) =>
      folderIds.has(id) && values.indexOf(id) === index,
  );

  return {
    mode: preferences.mode,
    manuallyExpanded,
    manuallyCollapsed,
    pinnedBranches,
    manualOrder,
  };
}

export function viewportTechnicalNodeBudget(
  canvasWidth: number,
  canvasHeight: number,
): number {
  if (!Number.isFinite(canvasWidth) || !Number.isFinite(canvasHeight)) {
    return 24;
  }
  const estimated =
    Math.floor(Math.max(0, canvasWidth) / 110) *
    Math.floor(Math.max(0, canvasHeight) / 64);
  return Math.max(24, Math.min(96, estimated));
}

function compareNodeIds(
  leftId: string,
  rightId: string,
  byId: ReadonlyMap<string, GraphNode>,
): number {
  const left = byId.get(leftId);
  const right = byId.get(rightId);
  if (!left || !right) return leftId.localeCompare(rightId);
  return (
    Number(left.kind === 'File') - Number(right.kind === 'File') ||
    left.path.localeCompare(right.path, undefined, {
      numeric: true,
      sensitivity: 'base',
    }) ||
    left.id.localeCompare(right.id)
  );
}

function orderedPreferenceIds(
  values: ReadonlySet<string>,
  manualOrder: readonly string[],
  byId: ReadonlyMap<string, GraphNode>,
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const id of manualOrder) {
    if (!values.has(id) || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  for (const id of [...values].sort((left, right) =>
    compareNodeIds(left, right, byId),
  )) {
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

export function projectTechnicalExpansion(
  graphNodes: readonly GraphNode[],
  graphEdges: readonly GraphEdge[],
  intent: TechnicalExpansionIntent,
  requestedBudget: number,
): TechnicalExpansionProjection {
  const model = buildFileTreeModel(graphNodes);
  const authorizedNodeIds = new Set(model.byId.keys());
  const budget = Math.max(1, Math.floor(requestedBudget));
  const visibleNodeIds = new Set<string>();
  const reasonByNodeId = new Map<string, TechnicalExpansionReason>();

  const setReason = (
    nodeId: string,
    reason: TechnicalExpansionReason,
  ): void => {
    const current = reasonByNodeId.get(nodeId);
    if (
      current === undefined ||
      REASON_PRIORITY[reason] > REASON_PRIORITY[current]
    ) {
      reasonByNodeId.set(nodeId, reason);
    }
  };

  const addNode = (
    nodeId: string,
    reason: TechnicalExpansionReason,
  ): void => {
    if (!authorizedNodeIds.has(nodeId)) return;
    visibleNodeIds.add(nodeId);
    setReason(nodeId, reason);
  };

  const pathToRoot = (nodeId: string): string[] => {
    if (!authorizedNodeIds.has(nodeId)) return [];
    const reversed: string[] = [];
    const visited = new Set<string>();
    let currentId: string | undefined = nodeId;
    while (currentId !== undefined && !visited.has(currentId)) {
      visited.add(currentId);
      reversed.push(currentId);
      currentId = model.parentById.get(currentId);
    }
    return reversed.reverse();
  };

  const addPath = (
    nodeId: string,
    reason: TechnicalExpansionReason,
    protectedPath = false,
  ): boolean => {
    const path = pathToRoot(nodeId);
    if (path.length === 0) return false;
    const missing = path.filter((id) => !visibleNodeIds.has(id)).length;
    if (!protectedPath && visibleNodeIds.size + missing > budget) return false;
    for (const id of path) addNode(id, reason);
    return true;
  };

  const addChildren = (
    folderId: string,
    reason: TechnicalExpansionReason,
    ignoreManualCollapse = false,
  ): void => {
    const folder = model.byId.get(folderId);
    if (
      folder?.kind !== 'Folder' ||
      (!ignoreManualCollapse && intent.manuallyCollapsed.has(folderId))
    ) {
      return;
    }
    if (!visibleNodeIds.has(folderId) && !addPath(folderId, reason)) return;
    for (const child of model.childrenById.get(folderId) ?? []) {
      if (visibleNodeIds.has(child.id)) {
        setReason(child.id, reason);
        continue;
      }
      if (visibleNodeIds.size >= budget) break;
      addNode(child.id, reason);
    }
  };

  const addFirstChild = (
    folderId: string,
    reason: TechnicalExpansionReason,
  ): void => {
    const folder = model.byId.get(folderId);
    if (
      folder?.kind !== 'Folder' ||
      intent.manuallyCollapsed.has(folderId) ||
      visibleNodeIds.size >= budget
    ) {
      return;
    }
    const child = (model.childrenById.get(folderId) ?? []).find(
      (candidate) => !visibleNodeIds.has(candidate.id),
    );
    if (child) addNode(child.id, reason);
  };

  const addRootLandmarks = (
    rootId: string,
    reason: TechnicalExpansionReason,
  ): void => {
    if (intent.manuallyCollapsed.has(rootId)) return;
    const children = model.childrenById.get(rootId) ?? [];
    const folders = children.filter((child) => child.kind === 'Folder');
    // Root-level loose files turn a repository tree into an unreadable
    // starburst. Show folder landmarks by default, but keep a flat repository
    // usable by falling back to its files. Search, focus, and manual expansion
    // still reveal any root file on demand.
    const landmarks = folders.length > 0 ? folders : children;
    for (const child of landmarks) {
      if (visibleNodeIds.size >= budget) break;
      addNode(child.id, reason);
    }
  };

  if (intent.mode === 'full') {
    for (const node of graphNodes) {
      addNode(
        node.id,
        model.parentById.has(node.id) ? 'context' : 'root',
      );
    }
  } else {
    // Roots, the current focus corridor, and explicitly protected branches are
    // the only paths allowed to exceed the adaptive budget.
    for (const root of model.roots) addNode(root.id, 'root');

    if (intent.focusNodeId) {
      addPath(intent.focusNodeId, 'focus-path', true);
    }

    const transientIds = intent.transientReveal
      ? [...intent.transientReveal.nodeIds]
          .filter((id) => authorizedNodeIds.has(id))
          .sort((left, right) => compareNodeIds(left, right, model.byId))
      : [];
    transientIds.forEach((nodeId, index) => {
      const transientSource = intent.transientReveal?.source;
      addPath(
        nodeId,
        'transient',
        transientSource === 'deep-link' ||
          transientSource === 'agent' ||
          transientSource === 'onboarding' ||
          index === 0,
      );
    });

    const pinnedIds = orderedPreferenceIds(
      intent.pinnedBranches,
      intent.manualOrder,
      model.byId,
    );
    for (const nodeId of pinnedIds) addPath(nodeId, 'pinned', true);

    const manualIds = orderedPreferenceIds(
      intent.manuallyExpanded,
      intent.manualOrder,
      model.byId,
    );
    for (const nodeId of manualIds) addPath(nodeId, 'manual', true);

    // Give every protected branch one contextual child before a large folder
    // can spend the rest of the viewport budget.
    for (const folderId of pinnedIds) addFirstChild(folderId, 'pinned');
    for (const folderId of manualIds) addFirstChild(folderId, 'manual');
    for (const folderId of pinnedIds) addChildren(folderId, 'pinned');
    for (const folderId of manualIds) addChildren(folderId, 'manual');

    if (intent.focusNodeId && authorizedNodeIds.has(intent.focusNodeId)) {
      const focused = model.byId.get(intent.focusNodeId);
      if (focused?.kind === 'Folder') {
        addChildren(focused.id, 'context');
      }

      // Spend the remaining budget on nearby siblings, from the focused node
      // outward toward the root. A manual collapse still wins for its branch.
      const focusPath = pathToRoot(intent.focusNodeId);
      for (let index = focusPath.length - 1; index > 0; index -= 1) {
        const parentId = focusPath[index - 1];
        addChildren(parentId, 'context');
      }
    }

    if (intent.mode === 'balanced') {
      for (const root of model.roots) addRootLandmarks(root.id, 'context');
    } else if (!intent.focusNodeId) {
      // Focus mode without a focus still retains high-level folder landmarks.
      for (const root of model.roots) addRootLandmarks(root.id, 'context');
    }
  }

  const nodes = graphNodes.filter((node) => visibleNodeIds.has(node.id));
  const edges = graphEdges.filter(
    (edge) =>
      visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target),
  );

  const visibleChildCount = new Map<string, number>();
  const totalChildCount = new Map<string, number>();
  const foldedDescendantCount = new Map<string, number>();
  const hiddenImportCount = new Map<string, number>();
  const expandedFolderIds = new Set<string>();
  const folderStateById = new Map<string, TechnicalFolderState>();

  for (const node of nodes) {
    if (node.kind !== 'Folder') continue;
    const children = model.childrenById.get(node.id) ?? [];
    const visibleChildren = children.filter((child) =>
      visibleNodeIds.has(child.id),
    ).length;
    const totalChildren = children.length;
    visibleChildCount.set(node.id, visibleChildren);
    totalChildCount.set(node.id, totalChildren);
    foldedDescendantCount.set(node.id, 0);
    hiddenImportCount.set(node.id, 0);
    if (visibleChildren > 0) expandedFolderIds.add(node.id);

    folderStateById.set(
      node.id,
      totalChildren === 0
        ? 'leaf'
        : visibleChildren === 0
          ? 'collapsed'
          : visibleChildren < totalChildren
            ? 'contextual'
            : 'expanded',
    );
  }

  const nearestVisibleFolder = (hiddenNodeId: string): string | null => {
    const visited = new Set<string>([hiddenNodeId]);
    let parentId = model.parentById.get(hiddenNodeId);
    while (parentId !== undefined && !visited.has(parentId)) {
      visited.add(parentId);
      const parent = model.byId.get(parentId);
      if (!parent) return null;
      if (visibleNodeIds.has(parent.id) && parent.kind === 'Folder') {
        return parent.id;
      }
      parentId = model.parentById.get(parent.id);
    }
    return null;
  };

  // Assign each folded node to one real, nearest visible Folder. Counts are
  // therefore additive and never double-count descendants at every ancestor.
  for (const node of graphNodes) {
    if (visibleNodeIds.has(node.id)) continue;
    const owner = nearestVisibleFolder(node.id);
    if (owner) {
      foldedDescendantCount.set(
        owner,
        (foldedDescendantCount.get(owner) ?? 0) + 1,
      );
    }
  }

  for (const edge of graphEdges) {
    if (edge.type !== 'IMPORTS') continue;
    const owners = new Set<string>();
    if (!visibleNodeIds.has(edge.source)) {
      const owner = nearestVisibleFolder(edge.source);
      if (owner) owners.add(owner);
    }
    if (!visibleNodeIds.has(edge.target)) {
      const owner = nearestVisibleFolder(edge.target);
      if (owner) owners.add(owner);
    }
    for (const owner of owners) {
      hiddenImportCount.set(owner, (hiddenImportCount.get(owner) ?? 0) + 1);
    }
  }

  const transientNodeIds = intent.transientReveal?.nodeIds ?? new Set<string>();
  const pinnedBranchIds = new Set(
    [...intent.pinnedBranches].filter((id) => authorizedNodeIds.has(id)),
  );
  const transientMatchCount = [...transientNodeIds].filter((id) =>
    authorizedNodeIds.has(id),
  ).length;
  const visibleTransientMatchCount = [...transientNodeIds].filter((id) =>
    visibleNodeIds.has(id),
  ).length;
  const foldedBranchCount = [...foldedDescendantCount.values()].filter(
    (count) => count > 0,
  ).length;
  const key = [
    intent.mode,
    budget,
    ...graphNodes
      .filter((node) => visibleNodeIds.has(node.id))
      .map((node) => node.id),
  ].join(':');

  return {
    mode: intent.mode,
    nodes,
    edges,
    visibleNodeIds,
    expandedFolderIds,
    foldedDescendantCount,
    hiddenImportCount,
    visibleChildCount,
    totalChildCount,
    folderStateById,
    reasonByNodeId,
    pinnedBranchIds,
    budget,
    overBudgetBy: Math.max(0, visibleNodeIds.size - budget),
    foldedBranchCount,
    transientMatchCount,
    visibleTransientMatchCount,
    key,
  };
}
