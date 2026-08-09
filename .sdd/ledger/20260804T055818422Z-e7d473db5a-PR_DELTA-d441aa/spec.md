# Spec — W0-00: Dependency & Environment Baseline (re-derivation / audit)

> Planner output for the Red and Dev stages. This **overwrites** the previous top-level
> `.pipeline/spec.md` (which held unrelated W3-10 content) — expected per `.pipeline/README.md`:
> the six top-level stage files are per-ticket working state and may be overwritten.
>
> This is a **re-derivation and audit** of W0-00, not a fresh build and not a "check if it's done"
> pass. W0-00 originally ran on 2026-07-11 (archived under `.pipeline/w0-00/`). Since then, many
> later tickets (W0-01, W0-04, W0-05, W0-06, W0-07, W2-03, W3-07, …) have added packages and
> restructured the repo into a single npm workspace. W0-00 is the *living single source of truth*
> for dependency pinning + `DEPENDENCIES.md` completeness, so its acceptance criteria must hold
> against the repo **as it exists now**, not as it looked on 2026-07-11.

---

## Audit findings (read this first — context for Red and Dev)

The 2026-07-11 W0-00 run itself was reviewed (its `review.md`, `test-results.md`, and
`security-report.md` are all `PASS`) and produced a genuinely clean initial baseline — this is
**not** a "shipped without review" case for the original work. However, the ticket's own acceptance
criterion ("`DEPENDENCIES.md` lists **every** package plus its PRD section reference") is a standing
invariant that later tickets were supposed to maintain, and the repo has **drifted out of
compliance** with it. Concrete drift found by diffing the current four manifest locations against the
current `DEPENDENCIES.md` and against the PRD ticket text (`docs/PRD_Tickets.md` W0-00, lines 17–34):

**A. Version pin that contradicts the PRD's named version (load-bearing):**

- **`zod`** — PRD W0-00 explicitly names **`zod 4.4.x`**. `services/core/package.json` pins
  **`zod: 3.25.76`** — a full major version behind. This is *not* forced by a peer constraint:
  `package-lock.json` shows `@modelcontextprotocol/sdk@1.29.0` declares
  `"zod": "^3.25 || ^4.0"` (it accepts zod 4). So the `3.25.76` pin is a **silent narrowing /
  staleness**, not a necessary compatibility choice. Dev must reconcile this (see AC-4, O-1): either
  bump to `4.4.x` and fix any zod-3-only API usage in `services/core` source, or — if a real blocker
  surfaces on install/typecheck/test — document the exact blocker. Note `3.25.76` is also an exact
  patch pin rather than the `4.4.x` minor-line style the PRD uses.

**B. Packages present in a manifest but missing from / stale in `DEPENDENCIES.md`** (each is a direct
violation of "lists every package"):

1. `apps/web` → **`@sigma/node-border`** (dep) — absent from `DEPENDENCIES.md` entirely.
2. `apps/web` → **`@sayre/config`** (dep) — absent from the `apps/web` table.
3. `apps/web` → **`@sayre/shared-types`** (dep) — now a real `apps/web` dependency, but the
   `packages/shared-types` prose in `DEPENDENCIES.md` (lines 50–56) still asserts `apps/web`
   "[doesn't] import it directly." Stale + no `apps/web` row.
4. `apps/web` → **`react-test-renderer`** (devDep) — absent.
5. `apps/web` → **`@types/react-test-renderer`** (devDep) — absent.
6. `services/core` → **`@sayre/config`** (dep) — absent from the `services/core` table
   (`@sayre/config` is documented only as a `services/gateway` dependency, line 114).
7. **`packages/config`** (`@sayre/config`) — the entire package has **no section** in
   `DEPENDENCIES.md`; its devDeps (`@types/node`, `typescript`, `vitest`) are undocumented.
8. `services/workers` → **`PyJWT[crypto]`** (dep, `2.10.*`) — absent from `DEPENDENCIES.md`.
9. `services/workers` → **`httpx`** — `pyproject.toml` now declares it as a **main**
   `[project.dependencies]` entry (`httpx==0.27.*`), but `DEPENDENCIES.md` (line 153) still lists it
   under the **dev group** with a "required transitively by Starlette's TestClient" reference. Stale
   location + rationale.

