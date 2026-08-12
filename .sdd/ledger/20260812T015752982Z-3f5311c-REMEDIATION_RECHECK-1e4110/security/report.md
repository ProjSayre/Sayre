# Security Audit Report — CH-01 (Ephemeral scoped MCP credentials for first-party chat) — REMEDIATION_RECHECK

Run ID: 20260812T015752982Z-3f5311c-REMEDIATION_RECHECK-1e4110
Mode: REMEDIATION_RECHECK
This is round 5 of a `/re-gate` — a rebase onto a moved main plus a forced MIGRATION RENUMBER.

## 1. Verdict

**PASS**

## 2. Target and baseline

- Repository: projsayre/sayre (https://github.com/ProjSayre/Sayre.git)
- Working path: (git worktree) agent-a7c6f9616bdc59002
- Commit: `3f5311cfecfbeb6b4e7aa499a18329268386f679`, branch `ticket/ch-01-ephemeral-mcp-credentials`, clean (`git status --porcelain` empty).
- Environment: local-dev worktree; docker-compose services already running locally (`sayre-postgres` `pgvector/pgvector:pg16`, `sayre-redis`, `sayre-neo4j`, `sayre-localstack`, `sayre-prometheus`) on localhost — not shared, not production. `sayre-postgres` confirmed identical (`pgvector/pgvector:pg16`) to CI's pinned image.
- `.pipeline/review.json` verdict: **PASS**, `stamp.treeHash` `13b757c9…`, `headSha` `3f5311cf…`, `dirty: false`. Re-verified fresh via `node scripts/check-stamp-freshness.mjs review.json`: exit 0, status `"fresh"`, before doing any work below.
- Baseline: `20260811T055856705Z-47e012d-REMEDIATION_RECHECK-17901a` (round 4's PASS, 52 observations), explicitly named by the calling agent as this round's prior run.

**What actually happened between round 4 and round 5.** The branch was rebased again: base moved `90a1dca` → `2520ec9` via four gapfill merges (W0-05/W0-06/W0-07/W1-02), re-authoring all three CH-01 commits (feat `a45240c`→`73b01dd`, fix `7a349cd`→`9c185f7`, chore `47e012d`→`3f5311c`). Unlike round 4's rebase (which added zero migrations on main's side), **this round's rebase caused a genuine migration-index collision**: main's own W0-05 gapfill landed `drizzle/0019_w0_05_tenant_consistent_repo_fks.sql` at journal idx 19, the exact slot CH-01's own migration previously held. CH-01's migration was `git mv`'d `0019_ch01_ephemeral_mcp_credentials.sql` → `0020_ch01_ephemeral_mcp_credentials.sql`, with its journal entry moved to idx 20 (`when: 1785384400000`, strictly greater than idx 19's `1785384300000`). `git merge-base --is-ancestor 47e012d HEAD` **fails** — round 4's target is not a literal ancestor of this round's HEAD.

**Content equivalence verified directly, as the substitute for the failed ancestry check:** `git diff --name-status 47e012d HEAD` restricted to all 25 of CH-01's declared paths (`changes.json.filesChanged` union `red.json`'s test paths) returns **exactly six files**:

```
M	.github/workflows/ci.yml
M	services/core/drizzle/meta/_journal.json
M	services/core/src/db/ephemeralMcpCredentials.rls.test.ts
M	services/core/src/db/rls_acceptance.tester.test.ts
M	services/core/src/db/schema.ts
M	services/core/src/security/ephemeralMcpCredentialMigration.test.ts
```

(the migration file itself was renamed 0019→0020 — outside this path-restricted diff by construction, since the paths differ — and independently confirmed content-identical: `diff <(git show 47e012d:services/core/drizzle/0019_ch01_ephemeral_mcp_credentials.sql) <(git show HEAD:services/core/drizzle/0020_ch01_ephemeral_mcp_credentials.sql)` produced **zero output**). Every other one of the 25 declared paths is byte-identical between round 4's audited state and this round's HEAD. Comparable per `audit-contract.md` §2 order item 1 (human-specified compatible run), with git-ancestry substituted by direct content-equivalence for the reason given. Registry/contract/orchestrator/brief/schema/this-checker-definition content hashes re-hashed this run: **identical to round 4's**, including `.sdd/stages/security.md` and `.claude/agents/security-checker.md` — no discrepancy to investigate this round either.

## 3. What changed since the baseline PASS — the renumber is the main event

