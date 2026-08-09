# Audit 17 — Build / Typecheck / Lint Ground Truth

Repo: `C:\Users\splat\OneDrive\Desktop\Sayre`
Branch: `planning/future-tickets` @ `b8dc223`
Date: 2026-07-31
Node: v24.14.0 · npm: 11.9.0 · Python: 3.11.9
Nothing was fixed. No source file was edited. `git status` at end of audit is unchanged from start
(` M .gitignore`, `?? docs/architecture-assessment-2026-07.md`) — `package-lock.json` was **not** modified.

---

## 0. The single most important finding: the repo was in an uninstalled state

At the start of this audit **no workspace dependencies were installed**. Root `node_modules` held only
71 top-level packages (the Vite marketing-site deps). There was no `node_modules/@sayre`, no
`node_modules/turbo`, no `node_modules/eslint`, and no `node_modules` directory in **any** of
`apps/web`, `services/core`, `services/gateway`, `packages/config`, `packages/shared-types`.

Consequence: **every workspace verification command failed**, and the 575 TypeScript errors measured
in that state were ~95% `Cannot find module` noise, not real defects.

Mid-audit, `npm install --dry-run` (run to test whether the dependency graph even resolves)
materialized the full tree — 559 root packages, `@sayre` workspace links, `turbo`, `eslint`. Every
command was then re-run from a correctly installed tree. Both passes are reported below, because the
first pass is what a teammate cloning this repo actually experiences until they run `npm install`.

**The code itself is clean. The environment and the documented command surface are what's broken.**

---

## 1. Results table

### Pass A — as found on disk (workspace deps NOT installed)

| # | Command | Exists? | Exit | Errors |
|---|---|---|---|---|
| 1 | `npx tsc --noEmit` (root) | yes | 0 | 0 — but see §3, scope is marketing site only |
| 2 | `npm run test` (root) | **NO — missing script** | 1 | n/a |
| 3 | `npm run lint` (root) | **NO — missing script** | 1 | n/a |
| 4 | `npm run test:workspaces` | yes | 1 | `'turbo' is not recognized` |
| 5 | `npm run lint:workspaces` | yes | 1 | `'turbo' is not recognized` |
| 6 | `npm run typecheck:workspaces` | yes | 1 | `'turbo' is not recognized` |
| 7 | `npm run build:workspaces` | yes | 1 | `'turbo' is not recognized` |
| 8 | `npm run build` (root) | yes | 0 | 0 — `tsc --noEmit && vite build`, 93 modules, 618ms |
| 9 | `npx tsc --noEmit` in `services/core` | yes | 2 | 379 |
| 10 | `npx tsc --noEmit` in `apps/web` | yes | 2 | 131 |
| 11 | `npx tsc --noEmit` in `services/gateway` | yes | 2 | 61 |
| 12 | `npx tsc --noEmit` in `packages/config` | yes | 2 | 4 |
| 13 | `npx tsc --noEmit` in `packages/shared-types` | yes | 0 | 0 |
| 14 | `poetry run pytest --collect-only -q` | **NO — poetry not installed** | n/a | n/a |
| 15 | `python -m pytest --collect-only -q` | **NO — pytest not installed** | 1 | `No module named pytest` |

### Pass B — after the dependency tree was materialized

| # | Command | Exists? | Exit | Errors |
|---|---|---|---|---|
| 1 | `npx tsc --noEmit` (root) | yes | **0** | 0 |
| 2 | `npm run build` (root) | yes | **0** | 0 |
| 3 | `npm run build:workspaces` | yes | **0** | 0 — 5/5 turbo tasks successful, 21.1s |
| 4 | `npm run typecheck:workspaces` | yes | **0** | 0 — 8/8 turbo tasks successful, 5.5s |
| 5 | `npm run lint:workspaces` | yes | **0** | 0 errors, 0 warnings — 3/3 tasks, 3.3s |
| 6 | `npm run test:workspaces` | yes | **0** | 0 — 7/7 tasks, 1340 passed / 7 skipped, 16.5s |
| 7 | `npm run lint -w @sayre/core` | yes | 0 | 0 (`eslint . --ext .ts`, silent) |
| 8 | `npm run lint -w @sayre/gateway` | yes | 0 | 0 (`eslint . --ext .ts`, silent) |
| 9 | `npm run lint -w @sayre/web` | yes | 0 | `✔ No ESLint warnings or errors` |

No command hung. No command required a live Postgres / Neo4j / Redis to complete — the suites mock
their infrastructure (gateway logs a deliberate `redis publish failed` inside a redelivery test).

---

## 2. Documented-but-missing / documented-but-wrong commands

`CLAUDE.md` "Commands" and "Verification" sections vs. the actual root `package.json`:

