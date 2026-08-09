# PL-15 — Repo restructure: separate the marketing site from the monorepo root

> Working id only. PL-15 is **not** in `docs/PRD_Tickets.md` and this ticket does not add it there.
> Branch: `refactor/repo-restructure` @ `17e2299`. Lane: none declared (ticket was not filed through
> `.github/ISSUE_TEMPLATE/pipeline-ticket.yml`); the diff spans the repo, so it is effectively `full`.

## Ticket Check

**What I'm about to build**
The repo currently has two things stacked on top of each other at the top level: the old marketing
website, and the actual product. I'm going to give the marketing website its own folder so the top
level of the repo is just "here are the parts of the product," and put the loose folders that are
lying around (design files, documents, audit write-ups) into places where a new person would
actually think to look for them.

**What I'm explicitly not doing**
I'm not changing how the website looks, what it says, or what it does — not one pixel. I'm not
changing any product code, and I'm not touching the machinery that runs our AI build pipeline (that
stuff works; moving it would be risk for no reward). I'm also not finishing the job: a few messy
corners are deliberately left alone and written down as named follow-ups, because trying to fix
everything at once is how a change like this breaks something quietly.

**How you'll know it worked**
`sayre.pages.dev` still loads and looks exactly the same, including the privacy page. The green
"Cloudflare Pages" check still appears and still passes on the pull request. And if you open the
repo in a file browser, the top level reads like a table of contents — `apps/`, `services/`,
`packages/`, `docs/`, `infra/` — instead of a website's guts mixed in with everything else.

**What I had to guess**
Two things live outside this repo and I can't see them from here. First, the Cloudflare settings
that decide how the website gets built are in Cloudflare's dashboard, not in our code — so I built
the move to keep working *without* anyone changing that dashboard, and I've written a step for a
human to double-check those settings before merging. Second, there's a `vercel.json` file suggesting
we may also deploy to Vercel; I couldn't confirm whether that's live or a leftover, so I left it
exactly where it is and flagged it for a human to check. I also assumed the marketing site's hero
animation source files belong with the site rather than in the docs folder, because a script
literally imports them.

## Goal

Make the repository root read as a monorepo root rather than as a Vite marketing site with a
monorepo grafted around it: move the marketing site into its own `apps/site/` workspace, give every
loose top-level directory a home, commit the orphaned audit artifacts, and update every path that
CI, the deploy, the docs, or a test pins — with zero change to what the deployed site serves.

## Scope

### In scope (this run)

