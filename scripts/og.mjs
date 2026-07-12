// Dev-only OG image renderer (spec §15). Renders the demo canvas at the curated
// state — PaymentForm.tsx selected, ancestry lit, wordmark bottom-left, on --bg —
// and writes public/og.png (1200×630). Run manually: `npm run og`, commit the output.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { Resvg } from "@resvg/resvg-js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const W = 1200;
const H = 630;

const COLORS = {
  bg: "#131412",
  edge: "#2B2B27",
  nodeStroke: "#55554E",
  textFaint: "#64645C",
  textMuted: "#8B8B82",
  text: "#A9A9A0",
  textBright: "#E8E6E1",
  accent: "#4F7F5D",
  accentText: "#74A583",
  testPass: "#74A583",
  testFail: "#9E6B62",
};

// ---------------------------------------------------------------------------
// fonts: Google serves TTF urls to a plain (non-browser) user agent
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// curated visible items — the mock's airy money shot, built from real data
// ---------------------------------------------------------------------------

function curatedItems(data) {
  const { NODE_BY_ID, CHILDREN } = data;
  const items = [];
  const push = (id, depth) => {
    const node = NODE_BY_ID.get(id);
    if (!node) throw new Error(`unknown node ${id}`);
    items.push({ kind: "node", id, node, parentId: node.parentId, depth });
  };
  const ghost = (parentId, depth, count) =>
    items.push({
      kind: "ghost",
      id: `${parentId}//ghost`,
      parentId,
      depth,
      count,
      label: `… ${count} more files`,
    });

  push("acme", 0);
  push("apps", 1);
  push("apps/admin", 2);
  push("apps/api", 2);
  push("apps/web", 2);
  push("apps/web/src", 3);
  push("apps/web/src/checkout", 4);
  for (const child of CHILDREN.get("apps/web/src/checkout") ?? []) push(child.id, 5);
  ghost("apps/web/src", 4, 136);
  push("packages", 1);
  push("packages/config", 2);
  push("packages/core", 2);
  push("packages/ui", 2);
  push("services", 1);
  push("services/search-indexer", 2);
  push("tools", 1);
  return items;
}

// ---------------------------------------------------------------------------

function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function main() {
  const server = await createServer({ root, server: { middlewareMode: true }, appType: "custom", logLevel: "error" });
  try {
    const data = await server.ssrLoadModule("/src/data/index.ts");
    const layoutMod = await server.ssrLoadModule("/src/demo/canvas/layout.ts");
    const { layoutItems, litSets, nodeRadius, itemLabel, itemFontSize } = layoutMod;

    const SELECTED = "apps/web/src/checkout/PaymentForm.tsx";
    const items = curatedItems(data);
    const layout = layoutItems(items);
    const lit = litSets(SELECTED);

    const b = layout.bounds;
    const pad = 70;
    const k = Math.min((W - pad * 2) / (b.maxX - b.minX), (H - pad * 2) / (b.maxY - b.minY), 1);
    const tx = W / 2 - k * (b.minX + b.maxX) / 2;
    const ty = H / 2 - k * (b.minY + b.maxY) / 2;

    const pos = (id) => layout.positions.get(id);
    let edges = "";
    let nodes = "";

    for (const item of items) {
      if (!item.parentId) continue;
      const p = pos(item.parentId);
      const c = pos(item.id);
      if (!p || !c) continue;
      if (item.kind === "ghost") {
        edges += `<line x1="${p.x}" y1="${p.y}" x2="${c.x}" y2="${c.y}" stroke="${COLORS.edge}" stroke-width="1" opacity="0.5"/>`;
        continue;
      }
      const isLit = lit.edges.has(`${item.parentId}→${item.id}`);
      edges += `<line x1="${p.x}" y1="${p.y}" x2="${c.x}" y2="${c.y}" stroke="${isLit ? COLORS.accent : COLORS.edge}" stroke-width="${isLit ? 1.5 : 1}"/>`;
    }

    for (const item of items) {
      const c = pos(item.id);
      if (!c) continue;
      if (item.kind === "ghost") {
        nodes += `<text x="${c.x + 6}" y="${c.y + 3.5}" font-size="10.5" fill="${COLORS.textFaint}">${esc(item.label)}</text>`;
        continue;
      }
      const node = item.node;
      const isSelected = item.id === SELECTED;
      const onPath = !isSelected && lit.nodes.has(item.id);
      const r = nodeRadius(item, isSelected);
      const label = itemLabel(item);
      const fs = itemFontSize(item);
      const labelFill = isSelected || onPath ? COLORS.accentText : node.type === "file" ? COLORS.textMuted : COLORS.text;

      if (node.type === "file") {
        const fill = isSelected || onPath ? COLORS.accent : COLORS.nodeStroke;
        nodes += `<circle cx="${c.x}" cy="${c.y}" r="${r}" fill="${fill}"/>`;
        if (node.meta.tests) {
          const badge = node.meta.tests.status === "pass" ? COLORS.testPass : COLORS.testFail;
          nodes += `<circle cx="${c.x + r + 3}" cy="${c.y - r - 3}" r="2" fill="${badge}"/>`;
        }
      } else {
        const stroke = onPath || isSelected ? COLORS.accent : node.type === "root" ? COLORS.textMuted : COLORS.nodeStroke;
        const sw = isSelected ? 2 : 1.5;
        nodes += `<circle cx="${c.x}" cy="${c.y}" r="${r}" fill="${COLORS.bg}" stroke="${stroke}" stroke-width="${sw}"/>`;
      }
      nodes += `<text x="${c.x + r + 6}" y="${c.y + fs * 0.35}" font-size="${fs}" fill="${labelFill}">${esc(label)}</text>`;
    }

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="Fragment Mono">
  <rect width="${W}" height="${H}" fill="${COLORS.bg}"/>
  <g transform="translate(${tx}, ${ty}) scale(${k})">${edges}${nodes}</g>
  <text x="28" y="${H - 26}" font-size="20" fill="${COLORS.textBright}">sayre_</text>
  <text x="${W - 28}" y="${H - 26}" font-size="12" fill="${COLORS.textFaint}" text-anchor="end">your codebase, mapped · sample data</text>
</svg>`;

    const fontPath = await fetchFont();
    const resvg = new Resvg(svg, {
      font: { fontFiles: [fontPath], loadSystemFonts: false, defaultFontFamily: "Fragment Mono" },
    });
    const png = resvg.render().asPng();
    const out = path.join(root, "public", "og.png");
    await writeFile(out, png);
    console.log(`wrote ${out} (${png.length} bytes)`);
  } finally {
    await server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