**C. Cosmetic / low-priority pin-style note (confirm, don't necessarily change):**

10. `services/workers` → **`openai`** is pinned as a range `openai>=2.45.0,<2.46.0`; PRD names
    `openai 2.45.*`. Functionally equivalent (both resolve to the 2.45 line); flagged only so Dev
    confirms it's intentional and not a stray inconsistency with the `==X.Y.*` style used by every
    other Python pin.

**D. Structural divergence from the 2026-07-11 plan (not a defect — but changes how the acceptance
test is run):**

11. The archived `.pipeline/w0-00/spec.md` planned **per-package** lockfiles
    (`apps/web/package-lock.json`, `services/core/package-lock.json`) and independent per-package
    installs. W0-01 replaced that with a **single root npm workspace**: root `package.json` has
    `"workspaces": ["apps/web", "services/core", "services/gateway", "packages/*"]` and there is one
    root `/package-lock.json`. There are **no** per-package `package-lock.json` files anymore. The
    "fresh clone installs with zero version-resolution conflicts" acceptance test is therefore now:
    one root `npm install`/`npm ci` (covers all five npm workspace members) **plus** one
    `poetry install` in `services/workers/` (Poetry, not in the npm workspace). Any AC or test that
    assumes per-package lockfiles is obsolete.

**Nothing** in the current manifests is a stub/mock/hardcoded-fake in the code-behavior sense (this
is a manifest-only ticket). The defects above are: one wrong version pin vs. the PRD (zod), and a
set of undocumented/stale `DEPENDENCIES.md` rows. No evidence of the *current* manifests having
shipped "never run" — they resolve into a committed root lockfile — but the zod-vs-PRD mismatch
should get an explicit human sign-off before merge (O-1), because it's a deliberate-looking
deviation from a version the PRD names outright.

---

## Goal

Every third-party dependency named in the PRD (and every additional package any later ticket has
since added to `apps/web`, `services/core`, `services/gateway`, `packages/*`, and
`services/workers`) is pinned to a specific version in exactly one place per runtime, resolves on a
fresh clone with zero version-resolution conflicts, and appears in `DEPENDENCIES.md` with a purpose,
a PRD/architecture reference, and (where applicable) a known-future-swap note — so no two parallel
tickets pick incompatible versions and no migration is a surprise dependency hunt later.

## Scope

**In scope**

- Reconcile the `zod` pin in `services/core/package.json` against the PRD's named `zod 4.4.x`
  (finding A / O-1).
- Bring `DEPENDENCIES.md` back to full compliance with "lists every package": add a row for every
  package currently in any manifest that is missing one, fix every stale row/prose statement
  (findings B1–B9), and add a `packages/config` section (finding B7).
- Confirm the `openai` pin style (finding C10) — change only if O-2 resolves that way.
- Re-verify the acceptance test end to end against the **current** workspace layout: root
  `npm ci` (or `npm install`) resolving all npm workspace members with zero `ERESOLVE`/peer
  warnings, `poetry install` in `services/workers/` with zero resolver conflict, and the committed
  root `package-lock.json` + `services/workers/poetry.lock` reproducing identical resolved versions
  from a clean state (finding D11).

**Explicitly out of scope**

- Adding, removing, upgrading, or re-pinning any dependency other than `zod` (and `openai` only if
  O-2 says so). This ticket does **not** re-litigate the version choices later tickets made for
  their own packages — it only ensures they are pinned and documented. Do not "tidy" other versions.
- Any application/business logic, route handlers, React components, Cypher, worker job code, schema,
  or migration files. The **only** allowed source-code edit is the minimal set required to keep
  `services/core` compiling/testing green **if** the zod bump (O-1) forces a zod-4 API adjustment —
  and if that turns out to be more than trivial, stop and raise it (O-1) rather than doing a broad
  refactor under a dependency ticket.
- The root Vite marketing site's own dependencies (`d3-hierarchy`, `react-router-dom`, `vite`,
  etc.) and scripts — out of scope, unchanged, and explicitly excluded from `DEPENDENCIES.md` per
  its own header. Only the root-workspace `turbo` devDep is in `DEPENDENCIES.md` (already present).