1. **Marketing site → `apps/site/`** as a real npm workspace named `@sayre/site` (`index.html`,
   `src/`, `public/`, `vite.config.ts`, and the site's own scripts).
2. **Root `package.json` becomes a true workspace root** — renamed off `sayre-site`, no runtime
   `dependencies`, site deps relocated, site scripts reduced to thin delegating aliases.
3. **Deploy-compatibility shims**, so no dashboard change is *required* for the site to keep
   deploying: the site build still emits to repo-root `dist/`, root `npm run build` still triggers
   it, root `vercel.json` is byte-unchanged, and root `npx tsc --noEmit` still covers the site.
   Plus two Executor-Human verification steps (AC-16, AC-17).
4. **`scripts/` de-mixed** by moving the marketing-site family out to `apps/site/scripts/`, leaving
   `scripts/` as the SDD control plane + secret-scanning + one product QA script.
5. **Loose top-level directories placed**: `Design System/` → `docs/design-system/`, `Documents/` →
   `docs/product/`, `design/` → `apps/site/design/`.
6. **Orphaned audit artifacts committed** under `docs/audits/` (they are currently untracked).
7. **Hygiene**: `debug.log` removed; `.gitignore` generalized so build/tool scratch directories are
   ignored wherever they now land.
8. **Reference sweep + doc truth**: root `README.md` becomes the monorepo README, `apps/site/README.md`
   takes the site content, `AGENTS.md`'s "Repo shape" section, `CLAUDE.md`'s Structure/Commands,
   `DEPENDENCIES.md`, `scripts/tsconfig.json`'s rationale comment, and `apps/web/package.json`'s
   description are all corrected. New `docs/repo-structure.md` documents the layout and the deferred
   follow-ups.
9. **One CI step added** (`site — build`): the marketing site has never been built in CI, so the only
   signal today is Cloudflare's own check. That is precisely the wrong place to first learn this
   ticket broke something.
10. **One pre-existing red test updated and declared**: `scripts/dependency-baseline.test.mjs`'s
    `[AC-8][EC-10]` case pins the marketing site's scripts/deps to the *root* `package.json`.

### Explicitly out of scope (deferred, with reasons — record all of these in `docs/repo-structure.md`)

- **D1 — Splitting `scripts/` further** into `scripts/pipeline/`, `scripts/security/`, `scripts/ci/`.
  Blocked by real coupling, not taste: `scripts/sdd-completeness.test.mjs` enumerates test suites via
  `readdirSync(resolve(repoRoot, 'scripts'))` (non-recursive) and maps them to npm scripts with the
  regex `scripts/([\w.-]+\.test\.mjs)`, whose character class cannot cross a `/`; `.claude/settings.json`'s
  `PreToolUse` hook command is the literal string `node scripts/guard-checker-readonly.mjs`;
  `scripts/tsconfig.json`'s `include` lists 25 bare filenames; and `.sdd/stages/*.md` reference
  `scripts/<name>.mjs` throughout. Removing the *marketing-site* family (item 4 above) already makes
  `scripts/` coherent without touching any of that.
- **D2 — Removing the root-`dist/` compat shim** and pointing Cloudflare Pages at `apps/site/`.
  Needs the dashboard settings recorded by AC-16 first.
- **D3 — Deciding `vercel.json`'s fate.** Needs AC-17's answer.
- **D4 — Moving `DEPENDENCIES.md` / `MCP_TOOL_CONTRACT.md` / `SECRETS.md` under `docs/`.** 29 tracked
  files reference them, including source comments in `services/core`, `packages/config`,
  `services/workers`, `infra/`, and a red-listed test.
- **D5 — Moving `security-attacker-agents/` under `.sdd/`.** Its paths are pinned by
  `scripts/validate-security-audit-agents.mjs`, `scripts/validate-security-audit-run.mjs`,
  `scripts/sdd-completeness.test.mjs`, and `.sdd/stages/security.md`, and are content-hashed into
  every historical `security/manifest.json` in the ledger. Pure churn against working machinery.
- **D6 — Giving the monorepo root a neutral `tsconfig.json`.** The current root config is the
  marketing site's (React/DOM `compilerOptions`); this run retargets its `include` and has
  `apps/site/tsconfig.json` extend it, which is honest but inverted.
- **D7 — Normalizing filenames that contain spaces** (e.g. `Sayre Directions-selection.png`). This
  run normalizes *directory* names only, to keep the reference sweep bounded.
- **D8 — `scripts/test-product-workspace-ux.mjs` → `apps/web/scripts/`.** It is a fifth family
  (product QA); leaving it keeps this diff's script moves to one coherent set.
- **D9 — Adding `apps/site/**` to a fenced lane in `.sdd/bounds.yml`.** Today the marketing site's
  `src/**` is in no fenced lane either, so this run preserves the existing semantics exactly rather
  than quietly widening a fence.
- **D10 — `docs/wave3-frontend-product-audit.md` → `docs/audits/`.** Tracked and referenced; left in
  place to keep the audit-directory move limited to files that are currently untracked.

### Untouched by design (see "Recorded decisions")

`.sdd/` (including `.sdd/ledger/**` and `.sdd/bounds.yml`), `.claude/`, `.pipeline/`, `.codex/`,
`security-attacker-agents/`, `infra/`, `.github/` (except the single added CI step),
`packages/**`, `services/**`, and `apps/web/**` (except its `package.json` `description` string).

## Affected files

Paths are repo-relative. "Moved" means `git mv` (preserve history; do not delete-and-recreate).

### Moved — marketing site → `apps/site/` (content unchanged unless noted)

| From | To | Content change? |
|---|---|---|
| `index.html` | `apps/site/index.html` | none |
| `src/` (entire tree: `App.tsx`, `config.ts`, `main.tsx`, `vite-env.d.ts`, `data/`, `demo/`, `landing/`, `legal/`, `shared/`, `styles/`) | `apps/site/src/` | none, except `apps/site/src/landing/heroTreeData.ts` line 2's comment (`Design System/filetree-graph*` → `docs/design-system/filetree-graph*`) |
| `public/` (`favicon.svg`, `og.png`, `_redirects`, `media/` — 8 media files) | `apps/site/public/` | none |
| `vite.config.ts` | `apps/site/vite.config.ts` | **yes** — adds `build.outDir` / `build.emptyOutDir` (see Interfaces) |
| `scripts/og.mjs` | `apps/site/scripts/og.mjs` | none |
| `scripts/render-anime-hero.mjs` | `apps/site/scripts/render-anime-hero.mjs` | none |
| `scripts/smoke.mjs` | `apps/site/scripts/smoke.mjs` | none |
| `scripts/test-waitlist.mjs` | `apps/site/scripts/test-waitlist.mjs` | none |
| `scripts/export-tree.mjs` | `apps/site/scripts/export-tree.mjs` | **yes** — output paths (see Interfaces) |
| `scripts/anime-hero-render/index.html` | `apps/site/scripts/anime-hero-render/index.html` | none |
| `scripts/anime-hero-render/entry.jsx` | `apps/site/scripts/anime-hero-render/entry.jsx` | none |
| `design/handoffs/anime-hero-animation/` (README.md + `project/`, incl. `project/screenshots/`) | `apps/site/design/handoffs/anime-hero-animation/` | none |

Four of the five moved scripts require **no** path edits because each already resolves everything
relative to its own file location (`path.resolve(dirname(fileURLToPath(import.meta.url)), "..")`),
so their "repo root" becomes `apps/site` and every derived path (`public/media`, `public/og.png`,
`scripts/.fontcache`, `/scripts/anime-hero-render/index.html`, `../src/config.ts`, `.tmp/`) lands
correctly. `apps/site/scripts/anime-hero-render/entry.jsx`'s
`await import("../../design/handoffs/anime-hero-animation/project/…")` is likewise preserved exactly
by moving `design/` to `apps/site/design/` — that is the reason for that destination (see decisions).

### Moved — loose top-level directories

| From | To |
|---|---|
| `Design System/SAYRE_DESIGN_SYSTEM.md` | `docs/design-system/SAYRE_DESIGN_SYSTEM.md` |
| `Design System/filetree-graph.png` | `docs/design-system/filetree-graph.png` |
| `Design System/filetree-graph-labeled.png` | `docs/design-system/filetree-graph-labeled.png` |
| `Design System/filetree-graph-blank.png` | `docs/design-system/filetree-graph-blank.png` |
| `Design System/filetree-graph.svg` | `docs/design-system/filetree-graph.svg` |
| `Design System/Sayre Directions-selection.png` | `docs/design-system/Sayre Directions-selection.png` (basename preserved — see D7) |
| `Documents/PRD/PRD V1.pdf` | `docs/product/PRD-V1.pdf` |
| `Documents/Spec/SAYRE_FRONTEND_SPEC.md` | `docs/product/SAYRE_FRONTEND_SPEC.md` (content: 3 path refs updated) |

### Moved + newly tracked — audit artifacts (currently untracked on disk)

| From | To |
|---|---|
| `docs/architecture-assessment-2026-07.md` | `docs/audits/architecture-assessment-2026-07.md` |
| `docs/deep-audit-2026-07-31.md` | `docs/audits/deep-audit-2026-07-31.md` |
| `docs/deep-audit-2026-07-31/` (18 files) | `docs/audits/deep-audit-2026-07-31/` |

These are untracked, so `git mv` will not work on them — move on disk, then `git add docs/audits/`.

### Created

- `apps/site/package.json`
- `apps/site/tsconfig.json`
- `apps/site/turbo.json`
- `apps/site/README.md`
- `docs/repo-structure.md`

### Modified

- `package.json` (root)
- `package-lock.json` (regenerated by `npm install`, committed)
- `tsconfig.json` (root) — `include` retargeted
- `turbo.json` — **no change required**; verify and leave alone
- `.gitignore`
- `README.md` (root) — rewritten as the monorepo README
- `AGENTS.md` — "## Repo shape" section
- `CLAUDE.md` — "## Structure" and "## Commands"
- `DEPENDENCIES.md` — line 4's scope sentence, the "Root `package.json` (the marketing site's,
  `sayre-site`)" paragraph (~line 201), and an appended `**PL-15:**` note in that file's existing
  amendment style