### 3.1 Migration renumber: SQL body unchanged, journal contiguous, ordering proven on a fresh database

Verified all four things the calling brief named, independently:

1. **SQL body unchanged by the rename.** `diff` between the pre-rename blob (at `47e012d`) and the post-rename blob (at `HEAD`) is empty — all three CHECK constraints (`mcp_client_keys_kind_check`, `mcp_client_keys_ephemeral_shape_check`, `mcp_client_keys_ephemeral_ttl_check`), both partial indexes, the `DROP FUNCTION IF EXISTS` before `CREATE FUNCTION`, and the re-issued `REVOKE ALL … FROM PUBLIC` / `GRANT EXECUTE … TO sayre_app` are byte-identical. Confirmed by direct read of `services/core/drizzle/0020_ch01_ephemeral_mcp_credentials.sql` in full.
2. **Journal is contiguous 0..20 with strictly increasing `when`.** Verified programmatically: 21 entries, `idx === index` for every entry, `idx` values form a set of size 21 (no duplicates), every consecutive `when` pair strictly increasing. idx 19 = `0019_w0_05_tenant_consistent_repo_fks` (`when: 1785384300000`, main's own migration, confirmed via `git show origin/main:…/_journal.json` to be unmodified by this branch); idx 20 = `0020_ch01_ephemeral_mcp_credentials` (`when: 1785384400000`). `journal.entries.at(-1)` equals the idx-20 entry.
3. **No stale references.** `rg 0019_ch01` across the whole tracked tree returns matches only under `.sdd/ledger/**` (18 hits, all inside four already-sealed immutable historical run directories plus the ledger index) — zero live/current-code references to the old filename or tag.
4. **Ordering proven dynamically on a fresh database, not a pre-migrated one.** Per this round's own briefing, dropped the five throwaway RLS databases first (`w005_rls_test`, `w005_rls_tester`, `w206_tenant_isolation_tester`, `ch01_ephemeral_rls_test`, `w3010_jira_connections_rls_test` — deliberately leaving `ch03_chat_rls_test` untouched, a different lane's fixture in the same shared container) via a scratchpad-only Node helper that resolved the admin credential through `docker inspect sayre-postgres` and never printed it. This was necessary so drizzle's own `__drizzle_migrations` bookkeeping could not carry the pre-rename `0019_ch01_ephemeral_mcp_credentials` tag/hash forward under a database that had ever migrated to the old name. Then ran, against completely fresh databases:
   - `npm --prefix services/core run test:rls:ephemeral:ci`: **7/7**.
   - `npm --prefix services/core run test:rls:acceptance:ci`: **65/65**, including `[AC-12/edge] running migrate() a second time is a no-op` and the three `[W0-05 GAP-1]` tenant-lineage-FK tests (up from round 4's 64/64 — the +1 is main's own coverage gain pulled in by the rebase, not a CH-01 change, and confirmed to already be part of `origin/main`, not something this diff touches).
   - `npm --prefix services/core run test:rls:ci`: **19/19**.

   This is direct, dynamic proof that applying main's tenant-consistent-repo-FK migration (idx 19) **before** CH-01's own migration (idx 20) is clean, and that CH-01's own CHECK constraints, partial indexes, and recreated `resolve_mcp_client_key` function all install correctly on top of it, starting from nothing. **New observation SC-13 v3, PASS.**

### 3.2 Did the renumber weaken the migration's own security contract? No.

Read `ephemeralMcpCredentialMigration.test.ts` in full and diffed it against round 4's baseline. The only changes are the four mechanical ones changes.json declares: the `MIGRATION_URL` literal, the `journal.entries.find` tag lookup, the `describe` title, and the header comment — all now say `0020`. Every assertion is unchanged in kind and strictness:

- `expect(entry).toEqual({idx: 20, version: '7', when: 1785384400000, tag: '0020_ch01_ephemeral_mcp_credentials', breakpoints: true})` is still full-object equality, not a subset/presence check.
- `expect(journal.entries.at(-1)).toEqual(entry)` is still a strict newest-entry/tip assertion.
- `expect(new Set(journal.entries.map(i=>i.idx)).size).toBe(journal.entries.length)` is still an idx-uniqueness assertion over the whole journal.
- The DROP-before-CREATE assertion (`createAt` greater than `dropAt`, `revokeAt`/`grantAt` greater than `createAt`), the privilege assertions (`SECURITY DEFINER`, `SET search_path = public, pg_temp`, `STABLE`), and the no-credential-vocabulary assertion (`not.toMatch(/\b(?:raw_key|plaintext|token|secret)\b/i)`) are byte-identical to the pre-renumber version.

