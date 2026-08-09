# Security Audit Report — PL-15 (Repo restructure) — REMEDIATION_RECHECK

Run `20260809T120125162Z-17e2299ac5f2-REMEDIATION_RECHECK-0f908e` · Mode `REMEDIATION_RECHECK` · Verdict **PASS**

## 1. Target and environment

- **Repository:** `projsayre/sayre`
- **Commit:** `17e2299ac5f2025be0cd149c6e30e8a2a0c172f2`, branch `refactor/repo-restructure`, worktree dirty (139 staged paths, unchanged in count since this stage's prior run — only content within four already-tracked paths changed)
- **Environment:** local development checkout — static analysis plus local test/validator suites only; no live/staging/production target
- **Gate input:** `.pipeline/review.json` **pass 3**, verdict `PASS`, stamped `treeHash 0f19b81e1b1d…`; independently re-verified fresh this run via `node scripts/check-stamp-freshness.mjs review.json` → exit 0, `"fresh"`.

## 2. Provenance — read this first

Since this stage's own prior `BLOCKED` run (`20260809T104534944Z-17e2299ac5f2-PR_DELTA-b175a8`): dev ran two fix rounds (masked-prefix redaction, then a full zero-character-placeholder redaction after the coordinator ruled the mask still carried real fragments). Review pass 2 (`NEEDS_FIXES`) then found the *same reconnaissance class* surviving in two locations the value-fragment sweep structurally cannot see — the audit index's §P0-5 exact line-to-secret table, and `audit-18`'s two exact `:23` line citations — plus a false completeness claim in the round-2 amendment record. The three-attempt `dev` loop cap was exhausted, so per `.sdd/pipeline.md`'s `/re-gate` section the **coordinator hand-applied review's five-item fix list directly** (`changes.md`'s "Coordinator hand-fix round" section is the record, honestly labeled `[coordinator hand-fix under /re-gate]` in `changes.json`). Review pass 3 re-derived every item against disk — not the hand-fix's own self-report — and returned `PASS`, explicitly naming this stage's independent recheck as the compensating control for implementer and coordinator being one context this round.

This recheck does the same: every claim below was independently re-derived from the current file content and re-run tooling, not accepted from review pass 3's or the hand-fix's account.

## 3. Baseline

**Baseline run:** this stage's own prior run, `20260809T104534944Z-17e2299ac5f2-PR_DELTA-b175a8` (`BLOCKED`) — same commit, same 139-path diff family; only `docs/audits/deep-audit-2026-07-31.md`, `audit-18-infra-cicd.md`, `.pipeline/spec.md`, and `scripts/repo-structure.test.mjs` changed content since (confirmed via `git diff HEAD --name-only`, still 139 paths, and via review pass 3's own numstat comparison, independently spot-checked this session).

## 4. Counts

**By result:** PASS 15 · FAIL 6 · UNVERIFIED 5 · NOT_APPLICABLE 13 (39 observations — the 38 from the prior run, re-evaluated, plus one new SEC-02 v3 dispositioning the MD5 residual).

**By result transition:** UNCHANGED 35 · **RESOLVED 3** (CORE-03, SEC-02 v1, SEC-02 v2) · FIRST_OBSERVATION 1 (SEC-02 v3, new this round).

**By finding status:** RESOLVED 3 · OPEN 6 (the six persisting findings, unaffected by the hand-fix round).

**By coverage transition:** UNCHANGED 38 · NOT_COMPARABLE 1 (the new SEC-02 v3 row).

## 5. Per-finding resolution

### 5.1 CORE-03 / SEC-02 v1 — RESOLVED

**Prior finding:** `docs/audits/deep-audit-2026-07-31/audit-18-infra-cicd.md:142` embedded the live, unredacted, real value of `NEO4J_AUTH` verbatim (CRITICAL).

**Independently reproduced this round:** line 142 now reads `NEO4J_AUTH=<redacted>` — zero characters of the real value remain, confirmed by direct read. Line 139's file-reference line no longer cites an exact line number for the credential (previously `infra/New Text Document.txt:23`); only the byte size remains. A "PL-15 redaction note (round 3)" at lines 144-151 records the redaction history in-file rather than silently. A full repo-wide grep for the nine specific masked-prefix fragment strings this stage's own first pass read pre-redaction (`sk-ant-api03`, `sk-proj-S5Gn`, `1911e9`, `81edd2`, `ATOAvQ`, `gyBmvR`, `61549a`, `9f8e7d`, `CC@101`) and for any `New Text Document\.txt:[0-9]` / `\.env:[0-9]` location citation returns zero hits anywhere in `docs/audits/**`. `node --test scripts/repo-structure.test.mjs` (34/34) and `node scripts/check-red-integrity.mjs` (clean) independently re-run this session confirm the file's `AC-9` digest pin matches its current, redacted content.

