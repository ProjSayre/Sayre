# Audit 14 — Dead Code, Duplication & Repo Hygiene

Repo: `C:\Users\splat\OneDrive\Desktop\Sayre` · Branch `planning/future-tickets` @ `b8dc223` · Date 2026-07-31

Every claim below was verified with `git`/`grep`/`node`. Findings are labelled **VERIFIED** (proved by command
output) or **SUSPECTED** (inference stated as such).

---

## 1. THE STRUCTURAL VERDICT — `src/` vs `apps/web/`

**Both are live and both are authoritative — for different products. This is a deliberate, documented split,
not drift.** The real problem is not the two frontends; it is that the *root build/verification wiring* still
belongs exclusively to the marketing site, so CLAUDE.md's mandated verification loop silently checks almost
nothing. See Finding A.

### Evidence

| | `src/` (root Vite app) | `apps/web/` (Next.js) |
|---|---|---|
| npm package | `sayre-site` (root `package.json`) | `@sayre/web` |
| Purpose | public marketing site — `trysayre.com` | the product: Technical/Product/Onboarding canvas |
| Routes | `/`, `/privacy` only (`src/App.tsx:7-12`) | full product app |
| Tracked files | 53 | 121 |
| Commits touching it | 12 | 54 |
| Last touched | **2026-07-21** (`520ce9e` "Harden public landing page") | **2026-07-27** (`3d777ca`) |
| CI coverage | **none** | lint + typecheck + test |

The split is explicit, not accidental — `apps/web/package.json` describes itself as:

> "Next.js product visualization client (Technical/Product/Onboarding tree canvas). Distinct from the root
> Vite marketing site."

And `DEPENDENCIES.md:4` states it "does **not** cover the root Vite marketing site".

**There is zero code coupling between them** (VERIFIED — `git grep` for cross-imports in both directions
returns nothing). `src/data/*` is *not* drifted product logic; it is hand-written fixture data describing a
**fictional e-commerce repo** (`src/data/edges.ts:19` references `apps/web/src/checkout/CheckoutPage.tsx`, a
path that does not exist in this repo). The name collisions between the two trees (`TopBar`) are coincidental,
and the collisions between `apps/web/app/lib/*` and `services/core/src/services/*` (`saveAgentSkillMd`,
`disconnectJira`) are **correct layering**, not duplication — VERIFIED by reading both: the `apps/web` copies
are thin `fetch` wrappers hitting `/api/core/...`, the `services/core` copies are the real implementations with
`AuthContext` and RBAC (`apps/web/app/lib/nodeOverlay.ts:240` vs
`services/core/src/services/agentSkillMdService.ts:186`).

### Recommended action — KEEP BOTH, but fix the root wiring and amputate the dead demo

1. **Keep** `src/` as the marketing site. It ships `trysayre.com` and is genuinely live.
2. **Keep** `apps/web/` as the product. Authoritative for everything CLAUDE.md describes.
3. **Fix the root `package.json` script names** (Finding A) — this is the actual bug the two-frontend layout
   is causing.
4. **Delete the dead demo island inside `src/`** (Finding C) — 23 unreachable files.
5. Consider **moving the marketing site to `apps/site/`** so the root `package.json` becomes a pure workspace
   root. This removes the root-scripts ambiguity permanently. Medium effort, high clarity payoff; optional.

---

## 2. FINDINGS BY IMPACT

### A. CRITICAL — CLAUDE.md's mandated verification loop is 2/3 non-functional

CLAUDE.md "Verification" instructs, after **every change**:
`1. npx tsc --noEmit` → `2. npm run test` → `3. npm run lint`.

**VERIFIED — two of those three scripts do not exist at the repo root:**

```
$ npm run test  → npm error Missing script: "test"
$ npm run lint  → npm error Missing script: "lint"
```

Root `package.json` defines `test:workspaces` / `lint:workspaces` / `typecheck:workspaces`, but no bare
`test`, `lint`, or `typecheck`.

