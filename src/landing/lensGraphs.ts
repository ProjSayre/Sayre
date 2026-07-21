// Static graph states for the landing feature views — built from the real
// dataset + layout code at module init (ported from the design's dc script).

import { childrenOf } from "../data";
import { itemFontSize, itemLabel, layoutItems, litSets, nodeRadius, visibleTreeItems } from "../demo/canvas/layout";
import { rollupScope } from "../demo/canvas/rollup";

const VOID = "#0D0E0C";

export interface LensGraph {
  vb: string;
  anchors: Record<string, { x: number; y: number }>;
  edges: { x1: number; y1: number; x2: number; y2: number; stroke: string; w: number; op: number; dash: string }[];
  rings: { x: number; y: number; r: number; stroke: string; sw: number; dash: string; fill: string }[];
  dots: { x: number; y: number; r: number; fill: string }[];
  labels: { x: number; y: number; anchor: string; fs: number; fill: string; fw: number; label: string }[];
}

const EXPANDED = ["acme", "apps", "apps/web", "apps/web/src", "apps/web/src/checkout", "packages", "services"];

function buildTree(selectedId: string | null, mode: "lit" | "feature"): LensGraph {
  const items = visibleTreeItems(new Set(EXPANDED));
  const layout = layoutItems(items);
  const lit = litSets(selectedId);
  const pos = layout.positions;
  const out: LensGraph = { vb: "", anchors: {}, edges: [], rings: [], dots: [], labels: [] };
  for (const it of items) {
    const p = pos.get(it.id);
    if (!p) continue;
    out.anchors[it.id] = { x: p.x, y: p.y };
    if (it.parentId !== null) {
      const pp = pos.get(it.parentId);
      if (pp) {
        const isGhost = it.kind === "ghost";
        const isLit = !isGhost && mode === "lit" && lit.edges.has(it.parentId + "→" + it.id);
        out.edges.push({ x1: pp.x, y1: pp.y, x2: p.x, y2: p.y, stroke: isLit ? "#4F7F5D" : "#2B2B27", w: isLit ? 1.5 : 1, op: isGhost ? 0.5 : 1, dash: "none" });
      }
    }
    if (it.kind === "ghost") {
      out.labels.push({ x: p.x + 6, y: p.y + 3.5, anchor: "start", fs: 10.5, fill: "#64645C", fw: 400, label: it.label });
      continue;
    }
    const n = it.node;
    const isSel = mode === "lit" && selectedId === n.id;
    const onPath = mode === "lit" && !isSel && lit.nodes.has(n.id);
    const r = nodeRadius(it, isSel);
    if (n.type === "file") {
      out.dots.push({ x: p.x, y: p.y, r, fill: isSel || onPath ? "#4F7F5D" : "#55554E" });
      if (mode === "lit" && n.meta.tests && n.meta.tests.status === "fail") out.dots.push({ x: p.x + r + 3, y: p.y - r - 3, r: 2, fill: "#9E6B62" });
    } else {
      out.rings.push({ x: p.x, y: p.y, r, stroke: isSel || onPath ? "#4F7F5D" : n.type === "root" ? "#8B8B82" : "#55554E", sw: isSel ? 2 : 1.5, dash: "none", fill: VOID });
    }
    const fs = itemFontSize(it);
    out.labels.push({
      x: p.x + r + 6,
      y: p.y + fs * 0.32,
      anchor: "start",
      fs,
      fill: isSel || onPath ? "#74A583" : n.type === "file" ? "#8B8B82" : n.type === "root" ? "#E8E6E1" : "#A9A9A0",
      fw: isSel ? 600 : 400,
      label: itemLabel(it),
    });
  }
  if (mode === "feature") {
    const c = pos.get("apps/web/src/checkout");
    if (c) {
      out.rings.push({ x: c.x, y: c.y + 55, r: 150, stroke: "#4F7F5D", sw: 1.5, dash: "6 3", fill: "none" });
      out.labels.push({ x: c.x, y: c.y - 110, anchor: "middle", fs: 11.5, fill: "#74A583", fw: 600, label: "checkout" });
      out.labels.push({ x: c.x, y: c.y - 96, anchor: "middle", fs: 10.5, fill: "#64645C", fw: 400, label: "9 files · 3 open tickets · shipped 2d ago" });
    }
  }
  const b = layout.bounds;
  const focus = pos.get("apps/web/src/checkout") ?? { x: (b.minX + b.maxX) / 2, y: 0 };
  const vbH = b.maxY - b.minY + 110;
  const vbW = vbH * 1.05;
  out.vb = (focus.x - vbW / 2).toFixed(1) + " " + (b.minY - 55).toFixed(1) + " " + vbW.toFixed(1) + " " + vbH.toFixed(1);
  return out;
}

function buildRelations(): LensGraph {
  const kids = childrenOf("apps");
  const aggs = rollupScope("apps", { imports: true, calls: true });
  const n = kids.length;
  const R = 150;
  const pos = new Map<string, { x: number; y: number }>();
  kids.forEach((k, i) => {
    const ang = (i / n) * Math.PI * 2 - Math.PI / 2;
    pos.set(k.id, { x: Math.cos(ang) * R, y: Math.sin(ang) * R * 0.8 });
  });
  const out: LensGraph = { vb: "-260 -220 520 440", anchors: {}, edges: [], rings: [], dots: [], labels: [] };
  const sel = "apps/api";
  for (const a of aggs) {
    const p1 = pos.get(a.fromId);
    const p2 = pos.get(a.toId);
    if (!p1 || !p2) continue;
    const isOut = a.fromId === sel;
    const isIn = a.toId === sel;
    out.edges.push({ x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, stroke: isOut || isIn ? "#4F7F5D" : "#2B2B27", w: isOut ? 1.5 : 1, op: 1, dash: isIn ? "4 3" : "none" });
    out.labels.push({ x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 - 7, anchor: "middle", fs: 9.5, fill: "#64645C", fw: 400, label: String(a.count) });
  }
  for (const k of kids) {
    const p = pos.get(k.id)!;
    out.anchors[k.id] = { x: p.x, y: p.y };
    const isSel = k.id === sel;
    out.rings.push({ x: p.x, y: p.y, r: isSel ? 9 : 8, stroke: isSel ? "#4F7F5D" : "#55554E", sw: isSel ? 2 : 1.5, dash: "none", fill: VOID });
    out.labels.push({ x: p.x + 14, y: p.y + 4, anchor: "start", fs: 12, fill: isSel ? "#74A583" : "#A9A9A0", fw: isSel ? 600 : 400, label: k.name + "/" });
  }
  return out;
}

let cache: { g1: LensGraph; g2: LensGraph; g3: LensGraph } | null = null;

export function lensGraphs(): { g1: LensGraph; g2: LensGraph; g3: LensGraph } {
  if (!cache) {
    cache = {
      g1: buildRelations(),
      g2: buildTree("apps/web/src/checkout/PaymentForm.tsx", "lit"),
      g3: buildTree(null, "feature"),
    };
  }
  return cache;
}
