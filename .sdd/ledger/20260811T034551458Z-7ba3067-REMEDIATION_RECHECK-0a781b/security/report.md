# Security Audit Report - CH-01 (Ephemeral scoped MCP credentials for first-party chat) - REMEDIATION_RECHECK

Run ID: 20260811T034551458Z-7ba3067-REMEDIATION_RECHECK-0a781b
Mode: REMEDIATION_RECHECK
This is a /re-gate run.

## 1. Verdict

**PASS**

## 2. Target and baseline

- Repository: projsayre/sayre (https://github.com/ProjSayre/Sayre.git)
- Working path: (git worktree) agent-a7c6f9616bdc59002
- Commit: 7ba3067f7ccfcfd38346f53ba5773b7f1a54b1e4, branch ticket/ch-01-ephemeral-mcp-credentials, dirty (3 modified files, all hand-edited on top of the committed CH-01 changeset)
- Environment: local-dev worktree; sayre-postgres (pgvector/pg16, healthy, identical image to CI's pinned one) already running on localhost -- not shared, not production
- .pipeline/review.json verdict: PASS, stamp.treeHash 18550d27...; re-verified fresh via node scripts/check-stamp-freshness.mjs review.json (exit 0, status "fresh") before doing any work below.
- Baseline: 20260810T213047899Z-ee496aa4-PR_DELTA-bf4071 (the prior PASS this recheck is against). Ancestry verified: git merge-base --is-ancestor ee496aa 7ba3067 succeeds -- ee496aa is a direct ancestor of this run's target. Same repository, same environment class, same tenant-fixture pattern, same audit-framework content hashes (re-hashed this run; identical to the baseline manifest's, except supply-chain-infrastructure-attacker.md, which the baseline never loaded). Comparable per audit-contract.md section 2 order item 1.

## 3. What changed since the baseline PASS (re-derived independently)

git diff HEAD against the committed CH-01 tip (7ba3067) shows exactly three uncommitted files -- confirmed directly, not taken from changes.json's self-report, though changes.json's redTestChanges entry matches what was found byte-for-byte:

1. services/core/src/db/ephemeralMcpCredentials.rls.test.ts -- line 39: process.env.CH01_TEST_DB_NAME ?? "ch01_ephemeral_rls_test" changed to getConfig("CH01_TEST_DB_NAME"), plus a header-comment update and the new getConfig import. No test, assertion, or @spec line touched.
2. packages/config/src/config.ts -- adds CH01_TEST_DB_NAME to CONFIG_NAMES and default 'ch01_ephemeral_rls_test' to DEFAULTS, alongside the pre-existing RLS_TEST_DB_NAME/TENANT_ISOLATION_TESTER_DB_NAME siblings.
3. .github/workflows/ci.yml -- adds one 14-line step ("core - RLS isolation tests (ephemeral MCP credentials)") to the existing node job, running npm --prefix services/core run test:rls:ephemeral:ci with the job's already-committed CI-local throwaway DATABASE_ADMIN_URL.

Confirmed scripts/ is byte-identical across the whole delta: git diff ee496aa -- scripts/ and git diff HEAD -- scripts/ both return zero lines, and git status scripts/ reports a clean tree.

Read all three files directly before forming any hypothesis, per the audit contract's two-phase method, then re-ran the actual CH-01 production code's dependent test suites to confirm zero behavioral drift.

## 4. This recheck's specific attack-surface findings

- Guard integrity - genuine fix, not a bypass. scripts/check-secret-access.mjs is untouched (zero diff vs. both ee496aa and HEAD). Its ALLOWLIST still contains only the two central loaders per language plus one pre-existing, independently justified test-file entry -- the hand-edited RLS test file is not in it. npm run check:secret-access passes clean against the current tree (exit 0). The gate passes because the flagged call site was fixed (process.env.CH01_TEST_DB_NAME -> getConfig(...)), not because the gate was weakened or bypassed. See SEC-01 (v2) below.
- CONFIG_NAMES boundary integrity. CH01_TEST_DB_NAME is a throwaway test database name (default 'ch01_ephemeral_rls_test'), registered only in the non-secret CONFIG_NAMES catalog, mirroring the pre-existing RLS_TEST_DB_NAME/TENANT_ISOLATION_TESTER_DB_NAME sibling entries. Verified dynamically this run against the compiled packages/config/dist: getConfig('DATABASE_ADMIN_URL') throws ConfigError: Unsupported configuration name. while getConfig('CH01_TEST_DB_NAME') returns its default -- the widening does not, and structurally cannot, open a path to any of the 21 names in the separate, closed SECRET_NAMES catalog (packages/config/src/secrets.ts), which getConfig has no knowledge of at all. See SEC-01 (v2) below.
- Red-test integrity - independently confirmed, not merely accepted from review.md. Counted directly: 7 test( blocks, 36 assert. calls, 7 @spec comment lines covering AC-2, AC-5, AC-7, AC-8, AC-12, EC-8, EC-14, EC-15, EC-20, EC-21, EC-23, EC-24 (12 unique IDs) -- all identical to what the diff shows was present before the hand-edit (the diff touches only the header comment, one import, and one constant's right-hand side; zero lines inside any test(/assert/@spec region). No behavioral assertion was added, removed, or weakened.
- CI workflow as an attack surface. The added step is a run: step (not uses:), with a fixed literal command string and one fixed literal env value byte-identical to four already-reviewed sibling RLS steps in the same job. No secrets.* reference exists anywhere in the 503-line file, no permissions: block exists (default GITHUB_TOKEN scope, unchanged), the on: trigger block (push/pull_request, not pull_request_target) is unchanged, no uses: (third-party action) was added, and no artifact-upload step exists. See SEC-08, SC-04, SC-05, SC-06, SC-10 below.
- Core CH-01 properties re-confirmed on the full diff. Digest-only storage, no auth oracle (byte-identical rejection body/status/log across every reason), strictly-narrowing scope ceiling, server-stamped org_id, cross-kind confusion rejected both directions, SECURITY DEFINER/REVOKE/GRANT privilege state -- all re-verified this run with fresh dynamic evidence against real Postgres (see section 6 below). All production code these properties depend on (ephemeralMcpCredentialService.ts, ephemeralMcpCredentialStore.ts, mcpKeyService.ts, mcpKeyStore.ts, toolExecution.ts, metrics.ts, migration 0019) has a zero-line git diff since the baseline PASS -- confirmed directly, not inferred.

## 5. Counts

| Result | Count |
|---|---|
| PASS | 20 |
| NOT_APPLICABLE | 22 |
| UNVERIFIED | 4 |
| FAIL | 1 |

| Result transition | Count |
|---|---|
| UNCHANGED | 31 |
| CHANGED | 1 |
| FIRST_OBSERVATION | 15 |

| Coverage transition | Count |
|---|---|
| UNCHANGED | 32 |
| NOT_COMPARABLE | 15 |

Finding statuses: OPEN - 1 (unchanged from baseline). Surface readiness: IMPLEMENTED - 14/14 (unchanged). Readiness transitions: UNCHANGED - 14/14.

47 observations total this run (32 comparable to the baseline's 32, plus 15 newly selected/newly-targeted observations: 14 SC-* from newly-selected supply-chain-infrastructure, and one additional SEC-01 observation targeting packages/config/src/config.ts / scripts/check-secret-access.mjs specifically, which the baseline never evaluated since neither file was in scope then).

## 6. Progress since the baseline PASS

- Regressed (PASS to FAIL, or coverage lost on a CRITICAL/HIGH boundary): none.
- New CRITICAL/HIGH findings: none.
- Persisting finding: MCPT-02 (FND-c8951999637a), MEDIUM, OPEN, unchanged. mcpKeyService.ts (the file the finding lives in) has a zero-line git diff since the baseline PASS -- re-read directly and re-ran the sibling-path assertions (mcpCredentialResolution.test.ts 12/12, ephemeralMcpGateway.test.ts 3/3) with identical results. Non-blocking per this stage's mandatory-gate rule (MEDIUM, not tenant-isolation/RBAC, not CRITICAL/HIGH, not a regression).
- Changed (result value changed, not a regression): SEC-08 (CI and test leakage), NOT_APPLICABLE to PASS. The baseline never evaluated .github/workflows/ci.yml because it wasn't in the diff yet; this recheck's own delta genuinely touches it, so the check now has a real target and passed on direct review (see section 4 above).
- First observation this run: the 14 supply-chain-infrastructure (SC-*) checks -- newly selected because .github/workflows/ci.yml now matches that surface's .github/** trigger path for real (the baseline's non-selection reasoning, "zero...CI...changes in this diff," no longer holds) -- plus one additional SEC-01 observation targeting the config.ts/guard-integrity question specifically. 3 of the 14 SC-* checks resolved PASS (SC-04, SC-05, SC-10); the rest resolved NOT_APPLICABLE because this specific one-step CI diff has no dependency/container/IAM/TLS/availability/migration target asset to exercise them against (a statement about this delta, not a MILESTONE-scope claim about the repository).
- Resolved: none this run (nothing in this delta touched MCPT-06/MCPT-07/SEC-10/SEC-14, so those four UNVERIFIED observations remain unchanged).
- Risk-accepted: none.

## 7. Verified clean (affirmatively tested and passed this run, not merely re-asserted)

All against real Postgres (sayre-postgres, already running, healthy), independently run this session:

- npm run test --workspace @sayre/core: 105 files / 1056 tests passed / 7 skipped -- identical counts to the baseline PASS.
- npx tsc --noEmit -p services/core/tsconfig.json: clean, exit 0.
- npx turbo run typecheck --filter=@sayre/config: clean, exit 0.
- npx turbo run lint --filter=@sayre/core --force (cache bypassed): clean, zero findings.
- npm test --workspace @sayre/config: 34/34 passed (config.test.ts 7, secrets.test.ts 27).
- node --import tsx --test src/db/ephemeralMcpCredentials.rls.test.ts - run twice: once at the default database name (ch01_ephemeral_rls_test, exercising getConfig's default-fallback path) and once with CH01_TEST_DB_NAME explicitly overridden to a throwaway alternate name (proving the config wiring is genuinely live, not vestigial -- the override database was actually created under the overridden name, confirmed via psql, then dropped). 7/7 both times.
- npm --prefix services/core run test:rls:ephemeral:ci (the exact CI-invoked script): 7/7 passed.
- npx vitest run src/security/tenantIsolation.penetration.test.ts (with DATABASE_ADMIN_URL set): 17/17 passed, including the RLS-with-app-filter-removed test across all 13 tenant tables and the cross-org INSERT rejection test.
- Every CH-01-specific vitest file individually re-run: ephemeralMcpCredentialService.test.ts (19), mcpCredentialResolution.test.ts (12), ephemeralMcpGateway.test.ts (3), mcpKeyStoreKind.test.ts (4), ephemeralMcpCredentialMigration.test.ts (4), ch01UnmodifiedSurfaces.test.ts (2), mcpKeyService.test.ts (3), gateway.test.ts (3) -- 50/50, identical per-file counts to the baseline.
- npm run check:secret-access: exit 0, "Secret-access gate passed.", against the full current tracked tree.
- A direct dynamic probe of the compiled packages/config/dist/index.js: getConfig('DATABASE_ADMIN_URL') throws ConfigError: Unsupported configuration name.; getConfig('CH01_TEST_DB_NAME') returns 'ch01_ephemeral_rls_test'.
- node scripts/validate-security-audit-agents.mjs: "Security audit agent validation passed: 8 surface briefs, 108 unique checks, 2 schemas."

Static-only, additionally confirmed this run: git diff ee496aa -- scripts/ and git diff HEAD -- scripts/ both empty; a full-file grep of .github/workflows/ci.yml for permissions:/pull_request_target/secrets./upload-artifact/GITHUB_TOKEN matches only the two pre-existing, unmodified actions/checkout@v4 lines; zero-line git diff HEAD on every CH-01 production source file (mcpKeyService.ts, ephemeralMcpCredentialService.ts, ephemeralMcpCredentialStore.ts, toolExecution.ts, metrics.ts, schema.ts, drizzle/0019_*.sql).

## 8. Limitations

- MCPT-06/MCPT-07 (gateway lifecycle/JSON-RPC fuzzing) remain UNVERIFIED, unchanged -- gateway.ts is still untouched and still not independently fuzzed by any run in this worktree.
- MCPT-02's timing dimension remains STATIC-only -- no empirical wall-clock latency sampling was performed this run either.
- SEC-10/SEC-14 (audit tamper-evidence / alerting) remain UNVERIFIED, unchanged -- pre-existing, non-CH-01 gaps this delta does not touch.
- The supply-chain-infrastructure checklist was executed for the first time this run, scoped strictly to the actual one-step CI diff in front of it. The 11 NOT_APPLICABLE SC-* results are a statement about this specific delta having no dependency/container/IAM/TLS/availability/migration target asset -- not a MILESTONE/FULL-scope claim that those dimensions are secure for the repository as a whole.
- llm-rag, model-provider, websocket-realtime, ingestion-queue-webhook, web-api-client were not selected this run -- none has a target asset in this delta's three changed files.

## 9. Cleanup

- Ran docker inspect sayre-postgres (read-only) and one docker exec sayre-postgres psql SELECT/DROP DATABASE pair against the already-running, pre-existing sayre-postgres container (not created by this run). Created exactly one throwaway artifact this run beyond the suite's own sanctioned operation -- a database named ch01_ephemeral_rls_test_override_check, created solely to prove CH01_TEST_DB_NAME's override path is live -- and dropped it immediately after with DROP DATABASE ch01_ephemeral_rls_test_override_check, confirmed via a follow-up SELECT datname FROM pg_database WHERE datname LIKE 'ch01%' showing only the sanctioned default database remains.
- The sanctioned default database (ch01_ephemeral_rls_test) was left truncated (0 rows in mcp_client_keys, confirmed by direct query) by the suite's own after() hook, exactly as the baseline run also confirmed.
- No source file was written, edited, or deleted during this run (read-only with respect to source code). No repository file outside this run's own .pipeline/security-history/<run-id>/ artifact directory and the one logged, exact database name above was created, modified, or left behind.
- A local-dev Postgres credential (the already-running sayre-postgres container's own POSTGRES_PASSWORD, read via docker inspect) was used to construct DATABASE_ADMIN_URL for the test invocations above; it was never written to a file, never intentionally echoed via a Bash command's own stdout for logging purposes, and is not reproduced anywhere in this report or its sibling artifacts, consistent with the audit contract's redaction requirement. It is a throwaway local-development-only value, distinct from the equally-throwaway CI-local placeholder already committed in ci.yml.

## 10. Recheck scope for the next run

Unchanged from the baseline's own stated scope: if MCPT-02's timing finding is remediated in mcpKeyService.ts, the next run should rerun MCPT-02's full evidence list (including an empirical timing measurement this time) plus EC-3/EC-4/EC-5/EC-6/EC-7/EC-8 in mcpCredentialResolution.test.ts and AC-3/EC-1 in ephemeralMcpGateway.test.ts. No new recheck scope is opened by this run's own delta -- the three hand-edited files are fully re-verified clean above with no open finding attributable to them.
