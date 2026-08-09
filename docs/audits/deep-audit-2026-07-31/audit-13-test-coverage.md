# Audit 13 — Test Coverage: Ground Truth

Repo: `C:\Users\splat\OneDrive\Desktop\Sayre` — branch `planning/future-tickets` @ `b8dc223`
Date: 2026-07-31. All results below are **observed output**, not inference.

## Headline

The stated premise — *"we dumped code for our MVP and didn't go back and check or do proper
tests"* — **is not what the repo shows.** There are **192 test files** (149 TS/TSX, 40 Python,
3 `.mjs`) and **2013 passing assertions-bearing tests**. The backend security tests are, in
places, better than average commercial work: they include negative controls, anti-vacuity
sanity checks, and static scans with deliberate decoy fixtures.

The real problems are **(a) the local dev environment cannot run the tests as checked out**,
**(b) the frontend is effectively untested**, and **(c) a handful of security-relevant
modules have zero coverage**.

---

## 1. Actual suite run results

### 1.1 `services/workers` — pytest

`poetry` is **not on PATH** (`command -v poetry` → nothing; `where poetry` → nothing). Six
cached Poetry venvs exist under `C:\Users\splat\AppData\Local\pypoetry\Cache\virtualenvs\`.
Global `python -m pytest` → `No module named pytest`. Ran via the newest venv's interpreter.

**As checked out — the suite does not run:**

```
=========================== short test summary info ===========================
ERROR tests/test_dynamic_coverage.py
ERROR tests/test_github_repository_auth.py
ERROR tests/test_ingestion.py
ERROR tests/test_initial_parse_wire_fixture.py
ERROR tests/test_onboarding_priority.py
ERROR tests/test_repository_credential_binding.py
ERROR tests/test_worker_entrypoints.py
!!!!!!!!!!!!!!!!!!! Interrupted: 7 errors during collection !!!!!!!!!!!!!!!!!!!
2 warnings, 7 errors in 6.24s
```

Root cause, identical in all 7:

```
sayre_workers\ingestion\github_installation.py:15: in <module>
    import jwt
