# Repo structure (PL-15)

This document records the shape the repository root took after PL-15 (repo restructure: separate
the marketing site from the monorepo root), why the shims it introduced exist, and the specific
follow-up work that ticket deliberately left undone.

## Directory map

| Path | What it is |
|---|---|
| `apps/site/` | The marketing site (`@sayre/site`, Vite + React, sayre.pages.dev) — its own npm workspace member. Source, static assets, its own scripts, and its design handoff archive all live here now. |
| `apps/web/` | The Next.js product visualization client. |
| `services/core/`, `services/gateway/`, `services/workers/` | The product platform's API, realtime gateway, and Python async worker fleet. |
| `packages/` | Shared TypeScript packages consumed by more than one workspace member. |
| `docs/` | Architecture reference, the product spec (`docs/product/`), the visual design system (`docs/design-system/`), and point-in-time audit records (`docs/audits/`). |
| `scripts/` | The SDD pipeline control plane, the secret-scanning gates, and one product QA script — no marketing-site tooling lives here anymore. |
| `.sdd/`, `.claude/`, `.pipeline/`, `.codex/` | The pipeline methodology, its runtime shims, a run's working state, and a local (untracked) design workspace, respectively. |
| `security-attacker-agents/` | The registered attacker briefs the security-checker stage runs against a change. |
| `infra/` | docker-compose and pinned service images for local development. |

## Deploy-compatibility shims

The repository root reads as a monorepo root now, but external systems (Cloudflare Pages'
dashboard configuration, muscle-memory `npm run …` commands, Vercel's root-directory convention)
still expect the shape the root had before this ticket. Three shims exist so none of them had to
change on the same day the files moved:

1. **`apps/site/vite.config.ts` emits to repo-root `dist/`.** Cloudflare Pages' Settings → Builds &
   deployments configuration lives in Cloudflare's dashboard, not in this repository, and (subject
   to the human verification this ticket's AC-16 requires) builds from the repo root into a `dist/`
   directory at that root. `build.outDir: "../../dist"` plus `build.emptyOutDir: true` keeps that
   external contract byte-identical even though the site's own source now lives two directories
   deeper. Do not "clean this up" to the workspace-relative default without completing D2 first.
2. **Root `dev`/`build`/`preview` are thin delegating aliases** (`npm run build --workspace
   @sayre/site` and so on) rather than being renamed to something like `dev:site`. An external build
   command of plain `npm run build` at the repo root, and years of muscle memory, both depend on
   those three names continuing to mean "the marketing site."
3. **`apps/site/turbo.json` disables the cache for its own `build` task.** The root `turbo.json`
   declares `build`'s outputs as living inside each package's own directory; `@sayre/site` writes
   outside its own package directory under shim 1 above, so without this override turbo could report
   a cache hit for a build that produced nothing it was tracking.

## Deferred follow-ups

Ten items were deliberately left undone rather than folded into this restructure, each for a
specific, named reason:

- **D1 — Splitting `scripts/` further** (e.g. into pipeline/security/ci subdirectories). Blocked by
  real coupling: the SDD completeness suite enumerates test suites with a non-recursive directory
  listing and maps them to package.json scripts with a regex whose character class cannot cross a
  path separator; the read-only guard hook is wired as a literal, unparameterized command string;
  `scripts/tsconfig.json`'s `include` lists bare filenames; and every `.sdd/stages/*.md` file
  references scripts by a flat `scripts/<name>.mjs` path. Removing the marketing-site family from
  `scripts/` already makes the directory coherent without touching any of that.
- **D2 — Removing the root-`dist/` compatibility shim** and pointing Cloudflare Pages at the site's
  own workspace directory instead. Needs the dashboard settings this ticket's human verification
  step records first — changing the shim and the dashboard out of sync would break the live deploy.
- **D3 — Deciding the fate of the repo-root Vercel configuration file.** Needs this ticket's second
  human verification step (whether a live Vercel project is actually connected) answered first.
- **D4 — Moving the three other repo-root reference documents under `docs/`.** Roughly thirty
  tracked files reference them by their current root-relative paths, including source comments
  across multiple service packages and a red-listed test. Out of scope for a restructure whose
  reference sweep is already large.
- **D5 — Moving the security attacker-agent registry under `.sdd/`.** Its paths are pinned by
  several validator scripts and the completeness suite, and are content-hashed into every
  historical ledger entry's security manifest. Pure churn against working, load-bearing machinery.
- **D6 — Giving the monorepo root a neutral, workspace-agnostic root TypeScript config.** The
  current root config is shaped for the marketing site's own browser/DOM compiler options; this
  restructure only retargets its `include` and has the site's own config extend it. That is honest
  about what changed, if inverted from what a from-scratch monorepo would choose — revisiting the
  root config's shape is separate work.
- **D7 — Normalizing filenames that contain a space.** This restructure normalizes directory names
  only, to keep the reference sweep bounded to a size that could actually be verified by hand.
- **D8 — Moving the product workspace UX QA script out of `scripts/`.** It is a fifth, distinct
  family (product QA, not pipeline control-plane or secret-scanning) — leaving it keeps this
  ticket's script moves to one coherent set (the marketing-site family) rather than two.
- **D9 — Adding the marketing site's source tree to a fenced lane in the bounds configuration.**
  The equivalent pre-move location was in no fenced lane either; this restructure preserves that
  existing (lack of) fencing rather than quietly widening a lane's reach as a side effect of a move.
- **D10 — Moving the wave-3 frontend/product audit document into the newly created audits
  directory.** That document is already tracked and referenced elsewhere; moving it is left for a
  change whose reference sweep is scoped around tracked-document moves specifically, rather than
  folded into a restructure whose audits-directory move is really about committing artifacts that
  were untracked before this ticket.

## Verification

`npm run build` at the repo root must still produce the same emitted file set at repo-root `dist/`
as before this restructure (`index.html`, one CSS + one JS asset, the redirects file, the OG image,
the favicon, and the media directory). `npx tsc --noEmit` at the repo root must still exit `0` over
a non-empty, now-relocated file set. Both are asserted mechanically by `scripts/repo-structure.test.mjs`
and are the two checks with real deploy risk if either regresses — see that file for the full,
mechanically-checked acceptance surface this document is a human-facing companion to.