- `apps/web/package.json` — `description` ("Distinct from the root Vite marketing site" is now false)
- `scripts/tsconfig.json` — the rationale comment naming nine excluded marketing-site/secret-scanning
  scripts; only four remain in `scripts/`. `compilerOptions` and `include` are unchanged.
- `scripts/dependency-baseline.test.mjs` — the `[AC-8][EC-10]` test (**declared red-test change**)
- `.github/workflows/ci.yml` — one added step

### Deleted

- `debug.log` (untracked; delete from disk)
- Leftover empty directories: `src/`, `public/`, `Design System/`, `Documents/`, `design/`,
  `scripts/anime-hero-render/`

## Interfaces / signatures

### `package.json` (root) — target shape

```jsonc
{
  "name": "sayre",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "packageManager": "npm@11.14.1",
  "workspaces": ["apps/*", "services/core", "services/gateway", "packages/*"],
  "scripts": {
    // Deploy/DX compatibility: these three keep their exact names and observable behaviour so an
    // external build command of `npm run build` at the repo root is unaffected (PL-15 shim, D2).
    "dev": "npm run dev --workspace @sayre/site",
    "build": "npm run build --workspace @sayre/site",
    "preview": "npm run preview --workspace @sayre/site",
    // …every existing check:* / test:* / generate:* / ledger:* / stamp / typecheck:scripts /
    // *:workspaces / workspace-pack / test:product-workspace-ux entry is carried over VERBATIM…
  },
  // No "dependencies" key at all — the workspace root ships no runtime code.
  "devDependencies": {
    "@types/node": "20.x",
    "js-yaml": "^4.3.0",
    "puppeteer-core": "^25.3.0",
    "turbo": "2.1.x",
    "typescript": "~5.6.3"
  }
}
```

Removed from root: `dependencies` (`d3-hierarchy`, `react`, `react-dom`, `react-router-dom`) and the
devDeps `@resvg/resvg-js`, `@types/d3-hierarchy`, `@types/react`, `@types/react-dom`,
`@vitejs/plugin-react`, `vite`. Removed root scripts: `og`, `hero:render`, `test:waitlist` (they move
to `@sayre/site`). `puppeteer-core` **stays** at root — `scripts/test-product-workspace-ux.mjs` still
imports it. `js-yaml` stays (`scripts/generate-agent-shims.mjs`).

### `apps/site/package.json` (new)

```jsonc
{
  "name": "@sayre/site",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Vite/React marketing site (sayre.pages.dev). Distinct from apps/web, the Next.js product client.",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "preview": "vite preview",
    "typecheck": "tsc --noEmit",
    "og": "node scripts/og.mjs",
    "hero:render": "node scripts/render-anime-hero.mjs",
    "smoke": "node scripts/smoke.mjs",
    "export-tree": "node scripts/export-tree.mjs",
    "test:waitlist": "node scripts/test-waitlist.mjs"
  },
  "dependencies": {
    "d3-hierarchy": "^3.1.2",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.30.0"
  },
  "devDependencies": {
    "@resvg/resvg-js": "^2.6.2",
    "@types/d3-hierarchy": "^3.1.7",
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.4",
    "puppeteer-core": "^25.3.0",
    "vite": "^5.4.11"
  },
  "engines": { "node": ">=20 <21" }
}
```

Every version spec is carried over **verbatim** from today's root `package.json` — this ticket
relocates dependencies, it does not upgrade any. `typescript` and `@types/node` are deliberately
**not** declared here: they stay root devDeps and resolve by hoisting, which avoids introducing a
second TypeScript version and avoids the question of whether `apps/site` should join
`scripts/dependency-baseline.test.mjs`'s `NPM_MANIFEST_PATHS` (it should not — see decisions).

### `apps/site/vite.config.ts`

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// PL-15 deploy-compatibility shim. Cloudflare Pages' build settings live in the Cloudflare
// dashboard, not in this repo, and today build from the repo root into `dist/`. Emitting there
// keeps that external contract byte-identical now that the site lives in apps/site/. Do NOT
// "clean this up" to the default apps/site/dist without flipping the dashboard first — that is
// deferred follow-up D2 in docs/repo-structure.md.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "../../dist",   // resolved relative to this config's dir (apps/site)
    emptyOutDir: true,      // required: Vite refuses to clear a dir outside its root otherwise
  },
});
```

### `apps/site/tsconfig.json`

```json
{ "extends": "../../tsconfig.json", "include": ["src"] }
```

### `tsconfig.json` (root) — only `include` changes

`"include": ["src"]` → `"include": ["apps/site/src"]`. `compilerOptions` untouched. This keeps
`npx tsc --noEmit` at the repo root (CLAUDE.md's Verification step 1, and the site build's own
`tsc --noEmit`) checking exactly the same file set as before.

### `apps/site/turbo.json` (new)

```json
{ "extends": ["//"], "tasks": { "build": { "outputs": [], "cache": false } } }
```

Reason: the root `turbo.json` declares `build`'s outputs as `dist/**` *within* each package, but
`@sayre/site` writes outside its own package directory under the shim above. Declaring no outputs
and disabling the cache for this one task avoids turbo reporting a cache hit for a build that
produced nothing it tracked.

### `apps/site/scripts/export-tree.mjs` — the only script needing a path edit

`root` (currently `scripts/..`, becoming `apps/site`) is still correct for the Vite dev server and
for the `scripts/.fontcache` path, but the four `OUT_*` constants must target the repo root's new
design-system directory:

```js
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");        // apps/site
const repoRoot = path.resolve(root, "..", "..");                                       // repo root
const DESIGN_SYSTEM_DIR = path.join(repoRoot, "docs", "design-system");
const OUT_PLAIN   = path.join(DESIGN_SYSTEM_DIR, "filetree-graph.png");
const OUT_LABELED = path.join(DESIGN_SYSTEM_DIR, "filetree-graph-labeled.png");
const OUT_BLANK   = path.join(DESIGN_SYSTEM_DIR, "filetree-graph-blank.png");
const OUT_SVG     = path.join(DESIGN_SYSTEM_DIR, "filetree-graph.svg");
```

Its file-header comment (lines 3–4) names `Design System/filetree-graph*.png` — update to
`docs/design-system/…`. Its usage line (`node scripts/export-tree.mjs`) becomes
`npm run export-tree --workspace @sayre/site`.

### `.gitignore` — exact edits

Replace:
```
scripts/.fontcache/
scripts/.shots/
```
with:
```
**/.fontcache/
**/.shots/
**/.tmp/
```
(`**/.tmp/` is new coverage: `render-anime-hero.mjs`'s `FRAME_DIR` writes `.tmp/anime-hero-frames`
and was never ignored.)

Add, in the "Claude agent workflow" block:
```
.playwright-mcp/
.pipeline-backup-*/
```

`dist/` stays exactly as-is — it remains the site's build output directory under the shim, and the
same rule also covers `apps/site/dist/` after D2.

### `.github/workflows/ci.yml` — one added step

Insert in the `node` job, immediately **after** the `Install dependencies (root, single pass)` step
and before `Agent shims — staleness check`:

```yaml
      # PL-15: the marketing site moved from the repo root into apps/site/. Until now nothing in
      # this repo ever built it — the only signal was Cloudflare Pages' own check on the PR, which
      # is the wrong place to first learn a restructure broke the site. `npm run build --workspace`
      # rather than a turbo filter, so this runs the site's real `tsc --noEmit && vite build`
      # without depending on turbo's cache semantics for a package that writes outside itself.
      - name: site — build
        run: npm run build --workspace @sayre/site
