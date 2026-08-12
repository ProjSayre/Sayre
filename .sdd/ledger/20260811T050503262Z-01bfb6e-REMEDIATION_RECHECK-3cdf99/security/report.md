# Security Audit Report - CH-01 (Ephemeral scoped MCP credentials for first-party chat) - REMEDIATION_RECHECK

Run ID: 20260811T050503262Z-01bfb6e-REMEDIATION_RECHECK-3cdf99
Mode: REMEDIATION_RECHECK
This is round 3 of a `/re-gate`.

## 1. Verdict

**PASS**

## 2. Target and baseline

- Repository: projsayre/sayre (https://github.com/ProjSayre/Sayre.git)
- Working path: (git worktree) agent-a7c6f9616bdc59002
- Commit: 01bfb6e9f6a9583b1c7d3ac9b684bcadfcdaed6f, branch ticket/ch-01-ephemeral-mcp-credentials, clean (`git status --porcelain` empty)
- Environment: local-dev worktree; docker-compose services already running locally (sayre-postgres/pgvector:pg16, sayre-redis, sayre-neo4j, sayre-localstack, sayre-prometheus) on localhost — not shared, not production. A real `npm ci` was run at the repository root this round; the gitignored junctions earlier rounds relied on are gone and unnecessary. Local sayre-postgres confirmed identical (`pgvector/pgvector:pg16`) to CI's pinned image.
- `.pipeline/review.json` verdict: PASS, `stamp.treeHash` `82d75ea2...`; re-verified fresh via `node scripts/check-stamp-freshness.mjs review.json` (exit 0, status "fresh") before doing any work below.
- Baseline: `20260811T034551458Z-7ba3067-REMEDIATION_RECHECK-0a781b` (round 2's PASS), explicitly named by the calling agent as this round's prior run.

**Ancestry caveat — investigated and resolved, not assumed.** `git merge-base --is-ancestor 7ba3067 HEAD` **fails**: `7ba3067` is not a literal git ancestor of this run's target. Investigated directly rather than either silently claiming ancestry or refusing on the technicality: the branch was rebased/amended between round 2 and round 3 — the feat commit was re-authored (`079ad62` -> `9cf76a4`, folding round 2's own 3-file hand-edit directly into the feat commit's content instead of leaving it as a separate diff), and the round-2 "chore: ledger entry" commit was replaced (`7ba3067` -> `19eb88d`, now recording round 2's PASS too). Content equivalence verified directly as the substitute for the failed ancestry check:

```
$ git diff --name-status 7ba3067..19eb88d -- . ":(exclude).sdd/ledger/**"
M       .github/workflows/ci.yml
M       packages/config/src/config.ts
M       services/core/src/db/ephemeralMcpCredentials.rls.test.ts
```

Excluding the ledger bookkeeping directory (which legitimately differs — it records one more completed run), this is **exactly** the same three files round 2's own manifest already declared as its dirty, hand-edited diff, with no additional difference. The working tree round 2 actually audited (`7ba3067`'s commit plus its 3 declared dirty files) is content-identical to commit `19eb88d`, which this round's own HEAD (`01bfb6e`) sits directly on top of. Comparable per `audit-contract.md` section 2 order item 1 (human-specified compatible run), with the git-ancestry check substituted by direct content-equivalence verification for the reason given.

## 3. What changed since the baseline PASS (re-derived independently)

```
$ git diff --name-only 19eb88d..HEAD
services/core/src/db/rls_acceptance.tester.test.ts

$ git diff --numstat 19eb88d..HEAD
11      0       services/core/src/db/rls_acceptance.tester.test.ts
```

One file, eleven insertions, zero deletions. Read the full diff directly:

```diff
@@ -225,6 +225,17 @@ const EXPECTED_COLUMNS: Record<TableName, Record<string, [string, boolean]>> = {
     ...
+    // CH-01 (drizzle/0019_ch01_ephemeral_mcp_credentials.sql): ...
+    kind: ["text", false],
+    conversation_id: ["uuid", true],
   },
   model_provider_configs: {
```

The change is confined to two new entries in the `mcp_client_keys` block of the `EXPECTED_COLUMNS` map (lines 225-241) plus an attributing comment. Nothing else in this 2,022-line file changed.

**Also independently re-confirmed the full CH-01 diff's production code has zero drift since round 2:**