Worse, step 1 **passes while checking none of the product code**. Root `tsconfig.json` sets
`"include": ["src"]`, so `npx tsc --noEmit` at the root typechecks **only the 48 marketing-site files** —
zero files from `apps/web`, `services/core`, `services/gateway`, or `packages/*`
(VERIFIED via `npx tsc --noEmit --listFilesOnly`; exits 0).

Net effect: an agent that edits `services/core` and dutifully follows CLAUDE.md gets one green checkmark
that proves nothing and two hard errors it must route around.

**Compounding: `AGENTS.md` directly contradicts `CLAUDE.md`.** `AGENTS.md:24` says:

> "Do not run `npm test` or `npm run lint` unless the active package actually defines those scripts."

AGENTS.md is correct; CLAUDE.md is wrong.

**Action (do this first):** Rewrite CLAUDE.md's Commands + Verification sections to be workspace-scoped —
e.g. `npm run typecheck --workspace @sayre/core`, `npm run test --workspace @sayre/core`,
`npx turbo run lint --filter=@sayre/web`, and `poetry run pytest` from `services/workers/`. Also correct
`Dev: npm run dev (turbo: web + core + gateway)` → root `npm run dev` is **`vite`** (marketing site);
the turbo command is `npm run dev:workspaces`. Optionally add root `test`/`lint`/`typecheck` aliases
delegating to turbo so the documented commands become true.

---

### B. HIGH (security-adjacent) — a real `.env` is duplicated as `infra/New Text Document.txt`

**VERIFIED.** On disk, untracked:

```
infra/.env                     5590 bytes   md5 120176f8745e0b1706e2b0fd67aded8c
infra/New Text Document.txt    5590 bytes   md5 120176f8745e0b1706e2b0fd67aded8c   ← byte-identical copy
```

It carries real credential keys including `POSTGRES_PASSWORD`, `AWS_SECRET_ACCESS_KEY`, `AWS_ACCESS_KEY_ID`,
`DATABASE_ADMIN_URL`, `GITHUB_APP_ID` (key names read; values not extracted).

Good news, both VERIFIED:
- It has **never been committed** — `git log --all -- "infra/New Text Document.txt"` is empty.
- The **uncommitted `.gitignore` change now catches it** (`git status --ignored` shows `!!`).

**Action:** `rm "infra/New Text Document.txt"`. Ignoring a stray secret copy is a backstop, not a fix — while
it exists it is one `git add -f` or one OneDrive share-link away from exposure. (Note this directory is inside
`OneDrive\Desktop`, so the file is being cloud-synced.)

---

### C. HIGH — the uncommitted `.gitignore` change is CORRECT and SAFE; commit it

`git diff .gitignore` adds an allowlist for `infra/`:

```gitignore
infra/*
!infra/.env.example
!infra/docker-compose.yml
!infra/github-app/
!infra/localstack/
!infra/prometheus/
```

Assessment — **safe, and it should be committed**:
- **No currently-tracked file becomes ignored.** VERIFIED by running `git check-ignore -v` over all 6 tracked
  `infra/` paths — zero hits. (This was the main risk; the allowlist covers every tracked path exactly.)
- **It stops nothing sensitive from being ignored** — it only *adds* coverage.
- It closes a real gap: `infra/New Text Document.txt` was previously **untracked-but-not-ignored** (`??`),
  i.e. one `git add -A` from being committed. Now `!!`.

One caveat to be aware of (not a defect): the allowlist is **deny-by-default**, so any legitimately new
`infra/` file will be invisible to git until someone adds a `!` line. That is the stated intent (the comment
says so), but it should be called out in onboarding docs so a future `infra/Dockerfile` isn't silently lost —
note `infra/Dockerfile` existed once (`ee67629`) and is now gone from both disk and index.

**Action:** Commit the `.gitignore` change as-is, in its own commit, together with deleting the stray `.txt`.

---

### D. HIGH — 23 of 53 `src/` files are unreachable dead code (the parked demo prototype)

**VERIFIED** by a module-graph reachability trace from the real entry point `src/main.tsx`
(script: scratchpad `reach.mjs`; follows static + dynamic imports and CSS `@import`):

```
REACHABLE=30  TOTAL=53  UNREACHABLE=23
```

