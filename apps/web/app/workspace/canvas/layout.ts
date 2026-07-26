import type { GraphNode } from '../types';

export interface Point {
  x: number;
  y: number;
}

export type TreeOrientation = 'top-down' | 'left-right';
export type RadialOrientation = 'landscape' | 'portrait';

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
 * A wide tidy tree is ideal for the small React Flow presentation, but a large
 * repository can have hundreds of leaves. Fitting that same line of leaves
 * into one viewport collapses the hierarchy into a stripe. Sigma therefore
 * uses a radial hierarchy: folders stay on the inner rings, files fan out
 * around their branch, and the ellipse follows the available viewport.
 */
export function layoutRadialTree(
  nodes: GraphNode[],
  orientation: RadialOrientation = 'landscape',
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
    left.path.localeCompare(right.path) ||
    left.name.localeCompare(right.name) ||
    left.id.localeCompare(right.id);
  roots.sort(compareNodes);
  for (const children of childrenOf.values()) children.sort(compareNodes);

  const leafWeights = new Map<string, number>();
  const weighing = new Set<string>();
  const leafWeight = (node: GraphNode): number => {
    const cached = leafWeights.get(node.id);
    if (cached !== undefined) return cached;
    // The graph service guarantees a tree, but failing closed to one slot
    // keeps a malformed cycle from hanging the browser.
    if (weighing.has(node.id)) return 1;
    weighing.add(node.id);
    const children = childrenOf.get(node.id) ?? [];
    const weight =
      children.length === 0
        ? 1
        : children.reduce((sum, child) => sum + leafWeight(child), 0);
    weighing.delete(node.id);
    leafWeights.set(node.id, Math.max(1, weight));
    return Math.max(1, weight);
  };

  const rootWeight = Math.max(
    1,
    roots.reduce((sum, root) => sum + leafWeight(root), 0),
  );
  const positions = new Map<string, Point>();
  const radiusGap = 150;
  const xScale = orientation === 'landscape' ? 1.7 : 0.95;
  const yScale = orientation === 'landscape' ? 0.95 : 1.55;

  const place = (
    node: GraphNode,
    depth: number,
    startAngle: number,
    angleSpan: number,
    ancestry: ReadonlySet<string>,
  ): void => {
    if (ancestry.has(node.id)) return;
    const angle = startAngle + angleSpan / 2;
    const radius = depth * radiusGap;
    positions.set(node.id, {
      x: Math.cos(angle) * radius * xScale,
      y: Math.sin(angle) * radius * yScale,
    });

    const children = childrenOf.get(node.id) ?? [];
    if (children.length === 0) return;
    const nextAncestry = new Set(ancestry);
    nextAncestry.add(node.id);
    const totalWeight = Math.max(
      1,
      children.reduce((sum, child) => sum + leafWeight(child), 0),
    );
    let cursor = startAngle;
    for (const child of children) {
      const childSpan = angleSpan * (leafWeight(child) / totalWeight);
      place(child, depth + 1, cursor, childSpan, nextAncestry);
      cursor += childSpan;
    }
  };

  let rootCursor = -Math.PI / 2;
  for (const root of roots) {
    const span = Math.PI * 2 * (leafWeight(root) / rootWeight);
    place(root, 0, rootCursor, span, new Set());
    rootCursor += span;
  }

  return positions;
}

/** React Flow positions the node box by its top-left corner. */
export function toBoxOrigin(point: Point): Point {
  return { x: point.x - NODE_BOX / 2, y: point.y - NODE_BOX / 2 };
}
