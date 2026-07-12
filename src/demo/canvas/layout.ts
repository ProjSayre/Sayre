import { hierarchy, tree } from "d3-hierarchy";
import type { HierarchyPointNode } from "d3-hierarchy";
import { CHILDREN, NODE_BY_ID, ROOT_ID, ancestorIds, ghostCount } from "../../data";
import type { RepoNode } from "../../data";
import { labelWidth } from "./measure";

export const ROW_GAP = 110; // vertical distance between depths (§7.1)

export type TreeItem =
  | { kind: "node"; id: string; node: RepoNode; parentId: string | null; depth: number }
  | { kind: "ghost"; id: string; parentId: string; depth: number; count: number; label: string };

/** flattened DFS of the currently-visible tree (canvas + tree panel share this) */
export function visibleTreeItems(expanded: ReadonlySet<string>): TreeItem[] {
  const out: TreeItem[] = [];
  const walk = (id: string, depth: number): void => {
    const node = NODE_BY_ID.get(id);
    if (!node) return;
    out.push({ kind: "node", id, node, parentId: node.parentId, depth });
    if (node.type === "file" || !expanded.has(id)) return;
    for (const child of CHILDREN.get(id) ?? []) walk(child.id, depth + 1);
    const ghosts = ghostCount(id);
    if (ghosts > 0) {
      out.push({
        kind: "ghost",
        id: `${id}//ghost`,
        parentId: id,
        depth: depth + 1,
        count: ghosts,
        label: `… ${ghosts} more files`,
      });
    }
  };
  walk(ROOT_ID, 0);
  return out;
}

export function nodeRadius(item: TreeItem, selected: boolean): number {
  if (item.kind === "ghost") return 0;
  if (item.node.type === "root") return 8;
  if (item.node.type === "folder") return selected ? 8 : 6.5;
  return selected ? 5 : 4.5;
}

export function itemLabel(item: TreeItem): string {
  if (item.kind === "ghost") return item.label;
  return item.node.type === "file" ? item.node.name : item.node.name + "/";
}

export function itemFontSize(item: TreeItem): number {
  if (item.kind === "ghost") return 10.5;
  return item.node.type === "file" ? 11 : 11.5;
}

/** horizontal footprint: node + gap + label (drives collision-free separation) */
function itemExtent(item: TreeItem): number {
  const r = item.kind === "ghost" ? 0 : nodeRadius(item, false);
  return r * 2 + 6 + labelWidth(itemLabel(item), itemFontSize(item));
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface FiletreeLayout {
  items: TreeItem[];
  positions: Map<string, { x: number; y: number }>;
  bounds: Bounds;
  maxDepth: number; // deepest visible level (0-based)
}

interface LNode {
  item: TreeItem;
  children: LNode[];
}

export function layoutFiletree(expanded: ReadonlySet<string>): FiletreeLayout {
  return layoutItems(visibleTreeItems(expanded));
}

/** layout a pre-built item list (also used by the dev-only OG renderer) */
export function layoutItems(items: TreeItem[]): FiletreeLayout {
  const byParent = new Map<string, LNode[]>();
  const lnodes: LNode[] = items.map((item) => ({ item, children: [] }));
  for (const ln of lnodes) {
    const pid = ln.item.kind === "ghost" ? ln.item.parentId : ln.item.parentId;
    if (pid === null) continue;
    const list = byParent.get(pid) ?? [];
    list.push(ln);
    byParent.set(pid, list);
  }
  for (const ln of lnodes) {
    if (ln.item.kind === "node") ln.children = byParent.get(ln.item.id) ?? [];
  }
  const rootLn = lnodes[0];

  const h = hierarchy<LNode>(rootLn, (d) => d.children);
  const layout = tree<LNode>()
    .nodeSize([1, ROW_GAP])
    .separation((a, b) => (itemExtent(a.data.item) + itemExtent(b.data.item)) / 2 + 24);
  const rootPoint = layout(h);

  const positions = new Map<string, { x: number; y: number }>();
  let bounds: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  let maxDepth = 0;

  rootPoint.each((p: HierarchyPointNode<LNode>) => {
    const item = p.data.item;
    positions.set(item.id, { x: p.x, y: p.y });
    const r = item.kind === "ghost" ? 0 : nodeRadius(item, true);
    const left = p.x - r;
    const right = p.x + r + 6 + labelWidth(itemLabel(item), itemFontSize(item));
    bounds = {
      minX: Math.min(bounds.minX, left),
      minY: Math.min(bounds.minY, p.y - r - 6),
      maxX: Math.max(bounds.maxX, right),
      maxY: Math.max(bounds.maxY, p.y + r + 6),
    };
    maxDepth = Math.max(maxDepth, item.depth);
  });

  return { items, positions, bounds, maxDepth };
}

/** ancestry lighting (§7.2): path root→selected plus selected→direct children */
export function litSets(selectedId: string | null): {
  nodes: Set<string>;
  edges: Set<string>; // keyed `${parentId}→${childId}`
} {
  const nodes = new Set<string>();
  const edges = new Set<string>();
  if (!selectedId || !NODE_BY_ID.get(selectedId)) return { nodes, edges };
  const chain = [...ancestorIds(selectedId), selectedId];
  for (const id of chain) nodes.add(id);
  for (let i = 0; i < chain.length - 1; i++) edges.add(`${chain[i]}→${chain[i + 1]}`);
  for (const child of CHILDREN.get(selectedId) ?? []) {
    nodes.add(child.id);
    edges.add(`${selectedId}→${child.id}`);
  }
  return { nodes, edges };
}