The dead set is a single self-consistent island rooted at `DemoPage.tsx`, which **nothing imports**
(VERIFIED — `git grep DemoPage` matches only its own definition line). It is unreachable by construction:
`src/App.tsx:10` routes `/demo` to `<Navigate to="/" replace />`, and both `vercel.json` and
`public/_redirects` 302 `/demo*` → `/`.

Unreachable files:

```
src/data/tour.ts
src/demo/DemoPage.tsx            src/demo/FeaturePanel.tsx     src/demo/Markdown.tsx
src/demo/Sidebar.tsx             src/demo/StatusLine.tsx       src/demo/TopBar.tsx
src/demo/TreePanel.tsx
src/demo/canvas/FeaturesView.tsx src/demo/canvas/FiletreeView.tsx
src/demo/canvas/RelationsView.tsx src/demo/canvas/useAnimatedPositions.ts
src/demo/search/CommandK.tsx     src/demo/search/fuzzy.ts      src/demo/search/useFileSearch.ts
src/demo/tour/Tour.tsx
src/landing/CanvasSandbox.tsx    src/landing/HeroTreeScene.tsx src/landing/heroTreeData.ts
src/shared/Chip.tsx              src/shared/Modal.tsx
src/styles/demo.css
src/vite-env.d.ts                ← NOT dead: ambient type declaration, keep
```

This is **documented and intentional** — `README.md:4-6`: "The previously staged interactive prototype remains
in source for possible future use, but it is not linked or shipped as a production route." So it is
*deliberate* dead code, not an accident. But it is not free:

- It is **still typechecked** on every root build (`tsc --noEmit` includes all of `src/`), so it must keep
  compiling forever.
- **17 of the repo's 30 `eslint-disable` lines live in this dead tree** (VERIFIED) — i.e. the majority of the
  repo's lint debt is in code that cannot execute.
- `src/demo/canvas/FeaturesView.tsx`, `FiletreeView.tsx`, `RelationsView.tsx` alone carry 8
  `react-hooks/exhaustive-deps` suppressions.

Three files deserve separate mention — they are dead **and** undocumented (not part of the "demo prototype"
story, they are abandoned landing-page experiments):
- `src/landing/CanvasSandbox.tsx` — **zero references anywhere in the repo** (VERIFIED).
- `src/landing/HeroTreeScene.tsx` — referenced only by a *comment* in `heroTreeData.ts:4` (VERIFIED).
- `src/landing/heroTreeData.ts` — imported only by `HeroTreeScene.tsx`, itself dead. Dead transitively.

**Action:**
- **Delete now:** `src/landing/CanvasSandbox.tsx`, `src/landing/HeroTreeScene.tsx`,
  `src/landing/heroTreeData.ts`. These are superseded by the shipped `HeroAnimeVideo.tsx` and have no
  documented reprieve.
- **Delete the demo island** (the `src/demo/**` unreachable files + `src/data/tour.ts` + `src/styles/demo.css`
  + `src/shared/Chip.tsx` + `src/shared/Modal.tsx`). It is recoverable from git history forever, and the
  product demo now lives in `apps/web/app/mock/`, which is real and CI-tested. If the team wants it kept,
  that is a legitimate call — but then it should move to a `prototype/` directory excluded from `tsconfig.json`
  so it stops costing typecheck and lint budget.
- **Do NOT delete** `src/demo/canvas/layout.ts`, `rollup.ts`, `measure.ts`, `useCamera.ts`, `src/demo/state.ts`
  — these are **live**, imported by `src/landing/lensGraphs.ts` and `LandingPage.tsx`. They are misleadingly
  filed under `demo/`; consider moving them to `src/shared/canvas/` after the deletion.
- Note `d3-hierarchy` (a root runtime dependency) is used **only** by `src/demo/canvas/layout.ts` — which is
  live. Keep the dependency.

---

### E. MEDIUM — CI covers neither the marketing site nor `services/gateway`

**VERIFIED** from `.github/workflows/ci.yml`. Jobs: `node` (config, web, core) and `workers` (Python).

