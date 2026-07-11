# Sayre — Marketing Site + Interactive Demo
## One-Shot Frontend Spec · v1.2

**Status:** draft for iteration
**Changelog:** v1.1 = v1 + 26 verified review findings. v1.2 = Features view redesigned (feature-as-node with bundled path expansion), Relations view redesigned (scoped drill-down graph), permanent IDE-style left tree panel, persona→tab mapping made fully diagonal, initial load = tech lead on filetree; + 12 post-rewrite verification fixes (tour reachability, rollup direction semantics, feature-node label geometry, schema `workspaces` field, stale v1.1 references).
**Date:** 2026-07-11
**Inputs:**
- `Design System/SAYRE_DESIGN_SYSTEM.md` — visual source of truth ("Warm Graphite")
- `Design System/Sayre Directions-selection.png` — approved mock 4d (canvas density/proportions reference)
- `Documents/PRD/PRD V1.pdf` — the full product this site sells (we are NOT building the product)

Where this spec quantifies something the design system leaves open, this spec wins. Where they conflict, the design system wins.

---

## 0. What this is — and is not

**This is** a static marketing website with a fully client-side, interactive, staged demo of Sayre — an AI-powered codebase visualization platform whose MVP does not exist yet. The site's job is lead generation: it gets linked in cold emails, and its conversion action is a waitlist signup.

**This is not** the product. There is no backend, no auth, no repo parsing, no live AI. Everything the demo shows runs on a hand-authored, fictional dataset baked into the bundle. All "AI-generated" content (descriptions, summaries, feature groupings) is pre-written canned content. Nothing in the UI may pretend to accept a real repository — the "want this on your codebase?" path always routes to the waitlist.

**Decisions already made (do not relitigate):**
1. Demo includes all three views — **Filetree** (the mock's tree), **Features** (feature-as-node), **Relations** (scoped drill-down relationship graph) — plus a permanent IDE-style left tree panel on desktop.
2. Dataset is a **fictional monorepo** (`acme/monorepo`), hand-crafted so every click tells a story.
3. Conversion = **email waitlist form** (no-backend form service).
4. AI content is **canned only** — zero runtime API calls.
5. **Persona switcher** ("view as") pre-selects sidebar layer checkmarks AND jumps to the role's home tab. The mapping is fully diagonal — **new hire → relations, tech lead → filetree, product manager → features** — so a skimmer flipping roles always sees the canvas change shape, never just checkboxes. Initial load: **tech lead on filetree** (the mock's money shot, test badges on; the cold-email reader usually *is* a tech lead).
6. Guided tour is **prompt-first** (a chip offers it; never auto-plays).
7. Stretch features are all IN: ⌘K fuzzy file search, test pass/fail badges, feature progress stats.
8. **Features view** = large dashed feature nodes sized by how many directories they wrap (capped), with bundled dir/file glyphs inside; bundled glyphs expand to reveal full file paths (the cross-directory proof).
9. **Relations view** = per-directory relationship graph with drill-down: the current scope's children and the aggregate edges between them, rolled up from file-level imports/calls; click into a dir to re-scope one level down.

---

## 1. Goals & definition of done

A cold-email recipient with 60 seconds of attention should, on `/demo`:
1. Immediately see a beautiful living graph (not a screenshot, not a video).
2. Click things and feel real product mechanics (selection, ancestry lighting, expand/collapse, sidebar).
3. Hit the persona moment — switch roles, watch the checkmarks and view change — and understand "different people read the same codebase differently, and this tool encodes that."
4. Have a one-click path to the waitlist without leaving the demo.

**Done means:** all acceptance checklist items (§18) pass; the site builds statically with zero console errors; the demo runs at 60fps pan/zoom on a mid-range laptop; every canned datum renders somewhere reachable.

---

## 2. Tech stack & constraints

| Concern | Choice | Notes |
|---|---|---|
| Framework | **Vite + React 18 + TypeScript** | SPA, static build, no SSR |
| Routing | `react-router-dom` | Routes: `/`, `/demo`. SPA fallback rewrite required (see §15) |
| Canvas | **Hand-rolled SVG** | ~250 authored nodes max — SVG is crisp, styleable with CSS tokens, accessible. No React Flow / Cytoscape / Sigma |
| Tree layout | `d3-hierarchy` (`tree()` / Reingold–Tilford) | Layout math only. No other d3 modules except `d3-zoom` (optional; hand-rolled pan/zoom also acceptable) |
| State | Plain React — one context + `useReducer` for demo state | No Redux/zustand/etc. |
| Styling | Vanilla CSS with custom properties | Tokens map 1:1 to the design system. No Tailwind, no CSS-in-JS |
| Fonts | Exact CSS2 link (DS §6 with the unused 700 weight dropped): `https://fonts.googleapis.com/css2?family=Familjen+Grotesk:wght@400;500;600&family=Fragment+Mono&display=swap` | Familjen Grotesk 400/500/600 + Fragment Mono 400 (single weight — never synthesize mono bold in chrome). `display=swap`, preconnect |
| Search | Hand-rolled subsequence fuzzy matcher | No fuse.js |
| Forms | Formspree-style POST endpoint | Placeholder const in `src/config.ts` |
| Deploy | Any static host (Vercel/Netlify) | `npm run build` → `dist/` |

**Dependency budget (hard cap — runtime bundle only):** `react`, `react-dom`, `react-router-dom`, `d3-hierarchy`, `d3-zoom`. Nothing else at runtime. devDependencies for tooling/scripts (e.g., the OG generator, §15) are unrestricted. JS bundle ≤ 250 KB gzipped.

`src/config.ts`:
```ts
export const WAITLIST_ENDPOINT = "";        // TODO: Formspree/Tally endpoint. Empty: dev = log + fake success; PRODUCTION = mailto fallback, never fake success (§12)
export const CONTACT_EMAIL = "hello@sayre.dev"; // TODO: confirm domain
export const SITE_URL = "https://sayre.dev";    // TODO: confirm — used for OG tags
export const PLAUSIBLE_DOMAIN = "";         // optional analytics; empty = no script injected
```

---

## 3. Information architecture

```
/            Landing page (hero + teaser canvas + persona sections + how-it-works + deep dives + waitlist + footer)
/demo        Full-screen demo (the app itself, staged). Deep-linkable — this is the cold-email URL.
```

- `/demo` renders the complete demo chrome edge-to-edge: top bar, canvas, sidebar, status bar. No marketing furniture except one small `get early access` button in the top bar.
- Landing embeds the *same canvas component* in attract mode as the hero teaser (§11).
- Unknown routes redirect to `/`.

---

## 4. Design language

### 4.1 Tokens (verbatim from design system — implement as CSS custom properties on `:root`)

```css
--bg: #131412;          /* app/canvas background */
--bg-raised: #1B1C19;   /* panels, cards, inputs, hover fills */
--border: #262723;      /* hairline borders, dividers */
--edge: #2B2B27;        /* default graph edges */
--node-stroke: #55554E; /* node outlines / file dots */
--text-faint: #64645C;  /* metadata, status bar, shortcuts */
--text-muted: #8B8B82;  /* secondary text, inactive tabs, file labels */
--text: #A9A9A0;        /* directory labels on canvas */
--text-bright: #E8E6E1; /* primary text, headings, active tab */
--accent: #4F7F5D;      /* olive-moss: selection, active path, primary buttons */
--accent-text: #74A583; /* accent-colored text on dark bg */
--accent-btn-text: #EDECE7; /* text on accent fills */
```

**New tokens this spec adds** (desaturated semantics, per design system rule "semantic colors should be similarly desaturated"):

