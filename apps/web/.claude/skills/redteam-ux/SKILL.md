---
name: redteam-ux
description: Run, screenshot, and red-team the Sayre web frontend (apps/web). Use when asked to start the web app, take a screenshot of it, drive the workspace or /mock wireframe headlessly, probe failure/degraded/keyboard/mobile states, or do an adversarial UX pass.
---

The Next.js product client (`apps/web`), driven headlessly through
`apps/web/.claude/skills/redteam-ux/driver.mjs` — a puppeteer-core CLI that
launches your installed Chrome/Edge, executes a JSON step list in one browser
session, and reports screenshots, console errors, page errors, failed
requests, tab order, and the accessibility tree. All paths below are relative
to the **repo root**, and all commands were verified on this checkout
(Windows, Git Bash).

Two drivable surfaces:

- **`/mock` — the fixture lab. Red-team here first.** The full workspace shell
  (explorer, React Flow canvas, drawer, settings) running purely on fixtures,
  with a **Mock controls** panel whose dials reach every state the MVP must
  handle (see dial table below).
- **`/` — the real shell** on the live data source. Without `services/core`
  running, its API calls fail — which renders the real failure states, and
  those are red-team targets in their own right (see Gotchas).

## Prerequisites

- Node ≥20 (v24.14.0 works despite `apps/web`'s `engines: <21` field).
- A local Chrome or Edge. Auto-detected from standard Windows/macOS/Linux
  paths; override with `CHROME_PATH=<path-to-chrome-binary>`.
- puppeteer-core comes from the root workspace install — no extra installs.

## Setup

```bash
npm install --no-audit --no-fund
```

## Run (agent path)

Start the dev server in the background (from `apps/web/`; ~5s to ready,
first page compile adds ~8s):

```bash
cd apps/web && npx next dev -p 3100
```

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:3100/mock
```

`200` means ready. Then drive it (from repo root):

```bash
node apps/web/.claude/skills/redteam-ux/driver.mjs ss mock
```

| command | what it does |
|---|---|
| `ss [path]` | goto + screenshot. No arg = `/`. **Pass `mock`, not `/mock`** (Gotchas). |
| `flow <steps.json \| ->` | run a JSON step list in one session; `-` reads stdin |

Options: `--base http://localhost:3100` (default), `--headed`,
`--keep-open <ms>`. Screenshots and a11y dumps land in
`apps/web/.claude/skills/redteam-ux/shots/` (gitignored); every step echoes a
JSON line, and console/network noise is summarized at the end.

Flow step vocabulary (all exercised on this checkout):

| step | example |
|---|---|
| goto | `{"goto": "mock"}` — path or full URL |
| resize | `{"resize": [390, 844]}` |
| dark | `{"dark": true}` — emulate prefers-color-scheme |
| click | `{"click": "[data-id=\"n_services\"]"}` |
| clickText | `{"clickText": "Mock controls"}` — buttons/links/roles by visible text |
| selectByLabel | `{"selectByLabel": "Backend", "value": "unavailable"}` — throws if value isn't a real option |
| type / press | `{"press": "Escape"}`, `{"press": "Tab", "times": 5}` |
| hover / waitFor / wait | `{"waitFor": ".drawer"}`, `{"wait": 400}` |
| eval | `{"eval": "document.title"}` — result logged |
| ss / fullPage | `{"ss": "after-click"}` |
| a11y | `{"a11y": true}` — accessibility tree → `shots/a11y-<step>.json` |
| taborder | `{"taborder": 15}` — Tab N times, logs the focus path |
| text | `{"text": ".banner"}` — innerText of first match |

A complete verified example — flip the backend dial and screenshot the outage
state:

```bash
node apps/web/.claude/skills/redteam-ux/driver.mjs flow - <<'EOF'
[
  {"goto": "mock"},
  {"clickText": "Mock controls"},
  {"selectByLabel": "Backend", "value": "unavailable"},
  {"wait": 400},
  {"ss": "mock-backend-unavailable"}
]
EOF
```

## The Mock controls dials

Open with `{"clickText": "Mock controls"}` — the selects only exist in the
DOM while the panel is open. Exact `value` strings for `selectByLabel`:

| dial | values |
|---|---|
| Session | `authenticated`, `signed-out`, `session-expired` |
| Role | `member`, `admin`, `owner` |
| Repository access | `authorized`, `repository-restricted`, `no-repositories`, `forbidden` |
| Repository readiness | `` (empty = from repository), `registered`, `technical-ready`, `graph-ready` |
| Graph data | `normal`, `loading`, `empty` |
| Semantic processing | `ready`, `generating`, `degraded`, `failed` |
| Realtime updates | `connected`, `reconnecting`, `updated`, `resync-required` |
| Backend | `available`, `unavailable` |
| GitHub installation | `installed`, `not-installed`, `approval-required`, `denied`, `error` |
| Agent/Skill MD | `normal`, `conflict` |

Canvas interaction: React Flow nodes carry `data-id`. Clicking a **folder**
node expands it; clicking a **file** node opens the overlay drawer. Ids are
short names — `n_invoice` for `invoice.ts` — so dump them first:

```json
{"eval": "[...document.querySelectorAll('.react-flow__node')].map(n=>n.dataset.id)"}
```

Verified drill-down: `n_services` → `n_billing` → `n_invoice` opens the FILE
drawer (Description / Specific Features / Dependencies / Recent Changes /
Tickets / Agent-Skill MD); `Escape` closes it.

## Red-team sweep (what to probe)

- Every dial value above × a screenshot — degraded copy, missing affordances,
  dead ends. `Reset to defaults` (a button in the panel) restores baseline.
- Viewports: default 1440×900, then `{"resize": [768, 1024]}` and
  `{"resize": [390, 844]}` + re-`goto`. At 390px the explorer overlays the
  canvas and top-bar buttons drop out — mine this seam.
- `taborder` after each major state: file canvas nodes surface as focusable
  `div`s (React Flow `tabindex=0`), not buttons — check what Enter/Space do.
- RBAC by omission: with `Role: member`, Settings must be *absent from the
  DOM*, not disabled (verified true today) — assert absence, not `disabled`.
- Console summary at the end of every run: anything beyond the known
  favicon 404 (Gotchas) is a finding.
- `/` with no backend: misleading-copy audit (see Gotchas).

## Run (human path)

```bash
cd apps/web && npm run dev
```

Opens on port 3000. Ctrl-C to stop. Same app, nothing headless-specific.

## Test

```bash
cd apps/web && npx vitest run
```

34 files / 222 tests, all passing (~25s cold).

## Gotchas

- **Git Bash mangles leading-slash args**: `ss /mock` becomes
  `C:/Program Files/Git/mock` via MSYS path conversion → "Cannot navigate to
  invalid URL". Pass bare `mock` (the driver normalizes), keep paths inside
  JSON flows, or use `ss` with no arg for `/`.
- **`page.select` with a wrong value silently no-ops** — an earlier run
  "selected" `unauthenticated` (real value: `signed-out`) and screenshotted
  the wrong state with no error. The driver now throws unless the value is in
  the option list; trust the dial table above.
- **`/favicon.ico` 404s on every page**, so one console error is permanent
  background noise in every run. Don't report it as a finding; anything else
  in the console summary is real.
- **`/` without `services/core` shows "No repository selected … ask an
  administrator to grant access"** while the explorer says "Loading authorized
  files…" — the actual cause is `GET /api/core/repositories` aborting. The UI
  misattributes backend-down as an authorization problem: standing finding
  material, and don't let it fool a sweep into thinking auth is broken.
- **Canvas/explorer state survives `goto` within one browser session** —
  expanded folders stay expanded after re-navigation. Use a fresh driver
  invocation for a clean slate.
- **Bash tool cwd persists between calls** — a prior `cd apps/web` makes the
  `apps/web/...` driver path resolve double. Run the driver from repo root.

## Troubleshooting

- **`Protocol error (Page.navigate): Cannot navigate to invalid URL`**: MSYS
  path conversion ate your `/path` (first Gotcha). Use the bare-name form.
- **`No element found for selector: [data-id="n_invoice_ts"]`**: node ids are
  short names, not full filenames. Dump `dataset.id`s first (eval above).
- **`"X" not in options […] — page.select would silently no-op`**: the value
  string is wrong; copy it from the dial table.
- **`No Chrome/Edge binary found`**: set `CHROME_PATH` to your browser
  binary.