- Removing `@sayre/config`/`@sayre/shared-types` from `apps/web` even if they look unused — that is
  a separate decision (O-3); this ticket documents what is declared, it does not prune.
- `infra/docker-compose.yml` image pins — already correct and fully documented; no change expected.

## Affected files (exact paths)

Paths relative to repo root `/Users/chiemeka/SayreProjects/Sayre/`.

| Path | Status | Change |
|---|---|---|
| `DEPENDENCIES.md` | modify | Add missing rows/section and fix stale rows/prose (findings B1–B9); update the `zod` row to match whatever O-1 resolves. |
| `services/core/package.json` | modify (conditional) | `zod` pin only — to `4.4.x` if O-1 bumps it (unchanged if O-1 keeps 3.x with a documented reason). |
| `/package-lock.json` (root) | modify (generated) | Regenerated by `npm install` if the `zod` pin changes; committed. Do not hand-edit. |
| `services/core/src/**` | modify (conditional, minimal) | Only if the zod bump forces a zod-4 API fix to keep `npm run test`/typecheck green; see O-1. |
| `services/workers/pyproject.toml` + `services/workers/poetry.lock` | modify (conditional) | Only if O-2 normalizes the `openai` pin. |

Files that are **read/verified but not expected to change**: `apps/web/package.json`,
`services/gateway/package.json`, `packages/config/package.json`, `packages/shared-types/package.json`,
`infra/docker-compose.yml`, `infra/.env.example`, `.nvmrc`, `services/workers/.python-version`, root
`package.json`.

## Interfaces / manifest & doc contents (the load-bearing part)

### `services/core/package.json` — `zod`

- Current: `"zod": "3.25.76"`. Target (pending O-1): `"zod": "4.4.x"` to match PRD W0-00, unless a
  concrete install/typecheck/test blocker is found and documented. MCP SDK 1.29 does **not** block
  zod 4 (`"zod": "^3.25 || ^4.0"` in the lockfile), so "MCP requires zod 3" is **not** a valid
  reason on its own.

### `DEPENDENCIES.md` — rows to add / fix

Each new row uses the existing table columns
`Package | Runtime/Location | Purpose | Reference | Future swap`. Every listed package must end up
with a row and a real reference — no bare dash; use the file's existing "Not named in PRD;
build/test support" convention where appropriate:

- `apps/web` table, add:
  - `@sigma/node-border` (dep) — Sigma node-border rendering program. Reference: attribute to the
    ticket that introduced it (grep `@sigma/node-border` under `apps/web/src`); if unattributable,
    "Not named in PRD; Sigma rendering support".
  - `@sayre/config` (dep) — shared non-secret config / secret-reference loader consumed by the web
    client. Reference: W0-07 / `docs/wave0-foundation-contracts.md`.
  - `@sayre/shared-types` (dep) — cross-package wire/type contracts. Reference: W0-01 D-4.
  - `react-test-renderer` (devDep) and `@types/react-test-renderer` (devDep) — component test
    support for `apps/web` (vitest). Reference: "Not named in PRD; build/test support".
- `packages/shared-types` section prose — correct the "apps/web … [doesn't] import it directly"
  statement now that `apps/web` and `services/core` both declare `@sayre/shared-types` directly.
- `services/core` table, add:
  - `@sayre/config` (dep) — same loader package as gateway. Reference: W0-07 /
    `docs/wave0-foundation-contracts.md`.
- **New `## \`packages/config\`` section**, listing the package (`@sayre/config`, `0.1.0`, private)
  plus its devDeps `@types/node`, `typescript`, `vitest`. Reference: W0-07 /
  `.claude/rules/security-multitenancy.md` (the single secret-reference loader the secrets rule
  calls for).