| Documented in CLAUDE.md | Reality |
|---|---|
| `npm run dev` — "(turbo: web + core + gateway)" | **Wrong target.** Root `dev` is `vite` — the marketing site only. The turbo one is `dev:workspaces`. |
| `npm run build` | **Exists but wrong scope.** Root `build` is `tsc --noEmit && vite build` — marketing site only, zero MVP code. Workspaces need `build:workspaces`. |
| `npm run test` | **DOES NOT EXIST.** `npm error Missing script: "test"`. |
| `npm run lint` | **DOES NOT EXIST.** `npm error Missing script: "lint"`. |
| `npx tsc --noEmit` (Verification step 1) | **Exists but wrong scope.** Root `tsconfig.json` has `"include": ["src"]` — 48 files of Vite marketing site. It typechecks **none** of `apps/web`, `services/core`, `services/gateway`, `packages/*`. |
| `poetry run pytest` (from `services/workers/`) | **poetry is not installed** on this machine. |

Net effect: a developer who follows the CLAUDE.md verification block literally runs one command that
passes vacuously (`npx tsc --noEmit` over the marketing site) and two that error out with
"Missing script". **The prescribed verification loop cannot validate any MVP code.** The commands
that actually work are `typecheck:workspaces` / `test:workspaces` / `lint:workspaces`, and they are
not the ones documented.

Secondary doc drift: CLAUDE.md describes `packages/graph-schema/` as "shared openCypher schema +
query builders". The directory exists but contains exactly one file, `schema.md` — no
`package.json`, so it is not an npm workspace and is never built, typechecked, linted, or tested.

Also note `packages/config` and `packages/shared-types` have **no `lint` script**, so
`lint:workspaces` covers only 3 of the 5 workspaces.

---

## 3. TypeScript error breakdown

### Pass B (deps installed) — the real number

**0 errors.** `typecheck:workspaces` ran 8 turbo tasks (5 typechecks + 3 dependency builds) and every
one succeeded, including `@sayre/core`'s double check
(`tsc --noEmit && tsc --noEmit -p test/mcp-interop/tsconfig.json`). Root `npx tsc --noEmit`: 0.

### Pass A (deps missing) — 575 errors, for reference

Recorded because this is what the repo produces before `npm install`. Per workspace:
`services/core` 379 · `apps/web` 131 · `services/gateway` 61 · `packages/config` 4 ·
`packages/shared-types` 0.

Top error codes:

| Count | Code | Meaning | Dependency artifact? |
|---|---|---|---|
| 237 | TS2307 | Cannot find module | yes |
| 146 | TS7006 | Parameter implicitly `any` | yes — cascade from untyped imports |
| 66 | TS2304 | Cannot find name (`fetch`, `Response`) | yes — missing `@types/node` |
| 56 | TS2580 | Cannot find name `process` | yes — missing `@types/node` |
| 24 | TS2584 | Cannot find name `console` | yes — missing lib/types |
| 13 | TS2339 | Property does not exist on type | see below |
| 11 | TS7031 | Binding element implicitly `any` | yes |
| 5 | TS18046 | Value is of type `unknown` | see below |
| 5 | TS2345 | Argument not assignable | see below |
| 4 | TS2353 | Object literal specifies unknown property | see below |
| 4 | TS2503 | Cannot find namespace | yes |
| 2 | TS7016 | Untyped module import | yes |
| 1 | TS2322 | Type not assignable | see below |
| 1 | TS2366 | Function lacks ending return statement | see below |

546 of 575 (95%) are direct module/type-resolution artifacts. The remaining 29 looked like they might
be genuine — concentrated in `services/core/src/services/providerSettingsCatalog.ts` and
`providerSettingsService.ts` around `CredentialRegistryEntry` / `EndpointCatalogEntry` missing
`id` / `label` / `purpose` / `providers`. **They are not genuine.** Those interfaces are declared
locally as `extends ProviderCredentialOption` / `extends ProviderEndpointOption`, and the base types
come from `@sayre/config`, which was unresolvable in Pass A. With the workspace link restored, all 29
disappear (Pass B is clean).

Worst files in Pass A (all dependency-driven, all clean in Pass B):

| Errors | File |
|---|---|
| 26 | `services/core/src/github/appClient.ts` |
| 20 | `services/core/src/mcp/gateway.ts` |
| 19 | `services/gateway/src/index.ts` |
| 18 | `services/core/src/db/schema.ts` |
| 17 | `services/core/src/services/providerSettingsService.ts` |
| 14 | `services/core/src/sqs/consumer.ts` |
| 13 | `services/core/src/integrations/tickets/jira/jiraTokenCipher.ts` |
| 11 | `services/core/src/services/providerSettingsCatalog.ts` |
| 10 | `services/core/src/routes/jiraConnect.ts` |
| 9 | `apps/web/app/workspace/settings/McpSettings.tsx` |

---

## 4. Lint summary

**0 errors, 0 warnings** across all workspaces that define a lint script.

