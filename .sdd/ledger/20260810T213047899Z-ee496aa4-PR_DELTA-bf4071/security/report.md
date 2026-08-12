# Security Audit Report — CH-01 (Ephemeral scoped MCP credentials for first-party chat)

Run ID: `20260810T213047899Z-ee496aa4-PR_DELTA-bf4071`
Mode: `PR_DELTA`

## 1. Verdict

**PASS**

## 2. Target and environment

- Repository: `projsayre/sayre` (`https://github.com/ProjSayre/Sayre.git`)
- Working path: `C:\Users\splat\OneDrive\Desktop\Sayre\.claude\worktrees\agent-a7c6f9616bdc59002` (git worktree)
- Commit: `ee496aa4985fc4145afbadf34c54de9cf3e9910a`, branch `ticket/ch-01-ephemeral-mcp-credentials`, dirty (12 modified + 10 untracked files vs. that commit)
- Environment: local-dev worktree; docker-compose services already running locally (`sayre-postgres` pgvector/pg16, `sayre-redis`, `sayre-neo4j`, `sayre-localstack`, `sayre-prometheus`) on `localhost` — not shared, not production
- Product phase: MVP, pre-external-customer (confirmed in code: the pepper is resolved via `getSecret('env://MCP_TOKEN_PEPPER')`, the MVP-phase `.env` loader path per `.claude/rules/security-multitenancy.md`, not the KMS-backed phase)
- Authorization: runtime/dynamic tests authorized implicitly — this is a local, non-shared, non-production target, so the contract's default-to-static-until-authorized restriction does not apply. Ran the full `services/core` vitest suite and the CH-01-specific database-backed `node:test` suite against the already-running local Postgres container.

## 3. Baseline

No baseline. `.pipeline/security-history/` did not exist in this worktree before this run, and no entry in `.sdd/ledger/` covers CH-01's new files or this specific two-family `mcpKeyService.ts`/`mcpKeyStore.ts` change. Per `audit-contract.md` §2 baseline order, this is order item 4 ("No baseline. Mark every observation `FIRST_OBSERVATION`"). All 32 observations and all 14 surface-inventory rows are `FIRST_OBSERVATION`; all 32 coverage transitions are `NOT_COMPARABLE`.

## 4. What changed (re-derived independently, not taken from `changes.md`)

