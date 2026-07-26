import type { GraphNode } from '../types';

export interface Point {
  x: number;
  y: number;
}

export type TreeOrientation = 'top-down' | 'left-right';
export type ScalableTreeViewport = 'landscape' | 'portrait';

/** Circle/dot geometry from the design system: open circles contain, dots are leaves. */
export const NODE_BOX = 20;

const Y_GAP = 124;
const LABEL_GAP = 26;
/** Fragment Mono at 11px is close enough to monospaced 0.6em for layout. */
const CHAR_WIDTH = 6.4;

/**
 * Labels sit to the right of their node, so a leaf must reserve its own label
 * width before the next one starts — short folder names pack tightly and long
 * filenames get room, which is what the approved mock does.
 */
function slotWidth(node: GraphNode): number {
  return node.name.length * CHAR_WIDTH + LABEL_GAP;
}

/**
 * Tidy vertical tree: root at top centre, children fanned out below, leaves
 * laid out left to right across the bottom of their branch. Leaf order fixes
 * the x cursor; every parent is centred over its own first and last child.
 */
export function layoutTree(
  nodes: GraphNode[],
  orientation: TreeOrientation = 'top-down',
): Map<string, Point> {
  const childrenOf = new Map<string, GraphNode[]>();
  let root: GraphNode | null = null;

  for (const node of nodes) {
    if (node.parentId === null) {
      root = root ?? node;
      continue;
    }
    const siblings = childrenOf.get(node.parentId);
    if (siblings === undefined) childrenOf.set(node.parentId, [node]);
    else siblings.push(node);
  }

  const positions = new Map<string, Point>();
  if (root === null) return positions;

  let leafCursor = 0;

  const place = (node: GraphNode, depth: number): number => {
    const children = childrenOf.get(node.id) ?? [];
    const y = depth * Y_GAP;

    if (children.length === 0) {
      const x = leafCursor;
      leafCursor += slotWidth(node);
      positions.set(node.id, { x, y });
      return x;
    }

    const childCentres = children.map((child) => place(child, depth + 1));
    const x =
      (childCentres[0] + childCentres[childCentres.length - 1]) / 2;
    positions.set(node.id, { x, y });
    return x;
  };

  place(root, 0);
  if (orientation === 'left-right') {
    return new Map(
      [...positions].map(([id, point]) => [
        id,
        {
          x: point.y * 0.8,
          y: point.x * 0.5,
        },
      ]),
    );
  }
  return positions;
}

/**
 * The WebGL renderer keeps the exact same top-down tree grammar as the
 * approved React Flow mock. Large repositories need one extra piece of math:
 * vertical spacing grows with the leaf span so fitting hundreds of files does
 * not collapse every depth into a horizontal stripe.
 *
 * Leaves reserve equal presentation slots because Sigma renders labels only
 * when the camera is close enough. Parents remain centred over their first and
 * last child, producing the same restrained hierarchy at 25 or 2,500 nodes.
 */
export function layoutScalableTree(
  nodes: GraphNode[],
  viewport: ScalableTreeViewport = 'landscape',
): Map<string, Point> {
  if (nodes.length === 0) return new Map();

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const childrenOf = new Map<string, GraphNode[]>();
  const roots: GraphNode[] = [];

  for (const node of nodes) {
    if (node.parentId === null || !byId.has(node.parentId)) {
      roots.push(node);
      continue;
    }
    const children = childrenOf.get(node.parentId) ?? [];
    children.push(node);
    childrenOf.set(node.parentId, children);
  }

  const compareNodes = (left: GraphNode, right: GraphNode): number =>
    Number(left.kind === 'File') - Number(right.kind === 'File') ||
    left.path.localeCompare(right.path) ||
    left.name.localeCompare(right.name) ||
    left.id.localeCompare(right.id);
  roots.sort(compareNodes);
  for (const children of childrenOf.values()) children.sort(compareNodes);

  const rawPositions = new Map<string, Point>();
  const visiting = new Set<string>();
  let leafCursor = 0;
  let maxDepth = 0;

  const place = (node: GraphNode, depth: number): number => {
    const existing = rawPositions.get(node.id);
    if (existing !== undefined) return existing.x;

    maxDepth = Math.max(maxDepth, depth);
    if (visiting.has(node.id)) {
      const cycleX = leafCursor;
      leafCursor += 1;
      rawPositions.set(node.id, { x: cycleX, y: depth });
      return cycleX;
    }

    visiting.add(node.id);
    const children = (childrenOf.get(node.id) ?? []).filter(
      (child) => !visiting.has(child.id),
    );
    let x: number;
    if (children.length === 0) {
      x = leafCursor;
      leafCursor += 1;
    } else {
      const childCentres = children.map((child) => place(child, depth + 1));
      x =
        (childCentres[0] + childCentres[childCentres.length - 1]) / 2;
    }
    visiting.delete(node.id);
    rawPositions.set(node.id, { x, y: depth });
    return x;
  };

  for (const root of roots) {
    place(root, 0);
    leafCursor += 1.5;
  }
  // The service emits one rooted hierarchy. This fallback keeps a malformed
  // cycle or disconnected authorized component visible without hanging.
  for (const node of [...nodes].sort(compareNodes)) {
    if (rawPositions.has(node.id)) continue;
    place(node, 0);
    leafCursor += 1.5;
  }

  const xs = [...rawPositions.values()].map(({ x }) => x);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const centreX = (minX + maxX) / 2;
  const leafGap = 28;
  const horizontalSpan = Math.max(leafGap, (maxX - minX) * leafGap);
  const targetAspect = viewport === 'landscape' ? 1.75 : 0.72;
  const depthGap =
    maxDepth === 0
      ? 128
      : Math.max(128, horizontalSpan / targetAspect / maxDepth);

  return new Map(
    [...rawPositions].map(([id, point]) => [
      id,
      {
        x: (point.x - centreX) * leafGap,
        // Sigma uses Cartesian graph coordinates, so negative y places
        // descendants below the root in the viewport.
        y: point.y === 0 ? 0 : -point.y * depthGap,
      },
    ]),
  );
}

/** React Flow positions the node box by its top-left corner. */
export function toBoxOrigin(point: Point): Point {
  return { x: point.x - NODE_BOX / 2, y: point.y - NODE_BOX / 2 };
}