- `@sayre/core` — `eslint . --ext .ts` → exit 0, no output
- `@sayre/gateway` — `eslint . --ext .ts` → exit 0, no output
- `@sayre/web` — `next lint` → `✔ No ESLint warnings or errors`
- `@sayre/config`, `@sayre/shared-types` — **no lint script defined**, silently skipped by turbo

ESLint configs found: `apps/web/.eslintrc.json`, `services/core/.eslintrc.json`,
`services/gateway/.eslintrc.json`. There is **no root ESLint config and no root lint script** — the
root Vite marketing site under `src/` (48 `.ts`/`.tsx` files) is never linted by anything.

---

## 5. Test summary (Node)

`npm run test:workspaces` → exit 0. 7/7 turbo tasks, 16.5s.

| Package | Test files | Tests |
|---|---|---|
| `@sayre/config` | 2 passed | 34 passed |
| `@sayre/gateway` | 10 passed | 77 passed |
| `@sayre/web` | 34 passed | 222 passed |
| `@sayre/core` | 98 passed | 1007 passed, 7 skipped (1014) |
| **Total** | **144 files** | **1340 passed, 7 skipped** |

Skipped tests are worth a look — they cluster in security-relevant suites:
- `services/core/src/security/tenantIsolation.penetration.test.ts` — 6 of 17 skipped
- `services/core/src/services/onboardingSandboxService.test.ts` — 1 of 5 skipped

These are almost certainly gated on a live Postgres (the package has separate, un-run
`test:rls` / `test:rls:acceptance` scripts that require `--env-file=../../infra/.env`). So the
tenant-isolation penetration coverage that `security-multitenancy.md` leans on is **partially
inert in the default test run**.

---

## 6. Python collection result

**Cannot be collected. Blocked at the toolchain layer, not the code layer.**

| Check | Result |
|---|---|
| `poetry` on PATH | **not installed** |
| `pytest` on PATH / importable | **not installed** (`No module named pytest`) |
| `ruff` / `flake8` / `mypy` on PATH | **none installed** |
| Virtualenv (`services/workers/.venv`, repo `.venv`) | **absent** |
| Installed Python | 3.11.9 |
| `pyproject.toml` `requires-python` | `>=3.12,<3.13` — **3.11.9 does not satisfy this** |
| `services/workers/.python-version` | `3.12` |
| Test files present | 40 `test_*.py` |
| Python source files | 140 `.py` (excl. `__pycache__`) |

So `poetry run pytest` fails twice over: poetry is absent, and even installed it would refuse to
build an env against Python 3.11.9. A stale `.pytest_cache/` and `__pycache__/` exist in
`services/workers/`, so the suite ran on some machine at some point — just not this one.

Python linting **is** configured in `pyproject.toml` and simply has never been run here:

```toml
[tool.poetry.group.dev.dependencies]
pytest = "8.*"; pytest-asyncio = "0.24.*"; ruff = "0.6.*"; mypy = "1.11.*"

[tool.ruff]      target-version = "py312", line-length = 100
[tool.mypy]      python_version = "3.12", ignore_missing_imports = true
[tool.pytest.ini_options]  testpaths = ["tests"], pythonpath = ["."], asyncio_mode = "auto"
```

**140 Python files across the entire async worker fleet — the ingestion, semantic-enrichment, and
retrieval/RAG services — have zero verification coverage on this machine.** That is the largest
unverified surface in the repo by a wide margin.

---

## 7. Environment / engine mismatches

| Constraint | Declared | Actual | Status |
|---|---|---|---|
| Node (all 4 JS workspaces `engines`) | `>=20 <21` | v24.14.0 | **mismatch** — `npm install` emits 8 `EBADENGINE` warnings |
| Node (`.nvmrc`) | `20` | v24.14.0 | **mismatch** |
| Python (`pyproject.toml`) | `>=3.12,<3.13` | 3.11.9 | **mismatch — hard blocker for poetry** |

Everything passes on Node 24 anyway, but nothing here is running on the version CI/`.nvmrc` pins,
so local green is not evidence that pinned-version CI is green.

---

## 8. Bottom line

The user's worry — "I dumped code without checking" — is **not borne out by the code**. With
dependencies installed, all four verification gates are clean: 0 TypeScript errors, 0 lint
errors/warnings, 1340 tests passing, all builds succeeding.

What is actually broken is the layer around the code:

1. The repo ships uninstalled. Two of the four documented verification commands don't exist; a third
   silently checks the wrong 48 files.
2. The entire Python worker fleet (140 files, 40 test files) is unverifiable here — no poetry, no
   pytest, no ruff, no mypy, and the wrong Python minor version.
3. 7 tests skip by default, 6 of them in the tenant-isolation penetration suite.
4. Node and Python both run off-pin versus `.nvmrc` / `.python-version` / `engines`.

Cheapest high-value fixes, in order: add root `test` / `lint` / `typecheck` scripts that delegate to
the `:workspaces` variants (or just correct CLAUDE.md to name the real commands); install the Python
toolchain on 3.12; and find out what gates the 6 skipped isolation tests.