Ran the file directly: **4/4 pass**. Folded into the SC-13 v3 observation above as direct evidence for "did the renumber weaken the migration's own security contract."

### 3.3 `scripts/check-secret-access.mjs` — main's second, distinct edit this round

`git diff 90a1dca..2520ec9 -- scripts/check-secret-access.mjs` is a single-line hunk: `SOURCE_EXTENSION` widened from `/\.(?:ts|tsx|js|jsx|mjs|cjs|py)$/i` to `/\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|py)$/i` — strictly additive, closing a TypeScript-module (`.mts`/`.cts`) detection gap rather than opening one; no `ALLOWLIST`, `EXCLUDED_SEGMENT`, or other detection rule moved. `git diff 2520ec9..HEAD --name-only -- scripts/` is empty — CH-01's own three commits touch nothing under `scripts/`. Enumerated all 25 of CH-01's declared paths: every one ends in `.ts`, `.sql`, `.json`, `.md`, or `.yml` — zero `.mts`/`.cts` files, so the widening neither newly exempts nor newly implicates any CH-01 file. Re-ran `npm run check:secret-access` (exit 0) and `npm run check:org-secret-access` (exit 0) against the widened guard. **New observation SEC-01 v4, PASS.**

### 3.4 Three-way unions, each diffed directly against `origin/main` (confirmed = `2520ec9`)

- `services/core/src/db/rls_acceptance.tester.test.ts`: `git diff origin/main HEAD --` shows only a 13-line addition — the `kind`/`conversation_id` column-pin entries with an attributing comment. Main's own `[W0-05 GAP-1]` tenant-lineage-FK tests (3 tests, confirmed present in `origin/main`'s copy of this file) are untouched by this diff and confirmed still passing (bundled in the 65/65 run above).
- `services/core/src/db/schema.ts`: same check — diff against `origin/main` shows only CH-01's `kind`/`conversationId` column additions and the hand-authored-partial-index comment (with "drizzle/0019_*" updated to "drizzle/0020_*" in the comment text, the only content change).
- `.github/workflows/ci.yml`: diff against `origin/main` shows exactly one added block — the "core — RLS isolation tests (ephemeral MCP credentials)" step, 14 insertions / 0 deletions — byte-identical to the step already audited in rounds 3/4.
- `.sdd/ledger/index.json`: `node scripts/build-ledger-index.mjs --check` reports "up to date (469 file(s), 19 run(s))".

### 3.5 Metering isolation re-checked against a larger main delta

This round's rebase pulled in the full W1-02 webhook-receiver gapfill (`normalizeGithubEvent.ts`, a new `githubDeliveryIdentity.ts` module, `routes/githubWebhook.ts`, `services/githubWebhookService.ts`, `app.ts`/`http/express.ts` wiring) — substantially larger than round 4's then-current main delta. `git diff 2520ec9..HEAD --name-only` restricted to those paths is empty — CH-01's own commits touch none of them. Re-read `toolExecution.ts`'s full import list directly: still only `./metrics` and `./rateLimit`, zero shared module/namespace with any of main's newly-extended webhook code. `git diff --stat 47e012d..HEAD` on `toolExecution.ts`/`metrics.ts`: no output on either. **New observation MCPT-09 v4, PASS.**

### 3.6 Everything else: byte-identical to round 4, re-run fresh

`git diff --stat 47e012d..HEAD` on every other CH-01 production/test source file (`mcpKeyService.ts`, `ephemeralMcpCredentialService.ts`, `ephemeralMcpCredentialStore.ts`, `mcpKeyStore.ts`, `toolExecution.ts`, `metrics.ts`, `packages/shared-types/src/index.ts`, `packages/config/src/config.ts`, `services/core/package.json`, `test/mcp-interop/fixtureGateway.ts`, and 6 of the 7 red-listed test files) returns **no output** on every one. Re-ran dynamically against real Postgres this round:

