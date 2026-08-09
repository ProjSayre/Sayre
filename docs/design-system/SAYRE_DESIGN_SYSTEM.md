# Sayre Design System — "Warm Graphite"

Design spec for Sayre, a codebase-visualization tool (filetree / feature graph / relational graphs) for eng teams. Dark-first, professional, calm — a productivity tool, not a neon toy. Derived from approved mock **4d**.

---

## 1. Color palette

Warm neutral darks (slightly brown-tinted grays, never blue) with a single subdued olive-moss green accent. Chroma is deliberately low everywhere; the accent is reserved for selection/active state and never used decoratively.

### Core tokens

| Token | Hex | Use |
|---|---|---|
| `--bg` | `#131412` | App / canvas background |
| `--bg-raised` | `#1B1C19` | Panels, cards, inputs, hover fills |
| `--border` | `#262723` | All hairline borders and dividers |
| `--edge` | `#2B2B27` | Default graph edge lines |
| `--node-stroke` | `#55554E` | Default node outlines / file dots |
| `--text-faint` | `#64645C` | Metadata, status bar, shortcuts |
| `--text-muted` | `#8B8B82` | Secondary text, inactive tabs, file labels |
| `--text` | `#A9A9A0` | Directory labels on canvas |
| `--text-bright` | `#E8E6E1` | Primary text, headings, root node, active tab (warm white — never pure #FFF) |
| `--accent` | `#4F7F5D` | Olive-moss. Selection, active path, primary buttons |
| `--accent-text` | `#74A583` | Accent-colored text/labels (lighter for legibility on dark bg) |

Rules:
- Background tint is warm (green-brown), not blue-gray. If generating new neutrals, stay in that family (oklch hue ~110–130, chroma ≤ 0.01).
- One accent only. No secondary accent colors. Semantic colors (errors etc.) should be similarly desaturated if needed later.
- Accent-on-dark text uses `--accent-text`, not raw `--accent` (too dark for small text).
- Accent fills use `--accent` with `--text-bright`-family text (e.g. `#EDECE7`) on top.

## 2. Typography

| Role | Font | Notes |
|---|---|---|
| UI / headings / labels | **Familjen Grotesk** (Google Fonts) | 400, 500, 600. Tab labels & UI chrome at 500. |
| Code, paths, metrics, canvas node labels | **Fragment Mono** (Google Fonts) | 400 only (single weight); "bold" node labels use fill color + font-weight 600 (synthesized) sparingly. |

Rules:
- Everything on the graph canvas (node names, stats, zoom readout) is Fragment Mono.
- App chrome (tabs, buttons, panel headings, body copy) is Familjen Grotesk.
- Sizes used in the mock: logo/wordmark 14px mono; tabs 13px; canvas directory labels 11.5px; file labels 11px; status bar 10.5px; metadata 11px mono. Scale up proportionally for larger canvases, but keep canvas labels small and quiet.
- Wordmark is lowercase mono: `sayre_` in `--text-bright`.

## 3. Graph language (the core of the product)

### Layout
- Trees are **vertical**: root at top center, children fan out below, leaf files at the bottom row.
- **Edges are straight lines, node-center to node-center — no 90° elbows, no bezier curves.** Draw edges first, nodes painted on top (nodes have opaque `--bg` fill so lines don't pass through).

### Nodes
Node shape encodes type; size encodes depth/importance:

| Node type | Shape | Spec |
|---|---|---|
| Root directory | Large open circle | r=8, fill `--bg`, stroke `--text-muted` 1.5px |
| Directory | Open circle | r=6–7, fill `--bg`, stroke `--node-stroke` 1.5px |
| File (leaf) | Small closed dot | r=4.5, fill `--node-stroke`, no stroke |
| Selected directory | Open circle | r=8, fill `--bg`, stroke `--accent` 2px |
| Selected file | Closed dot | r=5, fill `--accent` |

- Open (hollow) = container/directory; closed (filled) = file/leaf. Keep this distinction everywhere, including legends and sidebars.
- Larger radius = higher in hierarchy. Don't exceed ~r=10 for normal nodes.

### Labels
- Labels sit **outside the node, to the right**: x offset ≈ node radius + 6px, vertically centered on the node (baseline ≈ node cy + 4 at 11.5px).
- Directories: `--text`, 11.5px mono, names end with `/` (e.g. `packages/`).
- Files: `--text-muted`, 11px mono, full filename with extension.
- Selected/active labels: `--accent-text`, weight 600.
- Never draw an edge through a label; edges terminate at node centers and labels live to the right, clear of vertical descent lines.

### Edges
- Default: `--edge`, 1px.
- Active/selected path (root → selected node → its children): `--accent`, 1.5px. The entire ancestry path lights up, not just one edge.

### Canvas
- Plain `--bg` background — **no dot grid, no texture**.
- Bottom-left status line, Fragment Mono 10.5px `--text-faint`: e.g. `zoom 100% · tree layout · depth 4`.

## 4. App chrome

### Top bar
- Height ~44px, `--bg` with 1px `--border` bottom, horizontal padding 18px.
- Left → right: wordmark `sayre_` (mono, `--text-bright`) · view tabs · right-aligned repo metadata (mono 11px `--text-faint`, middot-separated: `acme/monorepo · 1,204 files`).

### Tabs (view switcher: Filetree / Features / Relations)
- Text-only, Familjen Grotesk 13px weight 500, gap 20px.
- Active: `--text-bright` with a 5px `--accent` dot to its left (7px gap).
- Inactive: `--text-muted`, no dot. No boxes, pills, or underlines.

### Buttons
- Primary: `--accent` bg, `#EDECE7` text, 4px radius, Familjen Grotesk 500.
- Secondary: transparent bg, 1px `--node-stroke` border, `--text-bright` text, 4px radius.

### Panels / cards
- `--bg-raised` or `--bg` with 1px `--border`, radius 8px. Shadows minimal or none — hierarchy comes from borders and fills, not elevation.

## 5. Voice & general feel

- Quiet, precise, engineer-first. Density over decoration.
- Color appears only where it means something (selection, active path, live status).
- No gradients, no glows, no emoji, no rounded-pill UI. Corners 4–8px max.
- Metadata is middot-separated mono strings (`89 modules · 214 edges`), lowercase where natural.

## 6. Font loading

```html
<link href="https://fonts.googleapis.com/css2?family=Familjen+Grotesk:wght@400;500;600;700&family=Fragment+Mono&display=swap" rel="stylesheet">
```
