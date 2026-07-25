import type { GraphNode } from '../types';

export interface Point {
  x: number;
  y: number;
}

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
export function layoutTree(nodes: GraphNode[]): Map<string, Point> {
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
  return positions;
}

/** React Flow positions the node box by its top-left corner. */
export function toBoxOrigin(point: Point): Point {
  return { x: point.x - NODE_BOX / 2, y: point.y - NODE_BOX / 2 };
}
