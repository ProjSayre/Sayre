# Security Audit Report — PL-14 (wire W0-00 dependency suites; de-brittle [inline] wiring test), `/inline-edit` lane, PR_DELTA

**Run ID:** `20260809T081650273Z-951bb3dc4c0c-PR_DELTA-7d64c3`
**Verdict:** **PASS**

## 1. Target, mode, milestone, baseline

- **Repository:** `projsayre/sayre`
- **Commit:** `951bb3dc4c0ca5a0fa8a0cbbe0d97fbe3089a87f` (branch `fix/pl-04-pipeline-defects`, dirty) — PL-13's own landing commit.
- **Environment:** local development checkout — static analysis + local test/validator suites only; no live/staging/production target, no runtime penetration test.
- **Mode:** `PR_DELTA`.
- **Diff under audit:** exactly three files (`git diff HEAD`) — `package.json` (+2), `.github/workflows/ci.yml` (+10), `scripts/sdd-completeness.test.mjs` (+29/-18, one hunk).
- **Gate input:** `.pipeline/review.json` verdict `PASS`, pass 1, stamped `treeHash 3b52ffb8…` at HEAD `951bb3d`. Freshness independently re-verified: `node scripts/check-stamp-freshness.mjs review.json` → exit `0`, status `"fresh"`.
- **Baseline:** `20260809T073006612Z-010b2fe50c72-PR_DELTA-7ff0f1` (PL-13 re-run, `PASS`), commit `010b2fe50c72f0dbbc76fcf71480546e9a5c52a9`. Ancestry independently verified: `git merge-base --is-ancestor 010b2fe... 951bb3d...` → true. Same repository, same environment string, same empty `tenant_fixtures`. Comparable: **true**.

## 2. Adversarial angle 1 — CI-surface change (two new workflow steps)

**Question:** do the two new steps (`Dependency baseline — tests`, `Dependency install — tests`) — the second running a real `npm ci` mid-job — introduce new supply-chain or workflow-injection exposure versus the existing install step?

- **No expression interpolation.** Both `run:` lines are static literal strings (`npm run test:dependency-baseline` / `npm run test:dependency-install`) — zero `${{ }}` GitHub Actions expressions. No attacker-influenceable value (branch name, commit message, PR title, matrix value) is referenced anywhere in the new steps. Verified by direct read of the diff hunk.
- **No trigger/permission change.** `ci.yml`'s `on:`/`permissions:` blocks are untouched — still bare `push:`/`pull_request:`, no explicit `permissions:` key added or widened. The new steps run in the exact same trust/permission context as every pre-existing step in the `node` job.
- **Same lockfile, same runner, not a new trust boundary.** `dependency-install.test.mjs` (itself unmodified by this diff — only its CI wiring is new) calls `spawnSync('npm', ['ci'], { cwd: repoRoot, ... })` — array-form arguments, no `shell: true`, no untrusted-input concatenation. This is the same command, against the same committed `package-lock.json`, on the same runner, that the job's pre-existing "Install dependencies (root, single pass)" step already runs. Re-running an already-trusted command a second time later in the job is not a new execution surface.
- **No new install-lifecycle script.** `package.json`'s diff is a pure two-line insertion into `scripts` (not `dependencies`/`devDependencies`) — no `postinstall`/`prepare` hook, no floating version, `package-lock.json` itself untouched.
- **Trust model unchanged.** A PR that could inject a malicious `package.json` script already has code execution via the many `npm run` steps that already precede these two in the same job (`test:secret-access`, `test:readonly-guard`, etc.) — these two additions are two more instances of an already-accepted risk class, not a new one.

**Conclusion:** PASS across CORE-06, SEC-07/08, SC-02/04/05 (see full observations for evidence).

## 3. Adversarial angle 2 — the diff-to-content test conversion

**Question:** does moving `[inline] coverage and wiring` from `git diff --name-only HEAD` assertions to 11 content assertions weaken any security-relevant pin, especially on the control-plane files (`bounds.yml`, `check-lite-eligible.mjs`, `pipeline-contracts.mjs`)? Is the declared-but-not-mechanically-rehashable red-test change acceptable?