- `services/workers` table:
  - add `PyJWT[crypto]` (dep, `2.10.*`) — JWT verification for the worker fleet. Reference:
    attribute to the ticket that added it (grep `PyJWT`/`jwt` under `services/workers`); else "Not
    named in PRD; auth support".
  - move `httpx` from the dev-group row to a main-dependency row (it is `httpx==0.27.*` in
    `[project.dependencies]`), and fix its rationale (no longer "transitive via TestClient only").
- `zod` row — update to reflect O-1's resolved version and reference PRD W0-00's `zod 4.4.x` naming.

### `services/workers/pyproject.toml` — `openai` (only if O-2 changes it)

- Current: `openai>=2.45.0,<2.46.0`. If O-2 says match PRD style, change to `openai==2.45.*`
  (equivalent resolution). Otherwise leave as-is and just document the range in `DEPENDENCIES.md`.

## Approach (build order for Dev)

1. **Resolve O-1 first** (zod). Run a clean root `npm install`, then in `services/core` run
   `npm run typecheck` and `npm run test` with `zod` bumped to `4.4.x`. If green, keep the bump and
   regenerate/commit the root lockfile. If it forces more than a trivial API fix, stop and record the
   blocker per O-1 rather than refactoring broadly.
2. Update `DEPENDENCIES.md` for findings B1–B9 and add the `packages/config` section. Attribute each
   new row's Reference by grepping the consuming source / `.sdd/ledger/`, not by guessing.
3. Resolve O-2 (openai pin style); apply only if it changes.
4. **Re-run the full acceptance test from a clean state** (finding D11): remove `node_modules`, run
   root `npm ci` (asserts the committed lockfile is consistent and resolves with zero
   `ERESOLVE`/peer warnings across all npm workspace members); separately delete the Poetry venv and
   run `poetry install` in `services/workers/` against the committed `poetry.lock`. Both must be
   clean and reproducible.
5. Re-verify "lists every package": mechanically diff every dependency name in all six npm manifests
   + `pyproject.toml` against the rows in `DEPENDENCIES.md` and confirm zero gaps (see AC-2 / EC-5).
6. Record all deviations (final zod decision, openai decision, any zod-4 code fix) in `changes.md`.

## Acceptance criteria

- **AC-1 — Fresh-clone install, zero conflicts (the ticket's literal acceptance test; must be
  actually run, not asserted).** From a clean checkout with no `node_modules`: a single root
  `npm ci` completes with exit 0 and **no `ERESOLVE` and no peer-dependency warnings** across all
  npm workspace members (`apps/web`, `services/core`, `services/gateway`, `packages/config`,
  `packages/shared-types`); and `poetry install` in `services/workers/` completes with **zero
  dependency-resolver conflicts** under Python 3.12. Benign `EBADENGINE` (a dev machine on Node ≠20)
  and standard upstream deprecation notices do not count as conflicts. Red/Dev/Tester must run these
  commands from a genuinely clean state to verify this AC — it cannot be satisfied by inspection.
- **AC-2 — `DEPENDENCIES.md` lists every package.** Every dependency and devDependency in
  `apps/web/package.json`, `services/core/package.json`, `services/gateway/package.json`,
  `packages/config/package.json`, `packages/shared-types/package.json`, and every entry in
  `services/workers/pyproject.toml` (`[project.dependencies]` + `[tool.poetry.group.dev.dependencies]`),
  plus the root-workspace `turbo` devDep and the pinned infra images, appears as a row in
  `DEPENDENCIES.md` with a non-empty Purpose and a non-empty Reference. Specifically, all of
  findings B1–B9 are resolved: `@sigma/node-border`, `@sayre/config` (in both `apps/web` and
  `services/core` tables), `apps/web`'s `@sayre/shared-types`, `react-test-renderer`,
  `@types/react-test-renderer`, `PyJWT[crypto]` all have rows; a `packages/config` section exists;
  and `httpx` is documented as a main dependency, not a dev-only transitive.
