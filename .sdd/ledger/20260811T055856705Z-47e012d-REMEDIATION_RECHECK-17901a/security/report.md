# Security Audit Report — CH-01 (Ephemeral scoped MCP credentials for first-party chat) — REMEDIATION_RECHECK

Run ID: 20260811T055856705Z-47e012d-REMEDIATION_RECHECK-17901a
Mode: REMEDIATION_RECHECK
This is round 4 of a `/re-gate` — the first round after a rebase.

## 1. Verdict

**PASS**

## 2. Target and baseline

- Repository: projsayre/sayre (https://github.com/ProjSayre/Sayre.git)
- Working path: (git worktree) agent-a7c6f9616bdc59002
- Commit: `47e012d01a2d878bbfd33a365dd0b76ec343fac6`, branch `ticket/ch-01-ephemeral-mcp-credentials`, clean (`git status --porcelain` empty).
- Environment: local-dev worktree; docker-compose services already running locally (`sayre-postgres` `pgvector/pgvector:pg16`, `sayre-redis`, `sayre-neo4j`, `sayre-localstack`, `sayre-prometheus`) on localhost — not shared, not production. `sayre-postgres` confirmed identical (`pgvector/pgvector:pg16`) to CI's pinned image.
- `.pipeline/review.json` verdict: **PASS**, `stamp.treeHash` `be6a64ec…`, `headSha` `47e012d0…`, `dirty: false`. Re-verified fresh via `node scripts/check-stamp-freshness.mjs review.json`: exit 0, status `"fresh"`, before doing any work below. (`spec.json`/`red.json` stamps read `STALE` — expected consequence of the rebase, and per `.sdd/stages/security.md`'s "Staleness of required inputs" section only `review.json` is a refuse-on-stale input; `spec.md`/`red.md` content was always advisory. `changes.json` reads fresh.)
- Baseline: `20260811T050503262Z-01bfb6e-REMEDIATION_RECHECK-3cdf99` (round 3's PASS), explicitly named by the calling agent as this round's prior run.

**What actually happened between round 3 and round 4 (re-derived directly, not taken from the brief).** The branch was rebased: `git rebase --onto origin/main ee496aa` moved the base from `ee496aa` to `90a1dca` (two unrelated merges: `feat/w1-05-ingestion-delta-worker-core`, `feat/pipeline-gapfill-cost-controls`), re-authoring all three CH-01 commits (feat `9cf76a4`→`a45240c`, fix `7034dca`→`7a349cd`, chore `65e2ad8`→`47e012d`). `git merge-base --is-ancestor 01bfb6e HEAD` **fails** — round 3's target is not a literal ancestor of this round's HEAD.

**Content equivalence verified directly, in two independent steps, as the substitute for the failed ancestry check:**

1. `git diff --name-status 01bfb6e 65e2ad8 -- . ":(exclude).sdd/ledger/**"` (round 3's own audited commit vs. the pre-rebase HEAD it was squashed/ledger-committed into) is **empty** — `65e2ad8` is content-identical to round 3's own audited state.
2. Restricting `git diff --name-status 65e2ad8 HEAD` to all 25 of CH-01's declared paths (19 in `changes.json.filesChanged` plus `red.json`'s 6 non-declared-change test files) returns **only** the two files main also touched:
   ```
   M	.github/workflows/ci.yml
   M	docs/wave0-foundation-contracts.md
   ```
   `git diff 90a1dca..HEAD` on each of those two shows **only** CH-01's own added hunk (the `core — RLS isolation tests (ephemeral MCP credentials)` CI step; the one `docs/wave0-foundation-contracts.md` paragraph) — proof that main's own content survived intact and CH-01's own content survived intact, on both files, with zero semantic loss on either side.

No CH-01-declared file differs in substance between round 3's audited state and this round's target. Comparable per `audit-contract.md` §2 order item 1 (human-specified compatible run), with git-ancestry substituted by direct content-equivalence for the reason given. Registry/contract/orchestrator/brief content hashes re-hashed this run: identical to round 3's, **including** `.sdd/stages/security.md` and `.claude/agents/security-checker.md` — both of which round 2→round 3 found subject to a benign CRLF/LF working-tree artifact; this round's worktree copies of both hash to the same LF/committed-blob value round 3 recorded, with no discrepancy to investigate this time.

## 3. What changed since the baseline PASS — the rebase itself is the attack surface

No CH-01 source file changed. This round's actual work was verifying that **nothing main's own delta carried in silently weakened a control CH-01 depends on**, and that the rebase mechanics themselves didn't corrupt anything.

### 3.1 `scripts/check-secret-access.mjs` (main edited the shared secret-access guard)

`git diff ee496aa..90a1dca -- scripts/check-secret-access.mjs` is a single hunk that **only adds** one `ALLOWLIST` entry, `services/workers/tests/test_cross_runtime_roundtrip.py`, plus its justifying comment — no detection rule, regex, or extension filter moved. Read the newly-allowlisted file directly (`services/workers/tests/test_cross_runtime_roundtrip.py:70-171`): its `dict(os.environ)` read is for a cross-runtime test harness that must hand a spawned Node subprocess the parent's full environment — inexpressible through a per-name config loader. Of the two directly-read env names it actually asserts non-empty (`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`), both are set earlier in the same file by the `_localstack_config` pytest fixture to a fixed LocalStack dummy value (`"localstack-test"`) — never a value sourced from a real secret store — while the three genuinely config-backed names (`SQS_ENDPOINT_URL`, `SNS_ENDPOINT_URL`, `AWS_REGION`) already route through `get_config()`. Same shape of exemption as the one pre-existing entry (`scripts/guard-checker-readonly.test.mjs`), not a new class of hole. CH-01's own branch touches nothing under `scripts/` (`git diff --name-only 90a1dca..HEAD -- scripts/` empty). Re-ran `npm run check:secret-access` (exit 0) and `npm run check:org-secret-access` (exit 0) against the current tree. **New observation SEC-01 v3, PASS.**

### 3.2 Migration sequencing across the rebase

Main's own `_journal.json` at `90a1dca` tops out at `idx: 18` (`0018_ticket_cache_inferred_reference`, 19 entries) — **main added no migration**. HEAD's journal appends exactly `idx: 19` / `0019_ch01_ephemeral_mcp_credentials`, 20 entries total. `git ls-tree -r --name-only HEAD -- services/core/drizzle` is a contiguous `0000`–`0019` with no duplicate index or renumbering. Because main added zero migrations, there was no `idx: 19` collision to resolve. Independently ran `npm --prefix services/core run test:rls:acceptance:ci` against a database freshly migrated from all 20 committed migrations: **64/64 pass**, including `[AC-12/edge] running migrate() a second time is a no-op` — affirmative, dynamic confirmation the sequence applies cleanly end to end. **New observation SC-13 v2, PASS.**

### 3.3 AC-11 protected surfaces, re-confirmed on the new base

`git diff --name-only 90a1dca..HEAD -- services/core/src/mcp/handlers services/core/src/graph-query/permissions.ts services/core/src/mcp/gateway.ts services/core/src/auth/context.ts` → **empty**. Independently, `ch01UnmodifiedSurfaces.test.ts` — a per-file LF-normalized SHA-256 content-hash pin, not merely a git diff — re-ran clean: **2/2**. Two independent mechanisms agree the four protected surfaces are untouched. (Existing `rbac-boundary` observation, UNCHANGED.)

### 3.4 Metering/rate-limit isolation from main's BullMQ/webhook changes

Main's delta (pulled in by this rebase) extended `services/core/src/queue/bullmq.ts` (lane/priority topology) and webhook normalization (`normalizeGithubEvent{,.test}.ts`, `githubWebhookService.test.ts`, `routes/githubWebhook.fixtures.test.ts`). CH-01's branch touches **none** of those files (`git diff --name-only 90a1dca..HEAD` confirms). Read `services/core/src/mcp/toolExecution.ts`'s full import list directly: it imports only from `./metrics` and `./rateLimit` — zero import of, or from, anything under `services/core/src/queue/`. `credential.meteringSubject` (`mcp_live_<prefix>` or `chat:<userId>`) is passed only to the MCP-specific `mcpRateLimiter`/`recordMcpToolMeasurement`, never a BullMQ lane/job key — there is no shared namespace for main's queue change to collide with. `toolExecution.ts`/`metrics.ts` are independently confirmed byte-identical to round 3 (`git diff --stat 01bfb6e..HEAD` on both: no output). **New observation MCPT-09 v3, PASS.**

### 3.5 Everything else: byte-identical to round 3, re-run fresh

`git diff --stat 01bfb6e9f6a9583b1c7d3ac9b684bcadfcdaed6f HEAD` on every CH-01 production/test source file (`mcpKeyService.ts`, `ephemeralMcpCredentialService.ts`, `ephemeralMcpCredentialStore.ts`, `mcpKeyStore.ts`, `toolExecution.ts`, `metrics.ts`, `gateway.ts`, migration `0019`, and all 7 red-listed test files) returns **no output** on every one. Re-ran dynamically against real Postgres this round:

| Suite | Result |
|---|---|
| `test:rls:ephemeral:ci` | 7/7 |
| `test:rls:acceptance:ci` | 64/64 |
| `test:rls:ci` | 19/19 |
| `tenantIsolation.penetration.test.ts` (`DATABASE_ADMIN_URL` set) | 17/17 |
| 8 CH-01-specific vitest files | 50/50 |
| `npx tsc --noEmit` (`services/core/tsconfig.json`) | exit 0 |
| `npx tsc --noEmit` (`test/mcp-interop/tsconfig.json`) | exit 0 |

Identical counts to round 3.

## 4. Re-derived the CRLF line-ending artifact independently

`node scripts/check-red-integrity.mjs` reports **6 violations, 1 note**. For each of the 6 non-declared red files, independently computed SHA-256 of (a) raw worktree bytes — differs from `red.json`'s recorded hash; (b) the same content with `\r\n` normalized to `\n` — **matches** `red.json`'s recorded hash exactly; (c) `git show HEAD:<path>` — **also matches** exactly:

| File | raw vs. recorded | LF-normalized vs. recorded | `git show HEAD:` vs. recorded | CRLF pairs |
|---|---|---|---|---|
| `ephemeralMcpCredentialService.test.ts` | differ | MATCH | MATCH | 632 |
| `mcpCredentialResolution.test.ts` | differ | MATCH | MATCH | 399 |
| `mcpKeyStoreKind.test.ts` | differ | MATCH | MATCH | 160 |
| `ephemeralMcpGateway.test.ts` | differ | MATCH | MATCH | 321 |
| `ephemeralMcpCredentialMigration.test.ts` | differ | MATCH | MATCH | 127 |
| `ch01UnmodifiedSurfaces.test.ts` | differ | MATCH | MATCH | 84 |

`core.autocrlf=true` smudges this Windows worktree to CRLF; committed blobs and `red.json`'s hashes are LF. **Not a content change.** `core.autocrlf` was not changed by this run, per the calling brief's explicit instruction.

The 7th file, `ephemeralMcpCredentials.rls.test.ts`, is the one genuinely, declaredly changed file: its pre-change blob (`079ad62`) independently hashes to exactly `red.json`'s recorded value (`e8605b7f…`), confirming that commit is what `red` hashed. `git diff 079ad62 HEAD` on it is three hunks: a header comment, `-import { getSecret }` → `+import { getConfig, getSecret }`, and `-const TEST_DB_NAME = process.env.CH01_TEST_DB_NAME ?? "..."` → `+const TEST_DB_NAME = getConfig("CH01_TEST_DB_NAME")`. No assertion, test case, or fixture touched. `packages/config/src/config.ts:16,84` registers `CH01_TEST_DB_NAME` in `CONFIG_NAMES`/`DEFAULTS` beside `RLS_TEST_DB_NAME`, same pattern, same default, same override behavior. Legitimate, declared, `changes.json`-registered fix for CI's `check:secret-access` gate rejecting a direct `process.env` read outside the central loader. Re-ran against real Postgres: **7/7**.

## 5. Two known-failing CI steps, independently re-confirmed non-attributable

- **`test:sdd-completeness`** — ran it: **57/58, 1 failure.** The failing test's `actual` value is this worktree's CRLF copy of `.sdd/runtimes.yml` (confirmed via direct inspection: 0 CRLF pairs / 159 bare LF in `git show HEAD:.sdd/runtimes.yml`, and the failing regex `/\n  pr-review:\n\s+neutral: stages\/pr-review\.md/` **matches** that committed blob directly when tested against it). `git diff --name-only 90a1dca..HEAD -- .sdd/runtimes.yml` is **empty** — this branch does not touch that file at all. Not attributable to CH-01.
- **`test:dependency-install`** — ran it: 2 known failures, both Windows-host artifacts (`spawnSync('npm', …)` returning `actual: null` rather than an exit code without `shell: true`; `poetry env use python3.12` failing to resolve `/c/Users/splat/.local/bin/python3.12` on this Windows path). Neither is a security boundary; CI runs on Ubuntu and does not hit either.

## 6. Counts

| Result | Count |
|---|---|
| PASS | 25 |
| NOT_APPLICABLE | 22 |
| UNVERIFIED | 4 |
| FAIL | 1 |

| Result transition | Count |
|---|---|
| UNCHANGED | 49 |
| FIRST_OBSERVATION | 3 |

| Coverage transition | Count |
|---|---|
| UNCHANGED | 49 |
| NOT_COMPARABLE | 3 |

Finding statuses: OPEN — 1 (unchanged from rounds 1–3). Surface readiness: IMPLEMENTED — 14/14 (unchanged). Readiness transitions: UNCHANGED — 14/14.

**52 observations total this run** (49 comparable to round 3's own 49, all UNCHANGED, plus 3 newly added observations targeting this round's own rebase-specific evidence: SEC-01 v3, SC-13 v2, MCPT-09 v3, all FIRST_OBSERVATION since no prior run ever evaluated those specific target assets).

## 7. Progress since the baseline PASS

- **Regressed:** none.
- **New CRITICAL/HIGH findings:** none.
- **Persisting finding:** `MCPT-02` (`FND-c8951999637a`), MEDIUM, OPEN, unchanged for the fourth consecutive round. `mcpKeyService.ts` (the file the finding lives in) has a zero-line diff since round 3 — re-confirmed directly this run — and the sibling-path assertions (`mcpCredentialResolution.test.ts` 12/12, `ephemeralMcpGateway.test.ts` 3/3) re-ran with identical results. Non-blocking per this stage's mandatory-gate rule (MEDIUM, not tenant-isolation/RBAC, not CRITICAL/HIGH, not a regression).
- **Changed:** none this round.
- **First observation this round:** `SEC-01 v3` (main's `check-secret-access.mjs` ALLOWLIST widening — legitimate, not a hole), `SC-13 v2` (migration sequencing across the rebase — no collision, contiguous, main added no migration), `MCPT-09 v3` (CH-01's metering-subject bucket key shares no module/namespace with main's extended BullMQ lane topology). All three PASS.
- **Resolved:** none this round.
- **Risk-accepted:** none.

## 8. Verified clean (affirmatively tested and passed this run)

All against real Postgres (`sayre-postgres`, already running, healthy, confirmed identical image to CI's `pgvector/pgvector:pg16`), independently run this session, password never printed (constructed via `docker inspect sayre-postgres` into a scratchpad-only file and a spawned child process's environment):

- `npm --prefix services/core run test:rls:ephemeral:ci`: **7/7**.
- `npm --prefix services/core run test:rls:acceptance:ci`: **64/64**, including `[AC-12/edge]`'s idempotent-migrate assertion.
- `npm --prefix services/core run test:rls:ci`: **19/19**.
- `npx vitest run src/security/tenantIsolation.penetration.test.ts` (`DATABASE_ADMIN_URL` set): **17/17**.
- All 8 CH-01-specific vitest files: **50/50**, identical per-file counts to every prior round.
- `npx tsc --noEmit` on both `services/core/tsconfig.json` and `test/mcp-interop/tsconfig.json`: exit 0.
- `npm run check:secret-access`: exit 0. `npm run check:org-secret-access`: exit 0.
- `npm run check:security-audit-agents`: "8 surface briefs, 108 unique checks, 2 schemas."
- `npm run check:agent-shims`: 8 shims up to date. `npm run check:agent-ignore`: up to date. `npm run check:ledger-index`: 453 files / 16 runs, up to date.
- `node scripts/check-stamp-freshness.mjs review.json`: exit 0, "fresh."
- `git diff --name-status 65e2ad8 HEAD` restricted to all 25 CH-01-declared paths: only the two main-shared files, both confirmed additive-only for CH-01's own content.
- `git diff --stat 01bfb6e..HEAD` on every CH-01 production source file and every red-listed test file: zero-line diff on every one.
- Direct read of `services/core/drizzle/meta/_journal.json` at both `90a1dca` and `HEAD`: contiguous `idx: 0`–`idx: 19`, one new entry, no collision.
- `git diff ee496aa..90a1dca -- scripts/check-secret-access.mjs`: single additive hunk; direct read of the newly-allowlisted Python test file confirming a legitimate LocalStack-dummy-credential exemption.

## 9. Limitations

- `MCPT-06`/`MCPT-07` (gateway lifecycle/JSON-RPC fuzzing) remain UNVERIFIED, unchanged — `gateway.ts` is still untouched and still not independently fuzzed by any run in this worktree.
- `MCPT-02`'s timing dimension remains STATIC-only — no empirical wall-clock latency sampling was performed this run either.
- `SEC-10`/`SEC-14` (audit-log tamper-evidence / alerting) remain UNVERIFIED, unchanged — pre-existing, non-CH-01 gaps this round does not touch.
- `llm-rag`, `model-provider`, `websocket-realtime`, `ingestion-queue-webhook`, and `web-api-client` briefs were not selected this run either — CH-01's own branch has zero target asset in any of those surfaces. Main's own webhook-normalization and BullMQ-lane changes, pulled in by this round's rebase, are out of scope for this ticket-specific `REMEDIATION_RECHECK`; their interaction with CH-01's own metering path was checked directly (§3.4 / `MCPT-09 v3`, PASS) rather than auditing main's own changes on their own terms, which is `MILESTONE`/`FULL` scope.
- The `supply-chain-infrastructure` checklist (`SC-01`..`SC-14`) is carried forward from round 2's full execution; this round adds one fresh `SC-13` observation (migration sequencing across the rebase) but does not re-derive the other 13 from scratch, since none of their target assets differ from round 3's own re-confirmed state (`git diff --name-only 90a1dca..HEAD -- "**/package.json" "**/package-lock.json" "**/pyproject.toml" "**/poetry.lock" Dockerfile* infra/ .github/` returns only `ci.yml`, already audited, and `services/core/package.json`, confirmed two additive script entries with no dependency change).
- **Environment/tooling note (not a finding):** this run's content hashes for `.sdd/stages/security.md` and `.claude/agents/security-checker.md` both matched round 3's recorded hashes exactly — no CRLF discrepancy to investigate this time (unlike round 2→round 3's one-file artifact for the same file).
- `node scripts/check-red-integrity.mjs`'s 6 reported violations are a proven CRLF-only working-tree artifact (§4), not a content change.
- `test:sdd-completeness` (57/58) and `test:dependency-install` (2 known failures) independently re-run and re-confirmed non-attributable (§5).
- The ancestry caveat in §2: strict `git merge-base --is-ancestor` fails for the chosen baseline due to the intervening rebase, substituted with direct content-equivalence verification. Documented rather than silently worked around.

## 10. Cleanup

- No source file was written, edited, or deleted during this run (read-only with respect to source code). All command output was read via `Bash`/`Read` only.
- Test runs against real Postgres used each suite's own before/after lifecycle (`rls_acceptance.tester.test.ts` and `ephemeralMcpCredentials.rls.test.ts` each create and drop/truncate their own throwaway database or rows via their own hooks) — no additional fixture was created by this audit beyond those suite-owned lifecycles, and none was left behind (`git status --porcelain` empty at both the start and end of this run).
- A local-dev Postgres credential (the already-running `sayre-postgres` container's own `POSTGRES_PASSWORD`, read via `docker inspect`) was used to construct `DATABASE_ADMIN_URL` for the test invocations above; it was written only to a scratchpad-directory file outside the repository (`C:\Users\splat\AppData\Local\Temp\claude\C--Users-splat-OneDrive-Desktop-Sayre\9ee96397-6621-4edd-b707-4b0b934e3747\scratchpad\pgpw.txt`) and to a spawned child process's environment; never printed to this run's own terminal output, never echoed to a persistent log, and not reproduced anywhere in this report or its sibling artifacts.
- Two small Node runner scripts (to invoke `DATABASE_ADMIN_URL`-gated npm scripts without ever printing the password) were created under this session's own scratchpad directory. None of these paths resolves inside the repository checkout; nothing under the repository was created, modified, or left behind by them.

## 11. Recheck scope for the next run

Unchanged from rounds 1–3's own stated scope: if `MCPT-02`'s timing finding is remediated in `mcpKeyService.ts`, the next run should rerun `MCPT-02`'s full evidence list (including an empirical timing measurement this time) plus `EC-3`/`EC-4`/`EC-5`/`EC-6`/`EC-7`/`EC-8` in `mcpCredentialResolution.test.ts` and `AC-3`/`EC-1` in `ephemeralMcpGateway.test.ts`. No new recheck scope is opened by this round's own delta — CH-01's own files are fully re-verified byte-identical to round 3 above, and the rebase's own new evidence (`SEC-01 v3`, `SC-13 v2`, `MCPT-09 v3`) is all affirmatively PASS.