E   ModuleNotFoundError: No module named 'jwt'
```

`PyJWT[crypto]==2.10.*` **is** declared in `pyproject.toml:22` and **is** in `poetry.lock:1828`.
It is simply not installed in **any** of the six venvs (verified all six). This is an
un-synced environment (`poetry install` never re-run after PyJWT was added), not a
lockfile defect.

With `--continue-on-collection-errors`: `1 failed, 533 passed, 19 skipped, 7 errors`.
The one failure was itself a cascade of the same missing import
(`test_embedding_work.py::test_postgres_embedding_lookup_distinguishes_stale_work_from_missing_config`
→ `ImportError: import error in sayre_workers.ingestion: No module named 'jwt'`).

**After installing PyJWT into the venv, the suite is green:**

```
625 passed, 19 skipped, 171 warnings in 30.11s
```

All 19 skips are infra-gated, and every one prints an explicit reason:
- 9 × `test_tenant_isolation.py` — `DATABASE_ADMIN_URL unreachable`
- 8 × `test_graph_migrations.py` — `Neo4j and/or Postgres unreachable`
- 2 × `test_graph_metrics_tester.py` — `Neo4j unreachable`

### 1.2 Repo-root npm scripts

`npm run test` — **does not exist**, despite `CLAUDE.md` documenting it as the test command:

```
npm error Missing script: "test"
```

`npm run test:workspaces` **as checked out** — fails:

```
> turbo run test
'turbo' is not recognized as an internal or external command,
```

Diagnosis: **no workspace had its dependencies installed at all.**

| Path | `node_modules` |
|---|---|
| `apps/web` | MISSING |
| `services/core` | MISSING |
| `services/gateway` | MISSING |
| `packages/config` | MISSING |
| `packages/shared-types` | MISSING |
| `packages/graph-schema` | MISSING |
| repo root | present, 69 entries (Vite marketing-site deps only) — no `vitest`, no `turbo` |

**Consequence: all 149 TypeScript test files were unrunnable on this machine.** The
lockfile is fine (`lockfileVersion: 3`, contains all four workspaces and `vitest`); only the
install was missing. I ran `npm install` — **`package-lock.json` was unchanged afterwards**
(verified via `git status --short`), so this was purely a local-state fix.

### 1.3 Per-workspace results (after install) — all green

| Workspace | Test files | Passed | Skipped |
|---|---|---|---|
| `services/core` | 98 | **1007** | 7 |
| `apps/web` | 34 | **222** | 0 |
| `services/gateway` | 10 | **77** | 0 |
| `packages/config` | 2 | **34** | 0 |
| **Total** | **144** | **1340** | **7** |

`npm run test:workspaces` then succeeds: `Tasks: 7 successful, 7 total`.

The core suite's 7 skips are the `DATABASE_ADMIN_URL`-gated Postgres penetration tests —
vitest prints the reason: `[tenantIsolation.penetration] DATABASE_ADMIN_URL unreachable`.

**144 of 149 TS test files ran.** The missing 4 are `services/core/src/db/**`, deliberately
excluded in `services/core/vitest.config.ts:13` (`exclude: [..., 'src/db/**']`) because they
are `node:test` suites, not vitest — they run via the separate `test:rls` / `test:rls:acceptance`
scripts. This is documented in the config comment and **is wired into CI** (see §1.5).

### 1.4 `scripts/*.test.mjs`

`node --test scripts/` — **fails** on this machine:

```
Error: Cannot find module 'C:\Users\splat\OneDrive\Desktop\Sayre\scripts'
Node.js v24.14.0
```

This is a Node-version mismatch, not a test defect: `.nvmrc` says `20` and every workspace
pins `"engines": { "node": ">=20 <21" }`, but the installed runtime is **v24.14.0**.
Run per-file, all pass:

| File | tests | pass | fail |
|---|---|---|---|
| `scripts/check-secret-access.test.mjs` | 38 | 38 | 0 |
| `scripts/check-org-secret-access.test.mjs` | 7 | 7 | 0 |
| `scripts/validate-security-audit-run.test.mjs` | 3 | 3 | 0 |

### 1.5 CI runs strictly more than local

`.github/workflows/ci.yml` is materially better than the local story and explicitly
defends against silent skips:

- L87–90: `npm run test --workspace @sayre/core` with `DATABASE_ADMIN_URL` set — with a
  comment stating the reason is that turbo's strict env mode would strip the variable and
  "make the penetration suite silently take its reachability skip."
- L102 / L107: `test:rls:ci` and `test:rls:acceptance:ci` — the vitest-excluded `src/db/**` suites.
- L92–99: BullMQ round-trip with `MESSAGING_INTEGRATION_REQUIRED: 'true'` (zero broker skips).
- L206–210: `poetry run pytest` with `DATABASE_ADMIN_URL` + `DATABASE_RUNTIME_URL`, after
  applying the Node/drizzle Postgres schema so the Python tenant-isolation suite really executes.
- L228+: parses the messaging JUnit XML and **asserts no Python broker test was skipped**.

**So: the tenant-isolation coverage that skips locally does execute in CI.**

---

## 2. Coverage inventory

### 2.1 Well-covered, high-confidence areas

| Area | Test file(s) | Note |
|---|---|---|
| Webhook signature verification | `services/core/src/webhooks/githubSignature.test.ts` | 10 negative cases: missing header, bad prefix, wrong length, non-hex, tampered body, legacy sha1, raw-byte vs re-serialized JSON, wrong secret, never-throws |
| WS RBAC re-filter (fan-out) | `services/gateway/src/fanout/fanout.test.ts` | 11 cases incl. cross-org, unauthorized-close, removals-never-itemized, concurrency bound |
| Graph query building / RBAC | `services/core/src/graph-query/index.test.ts`, `permissions.test.ts` | fail-closed paths, deny-beneath-allow, cross-ref stripping, server-injected scope |
| `org_id` binding | `services/core/src/security/graphOrgGuard.test.ts` (14), `cypherOrgIdScan.test.ts` (13+) | static scan across TS **and** Python, with decoy fixtures |
| Postgres RLS | `src/db/rls.test.ts`, `rls_acceptance.tester.test.ts`, `security/tenantIsolation.penetration.test.ts` | 13 tenant tables, filter-less SELECT |
| Auth / authorize | `http/authenticate.test.ts`, `http/authorize.test.ts`, `routes/auth.integration.test.ts` | real `createApp()`, real HTTP server, 401-vs-403 distinction |
| Queue envelope + SQS dedupe | `queue/__tests__/envelope.test.ts`, `queue/sqs.test.ts` | `MessageDeduplicationId` derived from `idempotency_key`, 64-char bound |
| Python messaging/idempotency | `tests/test_idempotency.py`, `test_envelope.py`, `test_messaging_topology.py`, `test_sqs_roundtrip.py` | |
| Service-layer lint gate | `services/core/src/routes/lintGate.test.ts` | 8 cases proving routes cannot import `neo4j-driver`/`pg`/`drizzle-orm`/`bullmq`/`ioredis`/graph-query, **plus a compliant-fixture sanity control** so the gate is not always-failing |

### 2.2 Untested source modules

| Workspace | Source files | With no sibling test |
|---|---|---|
| `services/core/src` | — | 57 (many covered indirectly — see §3) |
| `apps/web/app` | 38 `.tsx` components | **33 untested** |
| `services/gateway/src` | — | 2 (`index.ts`, `server.ts` — bootstrap only) |
| `packages/config/src` | — | 1 (`index.ts` — barrel) |
| `packages/graph-schema` | — | **contains only `schema.md`** — no code, no `package.json`, no tests |

Sibling-file absence overstates the gap. I verified actual test-import references. Modules
with **0 referencing test files**:

`db/schema.ts`, `mcp/toolExecution.ts`, `routes/mcpKeys.ts`, `integrations/tickets/identifiers.ts`,
`integrations/tickets/ticketCacheStore.ts`, `services/coverageContextService.ts`,
`services/initialParseOutboxWake.ts`, `telemetry/graphMetrics.ts`.

(`routes/login.ts` showed 0 direct imports but **is** covered end-to-end via `createApp()` in
`routes/login.integration.test.ts`. `db/schema.ts` is exercised transitively by the RLS suites.)

---

## 3. Untested and dangerous — ranked by risk

**1. HIGH — `services/core/src/routes/mcpKeys.ts` (57 lines): no test asserts the admin guard.**
All four endpoints (`GET /settings/mcp`, `POST /settings/mcp/keys`,
`DELETE /settings/mcp/keys/:keyId`, `PUT /settings/mcp/rate-limit`) carry
`authenticate(), authorize('admin')`. **No test file references this router or these paths**
(grep for `mcp-keys|mcpKeys` across all `*.test.ts` → zero hits). Deleting `authorize('admin')`
from the key-issuance endpoint would break no test. The *service* (`mcpKeyService.test.ts`) and
the *middleware* (`http/authorize.test.ts`) are both well tested — it is only the **wiring**
that is unasserted. `routes/auth.integration.test.ts:235` proves this style of wiring test is
already established for other routes, so the pattern exists and simply wasn't applied here.
Given MCP keys are 256-bit credentials with permission ceilings, this is the sharpest gap.

**2. HIGH — `apps/web/app/workspace/state.tsx` (1023 lines): no behavioral test.**
The largest single source file in the web app. Only incidentally imported by
`app/workspace/settings/SettingsPanel.test.tsx:5` as a `WorkspaceProvider` wrapper — nothing
asserts its state transitions.

**3. MEDIUM-HIGH — frontend generally: 33 of 38 `.tsx` untested.**
Includes every canvas (`TechnicalTreeCanvas`, `ProductTreeCanvas`, `OnboardingTreeCanvas`,
`PrerequisiteCanvas`), `SigmaCanvas.tsx` (370 lines), all drawers, and `WorkspaceShell`.
Mitigating: the *pure* view-model logic under `app/lib/` and `app/workspace/*.ts` (trees,
overlays, expansion, layout) **is** well covered — 222 passing tests. The gap is rendering
and interaction, not tree computation.

**4. MEDIUM — `apps/web/app/workspace/realtime.ts` (109 lines): zero tests.**
Client half of the WebSocket path. The server half (`services/gateway`) is thoroughly tested;
the client reconnect/resync handling is not.

**5. MEDIUM — `services/core/src/mcp/toolExecution.ts` (67 lines): zero test imports.**
`executeMcpTool` is the dispatch chokepoint for all 9 MCP tools. `mcp/gateway.test.ts` (246
lines) and the interop harness cover the gateway; this specific module is not directly asserted.

**6. MEDIUM — `services/core/src/integrations/tickets/ticketCacheStore.ts` (121 lines): zero tests.**
`PostgresTicketCacheStore` writes tenant-scoped ticket rows. Covered only transitively by RLS.

**7. LOW-MEDIUM — `services/core/src/telemetry/graphMetrics.ts` (78 lines): zero tests.**
`instrumentGraphQuery` / `instrumentGraphWrite` wrap every graph call. A throw here would be
in the hot path of all reads.

**8. LOW — `coverageContextService.ts` (23), `initialParseOutboxWake.ts` (13),
`integrations/tickets/identifiers.ts` (12).** Small and simple; `identifiers.ts` builds
`ticketUid` composite keys used for idempotency, so it is worth a table-driven test.

**9. LOW — `packages/graph-schema/` is a stub.** `CLAUDE.md` describes it as holding
"shared openCypher schema + query builders," but the directory contains only `schema.md` and
has no `package.json`. Nothing to test yet — flagged as a doc/reality mismatch.

---

## 4. Test-quality findings

### 4.1 Anti-patterns explicitly checked for and NOT found

- **`expect(true).toBe(true)` / vacuous assertions** — zero hits across all TS and Python tests.
- **Self-mocking (mocking the module under test)** — zero. I scanned every `vi.mock` call
  against its file's subject-under-test name; no file mocks its own SUT.
- **`.only` / `xit` / `xdescribe` silently narrowing a suite** — zero hits.
- **Snapshot tests with no real assertions** — no snapshot files in the repo.

### 4.2 Skips are conditional and self-reporting (good), but locally invisible

The only three skip constructs in the TS tree are all reachability guards, not disabled tests:

- `services/core/src/queue/__tests__/bullmq.roundtrip.test.ts:194` — `describe.skipIf(!brokerUp)`
- `services/core/src/security/tenantIsolation.penetration.test.ts:604` — `describe.skipIf(!adminUrl)`
- `services/core/src/services/onboardingSandboxService.test.ts:118` — `const containerIt = integrationImage ? it : it.skip`

Each prints a `console.warn` naming the missing dependency, and CI forces all three to run.
**This is the right design.** The residual risk is purely local: a developer running
`npm test` on a laptop sees `1007 passed` and no failure, while the tenant-isolation
guarantee was never exercised. The mitigation already exists in CI — it just isn't
reproducible locally without `infra/docker-compose.yml` up.

### 4.3 Structural tests that assert shape, not behavior

`services/core/src/mcp/handlerContract.test.ts` (32 lines) is the whole test suite for the 9
MCP handler files. It asserts the exact filename list, that each file is `< 20` lines, that
none imports `drizzle-orm|neo4j-driver|node:fs|node:child_process|/db/|/graph-query/`, and
that each references `services.<something>`. That is a **genuinely useful architectural
invariant** (it enforces the "no business logic in handlers" rule from `CLAUDE.md`), but it
is not behavioral coverage — no handler's input/output contract is asserted here. Behavioral
coverage comes from `mcp/gateway.test.ts` and `test/mcp-interop/interop.test.ts`, which is
adequate; flagging only so this file isn't mistaken for handler unit tests.

### 4.4 Happy-path-only scan — 12 flagged, all false positives on inspection

A keyword scan flagged 12 files with ≥3 tests and no negative-sounding test name. Reading
them, every one covers real edge/error behavior under neutral naming — e.g.
`services/core/src/queue/__tests__/bullmq.lifecycle.test.ts:131,161,204` covers shutdown
races, cancellation at the prewarmed-Redis await boundary, and reentrant shutdown;
`services/core/src/services/providerSettingsService.test.ts:203` covers credential redaction.
**No genuine happy-path-only suite was found.**

### 4.5 Notable positive: anti-vacuity controls

Several suites include a deliberate control proving the assertion isn't trivially satisfiable:

- `services/core/src/routes/lintGate.test.ts` — *"sanity control: a thin, compliant route
  fixture lints clean (the gate is not just always-failing)"*
- `services/core/src/security/cypherOrgIdScan.test.ts:244` — *"the schema-anchor sentinel org
  DOES appear in exactly the two allowlisted anchor migration files (sanity: not vacuous)"*
- `services/core/src/security/cypherOrgIdScan.test.ts:260,269,274,300` — decoy fixtures
  (`$org_id` in a `//` comment, in a `/* */` block, in a `RETURN` projection, inside a
  double-quoted string) each asserted to **fail** the scan.
- `services/core/src/security/neo4jChokepoint.test.ts` — *"every non-test .ts file under
  services/core/src is covered by the scan or the allowlist (no directory is silently skipped)"*
- `services/workers/tests/test_tenant_isolation.py:214` —
  `test_negative_control_without_set_role_leaks_across_orgs`, which asserts the **pre-fix
  pattern still demonstrably leaks**, proving the isolation is attributable to
  `SET LOCAL ROLE sayre_app` and not to an accident of the seed data.

This is above-average rigour and materially raises confidence in the security suite.

---

## 5. Cross-tenant isolation — explicit answer

**YES. Tests asserting org A cannot read org B's data exist at four independent layers.**

| Layer | File | Runs without infra? |
|---|---|---|
| WebSocket fan-out | `services/gateway/src/fanout/fanout.test.ts:91` — *"AC2: an event for org A never reaches a connection subscribed under org B, even to the same repo"* | **YES** |
| Cypher `org_id` binding | `services/core/src/security/graphOrgGuard.test.ts:48` — *"throws when params.org_id diverges from the server-resolved orgId (forged/mismatched bound org)"* + `cypherOrgIdScan.test.ts` static scan over TS **and** Python | **YES** |
| Graph Query Service RBAC | `services/core/src/graph-query/index.test.ts:236,400,545,607` — scope enforcement, cross-ref stripping, fail-closed | **YES** |
| Postgres RLS | `security/tenantIsolation.penetration.test.ts:604` (13 tables, filter-less SELECT under org A), `db/rls.test.ts`, `db/rls_acceptance.tester.test.ts`, `workers/tests/test_tenant_isolation.py` (with negative control) | **No — infra-gated, but forced on in CI** |

Caveat worth stating plainly: the **strongest** of these — the database-level "app filter
removed" proofs — are exactly the ones that skip on a developer laptop. A local `npm test` /
`pytest` run is **not** sufficient to claim tenant isolation is intact; only a CI run (or
`docker compose up` first) is.

---

## 6. Recommended actions, in priority order

1. **Add an HTTP-level wiring test for `routes/mcpKeys.ts`** asserting 401 without a token and
   403 for a member-role token on all four endpoints. Copy the pattern from
   `routes/auth.integration.test.ts:235`. This is the one genuine security hole.
2. **Fix the local dev environment story.** `poetry install` (or document the venv path),
   `npm install`, and pin Node 20 — currently v24.14.0 is installed against an `engines`
   range of `>=20 <21`.
3. **Add a root `test` script.** `CLAUDE.md` documents `npm run test` as the verification
   command and it does not exist. Point it at `test:workspaces`.
4. **Fix `node --test scripts/`** — it does not accept a bare directory on Node 24. Use
   `node --test "scripts/*.test.mjs"`, and add those 48 tests to `test:workspaces` (today they
   run only as three separate CI steps).
5. **Add behavioral tests for `apps/web/app/workspace/state.tsx`** (1023 lines, the single
   largest untested file) and `realtime.ts`.
6. **Make the local skip loud.** Consider a `MESSAGING_INTEGRATION_REQUIRED`-style
   `TENANT_ISOLATION_REQUIRED` flag so a developer can opt into "fail if skipped" locally.
7. Small table-driven tests for `toolExecution.ts`, `ticketCacheStore.ts`, `graphMetrics.ts`,
   `identifiers.ts`.
8. Reconcile `packages/graph-schema` with `CLAUDE.md` — it is currently a single markdown file.

---

## Appendix — environment changes made during this audit

- Installed `PyJWT[crypto]==2.10.*` (+ `cryptography`, `cffi`, `pycparser`) into
  `...\virtualenvs\sayre-workers-mkD8pD9P-py3.12` to obtain a true pytest result.
- Ran `npm install` at the repo root to obtain true TS results. **`package-lock.json` verified
  unchanged afterwards** (`git status --short package-lock.json` → empty). No source file was
  modified by this audit.