`git diff --name-only` + untracked-file listing, confirmed against the working tree directly (not from `changes.md`'s self-report):

**New (untracked):** `services/core/src/services/ephemeralMcpCredentialService.ts`, `services/core/src/db/ephemeralMcpCredentialStore.ts`, `services/core/drizzle/0019_ch01_ephemeral_mcp_credentials.sql`, `services/core/src/db/ephemeralMcpCredentials.rls.test.ts`, `services/core/src/db/mcpKeyStoreKind.test.ts`, `services/core/src/mcp/ephemeralMcpGateway.test.ts`, `services/core/src/security/ch01UnmodifiedSurfaces.test.ts`, `services/core/src/security/ephemeralMcpCredentialMigration.test.ts`, `services/core/src/services/ephemeralMcpCredentialService.test.ts`, `services/core/src/services/mcpCredentialResolution.test.ts`.

**Modified:** `docs/wave0-foundation-contracts.md`, `packages/shared-types/src/index.ts`, `services/core/drizzle/meta/_journal.json`, `services/core/package.json`, `services/core/src/db/mcpKeyStore.ts`, `services/core/src/db/schema.ts`, `services/core/src/mcp/gateway.test.ts`, `services/core/src/mcp/metrics.ts`, `services/core/src/mcp/toolExecution.ts`, `services/core/src/services/mcpKeyService.test.ts`, `services/core/src/services/mcpKeyService.ts`, `services/core/test/mcp-interop/fixtureGateway.ts`.

**Confirmed unmodified** (`ch01UnmodifiedSurfaces.test.ts`, re-run this run, passing): all nine `services/core/src/mcp/handlers/*.ts`, `services/core/src/mcp/gateway.ts`, `services/core/src/graph-query/permissions.ts`, `services/core/src/auth/context.ts`.

Read every one of the new/modified production files directly (not summaries) before forming any hypothesis, per the contract's two-phase method.

## 5. Counts

| Result | Count |
|---|---|
| PASS | 15 |
| NOT_APPLICABLE | 12 |
| UNVERIFIED | 4 |
| FAIL | 1 |

| Surface readiness | Count |
|---|---|
| IMPLEMENTED | 14 (all registered surfaces) |

Result/readiness transitions: 32/32 and 14/14 `FIRST_OBSERVATION` respectively (no baseline). Coverage transitions: 32/32 `NOT_COMPARABLE`.

## 6. Ticket-specific attack surfaces (the areas this run was specifically asked to prioritize)

- **Digest-only storage** — PASS. No DB column, log line, error message, or metric attribute ever carries the raw token. See `CORE-03`, `MCPT-09` below.
- **Auth oracle (expired vs. unknown)** — byte-identical body/status/content-type: PASS (`MCPT-02`, `AC-3`/`EC-1`). Byte-identical error message/log-level across every rejection reason: PASS. Timing: **FAIL, MEDIUM severity, non-blocking** — see finding below.
- **Scope ceiling (strictly narrowing, deny rows honored)** — PASS, proven against real Postgres. See `MCPT-10`.
- **Tenant isolation (`org_id` server-stamped)** — PASS, proven against real Postgres with the app-layer filter removed. See `CORE-01`.
- **Cross-kind confusion (`agent` vs. `chat_ephemeral`)** — PASS, both directions. See `MCPT-02`/`EC-3`, `EC-4`.
- **`SECURITY DEFINER` REVOKE/GRANT re-issue** — PASS, proven against real Postgres via `pg_proc`/`has_function_privilege`. See `MCPT-11`.
- **TTL (300s default / 600s max, service + DB CHECK, no clock-skew bypass)** — PASS, proven against real Postgres including exact boundary cases. See `MCPT-11`.

## 7. The one finding

**MEDIUM**, **OPEN**, non-blocking (see `results.json`'s `MCPT-02` observation for the exact `finding_id`, `observation_key = "projsayre/sayre|MCPT-02|mcp|services/core/mcp-key-service:resolveMcpCredential|v1"`).

`resolveMcpCredential`'s rejection disjunction (`services/core/src/services/mcpKeyService.ts:288-300`) short-circuits *before* `mcpSecretHmac`/`hmacMatches` for every one of: unknown prefix, wrong credential family, revoked, expired, wrong pepper version, deleted issuer. Only a row that passes every one of those checks but has the *wrong secret* reaches `await deps.getPepper()` + HMAC computation + `timingSafeEqual`. This is a measurable, structural code-path-length asymmetry between "no such shape-valid row" and "shape-valid row, wrong secret" — a timing side channel for row-shape-validity/existence, independent of the (correctly constant-time) secret comparison itself once that branch is reached.

This **predates CH-01** — the identical early-return structure already existed for `mcp_live_` agent keys before this diff. CH-01's new `row.kind` clauses were added *into* the same short-circuiting disjunction (`mcpKeyService.ts:296-299`), inheriting rather than introducing the gap for the new `chat_ephemeral` family.

Practical exploitability is bounded: the attacker needs a syntactically well-formed 74-character token to test in the first place (the 8-byte/64-bit prefix is not guessable), and even a confirmed "row exists and is shape-valid" answer does not help forge the constant-time-compared secret. That bound, plus this not being a CH-01 regression, is why this is MEDIUM rather than HIGH/CRITICAL and does not block this gate (per `.sdd/stages/security.md`, only a tenant-isolation/RBAC-boundary failure or a current CRITICAL/HIGH failure/regression blocks).

Evidence: STATIC code-path analysis only — no empirical wall-clock latency sampling was performed this run. See `results.json`'s `MCPT-02` observation for the full evidence list (which also includes the DYNAMIC evidence that the *non-timing* dimensions — body, status, content-type, error message, log level — are all confirmed identical across every rejection reason).

**Remediation scope for the eventual recheck:** make `resolveMcpCredential` perform a dummy `hmacMatches` comparison against a canonical/random digest on every fast-reject branch too (not skip it), so wall-clock cost is independent of which rejection reason applied. This is pre-existing `mcpKeyService.ts` code, not CH-01-authored code, so remediation is a `mcpKeyService.ts` change tracked as its own follow-up, not a blocker for CH-01's merge.

## 8. Verified clean (affirmatively tested and passed, not merely "no exploit observed")

All against **real Postgres** (the already-running local `sayre-postgres` container), independently run this session, not accepted from `changes.md`/`test-results.md`/`review.md`'s self-reports:

- `npx vitest run` (full `services/core` suite): **105 files / 1056 tests passed / 7 skipped** — identical to `review.md`'s numbers, independently reproduced.
- `npx tsc --noEmit` (services/core): clean, exit 0.
- `npx eslint` on all 6 CH-01 production source files: clean, zero findings.
- `node --import tsx --test src/db/ephemeralMcpCredentials.rls.test.ts` (the suite `review.md` flagged as its single largest unverified surface, `RED-DEFERRED` at authoring time for lack of `DATABASE_ADMIN_URL`): **7/7 passed**, against a real, freshly-migrated Postgres database — closing that gap entirely for this run. Covers: all three `0019` CHECK constraints (shape, kind enum, TTL boundary including exact 300s/600s/601s/at-boundary cases) rejecting every malformed row; `issue()` writing the key row and ceiling `permissions` rows in one org-scoped transaction; a resolved ephemeral credential's coverage matching its issuer's live scope exactly (including a live narrow-after-mint case); a widened ceiling row still granting nothing beyond the issuer's live scope; issuing-user deletion cascading to `created_by = NULL` and an empty resolved scope; `deleteExpired` removing only one org's expired `chat_ephemeral` rows and their ceiling rows, leaving live rows, expired `agent` rows, and other orgs untouched; and the recreated `resolve_mcp_client_key` confirmed `SECURITY DEFINER`, `search_path = public, pg_temp`, `EXECUTE` revoked from `PUBLIC`, granted to `sayre_app`.
- `npx vitest run src/security/tenantIsolation.penetration.test.ts` (with `DATABASE_ADMIN_URL` set, not part of the plain suite run above): **17/17 passed**, including the RLS-with-app-filter-removed test across all 13 tenant tables (`mcp_client_keys` and `permissions` both included) and the cross-org `INSERT` rejection test.
- Every CH-01-specific vitest file individually re-run and passed: `ephemeralMcpCredentialService.test.ts` (19), `mcpCredentialResolution.test.ts` (12), `ephemeralMcpGateway.test.ts` (3), `mcpKeyStoreKind.test.ts` (4), `ephemeralMcpCredentialMigration.test.ts` (4), `ch01UnmodifiedSurfaces.test.ts` (2), `mcpKeyService.test.ts` (3), `gateway.test.ts` (3).
- `node scripts/validate-security-audit-agents.mjs`: `Security audit agent validation passed: 8 surface briefs, 108 unique checks, 2 schemas.`

Additional STATIC-only clean checks: origin allowlist + DNS-rebinding protection unaffected and unmodified (`MCPT-01`); no session/stream-ID mechanism exists in this transport at all, so session-hijacking/cross-session-injection/replay-resumption are structurally not applicable (`MCPT-03`/`04`/`05`); no plaintext-secret column exists in `mcp_client_keys` at all (`CORE-03`); every SQL-touching line in the new store code goes through drizzle's parameterized query builder, confirmed by rendering the actual emitted SQL text (`CORE-06`).

## 9. Limitations

- `MCPT-06` (lifecycle/version confusion) and `MCPT-07` (JSON-RPC validation) — **UNVERIFIED**. Both concern `gateway.ts` behavior that is byte-identical to pre-CH-01 and delegated entirely to `@modelcontextprotocol/sdk`; no dedicated fuzzing/probing of that pre-existing surface was performed this run, and no prior security-history run exists in this worktree to cite as established baseline coverage. A `MILESTONE`/`FULL` run should establish that baseline.
- `SEC-10` (audit-log tamper-evidence) and `SEC-14` (detection/alerting) — **UNVERIFIED**. Both are genuine but minor, pre-existing (not CH-01-introduced) gaps: the audit read is over a mutable operational table with no append-only enforcement beyond RLS/role privilege, and no alerting exists on repeated auth failures for this or the pre-existing agent-key family.
- The timing finding above is STATIC code-path reasoning, not an empirical latency measurement. No live timing-sampling harness was built this run.
- `model-provider`, `llm-rag`, `websocket-realtime`, `ingestion-queue-webhook`, `web-api-client`, and `supply-chain-infrastructure` briefs were **not selected** for full-checklist execution this run. Each was individually inspected against the actual diff (not just its registry trigger-path floor) and found to have no applicable target asset in this change — see `manifest.json`'s `surface_inventory` for the specific reasoning per surface. This is a `PR_DELTA`-proportionate judgment, not a claim that those surfaces are secure; a `MILESTONE`/`FULL` run would audit them directly regardless of this diff.
- `EPHEMERAL_CREDENTIAL_NAME` duplication (service export vs. store's private copy) and the "600" magic-number appearing in three unlinked places — both already flagged in `review.md`'s Suggestions — are non-security code-quality notes, not re-litigated here.

## 10. Single points of failure (PASS results relying on exactly one control layer)

- `CORE-03`/`MCPT-09` digest-only storage: relies on the service code always calling `mcpSecretHmac` before persistence (no second layer would catch a hypothetical future bug that constructed a row with the raw secret) — mitigated structurally by the DB schema having no plaintext column to write to, but that mitigation is itself a single fact, not a second independent control.
- `MCPT-02`/`EC-3`/`EC-4` cross-kind confusion: enforced by exactly one check (`row.kind !== parsed.kind` in `resolveMcpCredential`) — inherently single-layer since the DB CHECK constraints validate a row's own shape, not a cross-check against the token string presented at resolve time. Well-tested (both directions, `EC-3`) but architecturally a single gate.
- `MCPT-11`/`AC-13`/`EC-23` `SECURITY DEFINER` grant state: enforced by exactly one migration statement pair (`REVOKE ALL ... FROM PUBLIC` / `GRANT EXECUTE ... TO sayre_app`, re-issued because `DROP FUNCTION` drops prior grants) — if this statement pair were ever omitted from a future migration touching this function, `PUBLIC` would silently regain `EXECUTE`. Confirmed correct for `0019` itself; there is no independent second control (e.g., a CI check asserting `has_function_privilege('public', ...) = false`) that would catch a *future* regression here.
- Everything else marked PASS above relies on at least two independent layers (e.g., tenant isolation: app-layer `ctx.orgId` stamping *and* DB-level RLS; TTL: service validation *and* DB CHECK; scope ceiling: mint-time snapshot *and* live-scope intersection at every resolve).

## 11. Cleanup

- Ran `docker exec sayre-postgres env` and `docker exec sayre-postgres psql ...` read-only introspection queries against the already-running, pre-existing `sayre-postgres` container (not created by this run) to confirm its local-dev-only credentials and to verify the RLS test's own throwaway database (`ch01_ephemeral_rls_test`) was left truncated (0 rows) by that test's own `after()` hook. No file, table, row, or container was created, modified, or left behind by this run beyond what the repository's own `test:rls:ephemeral` script and `tenantIsolation.penetration.test.ts` already manage as part of their normal, sanctioned operation.
- No scratch git repo, `.pipeline/` fixture, or other throwaway path was created for this run beyond the required `.pipeline/security-history/<run-id>/` artifact directory itself.
- No source file was written, edited, or deleted during this run (read-only with respect to source code, consistent with this stage's mandate).

## 12. Recheck scope

If the `MCPT-02` timing finding is remediated in `mcpKeyService.ts`, the next run should: rerun `MCPT-02`'s full evidence list (both the confirmed-clean string/status/log dimensions and the timing dimension), plus `EC-3`/`EC-4`/`EC-5`/`EC-6`/`EC-7`/`EC-8` in `mcpCredentialResolution.test.ts` and `AC-3`/`EC-1` in `ephemeralMcpGateway.test.ts` (sibling paths using the same rejection disjunction), to confirm the fix does not regress any of the already-passing rejection-parity assertions.