```

### `scripts/dependency-baseline.test.mjs` — the declared red-test change

Only the `[AC-8][EC-10]` test body changes. Its intent (W0-00's diff must not disturb the marketing
site's scripts/deps, nor the infra image pins) is preserved and strengthened, not weakened:

```js
// @spec AC-8 EC-10
// PL-15: the marketing site moved from the repo root into apps/site/ (@sayre/site). The guarantee
// this test exists for is unchanged — only the manifest that holds the marketing site's scripts and
// dependencies moved. Declared as a red-test change in .pipeline/changes.json.
test('[AC-8][EC-10] the marketing site scripts/deps and infra image pins are unchanged', () => {
  const site = readJson('apps/site/package.json');
  assert.equal(site.scripts.dev, 'vite', 'marketing site dev script must stay `vite`');
  for (const script of ['og', 'test:waitlist', 'preview']) {
    assert.ok(site.scripts[script], `marketing site script ${script} must remain`);
  }
  for (const dep of ['d3-hierarchy', 'react-router-dom']) {
    assert.ok(site.dependencies[dep], `marketing site dependency ${dep} must remain`);
  }
  assert.ok(site.devDependencies.vite, 'marketing site vite devDependency must remain');

  // The workspace root must no longer carry the site's runtime dependencies — conflating the two
  // is exactly what PL-15 removed, and a silent regression back to it should fail here.
  const root = readJson('package.json');
  assert.equal(root.dependencies, undefined, 'the workspace root must declare no runtime dependencies');

  const compose = readText('infra/docker-compose.yml');
  for (const image of ['pgvector/pgvector:pg16', 'redis:7.4-alpine', 'neo4j:5.24-community']) {
    assert.ok(compose.includes(image), `infra image ${image} must stay unchanged`);
  }
});
```

`NPM_MANIFEST_PATHS` is **not** extended with `apps/site` — doing so would subject it to the AC-7
shared-tooling pin (`typescript: 5.5.x`), which is a dependency-policy decision this ticket has no
mandate to make.

### Documentation content contracts

- **`README.md` (root)** — replaced. Must contain, at minimum: one-paragraph statement of what Sayre
  is; a repo-layout table (`apps/site`, `apps/web`, `services/core`, `services/gateway`,
  `services/workers`, `packages/*`, `infra/`, `docs/`, `scripts/`, `.sdd/`, `security-attacker-agents/`)
  with one line each; a "Run it" section naming `npm run dev` (marketing site),
  `npm run dev:workspaces` (platform), `npm run build`, `npm run test:workspaces`; a pointer to
  `docs/repo-structure.md`, `CLAUDE.md`, and `AGENTS.md`. It must **not** retain marketing-site
  specifics (waitlist/Google Form, `src/config.ts` table, OG regeneration, deploy hosts).
- **`apps/site/README.md`** — receives today's root README content verbatim except: the `Spec:` /
  `Design system:` line repointed at `docs/product/SAYRE_FRONTEND_SPEC.md` and
  `docs/design-system/SAYRE_DESIGN_SYSTEM.md`; the archive line repointed at
  `apps/site/design/handoffs/anime-hero-animation/`; every `npm run …` example prefixed with
  `--workspace @sayre/site` (or a "run these from `apps/site/`" note); the `src/config.ts` heading
  becomes `apps/site/src/config.ts`; and the Deploy section states that Cloudflare Pages builds from
  the **repo root** into repo-root `dist/` via the shim, pointing at `docs/repo-structure.md`'s D2.
- **`AGENTS.md` § "Repo shape"** — the "Both of these are true at once" framing (the root *is* a Vite
  marketing site *and* a monorepo) is now false and must be replaced with a plain statement that the
  root is a monorepo workspace root and the marketing site is `apps/site`. The following paragraph's
  claim about which root scripts exist must be re-checked against the new root `package.json`
  (`test:waitlist` is no longer a root script).
- **`CLAUDE.md` § Structure** — add `apps/site/` — Vite/React marketing site (sayre.pages.dev). **§
  Commands** — correct the current mismatch: `npm run dev` runs the marketing site;
  `npm run dev:workspaces` is the turbo web+core+gateway command.
- **`docs/repo-structure.md` (new)** — the directory map, the three deploy-compat shims and why they
  exist, and the full D1–D10 deferred list with each reason.

## Approach

Build in this order; each step is independently verifiable, and the earlier steps are the ones with
deploy risk, so they get verified first.

1. **Create the workspace skeleton.** `apps/site/package.json`, `apps/site/tsconfig.json`,
   `apps/site/turbo.json`. Add `apps/*` to the root `workspaces` array. Do not move files yet.
2. **Move the site.** `git mv index.html src public vite.config.ts` into `apps/site/`. Edit
   `apps/site/vite.config.ts` to add the `build.outDir`/`emptyOutDir` shim. Retarget root
   `tsconfig.json`'s `include`.
3. **Rebalance the manifests.** Strip the site's deps/scripts from root `package.json`, rename it to
   `sayre`, add the three delegating scripts. Run `npm install` at the repo root and commit the
   regenerated `package-lock.json`.
4. **Verify the deploy contract now, before anything else moves**: `npm ci`, then `npm run build` at
   the repo root; confirm `dist/index.html`, `dist/assets/`, `dist/_redirects`, `dist/media/`,
   `dist/og.png`, `dist/favicon.svg` all exist. Confirm `npx tsc --noEmit` at the root exits 0.
   If this does not hold, stop and fix it before step 5 — every later step is cosmetic by comparison.
5. **Move the site scripts and the design handoff.** `git mv` the five `.mjs` files and
   `scripts/anime-hero-render/` into `apps/site/scripts/`; `git mv design apps/site/design`. Confirm
   `apps/site/scripts/anime-hero-render/entry.jsx` needs no edit (its `../../design/…` imports still
   resolve). Move `og`/`hero:render`/`test:waitlist` script entries to `apps/site/package.json` and
   add `smoke`/`export-tree`.
6. **Move the loose docs directories.** `git mv "Design System" docs/design-system`,
   `git mv "Documents/PRD/PRD V1.pdf" docs/product/PRD-V1.pdf`,
   `git mv Documents/Spec/SAYRE_FRONTEND_SPEC.md docs/product/SAYRE_FRONTEND_SPEC.md`. Remove the
   now-empty `Documents/` tree. Edit `apps/site/scripts/export-tree.mjs`'s output paths.
7. **Commit the audit artifacts.** Move the three untracked paths on disk into `docs/audits/`, then
   `git add docs/audits/`.
8. **Hygiene.** Delete `debug.log`. Apply the `.gitignore` edits. Confirm no leftover empty
   directories.
9. **Reference sweep.** Run the greps in AC-12 and fix every hit in a tracked, non-historical file.
   Explicitly do **not** touch `.sdd/ledger/**` or `.pipeline-backup-*/` — those are immutable records
   of what the tree looked like at the time.
10. **Docs and manifests truth pass.** Root `README.md`, `apps/site/README.md`,
    `docs/repo-structure.md`, `AGENTS.md`, `CLAUDE.md`, `DEPENDENCIES.md`, `apps/web/package.json`'s
    description, `scripts/tsconfig.json`'s comment.
11. **Tests and CI.** Update `scripts/dependency-baseline.test.mjs`'s `[AC-8][EC-10]`; add the
    `site — build` CI step; declare the red-test change in `.pipeline/changes.json` with the reason.
12. **Run the full verification matrix** (AC-15) and record the results in `.pipeline/changes.md`.

## Acceptance criteria

- **AC-1** — The marketing site's sources live under `apps/site/` and nowhere else:
  `git ls-files index.html src public vite.config.ts` returns nothing, and
  `apps/site/index.html`, `apps/site/vite.config.ts`, `apps/site/src/main.tsx`,
  `apps/site/src/App.tsx`, `apps/site/src/config.ts`, `apps/site/public/_redirects`,
  `apps/site/public/og.png`, `apps/site/public/favicon.svg`, and `apps/site/public/media/` all exist
  and are tracked. Every moved file's contents are byte-identical to its pre-move contents except
  `apps/site/vite.config.ts` and `apps/site/src/landing/heroTreeData.ts`.

- **AC-2** — `apps/site/package.json` exists, is named `@sayre/site`, and matches the shape in
  Interfaces (including every version spec carried over verbatim). The root `package.json` is named
  `sayre`, has no `dependencies` key, includes `apps/*` in `workspaces`, and retains every
  `check:*`/`test:*`/`generate:*`/`ledger:*`/`stamp`/`typecheck:*`/`*:workspaces`/`workspace-pack`/
  `test:product-workspace-ux` script verbatim, plus `dev`/`build`/`preview` as delegating aliases.

- **AC-3** — `npm ci` at the repo root exits 0 against the committed `package-lock.json`
  (i.e. the lockfile was regenerated in this change, not left stale).

- **AC-4** — `npm run build` at the repo root exits 0 and produces, at repo-root `dist/`:
  `index.html`, `assets/` (one `.js` + one `.css`), `_redirects`, `og.png`, `favicon.svg`, and
  `media/` with all 8 files. The set of emitted paths is the same set as a pre-change build.

- **AC-5** — `npx tsc --noEmit` at the repo root exits 0, and the root `tsconfig.json`'s `include` is
  `["apps/site/src"]` (so the command is not vacuously passing over an empty file set).

- **AC-6** — `.github/workflows/ci.yml`'s `node` job contains a `site — build` step running
  `npm run build --workspace @sayre/site`, placed after the root install step.

- **AC-7** — `scripts/` contains no marketing-site script: `scripts/og.mjs`,
  `scripts/render-anime-hero.mjs`, `scripts/smoke.mjs`, `scripts/test-waitlist.mjs`,
  `scripts/export-tree.mjs`, and `scripts/anime-hero-render/` do not exist, and their
  `apps/site/scripts/` counterparts do. Every `scripts/*.test.mjs` file and every SDD control-plane
  `.mjs` remains at `scripts/` (unmoved), and `scripts/tsconfig.json`'s `compilerOptions` and
  `include` array are unchanged.

- **AC-8** — No directory at the repo root has a name containing a space, and `Design System/`,
  `Documents/`, and `design/` no longer exist. `docs/design-system/` holds all 6 former
  `Design System/` files; `docs/product/` holds `PRD-V1.pdf` and `SAYRE_FRONTEND_SPEC.md`;
  `apps/site/design/handoffs/anime-hero-animation/` holds the former `design/` tree.

- **AC-9** — `git ls-files docs/audits` lists `docs/audits/architecture-assessment-2026-07.md`,
  `docs/audits/deep-audit-2026-07-31.md`, and 18 files under `docs/audits/deep-audit-2026-07-31/`;
  none of them remain at their former `docs/` locations, and their contents are byte-identical to
  the untracked originals.

  **AMENDMENT (dev attempt 2, post security-BLOCKED round):** original text above retained
  unmodified per `.sdd/stages/dev.md`'s amendment convention — this is the sanctioned "the spec was
  wrong" case, not a silent edit. `security-checker`'s first pass (`.pipeline/security-report.md`,
  run `20260809T104534944Z-17e2299ac5f2-PR_DELTA-b175a8`) reproduced a live, unredacted credential
  (`NEO4J_AUTH`) committed verbatim in `docs/audits/deep-audit-2026-07-31/audit-18-infra-cicd.md`
  (CRITICAL, CORE-03/SEC-02 v1) and a reconnaissance-grade masked-but-confirmed-live 12-secret
  inventory with exact file/line locations and per-row liveness tags in
  `docs/audits/deep-audit-2026-07-31/audit-15-secrets-deps.md` (HIGH, SEC-02 v2), corroborated by
  `docs/audits/deep-audit-2026-07-31.md` and `docs/audits/architecture-assessment-2026-07.md`.
  "Byte-identical to the untracked originals" is therefore corrected, for these four files only, to:
  **byte-identical to the untracked originals except security-mandated redactions, which are
  digest-pinned post-redaction.** The coordinator's disposition (safety-first default): generalize,
  don't drop — narrative/category/remediation guidance preserved in every finding; the live
  credential value and the exact file:line-to-secret mapping / per-row REAL-liveness tags removed,
  replaced with a note that exact locations and liveness were confirmed at audit time and remain on
  file in the auditor's untracked working copy. All 16 other files under `docs/audits/deep-audit-2026-07-31/`
  are unaffected and remain byte-identical to the untracked originals exactly as this AC originally
  required. `infra/New Text Document.txt` (the untracked source file the audits describe) is
  explicitly out of this diff's scope, per the coordinator's routing message — its deletion and the
  live credential's rotation are the human operator's own urgent actions, tracked separately.

  **AMENDMENT ROUND 2 (dev attempt 3, final):** attempt 2's "digest-pinned post-redaction" fix above
  still rendered masked value fragments (a real value's first/last few real characters, or a
  provider's real leading characters) for the same four files — real characters of a real credential
  are real secret material regardless of how few, so the coordinator's final disposition is a
  zero-character placeholder (e.g. `<redacted>`) for every value, everywhere in `docs/audits/**`, with
  no scheme/provider-prefix rendering either. Same four files re-redacted and re-pinned to their
  attempt-3 digests; no additional file needed redaction beyond a full repo-wide sweep (the two
  corroborating files already carried no exact-location table or masked fragment worth stripping
  beyond one placeholder-string normalization in `docs/audits/deep-audit-2026-07-31.md`). The
  qualifying text this amendment adds to AC-9 stays the same ("byte-identical ... except
  security-mandated redactions, which are digest-pinned post-redaction") — only the digests
  themselves, and the files' content, changed again.

  **AMENDMENT ROUND 3 (review pass 2, coordinator hand-fix under /re-gate — original text above
  retained).** Round 2's parenthetical claim that "the two corroborating files already carried no
  exact-location table" was **false**: `docs/audits/deep-audit-2026-07-31.md` §P0-5 still rendered a
  `| Line | Secret |` table mapping exact `infra/New Text Document.txt` line numbers to all 13
  secrets, and `audit-18-infra-cicd.md` still cited the credential's exact `:23` line twice — the
  same reconnaissance class SEC-02 v2 blocked on, in locations the value-fragment sweeps
  structurally could not catch (they contain zero value characters). Both are now generalized
  (line column removed with an honest removal note; line citations dropped from the file
  reference), the two affected digests re-pinned, and this paragraph replaces the false
  completeness claim as the record of what round 2 actually left behind. The AC-9 qualifying text
  is again unchanged.

- **AC-10** — `debug.log` does not exist at the repo root. `.gitignore` contains `**/.fontcache/`,
  `**/.shots/`, `**/.tmp/`, `.playwright-mcp/`, and `.pipeline-backup-*/`, no longer contains
  `scripts/.fontcache/` or `scripts/.shots/`, and still contains `dist/`, `.pipeline/**`,
  `!.pipeline/README.md`, and `.codex/`. `git check-ignore -q .sdd/ledger/index.json` exits 1
  (the ledger is still trackable).

- **AC-11** — `apps/site/scripts/export-tree.mjs` writes its four outputs into repo-root
  `docs/design-system/`, and `apps/site/scripts/anime-hero-render/entry.jsx` is unmodified.

- **AC-12** — Reference sweep is clean. Each of these returns no hits in tracked files, excluding
  `.sdd/ledger/**` and any `.pipeline*` path:
  `Design System/` · `Documents/` · `design/handoffs/` · `scripts/og.mjs` · `scripts/smoke.mjs` ·
  `scripts/export-tree.mjs` · `scripts/test-waitlist.mjs` · `scripts/render-anime-hero.mjs` ·
  `scripts/anime-hero-render/` · `"sayre-site"`.
  (Known hits to fix: `README.md`, `docs/product/SAYRE_FRONTEND_SPEC.md`,
  `apps/site/src/landing/heroTreeData.ts`, `apps/site/scripts/export-tree.mjs`, `package.json`,
  `DEPENDENCIES.md`, `scripts/tsconfig.json`.)

- **AC-13** — Documentation reflects reality: root `README.md`, `apps/site/README.md`, and
  `docs/repo-structure.md` satisfy the content contracts in Interfaces; `AGENTS.md`'s "Repo shape"
  section no longer asserts the repo root is a Vite marketing site; `CLAUDE.md`'s Structure section
  lists `apps/site/` and its Commands section distinguishes `npm run dev` from `npm run dev:workspaces`;
  `apps/web/package.json`'s `description` no longer says "root Vite marketing site"; `DEPENDENCIES.md`
  carries a `**PL-15:**` note recording the manifest split. `docs/repo-structure.md` records all ten
  deferred items D1–D10 with their reasons.

- **AC-14** — The change to `scripts/dependency-baseline.test.mjs` is declared as a red-test change in
  `.pipeline/changes.json` (file path + reason + a statement that the assertion's intent is preserved
  or strengthened, never weakened), and that file is the **only** pre-existing test file this change
  modifies.

- **AC-15** — Verification matrix: every command CI runs passes locally from the repo root.
  `npm run check:secret-access` · `npm run test:secret-access` · `npm run check:org-secret-access` ·
  `npm run test:org-secret-access` · `npm ci` · `npm run build --workspace @sayre/site` ·
  `npm run check:agent-shims` · `npm run test:agent-shims` · `npm run test:sdd-completeness` ·
  `npm run check:agent-ignore` · `npm run test:agent-ignore` · `npm run check:ledger-index` ·
  `npm run test:ledger-index` · `npm run test:ledger-append` · `npm run test:red-integrity` ·
  `npm run check:security-audit-agents` · `npm run test:security-audit-agents` ·
  `npm run test:security-audit-run` · `npm run test:pipeline-contracts` · `npm run test:write-stamp` ·
  `npm run test:stamp-freshness` · `npm run test:bounds` · `npm run test:lite-eligible` ·
  `npm run test:readonly-guard` · `npm run test:dependency-baseline` ·
  `npm run test:dependency-install` · `npm run typecheck:scripts` ·
  `npm run typecheck --workspace @sayre/config` · `npm test --workspace @sayre/config` ·
  `npx turbo run lint --filter=@sayre/web` · `npx turbo run typecheck --filter=@sayre/web` ·
  `npx turbo run test --filter=@sayre/web` · `npx turbo run lint --filter=@sayre/gateway` ·
  `npx turbo run typecheck --filter=@sayre/gateway` · `npx turbo run test --filter=@sayre/gateway` ·
  `npx turbo run lint --filter=@sayre/core` · `npx turbo run typecheck --filter=@sayre/core` ·
  `npx tsc --noEmit`.
  Any command that cannot run in this environment (Docker/Postgres/Redis-gated `@sayre/core` suites,
  the Python `workers` job) must be reported as **not run, with the reason**, never as passing.

- **AC-16** — *(Executor: Human — Cloudflare dashboard, no repo diff can do this)* Before merge, in
  Cloudflare **Pages** → account `9b15e5f5…` → project `sayre` → Settings → Builds & deployments,
  record verbatim into the PR description: **Root directory**, **Build command**, **Build output
  directory**. Confirm they are compatible with the shim (root directory `/` or empty; build command
  resolving to root `npm run build` or `npm run build --workspace @sayre/site`; output directory
  `dist`). If any of the three is incompatible, **do not merge**: either extend the shim or change
  the dashboard within the same merge window, and say which was done. Then confirm the `Cloudflare
  Pages` check on the PR is green and, after merge, that `sayre.pages.dev` serves the site including
  `/privacy`. Do **not** touch the separate Cloudflare **Workers** project on account `791596…`
  (that is PL-09's ticket, and revoking the shared GitHub App would take Pages down with it).

- **AC-17** — *(Executor: Human — Vercel dashboard)* Determine whether a live Vercel project is
  connected to this repository. Record the answer (and, if one exists, its **Root Directory** setting)
  in the PR description. `vercel.json` is byte-unchanged by this ticket either way; the answer feeds
  deferred item D3.

- **AC-18** — Nothing in `.sdd/` (including `.sdd/ledger/**` and `.sdd/bounds.yml`), `.claude/`,
  `.codex/`, `security-attacker-agents/`, `infra/`, `packages/**`, `services/**`, `turbo.json`, or
  `vercel.json` is modified, and `apps/web/**` is modified only in `apps/web/package.json`'s
  `description` string. `.github/` is modified only by AC-6's single added step.

## Edge cases

- **EC-1** — `package-lock.json` not regenerated after the manifests are split: `npm ci` fails with
  "lock file does not satisfy package.json". This is the single most likely way this change turns
  CI red on every job at once.
- **EC-2** — The Cloudflare Pages dashboard's build command is not `npm run build` (e.g. a literal
  `vite build`, or a `--prefix`/`--filter` form), or its output directory is not `dist`, or its root
  directory is not `/`. The shim then does not cover it and the site build breaks on merge. AC-16
  exists to catch this before merge, not after.
- **EC-3** — A live Vercel project exists with Root Directory `/`. `vercel.json` must stay at the repo
  root (Vercel reads it from the configured root directory), which is why this ticket does not move it.
- **EC-4** — `git mv` on a directory whose name contains a space (`"Design System"`) — the path must be
  quoted; an unquoted invocation silently moves the wrong thing or errors.
- **EC-5** — Case-insensitive filesystem (this checkout is Windows). None of the moves in this ticket
  is a case-only rename, but `Documents/` → `docs/product/` involves an existing `docs/` directory
  whose name differs only in case from `Documents` at the first letter — verify with
  `git ls-files docs Documents` after the move that no path was silently merged or lost.
- **EC-6** — `dist/` already exists at the repo root with stale content from a previous build. Vite
  refuses to empty an `outDir` outside its project root unless `emptyOutDir: true` is set explicitly;
  without it the build either warns and leaves stale files or fails. With it, confirm the emitted set
  is complete rather than a merge of old and new.
- **EC-7** — A moved script's relative path resolving to a *different but existing* location instead
  of failing loudly (e.g. `scripts/.fontcache` now meaning `apps/site/scripts/.fontcache`). Verify by
  execution or by reading each resolved path, not by assuming.
- **EC-8** — Moving any `scripts/*.test.mjs` file out of `scripts/` would break
  `scripts/sdd-completeness.test.mjs`'s non-recursive `readdirSync` enumeration and its
  `scripts/([\w.-]+\.test\.mjs)` package.json-value regex (the character class cannot cross a `/`).
  This ticket moves none of them; confirm that holds.
- **EC-9** — `.claude/settings.json`'s `PreToolUse` hook runs the cwd-relative command
  `node scripts/guard-checker-readonly.mjs`. That script does not move; if it ever did, the
  `review`/`security-checker`/`pr-review` read-only guard would silently stop enforcing (a hook that
  fails to load exits 1, and only exit 2 blocks).
- **EC-10** — A pre-existing red-listed test's content hash changes without being declared, which
  `review`'s red-test integrity check treats as a Critical. Exactly one such file changes here
  (`scripts/dependency-baseline.test.mjs`); it must be declared in `.pipeline/changes.json`.
- **EC-11** — `check:secret-access` runs **before** `npm ci` and scans every tracked
  `.ts/.tsx/.js/.jsx/.mjs/.cjs/.py` file from `git ls-files`, excluding path segments named
  `node_modules|.venv|venv|__pycache__|dist|build|coverage|generated|vendor`. Moved files stay in
  scope (none lands under an excluded segment), and its `ALLOWLIST` contains no moved path — so the
  gate's verdict must be unchanged. Confirm rather than assume: this step runs first in CI.
- **EC-12** — `.sdd/ledger/**`, `.sdd/stages/CHANGELOG.md`, and `.pipeline-backup-*/` contain many
  references to the old paths. These are historical records of past runs and must **not** be
  rewritten by the reference sweep; a "helpful" find-and-replace there would corrupt a
  content-hashed ledger entry and fail `test:sdd-completeness`'s pinned-hash assertions.
- **EC-13** — `.sdd/bounds.yml`'s `frontend` lane allows `apps/web/**` and `docs/**`. `apps/site/**`
  is in no fenced lane, exactly as root `src/**` is today — leaving it alone preserves the existing
  fence rather than silently widening it. This is a deliberate non-change (D9).
- **EC-14** — Turbo caching: `@sayre/site`'s build writes outside its own package directory, so the
  root `turbo.json`'s `outputs: ["dist/**", ".next/**"]` would record an empty output set and could
  report a cache hit for a build that produced nothing. `apps/site/turbo.json` disables the cache for
  that one task.
- **EC-15** — `npm run workspace-pack` (`vite-node packages/workspace-packs/src/cli-entry.ts`) has no
  declared `vite-node`/`vite` dependency anywhere; it resolves today via hoisting. Removing `vite`
  from the root devDeps must not break it (`vitest` still brings `vite` and `vite-node` transitively).
  Verify the command still starts.
- **EC-16** — `public/_redirects` carries both the SPA fallback and the `/demo` → `/` redirect. If it
  fails to reach `dist/_redirects`, `/privacy` 404s on Cloudflare Pages — a break that the build
  exiting 0 will not reveal.
- **EC-17** — `public/og.png`, `public/favicon.svg`, and `public/media/*` are committed static
  binaries, not build products (`npm run og` / `npm run hero:render` regenerate them on demand). They
  must be moved, never regenerated — a regenerated binary is an unreviewable diff.
- **EC-18** — Leftover empty directories after the moves (`src/`, `public/`, `Design System/`,
  `Documents/`, `Documents/PRD/`, `Documents/Spec/`, `design/`, `scripts/anime-hero-render/`). Git
  does not track empty directories, so they will not show in a diff but will still be on disk and in
  a file listing — which is the exact complaint this ticket exists to answer.
- **EC-19** — `apps/web/package.json`'s description ("Distinct from the root Vite marketing site")
  becomes false the moment the site moves. Small, but it is the kind of stale claim that teaches the
  next reader to distrust every other description in the repo.
- **EC-20** — `docs/deep-audit-2026-07-31.md` is an index over the 18 files in
  `docs/deep-audit-2026-07-31/`. Moving both under `docs/audits/` preserves their relative
  positions, so intra-audit links should survive — verify at least the index's links rather than
  assuming.
- **EC-21** — A broadened `.gitignore` pattern (`**/.tmp/`, `**/.shots/`, `**/.fontcache/`)
  accidentally matching an existing tracked path. Confirm `git status --porcelain` reports no newly
  ignored tracked file, and that `git check-ignore` on a representative tracked path in each
  workspace exits 1.
- **EC-22** — Root script semantics drift: `npm run dev` must still start the marketing site on
  :5173 and `npm run build` must still build the site, because both names are load-bearing outside
  this repo (deploy) and in muscle memory. Changing `dev` to mean "turbo across workspaces" would be
  a defensible design and is explicitly **not** done here.
- **EC-23** — `apps/site` joins the `apps/*` workspace glob, so `turbo run lint|typecheck|test`
  across workspaces now includes it. `@sayre/site` declares no `lint` or `test` script; turbo skips
  missing tasks rather than failing, but confirm `npm run test:workspaces` and `npm run lint:workspaces`
  still exit 0.
- **EC-24** — `engines: { "node": ">=20 <21" }` on `@sayre/site` under a Node runtime outside that
  range (Cloudflare Pages' default build image, a contributor on Node 22) produces an `EBADENGINE`
  warning — harmless unless `engine-strict` is set, but note it if the Pages build log shows it.

## Open questions

Both of these block **merge**, not `dev` — the shims in this spec are designed so implementation can
proceed and be fully verified without either answer.

- **OQ-1 (blocks merge)** — What are the Cloudflare Pages project's actual Root directory / Build
  command / Build output directory settings? They live in the Cloudflare dashboard and no repo diff
  can read or change them. The shim is built to preserve the repo-root `npm run build` → repo-root
  `dist/` contract, which covers the default configuration, but "covers the default" is an assumption
  until a human reads the dashboard. AC-16 is that read.
- **OQ-2 (blocks D3, not this ticket)** — Is there a live Vercel project for this repository?
  `README.md` documents a Vercel deploy path and `vercel.json` exists, but `docs/PRD_Tickets.md`'s
  PL-09 investigation found only Cloudflare Pages serving `sayre.pages.dev` and `trysayre.com`
  parked at Namecheap. Resolved here by *not moving* `vercel.json`; AC-17 records the answer so D3
  can be scoped.

---

*Note for the coordinator: I could not run `node scripts/write-stamp.mjs .pipeline/spec.json`
(no shell in this stage's tool grant). Per the run instructions, the coordinator stamps
`.pipeline/spec.json` after this stage. `red` must not start against an unstamped sidecar.*