| Suite | Result |
|---|---|
| `test:rls:ephemeral:ci` | 7/7 |
| `test:rls:acceptance:ci` | 65/65 |
| `test:rls:ci` | 19/19 |
| `tenantIsolation.penetration.test.ts` (`DATABASE_ADMIN_URL` set) | 17/17 |
| 8 CH-01-specific vitest files | 50/50 |
| Full `services/core` vitest suite | 115 files / 1263 tests (7 skipped) |
| `npx tsc --noEmit` (`services/core/tsconfig.json`) | exit 0 |
| `npx tsc --noEmit` (`test/mcp-interop/tsconfig.json`) | exit 0 |
| `npx eslint` (7 touched non-test source files) | exit 0 |

Identical or, for the full-suite/acceptance-suite counts, expected-and-explained-larger counts to round 4.

## 4. Re-derived the CRLF line-ending artifact independently

`node scripts/check-red-integrity.mjs` reports **5 violations, 2 notes** (down from round 4's 6 violations/1 note — the migration-renumber edit moved `ephemeralMcpCredentialMigration.test.ts` from the undeclared-violation bucket into the declared-change/note bucket). For each of the 5 non-declared red files, independently computed SHA-256 of (a) raw worktree bytes — differs from `red.json`'s recorded hash; (b) the same content with `\r\n` normalized to `\n` — **matches** `red.json`'s recorded hash exactly:

| File | raw vs. recorded | LF-normalized vs. recorded | CRLF pairs |
|---|---|---|---|
| `ephemeralMcpCredentialService.test.ts` | differ | MATCH | 632 |
| `mcpCredentialResolution.test.ts` | differ | MATCH | 399 |
| `mcpKeyStoreKind.test.ts` | differ | MATCH | 160 |
| `ephemeralMcpGateway.test.ts` | differ | MATCH | 321 |
| `ch01UnmodifiedSurfaces.test.ts` | differ | MATCH | 84 |

`core.autocrlf=true` smudges this Windows worktree to CRLF; committed blobs and `red.json`'s hashes are LF. **Not a content change.** `core.autocrlf` was not changed by this run, per the calling brief's explicit instruction.

The 2 "notes" (declared in `changes.json.redTestChanges`) are `ephemeralMcpCredentialMigration.test.ts` (the migration renumber, judged legitimate — see §3.2) and `ephemeralMcpCredentials.rls.test.ts` (two comment/title-only edits — `0019`→`0020` in the header comment and one test title; read the file directly, confirmed no assertion, fixture, or test body changed). Both declarations are accurate.

## 5. Two known-failing CI steps, independently re-confirmed non-attributable

- **`test:sdd-completeness`** — ran it: **57/58, 1 failure.** The failing test's `actual` value is this worktree's CRLF copy of `.sdd/runtimes.yml` (159 CRLF pairs, 0 bare LF, confirmed via direct inspection). `git diff 2520ec9..HEAD --name-only -- .sdd/runtimes.yml` is **empty** — this branch does not touch that file at all. Not attributable to CH-01.
- **`test:dependency-install`** — ran it: 2 known failures, both Windows-host artifacts (`spawnSync('npm', …)` returning `actual: null` rather than an exit code without `shell: true` — the exact artifact this round's own tooling for the DB-dependent suites had to work around too; `poetry env use python3.12` failing to resolve `/c/Users/splat/.local/bin/python3.12` on this Windows path). Neither is a security boundary; CI runs on Ubuntu and does not hit either.

The `node` job in `.github/workflows/ci.yml` has **45 steps**, confirmed by direct count (`awk` over the job's own line range). The security-relevant subset was independently re-run above (§3.6, §5); the remaining steps (frontend build/lint, non-security-relevant suites) were not individually re-run by this stage, consistent with tester's own full local reproduction (test-results.md) reporting the same two non-attributable failures and everything else green.

## 6. Counts

| Result | Count |
|---|---|
| PASS | 28 |
| NOT_APPLICABLE | 22 |
| UNVERIFIED | 4 |
| FAIL | 1 |

| Result transition | Count |
|---|---|
| UNCHANGED | 52 |
| FIRST_OBSERVATION | 3 |

| Coverage transition | Count |
|---|---|
| UNCHANGED | 52 |
| NOT_COMPARABLE | 3 |

Finding statuses: OPEN — 1 (unchanged from rounds 1–4). Surface readiness: IMPLEMENTED — 14/14 (unchanged). Readiness transitions: UNCHANGED — 14/14.

**55 observations total this run** (52 comparable to round 4's own 52, all UNCHANGED, plus 3 newly added observations targeting this round's own new attack surface: SC-13 v3, SEC-01 v4, MCPT-09 v4, all FIRST_OBSERVATION since no prior run ever evaluated those specific target assets/attack paths).

## 7. Progress since the baseline PASS

- **Regressed:** none.
- **New CRITICAL/HIGH findings:** none.
- **Persisting finding:** `MCPT-02` (`FND-c8951999637a`), MEDIUM, OPEN, unchanged for the fifth consecutive round. `mcpKeyService.ts` (the file the finding lives in) has a zero-line diff since round 4 — re-confirmed directly this run — and the sibling-path assertions (`mcpCredentialResolution.test.ts` 12/12, `ephemeralMcpGateway.test.ts` 3/3) re-ran with identical results. Non-blocking per this stage's mandatory-gate rule (MEDIUM, not tenant-isolation/RBAC, not CRITICAL/HIGH, not a regression).
- **Changed:** none this round.
- **First observation this round:** `SC-13 v3` (the forced migration renumber across a genuine index collision — SQL body unchanged, journal contiguous/ordered, proven on a fresh database), `SEC-01 v4` (main's second `check-secret-access.mjs` edit — `SOURCE_EXTENSION` widened to `.mts`/`.cts`, a coverage gain not a hole), `MCPT-09 v4` (metering-subject isolation re-confirmed against this round's substantially larger main webhook delta). All three PASS.
- **Resolved:** none this round.
- **Risk-accepted:** none.

## 8. Verified clean (affirmatively tested and passed this run)

All against real Postgres (`sayre-postgres`, already running, healthy, confirmed identical image to CI's `pgvector/pgvector:pg16`), independently run this session, password never printed (constructed via `docker inspect sayre-postgres` into a scratchpad-only Node helper's in-memory variable and a spawned child process's own environment):

- Dropped 5 throwaway RLS databases for a genuinely fresh migration run (see §3.1), leaving `ch03_chat_rls_test` untouched.
- `npm --prefix services/core run test:rls:ephemeral:ci`: **7/7**.
- `npm --prefix services/core run test:rls:acceptance:ci`: **65/65**, including `[AC-12/edge]`'s idempotent-migrate assertion and the three `[W0-05 GAP-1]` tenant-lineage-FK tests.
- `npm --prefix services/core run test:rls:ci`: **19/19**.
- `npx vitest run src/security/tenantIsolation.penetration.test.ts` (`DATABASE_ADMIN_URL` set): **17/17**.
- All 8 CH-01-specific vitest files: **50/50**.
- Full `services/core` vitest suite: **115 files / 1263 tests passed, 7 skipped**.
- `npx tsc --noEmit` on both `services/core/tsconfig.json` and `test/mcp-interop/tsconfig.json`: exit 0.
- `npx eslint` on the 7 touched non-test source files: exit 0.
- `npm run check:secret-access`: exit 0. `npm run check:org-secret-access`: exit 0.
- `npm run check:security-audit-agents`: "8 surface briefs, 108 unique checks, 2 schemas."
- `npm run check:agent-shims`: 8 shims up to date. `npm run check:agent-ignore`: up to date. `npm run check:ledger-index`: 469 files / 19 runs, up to date.
- `node scripts/check-stamp-freshness.mjs review.json`: exit 0, "fresh."
- `git diff --name-status 47e012d HEAD` restricted to all 25 CH-01-declared paths: exactly six files, all individually diffed and judged legitimate (§2, §3).
- SQL-body diff across the migration rename: zero output.
- Direct read of `services/core/drizzle/meta/_journal.json`: contiguous `idx: 0`–`idx: 20`, strictly increasing `when`, no duplicate idx.
- `rg 0019_ch01` across the tracked tree: matches only under `.sdd/ledger/**` (18 hits, all immutable).
- `git diff 90a1dca..2520ec9 -- scripts/check-secret-access.mjs`: single additive hunk (`SOURCE_EXTENSION` widened).

## 9. Limitations

- `MCPT-06`/`MCPT-07` (gateway lifecycle/JSON-RPC fuzzing) remain UNVERIFIED, unchanged — `gateway.ts` is still untouched and still not independently fuzzed by any run in this worktree.
- `MCPT-02`'s timing dimension remains STATIC-only — no empirical wall-clock latency sampling was performed this run either.
- `SEC-10`/`SEC-14` (audit-log tamper-evidence / alerting) remain UNVERIFIED, unchanged — pre-existing, non-CH-01 gaps this round does not touch.
- `llm-rag`, `model-provider`, `websocket-realtime`, `ingestion-queue-webhook`, and `web-api-client` briefs were not selected this run either — CH-01's own branch has zero target asset in any of those surfaces. Main's own webhook-normalization delta pulled in by this round's rebase is substantially larger than round 4's, but remains out of scope for this ticket-specific `REMEDIATION_RECHECK`; its interaction with CH-01's own metering path was checked directly (§3.5, `MCPT-09 v4`, PASS) rather than auditing main's own changes on their own terms, which is `MILESTONE`/`FULL` scope.
- The `supply-chain-infrastructure` checklist (`SC-01`..`SC-14`) is carried forward from round 2's full execution; this round adds one fresh `SC-13` observation (the forced migration renumber, materially different from round 4's "no collision" finding) but does not re-derive `SC-01/02/03/04/05/06/07/08/09/10/11/12/14` from scratch, since none of their target assets differ in substance from round 4's own re-confirmed state.
- **Environment/tooling note (not a finding):** this run's content hashes for every required source (contract, registry, orchestrator, every selected brief, both schemas, `.sdd/stages/security.md`, `.claude/agents/security-checker.md`) all matched round 4's recorded hashes exactly — zero discrepancy, none of these definitional files changed across the rebase.
- `node scripts/check-red-integrity.mjs`'s 5 reported violations are a proven CRLF-only working-tree artifact (§4), not a content change.
- `test:sdd-completeness` (57/58) and `test:dependency-install` (2 known failures) independently re-run and re-confirmed non-attributable (§5).
- The ancestry caveat in §2: strict `git merge-base --is-ancestor` fails for the chosen baseline due to the intervening rebase, substituted with direct content-equivalence verification. Documented rather than silently worked around.
- The remaining ~36 non-security-relevant steps of the `node` CI job's 45 (frontend build/lint, non-security test suites) were not individually re-executed by this stage; this stage focused on the security-relevant subset plus the two already-known, already-explained non-attributable failures, consistent with tester's own full local reproduction.

## 10. Cleanup

- No source file was written, edited, or deleted during this run (read-only with respect to source code). All command output was read via `Bash`/`Read` only.
- Test runs against real Postgres used each suite's own before/after lifecycle (`rls_acceptance.tester.test.ts` and `ephemeralMcpCredentials.rls.test.ts` each create and truncate/tear down their own throwaway database or rows via their own hooks). This run additionally dropped the five named throwaway RLS databases both *before* testing (per this round's own briefing, to force a fresh migration run) and *after* testing (to leave the shared container in a clean, reusable state for the next lane) — via a scratchpad-only Node helper script, logged at creation, deleted after use. `ch03_chat_rls_test` was never touched, listed, or queried.
- A local-dev Postgres credential (the already-running `sayre-postgres` container's own `POSTGRES_PASSWORD`, read via `docker inspect`) was used to construct `DATABASE_ADMIN_URL` for the test invocations above; it was written only into two scratchpad-directory Node helper scripts' own in-memory variables and a spawned child process's environment; never printed to this run's own terminal output, never echoed to a persistent log, and not reproduced anywhere in this report or its sibling artifacts.
- Four scratchpad-only Node helper scripts (to resolve `DATABASE_ADMIN_URL` without ever printing it, to drop the throwaway databases, and to invoke `DATABASE_ADMIN_URL`-gated npm/vitest scripts) were created under this session's own scratchpad directory. None of these paths resolves inside the repository checkout; nothing under the repository was created, modified, or left behind by them. `git status --porcelain` was empty at both the start and end of this run (checked directly, not merely assumed).

## 11. Recheck scope for the next run

Unchanged from rounds 1–4's own stated scope: if `MCPT-02`'s timing finding is remediated in `mcpKeyService.ts`, the next run should rerun `MCPT-02`'s full evidence list (including an empirical timing measurement this time) plus `EC-3`/`EC-4`/`EC-5`/`EC-6`/`EC-7`/`EC-8` in `mcpCredentialResolution.test.ts` and `AC-3`/`EC-1` in `ephemeralMcpGateway.test.ts`. No new recheck scope is opened by this round's own delta — CH-01's own files are fully re-verified byte-identical to round 4 above (except the six mechanical renumber/pin files, all individually judged legitimate), and the rebase's own new evidence (`SC-13 v3`, `SEC-01 v4`, `MCPT-09 v4`) is all affirmatively PASS.