```
$ git diff --stat 7ba3067..HEAD -- services/core/src/services/mcpKeyService.ts services/core/src/mcp/gateway.ts \
    services/core/src/mcp/toolExecution.ts services/core/src/mcp/metrics.ts \
    services/core/src/services/ephemeralMcpCredentialService.ts services/core/src/db/ephemeralMcpCredentialStore.ts \
    services/core/drizzle/0019_ch01_ephemeral_mcp_credentials.sql
(no output -- zero lines changed)
```

And `scripts/` is untouched across the whole CH-01 branch:

```
$ git diff --stat ee496aa..HEAD -- scripts/
(no output)
```

## 4. This round's specific attack-surface findings

- **Is the pin extended rather than weakened? Yes, provably.** Read the exact-match assertion loop directly (`rls_acceptance.tester.test.ts:676-709`, itself outside the diff's line range):
  ```ts
  for (const col of actual.keys()) {
    assert.ok(expected[col], `${table}: unexpected column '${col}' not in spec's column list`);
  }
  for (const [col, [dataType, nullable]] of Object.entries(expected)) {
    const got = actual.get(col);
    assert.ok(got, `${table}.${col} is missing`);
    assert.equal(got!.is_nullable, nullable ? "YES" : "NO", ...);
    assert.equal(got!.data_type, dataType, ...);
  }
  ```
  Loop 1 (unexpected-column rejection) is byte-identical — a genuinely unknown future column still fails the suite's very first test. Loop 2 (mandatory-presence + type/nullability) is also byte-identical, and adding `kind`/`conversation_id` to `expected` makes both entries **newly mandatory** — a pin entry with no live counterpart now fails too (`table.col is missing`). The edit can only add obligations; it cannot be used to wave a column through undetected. Neither entry uses a wildcard, `any`, or sentinel value.

- **Does the "unexpected column" gate still fire, and is a pinned column mandatory?** Verified both directions dynamically: ran the exact CI-invoked command against real Postgres (`npm --prefix services/core run test:rls:acceptance:ci`) — **64/64 pass**, including test 1, against a database freshly migrated from all committed migrations including `0019`. If either direction of the assertion had been weakened, or either type/nullability pin were wrong, this test would fail; it did not.

- **Are the pinned types honest?** Cross-checked against `drizzle/0019_ch01_ephemeral_mcp_credentials.sql` directly:
  ```sql
  ALTER TABLE mcp_client_keys ADD COLUMN kind text DEFAULT 'agent' NOT NULL;   -- pin: ["text", false] OK
  ALTER TABLE mcp_client_keys ADD COLUMN conversation_id uuid;                  -- pin: ["uuid", true]  OK
  ```
  These are the migration's *only* two `ADD COLUMN` statements, both on `mcp_client_keys`; no other table gains a column, and `expires_at` (already nullable) is reused rather than duplicated. The 64/64 dynamic pass above is independent, affirmative confirmation the live, migrated schema matches — a wrong nullability or type pin would have failed test 1's `assert.equal` on `is_nullable`/`data_type`.

- **The AC-5 no-plaintext guard is unaffected and untouched.** Read `rls_acceptance.tester.test.ts:1072-1082` directly — the forbidden-name blocklist (`key`/`secret`/`raw_key`/`token`/`password`/`key_hash`/`roles`) and the `key_prefix`/`key_hmac` required-name check sit far outside the diff's line range (225-241 vs. 1072-1082) and passed in the same 64/64 run. Neither `kind` nor `conversation_id` is in the forbidden set.

- **`sayre_app` privilege checks (`[AC-5] sayre_app role...`, `[AC-5] sayre_app has SELECT/INSERT/UPDATE/DELETE...`, `[W4-06] pre-tenant key bootstrap...`) are outside the diff entirely** (lines 1044-1118) and re-ran clean in the same 64/64 pass.

- **SECURITY DEFINER state.** `rls_acceptance.tester.test.ts` does not itself assert `prosecdef`; that assertion lives in the untouched sibling `ephemeralMcpCredentials.rls.test.ts:511-521` ("the recreated resolve_mcp_client_key stays SECURITY DEFINER and off PUBLIC"), re-run fresh this round against real Postgres: **7/7 pass** (`test:rls:ephemeral:ci`), including that exact test — `prosecdef=true`, `search_path` pinned, PUBLIC's EXECUTE still revoked, `sayre_app`'s still granted.

- **Cross-org isolation and cross-kind confusion.** `test:rls:ci` (general RLS suite, 13 tenant tables): **19/19**. `tenantIsolation.penetration.test.ts` (RLS-with-app-filter-removed across all 13 tables + cross-org INSERT rejection): **17/17**. `rls_acceptance.tester.test.ts`'s own AC-4 suite (lines 903-1040, outside the diff's edited range): bundled in the 64/64 above.

- **`scripts/` untouched — the secret-access ALLOWLIST was never widened.** `git diff --name-only ee496aa..HEAD -- scripts/` is empty; `npm run check:secret-access` -> exit 0; `npm run check:org-secret-access` -> exit 0.

- **Full CH-01-specific dynamic re-confirmation.** All 8 CH-01-specific vitest files (`ephemeralMcpCredentialService.test.ts`, `mcpCredentialResolution.test.ts`, `ephemeralMcpGateway.test.ts`, `mcpKeyStoreKind.test.ts`, `ephemeralMcpCredentialMigration.test.ts`, `ch01UnmodifiedSurfaces.test.ts`, `mcpKeyService.test.ts`, `gateway.test.ts`): **50/50**, identical per-file counts to round 1 and round 2.

## 5. Counts

| Result | Count |
|---|---|
| PASS | 22 |
| NOT_APPLICABLE | 22 |
| UNVERIFIED | 4 |
| FAIL | 1 |

| Result transition | Count |
|---|---|
| UNCHANGED | 47 |
| FIRST_OBSERVATION | 2 |

| Coverage transition | Count |
|---|---|
| UNCHANGED | 47 |
| NOT_COMPARABLE | 2 |

Finding statuses: OPEN — 1 (unchanged from round 1/round 2). Surface readiness: IMPLEMENTED — 14/14 (unchanged). Readiness transitions: UNCHANGED — 14/14.

49 observations total this run (47 comparable to round 2's own 47, all UNCHANGED, plus 2 newly added observations targeting this round's own changed file specifically: SEC-05 v2 and MCPT-09 v2, both FIRST_OBSERVATION since neither prior run ever evaluated `rls_acceptance.tester.test.ts` as a target asset).

## 6. Progress since the baseline PASS

- **Regressed:** none.
- **New CRITICAL/HIGH findings:** none.
- **Persisting finding:** MCPT-02 (`FND-c8951999637a`), MEDIUM, OPEN, unchanged. `mcpKeyService.ts` (the file the finding lives in) has a zero-line git diff since round 2 — re-confirmed directly this run — and the sibling-path assertions (`mcpCredentialResolution.test.ts` 12/12, `ephemeralMcpGateway.test.ts` 3/3) re-ran with identical results. Non-blocking per this stage's mandatory-gate rule (MEDIUM, not tenant-isolation/RBAC, not CRITICAL/HIGH, not a regression).
- **Changed:** none this round (round 2's own CHANGED entry, SEC-08, is itself now UNCHANGED relative to round 2).
- **First observation this round:** SEC-05 v2 and MCPT-09 v2 — both newly targeting `services/core/src/db/rls_acceptance.tester.test.ts`, the one file this round's delta touches, neither round 1 nor round 2 having evaluated it as a target asset. Both resolved PASS: the schema-pin's exact-match mechanism (both directions) is intact and the two new pinned columns are neither credential-shaped nor exempt from the no-plaintext-column guard.
- **Resolved:** none this round.
- **Risk-accepted:** none.

## 7. Verified clean (affirmatively tested and passed this run, not merely re-asserted)

All against real Postgres (`sayre-postgres`, already running, healthy, confirmed identical image to CI's `pgvector/pgvector:pg16`), independently run this session:

- `npm --prefix services/core run test:rls:acceptance:ci` (the exact CI step that failed on `main` and motivated this round): **64/64 pass**, including test 1.
- `npm --prefix services/core run test:rls:ephemeral:ci`: **7/7 pass**, including the SECURITY DEFINER/PUBLIC-revoked assertion.
- `npm --prefix services/core run test:rls:ci`: **19/19 pass**.
- `npx vitest run src/security/tenantIsolation.penetration.test.ts` (with `DATABASE_ADMIN_URL` set): **17/17 pass**.
- All 8 CH-01-specific vitest files individually: **50/50 pass**, identical per-file counts to round 1/round 2.
- `npm run check:secret-access`: exit 0, "Secret-access gate passed."
- `npm run check:org-secret-access`: exit 0, "Org-secret access gate passed."
- `npm run check:security-audit-agents`: "Security audit agent validation passed: 8 surface briefs, 108 unique checks, 2 schemas."
- `node scripts/check-stamp-freshness.mjs review.json`: exit 0, status "fresh".
- Direct read of `drizzle/0019_ch01_ephemeral_mcp_credentials.sql` confirming exactly two `ADD COLUMN` statements, both matching the new pin's types/nullability.
- Direct read of the exact-match assertion loop (`rls_acceptance.tester.test.ts:676-709`) confirming it is outside the diff's edited line range (225-241) and unmodified.
- `git diff --stat 7ba3067..HEAD` on every CH-01 production source file (`mcpKeyService.ts`, `ephemeralMcpCredentialService.ts`, `ephemeralMcpCredentialStore.ts`, `toolExecution.ts`, `metrics.ts`, `gateway.ts`, migration `0019`): zero-line diff on every one.
- `git diff --name-only ee496aa..HEAD -- scripts/`: empty (confirmed across the entire CH-01 branch, not just this round).

## 8. Limitations

- MCPT-06/MCPT-07 (gateway lifecycle/JSON-RPC fuzzing) remain UNVERIFIED, unchanged — `gateway.ts` is still untouched and still not independently fuzzed by any run in this worktree.
- MCPT-02's timing dimension remains STATIC-only — no empirical wall-clock latency sampling was performed this run either.
- SEC-10/SEC-14 (audit-log tamper-evidence / alerting) remain UNVERIFIED, unchanged — pre-existing, non-CH-01 gaps this delta does not touch.
- The supply-chain-infrastructure checklist (SC-01..14) is carried forward unchanged from round 2; this round's own delta does not match any of that surface's trigger paths, so no fresh SC-* evidence was gathered this round.
- llm-rag, model-provider, websocket-realtime, ingestion-queue-webhook, and web-api-client briefs were not selected this run either — none has a target asset in this round's one changed file.
- **Environment/tooling note (not a finding):** this run's content hash for `.sdd/stages/security.md` (`6c2e64d5...`) differs from round 2's recorded hash (`82045d3c...`) for the same, git-diff-confirmed-unchanged file. Resolved as a benign CRLF/LF line-ending artifact: CRLF-normalizing this run's LF content reproduces round 2's exact hash byte-for-byte, and `git cat-file -p HEAD:.sdd/stages/security.md | sha256` reproduces this run's hash exactly, confirming it matches the committed (LF) blob. Round 2's working-tree copy of this one file evidently had CRLF line endings at the time (the same `core.autocrlf=true` churn `review.md`'s own Warning 1 documents for a different file); this round's fresh `npm ci`/checkout state normalized it back to LF. Not a content change, not tampering, not attributable to CH-01.
- The ancestry caveat in section 2 above: strict `git merge-base --is-ancestor` fails for the chosen baseline due to an intervening rebase, substituted with direct content-equivalence verification. Documented rather than silently worked around.

## 9. Cleanup

- No source file was written, edited, or deleted during this run (read-only with respect to source code). All command output was read via `Bash`/`Read` only.
- Test runs against real Postgres used each suite's own before/after lifecycle (`rls_acceptance.tester.test.ts` and `ephemeralMcpCredentials.rls.test.ts` each create and drop/truncate their own throwaway database or rows via their own hooks) — no additional fixture was created by this audit beyond those suite-owned lifecycles, and none was left behind (`git status --porcelain` empty at both the start and end of this run).
- A local-dev Postgres credential (the already-running `sayre-postgres` container's own `POSTGRES_PASSWORD`, read via `docker inspect`) was used to construct `DATABASE_ADMIN_URL` for the test invocations above; it was never written to a file, never echoed via a `Bash` command's own stdout, and is not reproduced anywhere in this report or its sibling artifacts.
- A handful of throwaway scratch scripts (to construct `DATABASE_ADMIN_URL` without printing the password, and to programmatically build this run's `results.json`/`manifest.json` from round 2's own, reducing transcription risk) were created under this session's own scratchpad directory (`C:\Users\splat\AppData\Local\Temp\claude\C--Users-splat-OneDrive-Desktop-Sayre\9ee96397-6621-4edd-b707-4b0b934e3747\scratchpad\`). None of these paths resolves inside the repository checkout; nothing under the repository was created, modified, or left behind by them.

## 10. Recheck scope for the next run

Unchanged from round 1/round 2's own stated scope: if MCPT-02's timing finding is remediated in `mcpKeyService.ts`, the next run should rerun MCPT-02's full evidence list (including an empirical timing measurement this time) plus EC-3/EC-4/EC-5/EC-6/EC-7/EC-8 in `mcpCredentialResolution.test.ts` and AC-3/EC-1 in `ephemeralMcpGateway.test.ts`. No new recheck scope is opened by this round's own delta — the one changed file is fully re-verified clean above, and its extension is provably additive-only (11 insertions, 0 deletions, confined to a schema-pin data literal).
