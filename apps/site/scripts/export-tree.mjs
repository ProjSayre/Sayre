// Dev-only export: the demo's initial filetree (default expansion, ghost rows,
// test badges) as two pixel-aligned PNGs sharing one layout pass and frame:
//   docs/design-system/filetree-graph.png          — nodes + edges only (no text)
//   docs/design-system/filetree-graph-labeled.png  — exact copy with dir/file names
// Made for video work: animate to the textless frame, then swap in the labeled
// one — geometry is identical, only text appears.
// Usage: npm run export-tree --workspace @sayre/site

import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { Resvg } from "@resvg/resvg-js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");        // apps/site
const repoRoot = path.resolve(root, "..", "..");                                       // repo root
const DESIGN_SYSTEM_DIR = path.join(repoRoot, "docs", "design-system");
const OUT_PLAIN = path.join(DESIGN_SYSTEM_DIR, "filetree-graph.png");
const OUT_LABELED = path.join(DESIGN_SYSTEM_DIR, "filetree-graph-labeled.png");
const OUT_BLANK = path.join(DESIGN_SYSTEM_DIR, "filetree-graph-blank.png");
const OUT_SVG = path.join(DESIGN_SYSTEM_DIR, "filetree-graph.svg");
const TARGET_WIDTH = 3200;
const PAD = 80;

// null = the demo's untouched first frame; set to a node id (e.g. the
// PaymentForm path) to light an ancestry like the OG money shot.
const SELECTED = null;

const C = {
  bg: "#131412",
  edge: "#2B2B27",
  nodeStroke: "#55554E",
  textFaint: "#64645C",
  textMuted: "#8B8B82",
  text: "#A9A9A0",
  accent: "#4F7F5D",
  accentText: "#74A583",
  testPass: "#74A583",
  testFail: "#9E6B62",
};

async function fetchFont() {
  const cacheDir = path.join(root, "scripts", ".fontcache");
  const ttfPath = path.join(cacheDir, "FragmentMono-Regular.ttf");
  if (existsSync(ttfPath)) return ttfPath;
  await mkdir(cacheDir, { recursive: true });
  const cssRes = await fetch("https://fonts.googleapis.com/css2?family=Fragment+Mono&display=swap", {
    headers: { "User-Agent": "curl/8.0" },
  });
  const css = await cssRes.text();
  const m = css.match(/url\((https:[^)]+\.ttf)\)/);
  if (!m) throw new Error("could not find a ttf url in the google fonts css");
  const ttf = await fetch(m[1]);
  await writeFile(ttfPath, Buffer.from(await ttf.arrayBuffer()));
  return ttfPath;
}