- **AC-3 — Every package pinned, no floats.** No bare `*`, no `latest`, no unpinned Docker image tag,
  and no leading `^`/`~` in any of the four manifest locations, **except** the intentional
  workspace-internal `^0.1.0` references to `@sayre/*` sibling packages (npm-workspace-resolved, not
  a registry float) and the PRD-mandated `X.Y.*` minor-line style. `@sigma/node-border`'s `^3.0.0`
  is a float — Dev should confirm whether it should be pinned to the `3.0.x` style like `sigma`
  (raise under O-4 if changing it is non-trivial).
- **AC-4 — `zod` reconciled with the PRD.** `services/core`'s `zod` pin either matches the PRD's
  named `zod 4.4.x`, or, if kept on 3.x, `changes.md` records the concrete, reproduced blocker that
  justifies the deviation and O-1 is escalated for human sign-off. "MCP SDK requires zod 3" is not
  an acceptable justification (the lockfile shows it accepts `^3.25 || ^4.0`).
- **AC-5 — PRD-named packages all present in the correct manifest** (regression guard against the
  audit): web (`next, react, @xyflow/react 12.11.x, sigma, graphology, graphology-layout,
  tailwindcss, typescript`); core (`express, bullmq, ioredis, neo4j-driver, pg, jsonwebtoken,
  @modelcontextprotocol/sdk 1.29.x, zod, @aws-sdk/client-sqs, @aws-sdk/client-sns, @opentelemetry/api
  + sdk-metrics + exporter-prometheus`); workers (`fastapi, uvicorn, tree-sitter + language grammars,
  langchain, langgraph, graphifyy==0.9.16, openai (2.45 line), boto3, psycopg[binary], pgvector,
  anthropic`); infra images (Postgres [pgvector-capable], Redis 7, Neo4j 5-community). Each present at
  the PRD-named version where the PRD names one.
- **AC-6 — Reproducible lock, single workspace model.** After the change, `npm ci` from the committed
  root `/package-lock.json` and a clean `poetry install` from the committed
  `services/workers/poetry.lock` each reproduce identical resolved versions on a second run. There is
  exactly one root npm lockfile and no stray per-package `package-lock.json` files under `apps/web`,
  `services/core`, `services/gateway`, or `packages/*`.
- **AC-7 — Cross-runtime version consistency preserved.** Shared tooling stays on one line across
  npm workspace members: `typescript 5.5.x`, `eslint 8.57.x`, `vitest 2.1.x`, `@types/node 20.x`,
  `ioredis 5.4.x`, `@aws-sdk/client-* 3.1088.x` do not diverge between packages that declare them.
- **AC-8 — No out-of-scope changes.** The diff touches only `DEPENDENCIES.md`,
  `services/core/package.json` (zod), the root lockfile (regenerated), optionally
  `services/workers/pyproject.toml` + `poetry.lock` (openai, if O-2), and — only if the zod bump
  forces it — a minimal `services/core/src/**` zod-4 API fix. The marketing site, infra compose file,
  and all other version pins are unchanged.
- **AC-9 — `DEPENDENCIES.md` future-swaps intact.** The three migration-trigger entries
  (`neo4j-driver`→Neptune, `pgvector`→OpenSearch, `express`/REST→GraphQL) and the two
  deliberate-non-migration notes (React Flow/Sigma renderer split; SQS/SNS vs BullMQ) remain present
  and correct after the edits.

## Edge cases

- **EC-1 — zod 4 breaking-API surface.** If bumped, zod 4 changes several APIs (e.g. error
  formatting, `.default`/`z.record` signatures). A green `npm run test` in `services/core` (which now
  has real code and tests) is the gate; a compile pass alone is insufficient. Assert tests pass, not
  just typecheck.
- **EC-2 — Clean-state install, not warm-cache.** The AC-1 install must run after removing
  `node_modules` (and ideally with a cold npm cache) — a warm `node_modules` can mask an `ERESOLVE`
  the committed lockfile would otherwise surface on a real fresh clone. Same for the Poetry venv
  (`poetry env remove --all` before `poetry install`).
- **EC-3 — Lockfile not regenerated after a manifest edit.** If the zod pin changes but the root
  `package-lock.json` is not regenerated, `npm ci` will fail with a lockfile-mismatch error. Assert
  `npm ci` (which refuses to auto-fix) passes, not just `npm install`.