```css
--test-pass: #74A583;   /* same as --accent-text */
--test-fail: #9E6B62;   /* warm desaturated red — used ONLY for test-fail badges + form errors */
```

Rules that bind everything below: one accent; no gradients, glows, emoji, or pill UI; corners 4–8px; hierarchy via borders/fills, not shadows; warm neutrals only (oklch hue 110–130, chroma ≤ 0.01 for any new neutral).

### 4.2 Typography

- UI chrome & landing copy: **Familjen Grotesk** (400/500/600).
- Everything on canvas + all metadata strings + code/paths/tickets: **Fragment Mono** 400.
- Demo sizes per design system: tabs 13px/500; canvas directory labels 11.5px; file labels 11px; status bar 10.5px; metadata 11px mono; wordmark `sayre_` 14px mono `--text-bright`.
- Landing type scale (new): display 48px/1.1/600 (`--text-bright`); h2 28px/1.2/600; h3 18px/1.3/500; body 16px/1.6/400 (`--text-muted`, key sentences `--text`); eyebrow 12px mono uppercase-free (`--text-faint`, letter-spacing 0.04em). Mobile display: 34px.
- Voice: quiet, precise, engineer-first, lowercase where natural. All demo UI strings are lowercase. Landing headings use sentence case.

### 4.3 Shared components

- **Primary button:** `--accent` bg, `--accent-btn-text` text, 4px radius, Familjen 500 14px, padding 9px 16px. Hover: brighten bg ~6% (e.g. `#588a67`). No shadows.
- **Secondary button:** transparent, 1px `--node-stroke` border, `--text-bright`, same metrics. Hover: `--bg-raised` fill.
- **Input:** `--bg-raised`, 1px `--border`, 4px radius, mono 13px, `--text-bright`; placeholder `--text-faint`. Focus: border `--accent`, no glow ring.
- **Modal/panel:** `--bg-raised`, 1px `--border`, 8px radius, no shadow (a 1px border on `--bg` backdrop is enough); backdrop `rgba(19,20,18,0.7)`.
- **Chip (tickets, tags):** mono 10.5px, 1px `--border`, 4px radius, padding 2px 6px, `--text-muted`.

---

## 5. Demo dataset

One TypeScript module tree under `src/data/`. No fetches — imported statically.

### 5.1 Schema

```ts
export type Tab = "filetree" | "features" | "relations";
export type NodeType = "root" | "folder" | "file";

export interface RepoNode {
  id: string;              // path-like, stable: "apps/web/src/checkout/PaymentForm.tsx"
  name: string;            // display name; folders rendered with trailing "/"
  type: NodeType;
  parentId: string | null; // null only for root
  fileCount?: number;      // folders only: TOTAL files contained (incl. unauthored) — drives ghost rows + top-bar total
  expandedByDefault?: boolean;
  meta: NodeMeta;
}

export interface NodeMeta {
  description?: string;         // canned "AI-generated" summary, 1–2 sentences
  loc?: number;                 // files only
  lang?: string;                // "ts" | "tsx" | "css" | ...
  owners?: string[];            // Person ids
  recentChanges?: Change[];     // newest first, max 3
  dependencies?: Dependency[];
  featureIds?: string[];
  ticketIds?: string[];
  agentMd?: string;             // markdown, 4–10 lines
  tests?: { status: "pass" | "fail"; coveredBy: string[] }; // coveredBy = test file paths (COVERS edges)
}

export interface Change { sha: string; message: string; author: string; when: string; pr?: number; }
export interface Dependency { name: string; kind: "tool" | "package"; install?: string; } // install = copyable command
export interface RepoEdge { from: string; to: string; kind: "imports" | "calls"; }        // files only
export interface Feature {
  id: string; name: string; description: string; team: string;
  memberIds: string[];     // FILE node ids only (dirs are implied via parents) — keeps every derived count unambiguous
  workspaces: string[];    // authored display grouping, e.g. ["apps/web", "apps/api", "packages"] — renders as "3 workspaces"
  stats: { openTickets: number; mergedPrs: number; lastShip: string }; // e.g. lastShip: "2d ago"
  recentEdits: Change[];   // authored, newest first, exactly 3 — feeds §8.4 block 5; do NOT derive from member nodes
  ticketIds: string[];
}
export interface Ticket { id: string; source: "linear" | "jira"; title: string; status: "open" | "in progress" | "done"; }
export interface Person { id: string; name: string; handle: string; }
```

### 5.2 Authoring requirements

- **Scale:** ~200–250 authored nodes. Root `fileCount` = **1,204** (matches the approved mock's top bar). Folder `fileCount`s must be internally consistent (children's counts + ghost remainder sum to parent).
- **Ghost rows:** a folder whose `fileCount` exceeds its authored file descendants renders one final pseudo-child label: `… 37 more files` — Fragment Mono 10.5px `--text-faint`, no node dot, not selectable, not searchable, excluded from layout edge drawing except its single faint parent edge at 50% opacity. This is how 250 authored nodes honestly present as a 1,204-file repo.
- **Two content tiers:**
  - **Hero nodes (~30 files + ~12 folders):** full `NodeMeta` — description, owners, 2–3 recent changes, dependencies where sensible, features, tickets, agentMd, tests. Every node the tour touches is a hero node. Every expanded-by-default subtree contains only hero or standard nodes.
  - **Standard nodes (everything else):** at minimum `description` + `owners` + `loc`/`lang`. Missing layers render honest empty states (§8.3) — this reads as realism, not gaps.