**Verdict:** RESOLVED. Finding `FND-6b13544adb41` (CORE-03) / `FND-77eaa803b917` (SEC-02 v1) status updated to `RESOLVED`, first-seen preserved, last-seen this run.

### 5.2 SEC-02 v2 — RESOLVED

**Prior finding:** `docs/audits/deep-audit-2026-07-31/audit-15-secrets-deps.md:26-48` documented a masked-but-confirmed-live inventory of 12 further secrets with exact line locations and per-row "REAL" tags (HIGH).

**Independently reproduced this round, across three locations (not just the one this stage's prior pass named):**
- `audit-15-secrets-deps.md`'s C-1 table (now lines 35-49) is `| Secret | Category |` — names and generic categories only, no Line/Real?/Masked columns. A "PL-15 redaction note (round 3, final)" records what was removed and why.
- The audit **index**'s §P0-5 (`deep-audit-2026-07-31.md:89-113`), which review pass 2 caught independently of this stage's own prior pass, previously carried a `| Line | Secret |` table mapping exact `infra/New Text Document.txt` line numbers to all 13 secrets. It is now a single-column `| Secret |` table with an honest removal note.
- `architecture-assessment-2026-07.md:139-142` carries its own redaction note pointing at audit-15's generalized inventory rather than repeating detail.

A fresh grep for `Real\?|Masked|Line \|` across all 20 files returns only benign hits (the verdict heading "ARE THERE REAL SECRETS" and the redaction notes' own prose describing what used to be present). The two documented non-secret exemptions (`audit-15:92`'s methodology pattern list; `audit-15:94`'s literal fake fixture `'sk-proj-secret-looking-value'`) independently read and confirmed genuinely benign.

**Verdict:** RESOLVED. Finding `FND-ef8585eb74bf` status updated to `RESOLVED`, first-seen preserved, last-seen this run.

### 5.3 SEC-02 v3 (new) — MD5 file-identity-hash disposition: **ACCEPT, non-blocking**

Per the coordinator's explicit instruction and review's standing Warning 1, dispositioned explicitly rather than by silence:

- `docs/audits/deep-audit-2026-07-31/audit-14-dead-code-hygiene.md:103-104` renders the **full** 32-character MD5 (`120176f8745e0b1706e2b0fd67aded8c`) of both `infra/.env` and `infra/New Text Document.txt`, twice. `audit-15-secrets-deps.md:16` independently renders the **same** hash truncated to 8 characters plus an ellipsis. Both confirmed present by direct read this session; neither was touched by any redaction round (`audit-14` is outside the `AC-9` redaction set — its own byte-pin is unchanged and the passing suite proves it).
- **Reasoning:** MD5 is a one-way hash — no feasible method exists to reconstruct ~5590 bytes of arbitrary file content from a 32-character digest. This is categorically different from 5.1/5.2 (real characters, or an exact value-to-location map). The marginal reconnaissance value is narrow and second-order: useful only to an attacker who has *already* independently obtained a candidate copy of the file and wants to confirm authenticity without reading its content — at which point they would already see the plaintext variable names directly, making the hash close to redundant for that purpose. The hash also has genuine, disclosed defensive value: it lets a future audit (including a future run of this very stage) confirm, without re-deriving this finding, whether the flagged file has since been rotated (an unchanged MD5, independently reproduced by this stage in both the prior run and this one, currently means it has not).
- **Disposition: ACCEPT, both occurrences, non-blocking.** Recorded as its own observation (SEC-02 v3) specifically so this is not a silent pass.

## 6. Persisting findings — re-confirmed unaffected

| Finding | Check | Severity | Status | Re-confirmation this round |
|---|---|---|---|---|
| `FND-b1187a8efdf6` | SEC-01 v2 | MEDIUM | OPEN | `scripts/check-secret-access.mjs` / `scripts/guard-checker-readonly.test.mjs` absent from every change since the prior run. |
| `FND-3043428c5bd1` | SEC-09 | LOW | OPEN | `scripts/ledger-append.mjs` absent from every change since the prior run. |
| `FND-9ea3ec4bba13` | SEC-10 v3 | MEDIUM | OPEN | `scripts/ledger-append.mjs` unchanged. |
| `FND-9735a2fbe37a` | SEC-10 v6 | MEDIUM | OPEN | `scripts/check-lite-eligible.mjs` / `.sdd/bounds.yml` unchanged. |
| `FND-d26b84ebd646` | SC-03 | MEDIUM | OPEN | `.github/workflows/ci.yml` unaffected by the hand-fix round; still no scan step. |
| `FND-ef0066ad43ed` | SC-06 | LOW | OPEN | `ci.yml`'s `uses:` lines unaffected by the hand-fix round. |

None of these six files appear anywhere in the narrow diff between this stage's prior run and this one (`docs/audits/deep-audit-2026-07-31.md`, `audit-18-infra-cicd.md`, `.pipeline/spec.md`, `scripts/repo-structure.test.mjs` only) — independently confirmed via `git diff HEAD --name-only`, still exactly 139 paths.

## 7. Mechanical re-verification (this stage's own runs, not taken from review/tester)

- `node scripts/check-stamp-freshness.mjs review.json` → exit 0, `"fresh"`, stamp `treeHash 0f19b81e1b1d…` (pass 3).
- `node scripts/check-red-integrity.mjs` → clean, 0 violations. `scripts/repo-structure.test.mjs`'s hash is `1393b572…` this round (fourth value across the run's history), correctly declared in `changes.json`.
- `node --test scripts/repo-structure.test.mjs` → **34/34**.
- Independently recomputed all four `MOVED_FILE_DIGESTS` entries this test pins for the redacted/moved audit docs (`contentDigest()`'s own CRLF-normalized-UTF8-or-raw-bytes scheme): `deep-audit-2026-07-31.md` → `42ff7568…` MATCH; `audit-18-infra-cicd.md` → `373e20bb…` MATCH; `audit-15-secrets-deps.md` → `d1338290…` MATCH (correctly untouched this round); `architecture-assessment-2026-07.md` → `a9c43a63…` MATCH (correctly untouched this round).
- `npm run check:secret-access`, `check:org-secret-access`, `check:agent-shims`, `check:agent-ignore`, `typecheck:scripts` — all re-run this session, all clean, unchanged from the prior run.
- Read `.pipeline/spec.md`'s AC-9 "AMENDMENT ROUND 3" text directly: names round 2's false claim verbatim, states what actually survived, states what was done — matches disk exactly. Read `changes.json`'s `redTestChanges` item (5) directly: accurate, matches disk exactly.
- `git status --ignored=matching -- infra/` → `infra/New Text Document.txt` still reports `!!` (still gitignored, still present, still untouched, still outside this diff).

## 8. Restated for the record: human actions outside this diff's scope

`infra/New Text Document.txt` (and its twin `infra/.env`) remain on disk, untouched, correctly gitignored, and outside this diff — confirmed again this session. **Deleting this file and rotating all 13 secrets it contains (`NEO4J_AUTH`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_WEBHOOK_SECRET`, `JIRA_OAUTH_CLIENT_SECRET`, `JIRA_TOKEN_ENC_KEY`, `JWT_SIGNING_KEY`, `MCP_TOKEN_PEPPER`, `POSTGRES_PASSWORD`, `DATABASE_ADMIN_URL`/`DATABASE_RUNTIME_URL` credentials) remain the human operator's own urgent actions and are not, and cannot be, satisfied by anything in this diff or this pipeline run.** Per the coordinator's message, this has already been escalated to the human directly; restated here so the immutable record carries it regardless.

## 9. Verified clean

Same set as the prior run, all re-confirmed this session: no risky CI trigger/permission surface, no install-lifecycle script in any changed manifest, `.sdd/bounds.yml` byte-identical to HEAD, lockfile diff still pure workspace re-shaping. `apps/site` still has no server-side route/API surface (`web-api-client` re-affirmed not selected).

## 10. Limitations

Same as the prior run (CORE-01/02/04/05 UNVERIFIED by design; no live GitHub Actions run this session). Unchanged this round.

## 11. Cleanup

No throwaway fixtures created this run either — every check was a read, a `git`/`node --test`/`npm run` invocation against already-committed tooling, or a grep. Nothing created or left behind outside `.pipeline/security-history/20260809T120125162Z-17e2299ac5f2-REMEDIATION_RECHECK-0f908e/` and the mutable `.pipeline/security-report.md`/`security.json` handoff.

## 12. Verdict

**PASS.** All prior CRITICAL/HIGH findings (CORE-03, SEC-02 v1, SEC-02 v2) are RESOLVED with affirmative, independently-reproduced evidence — not accepted on review's or the hand-fix's account. The MD5 file-identity-hash residual is explicitly dispositioned as ACCEPT (non-blocking). The six persisting LOW/MEDIUM findings remain OPEN, carried forward on their own merits, and do not block per this stage's gate policy (only CRITICAL/HIGH failures, regressions, or tenant/RBAC failures block). Terminal `PASS` for this run — proceed to ledger append.