function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function main() {
  const server = await createServer({ root, server: { middlewareMode: true }, appType: "custom", logLevel: "error" });
  try {
    const data = await server.ssrLoadModule("/src/data/index.ts");
    const layoutMod = await server.ssrLoadModule("/src/demo/canvas/layout.ts");
    const { INITIAL_EXPANDED } = data;
    const { layoutFiletree, litSets, nodeRadius, itemLabel, itemFontSize } = layoutMod;

    // exactly what the demo renders on first load
    const layout = layoutFiletree(new Set(INITIAL_EXPANDED));
    const lit = SELECTED ? litSets(SELECTED) : { nodes: new Set(), edges: new Set() };

    const b = layout.bounds; // includes label extents — shared by both variants
    const w = b.maxX - b.minX + PAD * 2;
    const hgt = b.maxY - b.minY + PAD * 2;
    const tx = PAD - b.minX;
    const ty = PAD - b.minY;
    const pos = (id) => layout.positions.get(id);

    const render = (withText) => {
      let edges = "";
      let nodes = "";
      let texts = "";

      for (const item of layout.items) {
        if (!item.parentId) continue;
        const p = pos(item.parentId);
        const c = pos(item.id);
        if (!p || !c) continue;
        if (item.kind === "ghost") {
          // ghost edge stays in BOTH variants so geometry never shifts on swap
          edges += `<line x1="${p.x + tx}" y1="${p.y + ty}" x2="${c.x + tx}" y2="${c.y + ty}" stroke="${C.edge}" stroke-width="1" opacity="0.5"/>`;
          continue;
        }
        const isLit = lit.edges.has(`${item.parentId}→${item.id}`);
        edges += `<line x1="${p.x + tx}" y1="${p.y + ty}" x2="${c.x + tx}" y2="${c.y + ty}" stroke="${isLit ? C.accent : C.edge}" stroke-width="${isLit ? 1.5 : 1}"/>`;
      }

      for (const item of layout.items) {
        const c = pos(item.id);
        if (!c) continue;
        const cx = c.x + tx;
        const cy = c.y + ty;

        if (item.kind === "ghost") {
          if (withText) {
            texts += `<text x="${cx + 6}" y="${cy + 3.5}" font-size="10.5" fill="${C.textFaint}">${esc(item.label)}</text>`;
          }
          continue;
        }

        const node = item.node;
        const isSelected = item.id === SELECTED;
        const onPath = !isSelected && lit.nodes.has(item.id);
        const r = nodeRadius(item, isSelected);

        if (node.type === "file") {
          const fill = isSelected || onPath ? C.accent : C.nodeStroke;
          nodes += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}"/>`;
          if (node.meta.tests) {
            const badge = node.meta.tests.status === "pass" ? C.testPass : C.testFail;
            nodes += `<circle cx="${cx + r + 3}" cy="${cy - r - 3}" r="2" fill="${badge}"/>`;
          }
        } else {
          const stroke = isSelected || onPath ? C.accent : node.type === "root" ? C.textMuted : C.nodeStroke;
          nodes += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${C.bg}" stroke="${stroke}" stroke-width="${isSelected ? 2 : 1.5}"/>`;
        }

        if (withText) {
          const label = esc(itemLabel(item));
          const fs = itemFontSize(item);
          const fill = isSelected || onPath ? C.accentText : node.type === "file" ? C.textMuted : C.text;
          const x = cx + r + 6;
          const y = cy + fs * 0.32; // matches FiletreeView's baseline
          // halo pass first (manual paint-order: stroke), then the fill pass
          texts += `<text x="${x}" y="${y}" font-size="${fs}" fill="none" stroke="${C.bg}" stroke-width="3">${label}</text>`;
          texts += `<text x="${x}" y="${y}" font-size="${fs}" fill="${fill}">${label}</text>`;
        }
      }

      return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${hgt}" viewBox="0 0 ${w} ${hgt}" font-family="Fragment Mono">
  <rect width="${w}" height="${hgt}" fill="${C.bg}"/>${edges}${nodes}${texts}
</svg>`;
    };

    // browser-flavored standalone svg (for code-driven animation): same
    // geometry as the pngs, but structured — edges/nodes/labels grouped,
    // every element tagged with data-path + data-depth, styling in css.
    const r1 = (n) => Math.round(n * 10) / 10;
    const renderBrowserSvg = () => {
      let edges = "";
      let nodes = "";
      let labels = "";

      for (const item of layout.items) {
        if (!item.parentId) continue;
        const p = pos(item.parentId);
        const c = pos(item.id);
        if (!p || !c) continue;
        const attrs = `data-path="${esc(item.id)}" data-depth="${item.depth}"`;
        const coords = `x1="${r1(p.x + tx)}" y1="${r1(p.y + ty)}" x2="${r1(c.x + tx)}" y2="${r1(c.y + ty)}"`;
        if (item.kind === "ghost") {
          edges += `\n    <line class="edge edge--ghost" ${attrs} ${coords}/>`;
        } else {
          const isLit = lit.edges.has(`${item.parentId}→${item.id}`);
          edges += `\n    <line class="edge${isLit ? " edge--lit" : ""}" ${attrs} ${coords}/>`;
        }
      }

      for (const item of layout.items) {
        const c = pos(item.id);
        if (!c) continue;
        const cx = r1(c.x + tx);
        const cy = r1(c.y + ty);

        if (item.kind === "ghost") {
          labels += `\n    <text class="label label--ghost" data-path="${esc(item.id)}" data-depth="${item.depth}" x="${r1(c.x + tx + 6)}" y="${r1(c.y + ty + 3.5)}">${esc(item.label)}</text>`;
          continue;
        }

        const node = item.node;
        const isSelected = item.id === SELECTED;
        const onPath = !isSelected && lit.nodes.has(item.id);
        const r = nodeRadius(item, isSelected);
        const attrs = `data-path="${esc(item.id)}" data-depth="${item.depth}"`;
        const state = isSelected ? " is-selected" : onPath ? " is-onpath" : "";

        if (node.type === "file") {
          nodes += `\n    <circle class="node node--file${state}" ${attrs} cx="${cx}" cy="${cy}" r="${r}"/>`;
          if (node.meta.tests) {
            nodes += `\n    <circle class="badge badge--${node.meta.tests.status}" ${attrs} cx="${r1(cx + r + 3)}" cy="${r1(cy - r - 3)}" r="2"/>`;
          }
        } else {
          const kind = node.type === "root" ? "node--root" : "node--folder";
          nodes += `\n    <circle class="node ${kind}${state}" ${attrs} cx="${cx}" cy="${cy}" r="${r}"/>`;
        }

        const fs = itemFontSize(item);
        const kind = node.type === "file" ? "label--file" : "label--folder";
        labels += `\n    <text class="label ${kind}${state}" ${attrs} x="${r1(cx + r + 6)}" y="${r1(cy + fs * 0.32)}" font-size="${fs}">${esc(itemLabel(item))}</text>`;
      }

      return `<!-- sayre — acme/monorepo initial filetree (generated by apps/site/scripts/export-tree.mjs)
     geometry matches filetree-graph*.png exactly (png = this frame at ${TARGET_WIDTH}px wide).
     load Fragment Mono for exact text metrics:
     https://fonts.googleapis.com/css2?family=Fragment+Mono&display=swap -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${r1(w)} ${r1(hgt)}" font-family="Fragment Mono, ui-monospace, monospace">
  <style>
    .bg             { fill: #131412; }
    .edge           { stroke: #2B2B27; stroke-width: 1; }
    .edge--lit      { stroke: #4F7F5D; stroke-width: 1.5; }
    .edge--ghost    { opacity: 0.5; }
    .node--root     { fill: #131412; stroke: #8B8B82; stroke-width: 1.5; }
    .node--folder   { fill: #131412; stroke: #55554E; stroke-width: 1.5; }
    .node--file     { fill: #55554E; }
    .node.is-onpath.node--folder,
    .node.is-selected.node--folder { stroke: #4F7F5D; }
    .node.is-onpath.node--file,
    .node.is-selected.node--file   { fill: #4F7F5D; }
    .badge--pass    { fill: #74A583; }
    .badge--fail    { fill: #9E6B62; }
    .label          { paint-order: stroke; stroke: #131412; stroke-width: 3; }
    .label--folder  { fill: #A9A9A0; }
    .label--file    { fill: #8B8B82; }
    .label--ghost   { fill: #64645C; font-size: 10.5px; }
    .label.is-onpath, .label.is-selected { fill: #74A583; }
  </style>
  <rect class="bg" width="${r1(w)}" height="${r1(hgt)}"/>
  <g class="edges">${edges}
  </g>
  <g class="nodes">${nodes}
  </g>
  <g class="labels">${labels}
  </g>
</svg>
`;
    };
    await writeFile(OUT_SVG, renderBrowserSvg());

    const fontPath = await fetchFont();
    const opts = {
      fitTo: { mode: "width", value: TARGET_WIDTH },
      font: { fontFiles: [fontPath], loadSystemFonts: false, defaultFontFamily: "Fragment Mono" },
    };

    const plainImg = new Resvg(render(false), opts).render();
    await writeFile(OUT_PLAIN, plainImg.asPng());
    const labeled = new Resvg(render(true), opts).render().asPng();
    await writeFile(OUT_LABELED, labeled);

    // matching empty frame: same pixel dimensions, just the --bg fill
    const blankSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${plainImg.width}" height="${plainImg.height}"><rect width="${plainImg.width}" height="${plainImg.height}" fill="${C.bg}"/></svg>`;
    const blank = new Resvg(blankSvg).render().asPng();
    await writeFile(OUT_BLANK, blank);

    console.log(`wrote ${OUT_PLAIN}`);
    console.log(`wrote ${OUT_LABELED}`);
    console.log(`wrote ${OUT_BLANK}`);
    console.log(`frame: ${plainImg.width}×${plainImg.height}px, identical for all three`);
  } finally {
    await server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