- **The diff-based pin provided zero regression protection in CI.** `git diff --name-only HEAD` is always empty against a clean CI checkout — the ten-path loop passed unconditionally on every CI run that ever executed it. It only ever fired against a dirty *local* tree, which is the opposite of where a regression gate should bite. The content-based replacement inspects each file's full, current text on every run — a strict widening of what actually gates in CI, traded for a narrower "must contain the literal token 'inline'" signal (the disclosed EC-9 residual).
- **Spot-checked the coordinator-named control-plane files independently.** `grep -n inline .sdd/bounds.yml scripts/check-lite-eligible.mjs scripts/pipeline-contracts.mjs .sdd/hotfix.md` → zero matches across all four. Every content assertion touching these files is currently a true, non-vacuous negative claim, not a check that would pass regardless of content.
- **Independently re-derived the red-pin rehash, not merely trusted review's account.** `node scripts/check-red-integrity.mjs --dir .sdd/ledger/20260809T015417496Z-a537e98a7c24-PR_DELTA-1bf759` (PL-12's preserved run) → exit 1, one violation: `scripts/sdd-completeness.test.mjs`'s hash changed (`3f4df8ce…` → `1b11d66b…`) and "changes.json does not declare this change." Traced why directly (`scripts/check-red-integrity.mjs:58-90`): `--dir` redirects **all three** JSON inputs (red.json, spec.json, *and* changes.json) to the given directory — so this invocation reads the ledger's **frozen** PL-12 `changes.json` (which only declares PL-12's own red-test change, `ledger-append.test.mjs`), never the **live** `.pipeline/changes.json`. Read the live file directly: its `redTestChanges` array names `scripts/sdd-completeness.test.mjs` with an accurate, substantive reason, exactly matching this diff.
- **A real, narrow tooling gap, named rather than hidden — but not a control gap.** `check-red-integrity.mjs` has no invocation that mixes an *old* red.json pin with the *current* `.pipeline/changes.json` for this specific cross-ticket scenario (a red-listed file, from one ticket, touched by a later ticket on a lane with no red.json of its own). Every available invocation still exits 1 and forces explicit human adjudication — the tool fails closed in both directions, never silently accepting an undeclared change. No exploit path was demonstrated where this ambiguity lets a real violation go unflagged; it costs a manual cross-reference step, which review performed and this run independently re-performed.

**Conclusion:** PASS (SEC-10 v13, new this run). SEC-09/SEC-10 v3/v6 (persisting, unrelated to this diff) carried forward unaffected.

## 4. Adversarial angle 3 — wiring integrity

- **No `continue-on-error`.** Confirmed by direct read of both new step blocks in the diff — neither carries `continue-on-error` or any other non-gating modifier.
- **Steps actually gate.** Both run the real test suites (`node --test scripts/dependency-{baseline,install}.test.mjs` via `npm run`), not a no-op or a substring-satisfying placeholder.
- **Placement/order preserved.** `baseline` precedes `install` in both `package.json` and `ci.yml`, matching spec EC-7.

**Conclusion:** PASS (verified directly, matches review's Adjudication 3, independently re-confirmed).

## 5. Findings — carried forward on their merits (all unaffected by this diff)

1. **SEC-01 v2** (`FND-b1187a8efdf6`, MEDIUM) — `check-secret-access.mjs` ALLOWLIST whole-file residual. Neither that file nor the exempted `guard-checker-readonly.test.mjs` is in PL-14's diff.
2. **SEC-09** (`FND-3043428c5bd1`, LOW) — no ledger actor identity. `scripts/ledger-append.mjs` untouched.
3. **SEC-10 v3** (`FND-9ea3ec4bba13`, MEDIUM) — plain-path stale spec/ticket agreement. `scripts/ledger-append.mjs` untouched.
4. **SEC-10 v6** (`FND-9735a2fbe37a`, MEDIUM) — `--lite` multiplicative size-bound residual. `scripts/check-lite-eligible.mjs`/`.sdd/bounds.yml` untouched.
5. **SC-03** (`FND-d26b84ebd646`, MEDIUM) — no CI dependency/SBOM scanning gate. PL-14 adds test-running steps, not a scanning gate.
6. **SC-06** (`FND-ef0066ad43ed`, LOW) — GitHub Actions pinned to tags, not SHAs. No `uses:` line touched.

No new, regressed, or resolved findings beyond SEC-10 v13 above (which is `PASS`, not a finding).

## 6. Verified clean

- `npm run test:sdd-completeness` → 58 tests, 57 pass, 1 fail (the pre-existing, local-only CRLF `pr-review` regex failure — independently reproduced, matches review/tester's account exactly).
- `npm run test:dependency-baseline` → 11/11 pass.
- `node scripts/check-security-audit-agents` (via `npm run check:security-audit-agents`) → registry unchanged, still valid: 8 briefs, 108 checks, 2 schemas.
- `git diff HEAD --stat -- package-lock.json` → empty (no dependency change).
- `git diff HEAD --stat -- 'services/**' 'apps/**' 'packages/**' 'infra/**'` → empty (no product code touched).
- No hardcoded/historical secret in the diff (one false-positive grep match on the word "tokens" in a comment, verified benign).

## 7. Coverage trajectory

- **Gained:** CORE-01..06, SEC-01(v1 not re-added)/02-08/11-14, and SEC-10 v13 — all `FIRST_OBSERVATION`/`NOT_COMPARABLE` against a genuinely different diff (package.json/ci.yml/sdd-completeness.test.mjs vs baseline's driver.mjs/check-secret-access.mjs). SC-01..14 also freshly re-examined this round (ci.yml/package.json actually changed, unlike the PL-13 round), though transitions are `UNCHANGED` since the same `observation_key`s were reused and conclusions didn't change.
- **Unchanged:** SEC-01 v2, SEC-09, SEC-10 v3/v6, SC-01..14 — re-verified against the current diff, same evidenced result, same `observation_key` as baseline.
- **Lost:** none.
- **Not carried:** `web-api-client` (WEB-01..12) is not selected this round — `apps/web/**` is untouched by PL-14, and the coordinator's carry-forward list did not include it.

## 8. Limitations

- CORE-01/02/04/05 remain `UNVERIFIED` for this diff's own code — no application/persistence/webhook/ingestion code touched (all three files are pipeline control-plane/CI wiring).
- No dynamic GitHub Actions run was triggered this session (`authorization.runtime_tests_authorized: false`) — the new steps were verified by reading `ci.yml` directly and by independently running the equivalent npm scripts locally, not by an actual Actions execution. `dependency-install.test.mjs`'s npm-ci test was read but not re-executed this session (the pre-existing, spec-documented Windows `spawnSync('npm')` ENOENT quirk, EC-4) — its safety was verified by code reading (array-form args, no shell) rather than by running it.
- `web-api-client`/WEB-01..12 not re-examined this round (not triggered, not on the carry-forward list).
- Out of scope, disclosed only: the two cosmetic/non-security items review's own Warning 1 and Suggestion 1 already record (CI step-name wording divergence from spec's Interfaces sketch; EC-2's remote-CI-log claim being locally unverifiable) — neither bears on this audit's verdict.

## 9. Cleanup

No fixtures created. All checks were static code reading or unmodified repository commands (`git diff`, `git merge-base`, `grep`, `npm run test:sdd-completeness`, `npm run test:dependency-baseline`, `npm run check:security-audit-agents`, `node scripts/check-stamp-freshness.mjs`, `node scripts/check-red-integrity.mjs --dir ...`). No file created, modified, or left behind outside `.pipeline/security-history/20260809T081650273Z-951bb3dc4c0c-PR_DELTA-7d64c3/` itself and the `.pipeline/security-report.md`/`.pipeline/security.json` handoff files.

## 10. Recheck scope

For the six persisting findings: unchanged from prior runs (see each observation's `remediation_reference`), all out of PL-14's own scope. For SEC-10 v13's tooling-gap note: no code fix required (the gap is a rare-scenario usability limitation in `check-red-integrity.mjs --dir`, not a control gap) — if it recurs, the correct manual procedure is exactly what review and this run both did: rehash against the old ledger's red.json via `--dir`, then separately read the live `.pipeline/changes.json`'s `redTestChanges` by hand.