| Workspace | In CI? |
|---|---|
| `@sayre/config` | typecheck, test |
| `@sayre/web` | lint, typecheck, test |
| `@sayre/core` | lint, typecheck, test, RLS suites |
| `services/workers` | ruff, mypy, pytest |
| **`@sayre/gateway`** | **NOT COVERED** |
| **root `src/` (marketing site)** | **NOT COVERED** |
| `packages/shared-types` | not covered (built transitively) |

`services/gateway` is a declared workspace with its own tests and a `strict: true` tsconfig, and
`DEPENDENCIES.md:121` documents a `vitest` devDependency for it — but no CI step ever runs it. `src/` has no
CI at all, so a broken marketing site would only be caught at Vercel build time.

**Action:** Add a `gateway — lint/typecheck/test` step mirroring the core steps, and a cheap
`site — build` step running root `npm run build`.

---

### F. MEDIUM — `.codex/` is 1.4 GB of vendored third-party cruft, ignored only *locally*

**VERIFIED.** `du -sh .codex` → **1.4G**. Contents include `.codex/vendor/blender-mcp/` (a Blender MCP
server — entirely unrelated to this project: `addon.py`, `main.py`, `pyproject.toml`, `uv.lock`, `assets/`),
plus stale build logs (`concepts-vite.err.log` 38 KB, `vite.out.log`, `vite.err.log`) and `tmp/`.

It is **not committed** (0 tracked files) — but it is ignored via **`.git/info/exclude:11`**, which is a
*machine-local, uncommitted* file. So the protection does not travel: a teammate who creates `.codex/` gets it
as untracked noise, and `git add -A` would sweep it in.

It is also inside `OneDrive\Desktop`, meaning **1.4 GB is being cloud-synced continuously**.

**Action:** Delete `.codex/` from this working tree (it is vendored third-party code with its own upstream —
nothing here is project source). Then move the exclusion from `.git/info/exclude` into the tracked
`.gitignore` so the whole team is protected. Same treatment for the stray `*.log` files (already covered by
the existing `*.log` rule).

---

### G. LOW — `dist/` is clean

**VERIFIED — not a problem.** `git ls-files dist` returns **0** files and `git log --all -- dist/` is empty:
`dist/` has **never** been committed, in any branch, at any point in history. It is correctly ignored by the
`dist/` rule in `.gitignore`. It is 5.3 MB of local Vite output (`assets/`, `index.html`, `og.png`,
`_redirects`, `media/`).

No secret-leak vector here. **Action: none** (optionally `rm -rf dist` to reclaim OneDrive sync bandwidth).

---

### H. LOW — root-directory inventory

| Directory | Tracked files | Verdict |
|---|---|---|
| `Design System/` | 6 | **Keep.** Live — referenced by `README.md:8`. Space in the name is mildly hostile to shell tooling; renaming to `design-system/` would be an improvement, not a necessity. |
| `Documents/` | 2 | **Keep, but fix drift.** `PRD/PRD V1.pdf` + `Spec/SAYRE_FRONTEND_SPEC.md`, referenced by `README.md:8`. The spec is stale — see Finding I. |
| `design/` | 16 | **Keep.** Archived Anime-hero handoff, explicitly referenced by `README.md:25`. Confusingly near-homonymous with `Design System/`; consider merging both under one `design/` root. |
| `.codex/` | 0 | **Delete** — see Finding F. |
| `security-attacker-agents/` | 14 | **Keep.** Live and load-bearing — the `security-checker` pipeline stage consumes it, and root scripts `check:security-audit-agents` / `check:security-audit-run` validate it against `schemas/*.schema.json`. |
| `public/` | 11 | **Keep.** Vite static root for the marketing site (`og.png`, `favicon.svg`, `media/hero-anime.*`, `_redirects`). |
| `scripts/` | 15 | **Keep.** All 15 are wired to root `package.json` scripts or CI. Note `scripts/export-tree.mjs` and `scripts/smoke.mjs` have **no** npm-script entry — SUSPECTED ad-hoc dev utilities; verify with the author before removing. |
| `packages/graph-schema/` | 1 | **Doc drift.** Contains only `schema.md` — no `package.json`, so it is matched by the `packages/*` workspace glob but is not a real workspace. CLAUDE.md calls it "shared openCypher schema **+ query builders**"; the query builders do not exist. Either build them or reword CLAUDE.md. |