- **EC-4 — Workspace-internal `^0.1.0` false positive.** A naive "no `^`" grep will flag the
  legitimate `@sayre/*` workspace references. The pin-audit (AC-3) must exclude workspace-internal
  `^0.1.0` deps from the float check.
- **EC-5 — Package in a manifest but not in `DEPENDENCIES.md` (the core regression).** Build the
  package-name set from all six npm manifests + `pyproject.toml` and set-difference it against the
  package names appearing in `DEPENDENCIES.md`; the difference must be empty. This is the mechanical
  form of AC-2 and should be an explicit test.
- **EC-6 — Reverse gap: a `DEPENDENCIES.md` row for a package no longer in any manifest.** Less
  critical, but a stale row (documenting a package that was since removed) is also a correctness bug;
  flag any found, though removal is only required if clearly stale.
- **EC-7 — Python 3.12 specifically.** `poetry install` must resolve under Python 3.12
  (`requires-python = ">=3.12,<3.13"`), not 3.11 or 3.13. On a machine whose default is 3.13, the
  Poetry env must be pointed at a 3.12 interpreter before the resolve counts.
- **EC-8 — `@sigma/node-border` float.** Confirm the `^3.0.0` range resolves against `sigma 3.0.x`
  without a peer conflict, and decide (O-4) whether to hard-pin it.
- **EC-9 — Secret leakage regression.** Re-assert no real credentials in `infra/.env.example`,
  `infra/docker-compose.yml`, or `DEPENDENCIES.md` (placeholders/`${VAR}` only) — unchanged from the
  original run, but cheap to re-verify since `DEPENDENCIES.md` is being edited.
- **EC-10 — Marketing site untouched.** `git diff` must show zero changes to root `package.json`'s
  own scripts/deps beyond what already exists, `src/**`, `vite.config.ts`, `vercel.json`.

## Open questions

- **O-1 (zod 4.4.x vs 3.25.76) — NEEDS HUMAN SIGN-OFF.** PRD W0-00 names `zod 4.4.x`;
  `services/core` pins `zod 3.25.76`. MCP SDK 1.29 accepts zod 4, so the pin is not compatibility-
  forced. Default action: bump to `4.4.x`, run `services/core`'s typecheck + tests, and apply the
  minimal code fix if zod-4 APIs require one. If the bump breaks tests in a way that needs more than
  a trivial fix, **stop** and get a human decision (accept a scoped code change under this ticket, or
  keep 3.x and update the PRD / document the deviation). Do not silently leave the PRD-vs-manifest
  mismatch undocumented.
- **O-2 (openai pin style) — LOW.** Keep `openai>=2.45.0,<2.46.0` (document the range) or normalize
  to `openai==2.45.*` to match every other Python pin and the PRD's `openai 2.45.*`? Default:
  normalize to `==2.45.*` (zero resolution change, consistent style) unless there's a reason the
  range was chosen.
- **O-3 (`apps/web` unused workspace deps) — DEFERRED.** `apps/web` declares `@sayre/config` and
  `@sayre/shared-types`; confirm both are actually imported by `apps/web/src`. This ticket documents
  them regardless; pruning an unused one is a separate cleanup, not W0-00's job.
- **O-4 (`@sigma/node-border` hard-pin) — DEV DISCRETION.** Whether to convert `^3.0.0` to the
  `3.0.x` minor-line style used by `sigma`. Default: leave as-is unless it trips AC-3's float check;
  if changing it is non-trivial (peer resolution), raise before doing so.
- **O-5 (attribution references) — DEV RESEARCH.** For each newly-documented package, cite the real
  introducing ticket where determinable (grep the consuming source and `.sdd/ledger/`), and fall back
  to the file's existing "Not named in PRD; build/test support" convention only when genuinely
  unattributable — do not invent a PRD section number (the original run already established, and
  `DEPENDENCIES.md` still notes, that `docs/prd.md` has no literal "Section 4.10").