- **Edges:** 50–70 `RepoEdge`s among hero files, including ~10 `calls` edges modeling runtime HTTP flows (`useCheckout.ts` → `payments.ts`, `SearchPage` → `search.ts`, `SettingsPage` → `auth.ts`, admin's `OrdersTable.tsx` → `orders.ts`) so the frontend-calls-backend story exists when Relations rolls edges up. One high fan-in node: `packages/core/src/currency.ts`, exactly 6 in · 1 out (A.1).
- **Drill-path richness:** every dir on the curated Relations drill path — `acme/` (root), `apps/`, `packages/core/src/` (currency→flags plus currency.test→currency), `apps/api/src/routes/` (via a shared `middleware.ts` the route files import) — must show ≥2 intra-scope aggregate edges; `packages/` shows exactly 1 (ui → core, e.g. `packages/ui/src/Button.tsx` → `packages/core/src/analytics.ts` — do NOT route it through currency.ts, whose 6 importers are pinned in A.1). `tools/` is intentionally isolated (quiet realism, and it demos the `no detected relations at this level` state).
- **Edge directionality rule:** author edges so no sibling pair at any authored scope has aggregate edges in both directions — a Relations line's direction must always be unambiguous (§7.5).
- **Features:** exactly 4 clusters (§A.2); at least 3 span ≥ 2 top-level directories — the PRD's core claim is that features cross folder boundaries. (`design-system` intentionally lives entirely in `packages/ui`; a boundary that happens to coincide with a folder is part of the realism.)
- **Tests:** ~20 hero files carry `tests`; exactly 2 are `fail` (visual interest without looking broken). Every path in any `tests.coveredBy` must itself be an authored file node (e.g., `packages/core/src/currency.test.ts` beside `currency.ts`; the two failing files' test files sit in their same directories) — §8.2 makes these paths clickable, so unauthored targets would be dead clicks. Test files count toward the node budget and are ⌘K-searchable.
- The full story bible — directory structure, feature definitions, people, tickets, sample copy — is **Appendix A**. The builder authors the dataset to that bible; invented filler must stay consistent with it.

---

## 6. Demo shell

Full-viewport dark app. Four fixed regions + canvas:

```
┌──────────────────────────────────────────────────────────────────────┐
│ top bar (44px)                                                       │
├────────────┬───────────────────────────────────┬─────────────────────┤
│ tree panel │                                   │ sidebar (320px)     │
│ (240px)    │ canvas (SVG, pan/zoom)            │                     │
│            │                                   │                     │
│            │ status line (floats bottom-left)  │                     │
└────────────┴───────────────────────────────────┴─────────────────────┘
```

### 6.1 Top bar
44px, `--bg`, 1px `--border` bottom, 18px horizontal padding. Left → right:
1. Wordmark `sayre_` — mono 14px `--text-bright`. Clicking it on `/demo` goes to `/`.
2. **Tabs:** `filetree · features · relations` styled per design system: text-only Familjen 13px/500, 20px gap; active = `--text-bright` + 5px `--accent` dot 7px to its left; inactive = `--text-muted`. No underlines/pills.
3. Right-aligned group (12px gaps, vertically centered):
   - **Persona switcher:** mono 11px `--text-faint` label `view as` + a borderless select-style control showing current role in `--text` (`tech lead ▾`). Opens a small `--bg-raised` menu (1px `--border`, 4px radius) listing `new hire / tech lead / product manager`, active row marked with the 5px accent dot. Keyboard accessible.
   - **Repo metadata:** mono 11px `--text-faint`: `acme/monorepo · 1,204 files`.
   - **CTA:** primary button, small variant (12.5px, padding 6px 12px): `get early access`. Opens the waitlist modal (§12) — the demo never navigates away to convert.

### 6.2 Status line
Floating bottom-left over canvas, 16px inset. Fragment Mono 10.5px `--text-faint`. Content per tab:
- filetree: `zoom 100% · tree layout · depth 4`  (zoom live; depth = deepest currently-expanded level)
- features: `zoom 100% · 4 features · 27 files`  (computed from authored feature members — never hardcoded)
- relations: `relations · acme/ › apps/ · 3 nodes · 2 edges · imports + calls` (scope path + counts, computed) — when a file is selected, append its global counts: `currency.ts · 6 in · 1 out` (filenames render verbatim)

Appended on all tabs, separated by ` · `: `sample data` in `--text-faint`. (Honesty marker; quiet but present.)

### 6.3 Sidebar
320px fixed right, `--bg` with 1px `--border` left. Scrollable. Contents in §8.

### 6.4 Canvas
SVG filling remaining space. Pan (drag), zoom (wheel/pinch, cursor-anchored), range 40%–250%. Double-click empty canvas = zoom-to-fit (40px padding). Keyboard: `+`/`-` zoom, `0` fit, `⌘K`/`Ctrl+K` search. Fit-on-mount; re-fit on tab switch.

Render order (back → front): edges → nodes → labels → test badges → flyouts.

### 6.5 Left tree panel (all tabs)
The IDE-style compact navigator — the way to reach a specific dir or file without touching the graphs.
- 240px fixed left, `--bg`, 1px `--border` right, independent scroll.
- Rows 24px tall, mono 11.5px, indent 14px per depth; dirs in `--text` with trailing `/`, files `--text-muted`; ghost `… n more files` rows render here too (non-interactive, `--text-faint`). Hover: `--bg-raised` fill. Selected row: `--accent-text` text + 2px `--accent` left inset bar. Auto-scrolls the selection into view.
- **Shares `expandedIds` and selection with the canvas** — clicking a dir here runs the same reducer as clicking it on the filetree canvas (select + toggle expand), so panel and canvas can never desync. The panel uses these filetree semantics on **every** tab — it never drills or re-scopes on dir clicks (a panel-selected dir outside the relations scope is covered by §7.5's out-of-scope rule).
- Clicking a file selects it; the canvas responds per tab: **filetree** → camera flies to the node; **features** → the containing feature node accents and the file's bundled dot lights; **relations** → re-scope to the file's parent dir, then select.
- Collapse/expand: `[` key or a mono `«`/`»` control at the panel's top-right. Auto-collapsed at 900–1100px viewport width; hidden entirely < 900px (bottom sheet + search cover navigation there).
- a11y: `role="tree"`/`treeitem` with `aria-expanded`, WAI-ARIA tree keyboard pattern (arrows navigate, Enter activates).

---

## 7. The three views

The three tabs are three different projections of the same dataset: **filetree** renders the full tree, **features** renders feature-as-node, **relations** renders one directory scope at a time. Node selection, expansion state, relations scope, and persona persist across tab switches; feature selection is Features-tab-scoped (§7.4); the camera does **not** persist — it re-fits on every tab switch (§6.4).

### 7.1 Layout (filetree; node/label rules apply to all tabs)
- Vertical tidy tree (`d3.tree()`), root top-center, leaves toward the bottom, per design system §3.
- Collapsed folders contribute nothing below them. Expanding/collapsing animates positions 250ms ease-out (disabled under reduced motion).
- Node separation must guarantee: **no label ever collides with another label, node, or edge at 100% zoom.** Use `tree().nodeSize([x, y])` with x sized from the widest label in the row-pair plus 24px margin; y ≈ 110px. Tune to match the mock's airy density.
- Edges: straight lines, node-center to node-center, `--edge` 1px. Nodes have opaque `--bg` fill so edges never pass through. **No elbows, no curves — anywhere.**

### 7.2 Nodes (all tabs, per design system)

| State | Spec |
|---|---|
| Root | open circle r=8, fill `--bg`, stroke `--text-muted` 1.5px |
| Folder | open circle r=6.5, fill `--bg`, stroke `--node-stroke` 1.5px |
| File | closed dot r=4.5, fill `--node-stroke` |
| Selected folder | r=8, stroke `--accent` 2px |
| Selected file | r=5, fill `--accent` |
| Hover (non-selected) | stroke/fill lightens to `--text-muted`; label lightens one step; cursor pointer |

Labels right of node: x = radius + 6px, vertically centered. Folders `--text` 11.5px mono with trailing `/`; files `--text-muted` 11px mono full filename. Selected label `--accent-text` weight 600 (synthesized).

**Selection & ancestry lighting** (per design system §3, which wins where the mock differs):
- Edges on the path root → … → selected node, plus the edges selected → each direct child: `--accent` 1.5px. The *entire* ancestry lights, not just one edge.
- Selected node: selected styling from the state table; label `--accent-text` weight 600.
- Other nodes on the lit path (ancestors and direct children): folders get an `--accent` ring 1.5px, files an `--accent`-filled dot at normal radius; their labels `--accent-text` weight 400.
- Everything off-path is unchanged.

With `render.ts` selected this reproduces the mock's moment — `viz-core/` with accent ring + accent label, `render.ts` lit; the mock's unlit root edge is superseded by the design system's "entire ancestry path lights up" rule.

**Interaction:**
- Click file → select.
- Click collapsed folder → select + expand.
- Click already-selected expanded folder → collapse (keeps selection).
- Click empty canvas → deselect.
- (These click semantics govern the filetree canvas and the tree panel on every tab; on the Relations *canvas* only, the second click on a selected dir drills instead of collapsing — §7.5. The panel never drills.)
- Keyboard (when canvas focused): `←`/`→` previous/next sibling, `↑` parent, `↓` first child, `Enter` toggle folder expansion. Selection changes scroll/pan the node into view if off-screen. Focus ring: 1px `--accent` dotted outline offset 3px (SVG), only under keyboard navigation.

**Initial state:** the expanded set is exactly: `acme/`, `apps/`, `apps/web/`, `apps/web/src/`, `apps/web/src/checkout/`, `packages/`, `services/`, `services/search-indexer/`, `services/search-indexer/src/`. Everything else (`apps/api/`, `apps/admin/`, `packages/ui|core|config`, `tools/`) starts collapsed. Yields ≈35 visible nodes at ~depth 4 and puts both failing-test files (`useCheckout.ts`, `retry.ts`) on screen per §7.3. Nothing selected on load.

### 7.3 Filetree
Exactly the above. Plus the **tests overlay** when its layer toggle (§8) is on: files with `meta.tests` get a badge dot of r=2 (4px diameter) centered at (R+3, −R−3) from node center, where R is the node radius — `--test-pass` or `--test-fail`. Folders show nothing. The 2 failing files should sit in expanded-by-default paths so Tech Lead persona (tests preset ON) sees red immediately.

### 7.4 Features
Feature-as-node view — no tree on this canvas. Features render as first-class shapes (PRD §4.7's grouping, restaged):
- **Feature nodes:** exactly 4 large open circles, 1px dashed (`6 3`) `--node-stroke` stroke, opaque `--bg` fill. Resting radius `R = clamp(34 + 7 × dirCount, 40, 62)` px, where `dirCount` = distinct parent directories of the member files (`memberIds` are file-only — §5.1): checkout 4 → 62, search 3 → 55, auth 3 → 55, design-system 1 → 41. Size encodes how much of the repo the feature wraps, capped so nothing balloons. The hollow-equals-container language extends to feature scale.
- **Layout:** deterministic 2×2 arrangement centered in the viewport (checkout top-left, search top-right, auth bottom-left, design-system bottom-right); vertical row gap ≥48px, horizontal column gap = `max(48px, widest left-column label width + 36px)` so labels never reach the right-column rings (label widths measured/analytic per §16); fit on tab entry.
- **Bundled glyphs** inside each feature node: each spanned dir = a small open circle r=5 (`--node-stroke` 1.25px) evenly placed on an inner ring at 0.55R; that dir's member files = filled dots r=2.5 (`--node-stroke`) clustered beside their dir circle (deterministic offsets). Small-multiple of the canvas node language: hollow = dir, filled = file.
- **Label** outside-right of the ring per the label rules: feature name mono 11.5px `--text`, second line `9 files · 3 workspaces` mono 10.5px `--text-faint` (counts = `memberIds.length` and `workspaces.length`). Selected: dashed stroke `--accent` 1.5px, name `--accent-text` weight 600.
- **Shared-member edges:** a straight `--edge` 1px line between feature nodes sharing ≥1 member (checkout ↔ design-system via `PriceTag.tsx`); brightens to `--accent` 1.5px when either endpoint is selected. The feature panel lists the shared file(s).
- **Path expansion (the cross-directory proof):** every bundled glyph is a focusable button whose `aria-label` is its full path. Clicking a bundled **dir circle** opens an anchored flyout card (`--bg-raised`, 1px `--border`, 4px radius): header = the dir's full path from root (mono 10.5px `--text`), rows = its member files in this feature (mono 10.5px `--text-muted`, hover bright; click selects that file node). One flyout open at a time; `Esc` or outside click closes. Clicking a bundled **file dot** selects that file node directly — the sidebar's path header shows its full path. This is how a viewer proves to themselves that checkout's contents live in `apps/web/`, `apps/api/`, *and* `packages/`.
- **Selection model:** clicking the ring, name label, or interior background selects the *feature* (sidebar swaps to feature panel §8.4). Bundled-glyph file selection is node selection. Feature selection and node selection are mutually exclusive: selecting one clears the other. Feature selection is Features-tab-scoped — switching tabs clears it (node selection persists across tabs).

### 7.5 Relations
A scoped relationship graph with drill-down — how the pieces of the *current directory* lean on each other. Built for the new hire's workflow: start at the repo, see how the top-level dirs relate, get curious, click into one, and the graph re-draws one level down.
- **Scope:** `relationsScope` = a folder node id, default the root (`acme/`). Persists across tab switches like expansion state; entering the tab never changes it.
- **Canvas:** the scope's authored children (dirs + files) arranged on a deterministic circle — dirs first, alphabetical, then files; radius sized to the viewport; labels outside-right per §7.2, no overlaps. Node shapes exactly per the §7.2 state table. Ghost breadth is not rendered here (the always-on `sample data` marker covers it).
- **Aggregate edges:** roll up authored `RepoEdge`s (respecting the imports/calls filter) per **ordered** pair of scope children — A→B counts edges from descendants-or-self of A into descendants-or-self of B. Render one straight `--edge` line per unordered pair; width encodes the total count: 1px (≤2 underlying edges), 1.5px (3–5), 2px (6+). Direction matters only for selection lighting, and is always unambiguous because §5.2's directionality rule forbids sibling pairs with edges both ways. Rollup is computed once per (scope, filter) and memoized.
- **Selection:** click selects a dir or file (sidebar per §8). The selected node's edges light directionally: **outgoing** `--accent` 1.5px solid, **incoming** `--accent` 1px dashed (`4 3`); counterpart nodes light (`--accent-text` for outgoing targets, `--text` for incoming sources); a midpoint mono count label (9px, `--text-faint`) appears on lit edges showing the rolled-up edge count. Legend floats bottom-right, mono 10.5px `--text-faint`: `── outgoing · ─ ─ incoming`.
- **Drill:** a second click on an already-selected dir (or `Enter`) re-scopes *into* it, 250ms transition; files don't drill. The drilled dir **stays selected** (it becomes the out-of-scope parent of the new scope; the out-of-scope rule below covers its sidebar). **Breadcrumb** floats top-left of canvas (below top bar, 16px inset), mono 11px: `acme/ › apps/ › api/` — ancestor segments `--text-muted` (hover bright; click re-scopes up to that level), current segment `--text`. `Backspace` goes up one level.
- **Sidebar relations block** (Relations tab only; renders between the owners row and the layers block): first line `in 6 · out 1` mono 11.5px `--text`, then one row per counterpart — direction marker `→` (outgoing) / `←` (incoming) + full path, mono 11px `--text-muted`, hover bright. Content by selection type: a selected **file** lists its global file-level counterparts (currency.ts: `6 in · 1 out`); a selected **dir** lists its in-scope directed aggregates with rolled-up counts (apps/ at root scope: `→ packages/ · 9`). Clicking a counterpart row selects that node, re-scoping to its parent dir first if it isn't in the current scope — the "follow the thread" loop.
- **Edge-kind filter:** two mono 10.5px toggle words floating top-right of canvas (clear of the breadcrumb): `imports` / `calls` — active `--text`, inactive `--text-faint`. Both on by default.
- A scope with no intra-scope edges: status line appends `no detected relations at this level` (quiet, realistic — `tools/` is intentionally like this).
- A selected node outside the current scope stays selected in the sidebar; the canvas simply doesn't show it, and the status line still appends its global `n in · n out`.
- Keyboard: arrows cycle scope children, `Enter` selects (then drills a selected dir), `Backspace` goes up.

---

## 8. Sidebar: layers & personas

### 8.1 Anatomy (node selected)
Top → bottom:
1. **Path header:** full path, mono 12px, `--text-muted`, final segment `--text-bright`; wraps.
2. **Stat line:** mono 10.5px `--text-faint`: files `file · ts · 214 loc`; folders `folder · 9 files`.
3. **Owners row** (always visible; not a layer): mono 11px — label `owned by` in `--text-faint`, then names in `--text`, middot-separated: `owned by dana park · miguel reyes`. Omitted when the node has no owners. (On the Relations tab, the non-layer **relations** block from §7.5 renders directly after this row.)
4. **Layers block:** heading `layers` (mono 10.5px `--text-faint`), then seven toggle rows. Each row: 12px square checkbox (1px `--node-stroke` border, 2px radius; checked = `--accent` fill with 7px `--accent-btn-text` checkmark) + Familjen 13px `--text` label. Toggling re-renders only panel sections (and the canvas badge layer for `tests`) — no layout jank.
   - Rows in fixed order: `description · dependencies · recent changes · specific features · specific tickets · agent / skill md · tests`
5. **Sections** for each enabled layer, in that same order. Section heading: mono 10.5px `--text-faint` lowercase; 1px `--border` divider above each.

### 8.2 Section content
- **description** — the canned summary, Familjen 13.5px `--text`, line-height 1.55. Beneath it, mono 10.5px `--text-faint`: `generated by sayre · sample`.
- **dependencies** — rows of `Dependency`: mono 12px name `--text`, kind chip, and when `install` present a copyable command row (mono 11.5px in a `--bg-raised` 1px-border box; click copies, flashes `copied` in `--accent-text`).
- **recent changes** — up to 3 rows: message (Familjen 13px `--text`), then mono 10.5px `--text-faint`: `a1b2c3f · dana park · 2d ago · pr #482` (PR renders as chip).
- **specific features** — chips per feature; clicking one switches to the Features tab and selects that cluster.
- **specific tickets** — rows: source+id chip (`LIN-482`), title `--text` 13px, status in `--text-faint` (`in progress`). Done tickets: whole row `--text-faint`.
- **agent / skill md** — rendered markdown (h4/strong/code/ul only) inside a `--bg-raised` bordered box, mono 11.5px — it should read like a file, because in the product it is one. Header row inside box: `AGENTS.md · scoped to this node` in `--text-faint`.
- **tests** — status line (`passing` in `--test-pass` / `failing` in `--test-fail`, mono 12px) + `covered by` list of test file paths (clickable → selects that node). Toggling this row also toggles canvas badges (§7.3).

### 8.3 Empty states
A layer that's toggled on but has no data renders its heading + one mono 11px `--text-muted` line (quieter than populated content but still ≥4.5:1 — §13's contrast rule applies because this line is the section's entire content): `no linked tickets` / `no tracked dependencies` / `no agent guidance for this node` / `not covered by tests` / `no recent changes`. Never hide the section — the empty state is product realism.

### 8.4 Feature panel (Features tab, cluster selected)
Replaces node anatomy with PRD §4.7's four fields + stats:
1. Header: feature name (Familjen 16px 600 `--text-bright`) + `team: web platform` (mono 11px `--text-faint`).
2. **progress:** mono 11.5px `--text`: `3 open tickets · 12 merged prs · shipped 2d ago`.
3. **description** (canned).
4. **files included:** the live member list, mono 11.5px, each row clickable → selects that file node (stays on Features tab; its bundled dot lights inside the feature ring). When the feature shares members with another feature, a final mono 11px `--text-faint` line: `shares PriceTag.tsx with design system`.
5. **recent edits:** the feature's authored `recentEdits` (exactly 3 rows), same format as recent changes. Never derived from member nodes at runtime.
6. **tickets:** chips + titles as §8.2.

### 8.5 Nothing selected
Sidebar shows repo overview: `acme/monorepo` (mono 14px `--text-bright`), stat line `1,204 files · 4 features · 8 contributors`, the canned repo description (verbatim in A.6), then hint block (mono 11px `--text-faint`):
```
click a node to inspect it
⌘k to search files
view as — top right — changes what each role sees
```

### 8.6 Personas
```ts
export const PERSONAS: Persona[] = [
  { id: "new-hire",  label: "new hire",        defaultTab: "relations",
    layers: ["description", "dependencies", "agentMd"] },
  { id: "tech-lead", label: "tech lead",       defaultTab: "filetree",
    layers: ["description", "recentChanges", "features", "tests"] },
  { id: "pm",        label: "product manager", defaultTab: "features",
    layers: ["description", "features", "tickets"] },
];
```
- Initial persona: **tech lead** — the first frame is the mock's money shot (the full tree, test badges on), and the cold-email reader usually *is* one.
- The persona → tab mapping is fully diagonal (new hire → relations, tech lead → filetree, pm → features): a skimmer flipping roles always sees the canvas change *shape*, never just checkboxes. A visitor who blazes through cannot mistake the persona switcher for a no-op.
- Switching persona: (a) sets the seven checkmarks to exactly the preset, (b) switches to the persona's `defaultTab`, (c) **keeps the current node selection** (a feature selection clears when leaving the Features tab, per §7.4) — the layers nuance is still there for anyone who watches the same node re-dress itself. The checkmark changes should be *visible*: stagger the checkbox transitions ~40ms apart so the panel visibly reconfigures.
- Manual toggle changes after a switch are kept until the next persona switch (which resets to preset). No persistence across reloads.

---

## 9. Guided tour

**Prompt, never autoplay.** On first `/demo` visit (localStorage flag `sayre.tourSeen`), after 1.5s a chip appears bottom-center: `--bg-raised`, 1px `--border`, 6px radius, mono 12px — `take the 30-second tour?` with two inline actions: `start` (`--accent-text`; Fragment Mono has a single weight — differentiation is by color only) and `dismiss` (`--text-faint`). Explicit dismiss sets the flag; any 3 canvas interactions merely hide the chip for the session (an engaged user who never read it still gets the offer next visit). Skipping or completing the tour also sets the flag. A persistent affordance `tour` (mono 11px `--text-faint`, hover `--text`) sits next to the status line forever after.

**Mechanics:** steps are data (`src/data/tour.ts`): each = `{ camera, actions, caption, anchor }`. The tour performs real state changes (same reducers as user input) — never a canned overlay picture. Caption card: `--bg-raised`, 1px `--border`, 8px radius, max-width 340px, Familjen 13.5px `--text`, positioned near its anchor (auto-flipping), with mono 10.5px progress `2 / 6`, `next →` primary-text action, `skip` faint. `Esc` skips. User input outside the card is ignored while active (except `Esc`).

**Script (6 steps):** (the demo boots as tech lead on filetree — §8.6)
1. Fit whole tree. Caption near root: *"this is acme/monorepo — a 1,204-file sample repo mapped into a living graph. drag, zoom, click — nothing here is a screenshot."*
2. Expand + fly to + select `apps/web/src/checkout/PaymentForm.tsx`. *"click any node and its ancestry lights up. you're viewing as the tech lead — owners, churn, and failing tests, front and center."* (tech-lead layers: recent changes + tests visible; owners row on.)
3. Switch persona → new hire (tab flips to relations; the tour resets `relationsScope` to root in case of a re-run; `PaymentForm.tsx` **stays selected** — it's out of scope, so the canvas is a clean root frame while the sidebar visibly reconfigures to the new-hire layers: description, the stripe setup command, guardrails). *"switch roles and the map itself changes. a new hire starts from how the pieces lean on each other — with setup steps and guardrails in the sidebar instead of ticket noise."*
4. Select `apps/`, drill in (§7.5), then select `apps/api/` — the web → api and admin → api edges light as incoming dashed lines with count labels. *"click into any directory and the graph re-draws one level down — web and admin both call into api. connections a readme never explains."*
5. Switch persona → product manager (tab flips to features); select the `checkout` feature node. *"product managers get features as first-class shapes — checkout wraps 9 files across three workspaces, with its tickets and shipping progress pinned on."*
6. Center card, no anchor: *"this demo is sample data. your repo is the real one."* Buttons: `get early access` (primary → waitlist modal) + `keep exploring` (secondary → ends tour).

Completing or skipping sets `sayre.tourSeen`.

---

## 10. ⌘K search

- Open via `⌘K` / `Ctrl+K` or clicking a mono `⌘k` hint chip at canvas top-right (16px inset, `--text-faint`, 1px `--border`, 4px radius).
- Modal: top-centered (12vh from top), 480px, `--bg-raised`, 1px `--border`, 8px radius. Input row: mono 13px, placeholder `search files…`. Results: max 8 rows — filename mono 12.5px `--text-bright` + full path mono 10.5px `--text-faint`; matched characters `--accent-text`. Active row: `--bg` fill + 2px `--accent` left inset bar.
- Matching: case-insensitive subsequence over full path; score = contiguity + earliness + filename-hit bonus; files and folders both match; ghost rows never match. Empty query → 6 "suggested" hero files.
- `Enter`/click: close, then act per tab — **filetree:** expand ancestors, fly (400ms), select; **features:** select the node (its containing feature ring and bundled dot light); **relations:** re-scope to the file's parent dir, then select. `Esc` closes. Focus is trapped; background inert.
- No results: single row `no files match` `--text-faint`.

---

## 11. Landing page

Single scroll, `--bg` throughout, max-width 1120px content column, generous vertical rhythm (120px between sections, 72px mobile). Sticky-free simple top nav: wordmark left; right: `demo` text link (`--text-muted`, hover bright) + `get early access` primary button.

### §1 Hero
- Eyebrow: `early access · 2026`
- H1 (display): **Your codebase, mapped.**
- Sub (18px, `--text-muted`, max 560px): *Sayre parses a repository into a living graph every role can actually read — engineers trace dependencies, product managers see features, new hires find their footing.*
- CTAs: `explore the live demo` (primary → `/demo`) · `join the waitlist` (secondary → scrolls to waitlist band).
- **Teaser:** below CTAs, a 16:9 card (1px `--border`, 8px radius, `--bg` fill, clips overflow) containing the real canvas component in **attract mode**: a 12s scripted loop (select PaymentForm → ancestry lights, badges visible → persona flips to new hire: relations root draws, drill into apps/ → persona flips to product manager: feature nodes draw, checkout selected → back to start). Pointer events disabled except click-anywhere → `/demo`; hover pauses the loop and shows a centered mono chip `click to drive →`. Under reduced motion: static first frame + chip.

### §2 Problem line
Full-width quiet interlude, centered, max 640px: h2 **A codebase is a kitchen without labels.** body: *Everything is somewhere. Nobody can say where. Every onboarding, every handoff, every "which file is checkout actually in?" pays the tax.*

### §3 One graph, three lenses
h2: **One graph. Three lenses.** Three cards (grid, 1px `--border`, 8px radius, `--bg-raised`, 28px padding). Each card: mono eyebrow (`view as: new hire`), h3, body 14.5px `--text-muted`:
- **new hire** — *Start from how the pieces lean on each other — which services call which, one level at a time — with setup steps and guardrails attached to the exact files they concern.*
- **tech lead** — *Ownership, churn, failing tests, and module boundaries on one canvas. See boundaries drift before they break.*
- **product manager** — *Features drawn as real boundaries across the code — with tickets and shipping progress pinned to them, no engineer required to translate.*

### §4 How it works
h2: **How it works.** Three numbered rows (mono `01 / 02 / 03` in `--text-faint`):
1. **connect your repo** — *A read-only GitHub app watches your default branch.*
2. **the graph builds itself** — *Tree-sitter parsing plus LLM enrichment turn files into an ontology: features, owners, styles, tests.*
3. **everyone reads it their way** — *Three views over one graph, live within seconds of every push.*

### §5 View deep-dives
Three alternating rows (media left/right), each media = a **static SVG render** of the actual canvas components with curated state (not screenshots — same code, `interactive=false`):
- **filetree** — h3: *The shape of the repo, at a glance.* body: *Hollow circles are folders, filled dots are files, and the path to anything you select lights up. Your repo's actual hierarchy — not a metaphor for it.*
- **features** — h3: *The map product managers keep asking for.* body: *Features become first-class shapes — sized by how much of the repo they wrap, holding their directories and files inside, with tickets and shipping progress attached.*
- **relations** — h3: *See how the pieces lean on each other.* body: *Start at the repo: four directories and the lines between them. Click into one and the graph re-draws a level down — the connections a new hire needs, without reading a single import.*

### §6 Waitlist band
Centered, max 560px. h2: **Want this on your codebase?** body: *We're onboarding design partners now. Early teams get white-glove setup and a real say in what ships.* Form (§12) inline. Under the form, mono 10.5px `--text-faint`: `no spam · one email when your invite is ready`.

### §7 Footer
1px `--border` top. Row: `sayre_` · mono 11px `--text-faint` links: `demo`, `contact` (mailto `CONTACT_EMAIL`) · right: `© 2026 sayre`.

All copy above is final unless the team edits it — the builder must not invent alternative copy.

---

## 12. Waitlist capture

One `WaitlistForm` component used in: landing §6 (inline) and the demo modal (top-bar CTA + tour step 6).
- Fields: email (required, HTML5 + regex validation) and company (optional, single field, placeholder `company (optional)`). Stack vertically at <480px.
- Submit: primary button `join the waitlist`. POST JSON/form-encoded to `WAITLIST_ENDPOINT`; include a hidden `source` field: `landing` | `demo-topbar` | `demo-tour`.
- States: submitting (button text `joining…`, disabled); success (form is replaced with mono 13px `--accent-text`: `you're on the list — we'll be in touch.`); error (mono 11px `--test-fail` under the form: `something broke — email us instead:` + mailto link).
- `WAITLIST_ENDPOINT` empty: in dev builds (`import.meta.env.DEV`) log the payload and show success after 400ms. In production builds an empty endpoint must **never** fake success — the submit button is replaced with mono 11px `--text-muted`: `waitlist opens soon — email hello@sayre.dev` (mailto link, subject prefilled `early access`).
- Demo modal variant: title `get early access` (Familjen 16px 600), one body line: *linked here from an email? this demo is sample data — the waitlist gets sayre on yours.*

---

## 13. Responsive & accessibility

### Breakpoints
- Landing: fluid; grid sections collapse to single column < 760px; type scale steps down as §4.2.
- Demo ≥ 900px: full layout as specced.
- Demo < 900px (phones — cold-email links WILL open here):
  - Sidebar becomes a **bottom sheet**: collapsed 48px grab bar showing the selected node's name (mono 12px); drag/tap expands to 60vh. Nothing selected: the collapsed bar shows `acme/monorepo · tap a node to inspect`; tapping it expands to the §8.5 overview, whose third hint line reads `view as — at the top of this panel`.
  - A pinned `view as` persona row renders at the top of the expanded sheet — persona matters most exactly when a node is selected.
  - Top bar: wordmark + tabs + a compact `early access` primary CTA (12px, padding 5px 10px) **visible at all widths** + a `⋯` overflow menu (repo metadata; persona switcher as a secondary location). Below 400px the wordmark shortens to `s_` so the CTA never wraps. Tabs stay first-class.
  - Canvas: touch pan + pinch zoom mandatory. `⌘k` chip becomes a search icon-button (same modal, full-width).
  - Tour works; caption cards bottom-anchored full-width.

### Accessibility
- Every canvas node is a focusable SVG element with `role="button"` and `aria-label` (`folder packages, 9 files` / `file render.ts, selected`). Keyboard model per §7.2.
- Sidebar toggles are real checkboxes; tabs are `role="tablist"`; modals trap focus, `Esc` closes, restore focus on close.
- All meaningful text ≥ 4.5:1 against its background (`--text-faint` is decorative/metadata only — never the sole carrier of essential info).
- `prefers-reduced-motion`: no layout animations, no attract mode, no stagger; state changes are instant.
- Full keyboard path: tab into canvas → arrows to a node → read sidebar → switch persona → submit waitlist, mouse-free.

---

## 14. Motion

Small, physical, fast. Durations: hover 100ms; selection/ancestry lighting 150ms; expand/collapse & camera 250–400ms ease-out; checkbox stagger 40ms/item. Nothing bounces, nothing floats, nothing pulses. If it can't be tied to a user action, it doesn't move (attract-mode teaser is the sanctioned exception).

## 15. Meta, OG, analytics, deploy

- `<title>`: `sayre_ — your codebase, mapped` (landing); `sayre_ — live demo` (demo).
- Meta description: *Sayre parses your repository into a living graph every role can read. Explore the live demo.*
- OG/Twitter card: `public/og.png`, 1200×630 — a **committed static file**, not produced by `npm run build`. Builder adds a dev-only script (`scripts/og.mjs`, run manually via `npm run og`; devDependencies such as `@resvg/resvg-js` or `puppeteer` are fine — the §2 cap is runtime-only) that renders the demo canvas at the curated state (`PaymentForm.tsx` selected, ancestry lit, wordmark bottom-left, on `--bg`) and writes the file; commit the output. Tags use absolute URLs: `og:image` = `${SITE_URL}/og.png`, `summary_large_image`.
- Favicon: 32px SVG — hollow circle + filled dot motif: `--node-stroke` circle upper-left, `--accent` dot lower-right on `--bg`.
- Fonts: `preconnect` to fonts.googleapis.com/gstatic; the exact CSS2 link from §2 (700 weight deliberately dropped).
- Analytics: if `PLAUSIBLE_DOMAIN` set, inject Plausible script; else nothing. No cookies, no banner either way.
- SPA fallback for `/demo` deep links — ship `vercel.json`: `{ "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }] }` (and note Netlify `_redirects` equivalent: `/* /index.html 200`).

## 16. Performance budget

- JS ≤ 250 KB gz total; no code-splitting needed beyond Vite defaults, but the landing must not pay for tour/search code until `/demo` (dynamic import the demo route).
- 60fps pan/zoom: transform the single SVG viewport group (`transform` on `<g>`); never re-run layout during pan/zoom; memoize layout per (expansion set, tab).
- Lighthouse (mobile, landing): Performance ≥ 90, A11y ≥ 95, SEO ≥ 90.
- First contentful paint of the hero (text) must not wait on the teaser canvas (defer attract mode start to `requestIdleCallback`).
- `/demo` first paint: the main bundle renders the demo shell chrome as the Suspense fallback (top bar with wordmark/tabs/CTA + status line `loading acme/monorepo…`); kick off the demo route's dynamic import immediately when `location.pathname === "/demo"` rather than waiting for router render.
- Font-swap safety: initial label measurement, layout, and fit-on-mount run after `document.fonts.ready` (wait capped at 800ms; if fonts resolve later, re-measure and re-fit once) so §7.1's no-collision guarantee survives `display=swap`. Since Fragment Mono is monospaced, analytic label widths (char count × measured advance) are an acceptable substitute.

## 17. Suggested file structure

```
src/
  main.tsx  App.tsx  config.ts
  styles/    tokens.css  base.css  landing.css  demo.css
  data/      repo.ts  edges.ts  features.ts  people.ts  tickets.ts  personas.ts  tour.ts  copy.ts
  demo/      DemoPage.tsx  TopBar.tsx  StatusLine.tsx  TreePanel.tsx  Sidebar.tsx  FeaturePanel.tsx  LayerToggles.tsx
  demo/canvas/   Canvas.tsx  layout.ts  Nodes.tsx  Edges.tsx  FeatureNodes.tsx  RelationsView.tsx  rollup.ts  Breadcrumb.tsx  Badges.tsx  useCamera.ts
  demo/search/   CommandK.tsx  fuzzy.ts
  demo/tour/     Tour.tsx
  demo/state.ts  (context + reducer: tab, persona, selection, expanded, layers, tour, search)
  landing/   LandingPage.tsx  Hero.tsx  Teaser.tsx  Lenses.tsx  HowItWorks.tsx  DeepDives.tsx  WaitlistBand.tsx  Footer.tsx
  shared/    Button.tsx  Modal.tsx  WaitlistForm.tsx  Chip.tsx
scripts/     og.mjs   (dev-only OG renderer — §15)
```

Builder may deviate structurally; the state shape and component boundaries above are known-good.

## 18. Acceptance checklist

**Visual fidelity**
- [ ] Side-by-side with the mock PNG: node shapes/sizes/colors, label offsets, tab treatment, top-bar layout, and status line are indistinguishable in kind (content may differ).
- [ ] Zero pure #FFF, zero blue-tinted grays, zero gradients/shadows/glows/pills anywhere.
- [ ] All canvas text is Fragment Mono; all chrome is Familjen Grotesk.

**Demo mechanics**
- [ ] Pan/zoom at 60fps; wheel is cursor-anchored; fit on load, tab-switch, and `0`.
- [ ] Selecting a file lights the full root→node ancestry plus its children, with on-path node/label treatment per §7.2 (side-by-side: reproduces the mock's `viz-core/` → `render.ts` moment).
- [ ] Owners row: selecting `PaymentForm.tsx` under the tech-lead preset shows `owned by dana park` — tour step 2's "owners … front and center" claim is on screen.
- [ ] Folder click-to-expand, reclick-to-collapse; animated; ghost `… n more files` rows appear where fileCounts exceed authored children.
- [ ] First frame: tech lead persona on filetree, both red test badges visible without interaction.
- [ ] Persona switch: checkmarks visibly reconfigure (staggered) AND the canvas changes shape — new hire→relations, tech lead→filetree, pm→features; node selection survives.
- [ ] Features tab: 4 dashed feature nodes sized by dir count (checkout largest, design-system smallest); clicking a bundled dir circle opens the full-path flyout with its files; clicking a bundled file dot selects the node; checkout↔design-system shared edge present and listed in both panels; feature panel shows all six blocks.
- [ ] Relations tab: root scope shows apps/, packages/, services/, tools/ with ≥3 aggregate edges and tools/ isolated (`no detected relations` state); drilling into apps/ shows web→api and admin→api; breadcrumb and Backspace navigate up; selecting currency.ts inside packages/core/src shows `6 in · 1 out` and clicking a sidebar counterpart re-scopes to its parent.
- [ ] Left tree panel: stays in sync with canvas expansion/selection in both directions; file click behaves per tab (§6.5); collapses at 900–1100px; hidden < 900px.
- [ ] Tests layer: badges toggle with the checkbox; exactly 2 red badges findable within tech-lead default expansion.
- [ ] Every `tests.coveredBy` path resolves to an authored, selectable node — no dead clicks.
- [ ] ⌘K: fuzzy matches path subsequences, flies + selects, fully keyboard operable.
- [ ] Tour: prompt chip (never autoplay), 6 steps execute real state changes, `Esc` skips, final step converts to waitlist modal.

**Site & conversion**
- [ ] `/demo` deep link works on the deployed host (SPA rewrite verified).
- [ ] Waitlist form: all three sources submit with correct `source` field; success/error/dev states all reachable.
- [ ] Production build with empty `WAITLIST_ENDPOINT` shows the mailto fallback — never fake success. README deploy note states the endpoint must be set before any email campaign.
- [ ] `SITE_URL` set to the real domain; `og:image` is absolute; `public/og.png` is committed.
- [ ] Teaser attract mode loops, pauses on hover, clicks through to `/demo`; static under reduced motion.
- [ ] OG image renders in an actual unfurl test (Slack/iMessage/Twitter validator).
- [ ] Landing copy matches §11 verbatim.

**Quality**
- [ ] `tsc --noEmit` clean; zero console errors/warnings on both routes.
- [ ] Full keyboard journey (§13) possible; focus visible throughout; reduced-motion honored.
- [ ] Mobile (390px): demo usable (bottom sheet with `view as` row, pinch zoom), `early access` CTA visible without opening the overflow menu, landing clean, Lighthouse targets met.
- [ ] `sample data` marker visible in demo status line at all times.

---

## Appendix A — Dataset story bible

**The fiction:** Acme is a mid-size e-commerce company; `acme/monorepo` (1,204 files) holds its storefront, API, admin tool, and shared packages. The story must feel like a real Tuesday: a checkout revamp mid-flight, a flaky search indexer test, a new hire ramping on auth.

### A.1 Directory skeleton (authored spine — builder fills breadth with consistent filler)

```
acme/  (root, fileCount 1204)
├─ apps/
│  ├─ web/            # storefront (React/TS). src/checkout/ (HERO), src/search/, src/account/ (SettingsPage.tsx HERO), src/components/
│  ├─ api/            # Node API. src/routes/{payments,orders,search,auth,middleware}.ts (payments.ts HERO; middleware.ts imported by the other routes)
│  └─ admin/          # small internal tool: src/AdminApp.tsx + src/OrdersTable.tsx authored (OrdersTable calls api/routes/orders.ts), rest ghosts
├─ packages/
│  ├─ ui/             # design system: Button.tsx, Input.tsx, Modal.tsx, PriceTag.tsx (HERO)
│  ├─ core/           # src/currency.ts (HERO, high fan-in), session.ts (HERO), analytics.ts, flags.ts
│  └─ config/         # eslint/tsconfig (ghosts fine)
├─ services/
│  └─ search-indexer/ # worker; has the flaky failing test
└─ tools/             # scripts (ghosts)
```

Hero path for tour/teaser/OG: `apps/web/src/checkout/PaymentForm.tsx` — imports `packages/core/src/currency.ts`, `packages/ui/src/PriceTag.tsx`, `apps/web/src/checkout/useCheckout.ts`; called by `apps/web/src/checkout/CheckoutPage.tsx`. `currency.ts` is imported by exactly 6 files across `apps/web`, `apps/api`, `services/search-indexer`, and itself imports `packages/core/src/flags.ts` (rounding-mode rollout flag) — its one outgoing edge. This makes the §6.2 relations example (`currency.ts · 6 in · 1 out`), the §7.5 sidebar relations block, and the A.5 agentMd ("6 downstream imports") all agree.

### A.2 Features (exactly these 4)

| id | name | team | spans | stats flavor |
|---|---|---|---|---|
| checkout | checkout | web platform | apps/web/src/checkout/* (5), apps/api/src/routes/payments.ts, packages/core/src/currency.ts, packages/core/src/flags.ts (checkout rollout flag — ties to LIN-482), packages/ui/src/PriceTag.tsx → 9 files · 3 workspaces (apps/web · apps/api · packages) | 3 open tickets · 12 merged prs · shipped 2d ago |
| search | search & discovery | discovery | apps/web/src/search/* (3), apps/api/src/routes/search.ts, services/search-indexer/* (3) → 7 files | 2 open · 7 merged · shipped 5d ago |
| auth | auth & accounts | identity | apps/web/src/account/* (3), apps/api/src/routes/auth.ts, packages/core/src/session.ts → 5 files | 1 open · 3 merged · shipped 12d ago |
| design-system | design system | web platform | packages/ui/* (6) → 6 files | 2 open · 9 merged · shipped 1d ago |

Rules: `stats.openTickets` must equal the count of that feature's linked tickets with status `open` or `in progress`. Each feature carries 3 authored `recentEdits` consistent with its member files and people. Member-file totals (9 + 7 + 5 + 6 = 27) feed the §6.2 features status line. `memberIds` are file-only (§5.1); `workspaces` is authored per feature: checkout `["apps/web","apps/api","packages"]`, search `["apps/web","apps/api","services"]`, auth `["apps/web","apps/api","packages"]`, design-system `["packages/ui"]`.

### A.3 People (8)
`dana park (@dpark)`, `miguel reyes (@mreyes)`, `sam okafor (@sokafor)`, `priya nair (@pnair)`, `jules laurent (@jlaurent)`, `tomas berg (@tberg)`, `aisha khan (@akhan)`, `leo tanaka (@ltanaka)`. Spread ownership so each hero node has 1–2 owners; dana owns checkout-heavy files (the §8.1 owners row is where she appears during tour step 2), sam owns core/, priya owns the indexer.

### A.4 Tickets (~12; mix linear + jira)
Examples to set tone: `LIN-482 · stripe payment-intent migration · in progress` (checkout), `LIN-471 · rounding error on multi-currency carts · open` (currency.ts), `ACME-2201 · search results flicker on refine · in progress`, `LIN-455 · session refresh loop on safari · done`, `ACME-2188 · indexer retries exhaust queue · open` (the failing-test file). Every feature gets ≥2; hero files get 1–2 each.

### A.5 Canned-content voice
- **Descriptions** read like a sharp engineer wrote them, not marketing: *"Renders the card entry form and owns Stripe tokenization. Talks to useCheckout for cart state; never touches price math directly — that lives in currency.ts."*
- **agentMd** reads like a real AGENTS.md fragment: allowed tools, invariants, "don't touch X without Y" warnings. Example for currency.ts: *"all money is integer minor units. never introduce floats. any rounding change requires updating property tests in currency.test.ts. breaking: 6 downstream imports."*
- **Dependencies with install commands** (the new-hire preset's payoff): ≥3 hero nodes carry a `Dependency` with `install` — `PaymentForm.tsx` (inside the filetree default expansion) → `stripe listen --forward-to localhost:3000/api/webhooks`; `packages/core/src/session.ts` → `docker compose up -d redis`; `services/` (a relations root-scope child, so the new-hire persona's first clicks land on it) → `pnpm --filter search-indexer dev`. `session.ts`'s agentMd references the LIN-455 safari refresh loop.
- **Failing tests:** `services/search-indexer/src/retry.ts` (`ACME-2188`) and `apps/web/src/checkout/useCheckout.ts` (flaky timeout, message says so).
- Relative dates only (`2d ago`), lowercase mono metadata everywhere, no emoji, no exclamation marks.

### A.6 Canned copy (verbatim — the builder must not substitute)
- **Repo overview (§8.5):** *"storefront, api, admin tool, and shared packages for acme's e-commerce stack. a checkout revamp is mid-flight; the search indexer is on a flaky streak."*
- **checkout:** *"Everything between add-to-cart and a settled payment: cart state, the payment form, Stripe tokenization, and the price math they all share."*
- **search & discovery:** *"The storefront search box, the results page behind it, and the indexer that keeps results fresh."*
- **auth & accounts:** *"Sign-in, session handling, and account settings — one session model shared by web and api."*
- **design system:** *"The shared UI primitives — buttons, inputs, modals, price tags — every acme surface builds from."*