---

### I. LOW — documentation drift (beyond Finding A)

All VERIFIED by grep:

1. **`README.md:37`** documents a config export `GOOGLE_FORM_ENTRIES`. The actual export in
   `src/config.ts:12` is **`GOOGLE_FORM`**. `git grep GOOGLE_FORM_ENTRIES` matches the README and nothing
   else. → Fix the README table.
2. **`Documents/Spec/SAYRE_FRONTEND_SPEC.md:66-68`** still specifies the pre-launch domain: `sayre.dev`,
   `hello@sayre.dev`, `WAITLIST_ENDPOINT = ""`. Shipped reality (`src/config.ts:32-34`) is
   `trysayre.com`, `admin@trysayre.com`, and a populated Google Forms endpoint. → Mark the spec as
   historical, or update the three lines.
3. **`CLAUDE.md` Structure** lists `packages/graph-schema/` as providing query builders — see Finding H.
4. **`README.md`** describes *only* the marketing site and never mentions `apps/`, `services/`, or
   `packages/`. A newcomer cloning this repo would not learn the product exists. → Add a short
   "Repository layout" section distinguishing the marketing site from the product monorepo. This is the
   single highest-value doc fix after Finding A.

---

### J. LOW — test writes fixtures into the tracked source tree

`services/core/src/routes/lintGate.test.ts:16-18` creates `__lintgate_fixture_fat.ts`,
`__lintgate_fixture_import.ts`, and `__lintgate_fixture_clean.ts` **inside `services/core/src/routes/`** and
deletes them afterward. During this audit `git status` transiently showed
`?? services/core/src/routes/__lintgate_fixture_clean.ts` as untracked-and-not-ignored, then it vanished
(VERIFIED — observed across two consecutive `git status` runs).

If that test crashes or is interrupted, the fixture is left behind in a tracked directory and a subsequent
`git add -A` commits it.

**Action:** Add `services/core/src/routes/__lintgate_fixture_*.ts` to `.gitignore` (cheap), or write the
fixtures to a temp dir (better).

---

## 3. WHAT IS ACTUALLY IN GOOD SHAPE

Worth recording, because it narrows where future cleanup effort should go:

- **Type-safety discipline is excellent.** Exactly **one** `@ts-expect-error` in the entire repo
  (`services/core/src/queue/__tests__/bullmq.lifecycle.test.ts:72`), and it carries a justifying comment.
  **Zero** `@ts-ignore`, **zero** `@ts-nocheck`.
- **`strict: true` is set in every tsconfig** — root, `apps/web`, `services/core`, `services/gateway`,
  `packages/config`, `packages/shared-types`. The only one without an explicit `strict` inherits it
  (`services/core/test/mcp-interop/tsconfig.json` extends `../../tsconfig.json`). No strict escape hatches.
- **`any` is nearly absent** — 1 non-test occurrence repo-wide (`services/gateway/src/fanout/fanout.ts`).
- **Essentially no commented-out code.** A grep for commented code constructs returned only prose comments
  that happened to wrap onto a line starting with `for`/`if`/`import`.
- **No genuine duplicated helpers.** The three same-name pairs are all correct layering or cross-app
  coincidence (see §1).
- **Root typecheck passes clean** (`npx tsc --noEmit` → exit 0).
- **No secrets have ever been committed** to `infra/` or `dist/` in any branch.

---

## APPENDIX — Full TODO / FIXME / HACK / XXX inventory

Search: `git grep -nE "\b(TODO|FIXME|HACK|XXX)\b"` excluding `node_modules`, `dist`, `package-lock.json`,
and binary `*.png`.

**Total: 5 occurrences.** Zero are unfinished security or correctness paths in shipping code.

| # | Location | Text | Assessment |
|---|---|---|---|
| 1 | `services/core/src/security/cypherOrgIdScan.test.ts:262` | `// TODO: this should filter by $org_id but the WHERE clause was never added` | **NOT REAL DEBT.** VERIFIED by reading context: this string is the *body of a test fixture*. It is a regression test for finding `FND-5da52fce61f4` proving that a `$org_id` mention appearing **only inside a comment** does not satisfy `referencesOrgIdPredicate()`. The TODO text is the attack payload, not a task. |
| 2 | `services/core/src/security/graphOrgGuard.test.ts:130` | `// TODO: this should filter by $org_id but the WHERE clause was never added` | **NOT REAL DEBT.** Same fixture, runtime-guard side. Asserts `assertOrgScopedCypher()` **throws** `GraphOrgScopeError` on the audit's exact reproduction string. |
| 3 | `Documents/Spec/SAYRE_FRONTEND_SPEC.md:66` | `WAITLIST_ENDPOINT = ""` `// TODO: Formspree/Tally endpoint` | **RESOLVED IN CODE, STALE IN SPEC.** `src/config.ts:9` now holds a live Google Forms endpoint. → Finding I.2 |
| 4 | `Documents/Spec/SAYRE_FRONTEND_SPEC.md:67` | `CONTACT_EMAIL = "hello@sayre.dev"` `// TODO: confirm domain` | **RESOLVED IN CODE, STALE IN SPEC.** Now `admin@trysayre.com` (`src/config.ts:33`). |
| 5 | `Documents/Spec/SAYRE_FRONTEND_SPEC.md:68` | `SITE_URL = "https://sayre.dev"` `// TODO: confirm` | **RESOLVED IN CODE, STALE IN SPEC.** Now `https://trysayre.com` (`src/config.ts:34`). |

One further match was excluded as a false positive: `Design System/filetree-graph-labeled.png` (binary file
whose bytes contain the ASCII substring `TODO`).

### Related suppression inventory

| Marker | Count | Notes |
|---|---|---|
| `@ts-expect-error` | **1** | `services/core/src/queue/__tests__/bullmq.lifecycle.test.ts:72`, justified |
| `@ts-ignore` | **0** | — |
| `@ts-nocheck` | **0** | — |
| `eslint-disable` | **30 lines / 17 files** | **17 lines are in the dead `src/demo/` tree** (Finding D). Of the remaining 13: 6 are `no-console` in workers/pollers, 2 are `react-hooks/exhaustive-deps` in `apps/web`, and 3 are inside security test fixtures. |
| `any` (non-test) | **1** | `services/gateway/src/fanout/fanout.ts` |

---

## PRIORITIZED ACTION LIST

| # | Action | Effort | Impact |
|---|---|---|---|
| 1 | Fix CLAUDE.md Commands + Verification to workspace-scoped commands; reconcile with AGENTS.md | S | **Critical** — unblocks every agent run |
| 2 | `rm "infra/New Text Document.txt"`; commit the `.gitignore` change | XS | **High** — removes a synced plaintext secret copy |
| 3 | Delete `CanvasSandbox.tsx`, `HeroTreeScene.tsx`, `heroTreeData.ts` (zero-reference, undocumented) | XS | High — safe, immediate |
| 4 | Delete or quarantine the 20-file `src/demo/` dead island; keep `layout/rollup/measure/useCamera/state` | M | High — removes 57% of the repo's lint debt |
| 5 | Delete `.codex/` (1.4 GB); move its ignore rule from `.git/info/exclude` into `.gitignore` | XS | Medium — reclaims 1.4 GB of OneDrive sync |
| 6 | Add CI steps for `@sayre/gateway` and the root marketing-site build | S | Medium — closes two blind spots |
| 7 | Add a "Repository layout" section to README distinguishing site vs product monorepo | S | Medium |
| 8 | Fix `GOOGLE_FORM_ENTRIES`→`GOOGLE_FORM` in README; mark frontend spec historical; fix graph-schema claim | S | Low |
| 9 | Gitignore or relocate `lintGate.test.ts` fixtures | XS | Low |
| 10 | (Optional) Move marketing site to `apps/site/`, making root a pure workspace root | L | Medium — permanent fix for #1's root cause |
