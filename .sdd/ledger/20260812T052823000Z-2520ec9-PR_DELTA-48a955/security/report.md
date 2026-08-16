# Security Audit Report — W3-04 gap-fill, fix-verification pass for FND-7c51522045f7

## Verdict: PASS

Run ID: `20260812T052823000Z-2520ec9-PR_DELTA-48a955`
Mode: `PR_DELTA` (loop-back re-run within `/pipeline-gapfill`'s own routing after `review`
re-PASSed following `dev`'s fix — staying in `PR_DELTA` per the calling agent's explicit
instruction, not switching to `REMEDIATION_RECHECK`).
Target commit: `2520ec9d9919eab2498a548efb6321a440693c0b` (branch
`feat/w3-04-git-sync-integration-worker`, dirty — the fix is uncommitted working-tree state
layered on the same pinned commit, so `target.commit_sha` is unchanged from the baseline run).
Baseline: `20260812T050037000Z-2520ec9-PR_DELTA-90de4e` (this run's own immediately-prior run on
this exact ticket/surface, explicitly named by the calling agent — audit-contract.md's baseline
order option 1). Comparable: same commit, same branch, same dirty state, same environment, same
tenant fixtures, byte-identical policy/agent hashes, identical 41-path `changed_paths` set,
identical 73-check selection.

---

## 1. Current verdict, target, mode, milestone, baseline

This run re-audits `dev`'s fix for `FND-7c51522045f7` — the one blocking finding from the prior
security run on this ticket. `dev` narrowly touched 3 files:
`services/core/src/integrations/git/providers/index.ts` (`GIT_PROVIDER_REGISTRATIONS` now built
via `Object.create(null)` + `Object.assign` + `Object.freeze`, eliminating the prototype chain),
`services/core/src/integrations/git/providerCatalog.ts` (`loadGitProviderRegistry`'s
`registrations[entry.provider]` lookup now preceded by
`Object.prototype.hasOwnProperty.call(registrations, entry.provider)`, throwing the existing
`GitProviderCatalogError` on failure), and `providerCatalog.test.ts` (10 new regression tests).
`review` independently re-PASSed. `.pipeline/review.json`'s verdict is `PASS` and its stamp is
fresh (`node scripts/check-stamp-freshness.mjs review.json` → exit `0`), so a full check ran per
`.sdd/stages/security.md`.

Per the calling agent's brief, this run did **not** trust review's account of the fix — it
independently re-attempted the exact prior attack (and every plausible bypass variant) against
the current code, checked for a second unguarded lookup path, checked whether the
`Object.create(null)` change broke any other consumer relying on inherited `.toString()`/
`.hasOwnProperty()`, and re-ran the two adjacent checks (`mockOnly` production gate,
cross-provider credential isolation) plus the two sibling checks the finding's own recheck scope
named (`WEB-07`, `ING-04`).

**Result: the fix genuinely closes the gap. No regression found. `FND-7c51522045f7` is
RESOLVED.**

## 2. Security trajectory

**New:** none. **Regressed:** none. **Persisting:** none.

**Resolved:** one — `FND-7c51522045f7` (CORE-06, `git-provider-catalog-registry-lookup`).
Independently re-attempted this session: a disposable, non-repository dynamic repro under the OS
temp root imported the real, unmodified `providerCatalog.ts`/`providers/index.ts` via their
absolute filesystem paths and called `loadGitProviderRegistry()` for all 9 candidates named in
this run's brief (`constructor`, `__proto__`, `prototype`, `toString`, `hasOwnProperty`,
`valueOf`, `isPrototypeOf`, `propertyIsEnumerable`, `toLocaleString`) plus a genuinely-unknown
control (`nope`). **Every one of the 10 cases now throws the documented `GitProviderCatalogError`**
with message `GIT_PROVIDER_CATALOG names unknown git provider "<name>".` — including
`"__proto__"`, which in the pre-fix baseline run threw a milder, undocumented raw `TypeError` (a
secondary defect this fix also closes, not previously called out as fully fixed). See Findings
below for full reproduction detail.

**Risk-accepted:** none.

## 3. Coverage trajectory

All 73 selected checks carry over from the baseline with `coverage_transition: UNCHANGED` — every
observation retains at least the evidence quality (STATIC/DYNAMIC/BOTH) it had in the baseline
run; none regressed to `UNVERIFIED`. Result counts this run: 32 `PASS` (up from 31 — the resolved
finding), 37 `NOT_APPLICABLE` (unchanged), 4 `UNVERIFIED` (unchanged — MP-08, MP-10, SEC-06,
SEC-14, all pre-existing surfaces this fix does not touch), 0 `FAIL` (down from 1). Result
transitions: 72 `UNCHANGED`, 1 `RESOLVED`.

## 4. Surface readiness changes and documentation/code drift

No readiness regressions. All 14 registered surfaces remain `IMPLEMENTED`, `readiness_transition:
UNCHANGED` against the baseline (a comparable baseline now exists, unlike the baseline run's own
`FIRST_OBSERVATION` state). No documentation/code drift: `changes.md`'s "Fixes applied" section
and `review.md`'s independent structural-soundness read both accurately describe what shipped —
confirmed directly against the current file content in this run, not merely trusted from either
account.

## 5. Findings

**None open.** `FND-7c51522045f7` moves to `RESOLVED` — see full detail below. No new finding was
discovered in this run's independent re-attempt.

### `FND-7c51522045f7` — CORE-06 / `injection-boundaries` / `git-provider-catalog-registry-lookup` — RESOLVED

- **Status:** RESOLVED. First seen: `20260812T050037000Z-2520ec9-PR_DELTA-90de4e` (commit
  `2520ec9d9919eab2498a548efb6321a440693c0b`). Last seen (this run):
  `20260812T052823000Z-2520ec9-PR_DELTA-48a955` (same commit — uncommitted fix).
- **What was independently re-attempted.**
  1. **The original bypass and every JS-reserved-property variant named in this run's brief**:
     `constructor`, `__proto__`, `prototype`, `toString`, `hasOwnProperty`, `valueOf`,
     `isPrototypeOf`, `propertyIsEnumerable`, `toLocaleString`, plus a genuine-unknown control
     (`nope`). All 10 now throw `GitProviderCatalogError` with the documented message. Full
     repro output:
     ```
     [THROWS] provider="constructor" -> GitProviderCatalogError: GIT_PROVIDER_CATALOG names unknown git provider "constructor".
     [THROWS] provider="__proto__" -> GitProviderCatalogError: GIT_PROVIDER_CATALOG names unknown git provider "__proto__".
     [THROWS] provider="prototype" -> GitProviderCatalogError: GIT_PROVIDER_CATALOG names unknown git provider "prototype".
     [THROWS] provider="toString" -> GitProviderCatalogError: GIT_PROVIDER_CATALOG names unknown git provider "toString".
     [THROWS] provider="hasOwnProperty" -> GitProviderCatalogError: GIT_PROVIDER_CATALOG names unknown git provider "hasOwnProperty".
     [THROWS] provider="valueOf" -> GitProviderCatalogError: GIT_PROVIDER_CATALOG names unknown git provider "valueOf".
     [THROWS] provider="isPrototypeOf" -> GitProviderCatalogError: GIT_PROVIDER_CATALOG names unknown git provider "isPrototypeOf".
     [THROWS] provider="propertyIsEnumerable" -> GitProviderCatalogError: GIT_PROVIDER_CATALOG names unknown git provider "propertyIsEnumerable".
     [THROWS] provider="toLocaleString" -> GitProviderCatalogError: GIT_PROVIDER_CATALOG names unknown git provider "toLocaleString".
     [THROWS] provider="nope" -> GitProviderCatalogError: GIT_PROVIDER_CATALOG names unknown git provider "nope".
     ```
     Notably, `"__proto__"` — which in the baseline run threw a milder, undocumented raw
     `TypeError: registration.create is not a function` — now throws the documented
     `GitProviderCatalogError` too. The fix closes both the primary bypass and this secondary,
     lower-severity defect noted in the baseline report.
  2. **Whether `Object.create(null)` broke any other consumer relying on inherited
     `.toString()`/`.hasOwnProperty()`.** `Object.getPrototypeOf(GIT_PROVIDER_REGISTRATIONS) ===
     null` confirmed directly against the real, unmodified import. Grepped every reference to
     `GIT_PROVIDER_REGISTRATIONS` across `services/core/src`: it is imported in exactly two
     places — `providerCatalog.ts` (the guarded lookup itself) and `index.ts` (a bare re-export,
     calling no method on it). No other consumer exists in this codebase, so nothing was broken.
  3. **Whether a second, unguarded lookup path exists.** Grepped for `registrations[` across
     `services/core/src`: exactly one indexed-lookup call site
     (`providerCatalog.ts:150`), immediately preceded by the `hasOwnProperty` guard at line 145.
     `GitProviderRegistry` (`providerRegistry.ts`) is backed by a `Map<string,
     GitProviderAdapter>`, not an indexable plain object — `.get()`/`.has()` on a `Map` never
     resolves inherited `Object.prototype` members regardless of the key string, so this class
     carries no analogous weakness and needed no fix.
  4. **Whether the `hasOwnProperty.call` guard is structural (holds for any `registrations` map)
     or merely incidental to the shipped `Object.create(null)` manifest.** Called
     `loadGitProviderRegistry(plainLiteralRegistrations)` with an explicit, ordinary `{...}`
     object literal (deliberately bypassing `GIT_PROVIDER_REGISTRATIONS`'s own null-prototype
     construction) for `constructor`, `__proto__`, and `toString` — all three still throw
     `GitProviderCatalogError`. Confirms the guard itself, not just the shipped manifest's
     construction, closes the gap — i.e. the fix holds for any caller-supplied registrations map,
     matching `review.md`'s own structural-soundness claim, independently re-verified here rather
     than taken on trust.
  5. **The two adjacent checks named in the baseline finding.** `mockOnly` production gate
     (`registration.mockOnly === true && getConfig('NODE_ENV') === 'production'`) and
     cross-provider credential isolation (`buildContext(entry)` closes over that entry's own
     `credentialRef` only) — both re-verified via `providerCatalog.test.ts`'s existing pairs, all
     passing, no bypass found. Neither shares the fixed lookup's prototype-chain shape (the
     `mockOnly` gate is a direct boolean/string-equality check; credential isolation never
     indexes a shared object by an attacker-controlled key).
  6. **The two sibling checks named in the finding's recheck scope**, `WEB-07`
     (`ambiguous-and-prototype-shaped-input-handling`) and `ING-04`
     (`org-id-and-provider-derivation-from-envelope-only`) — both re-verified unaffected by the
     fix and unchanged.
- **Dynamic evidence.** `npx vitest run src/integrations/git/providerCatalog.test.ts` — 27/27
  pass. `npx vitest run src/integrations/git/` — 76 passed, 10 RED-DEFERRED skipped (0 failed),
  matching `test-results.md`/`review.md`'s independently-reproduced figures exactly. `npx tsc
  --noEmit -p services/core/tsconfig.json` and `npx eslint providerCatalog.ts providers/index.ts
  providerCatalog.test.ts` — both clean.
- **Reproduction and cleanup.** Created
  `/var/folders/dw/y01pxx3n6p370q1gfz24d3200000gn/T/w3-04-sec-recheck-7ab21c/` (OS temp root,
  never inside the repository) containing one throwaway script (`run.ts`) importing only the
  real, unmodified `providerCatalog.ts`/`providers/index.ts` via their absolute filesystem paths.
  Ran via `npx tsx` from `services/core` (so the imported files' own `node_modules` resolution —
  not the temp script's — reaches the workspace's `@sayre/config` package). No repository file
  was created, modified, or left behind at any point. Cleanup: `rm -f` the script then `rmdir`
  the containing directory immediately after capturing output; a follow-up `ls` confirmed nothing
  remains under that path.
- **Remediation reference.** `services/core/src/integrations/git/providerCatalog.ts:145-150`
  (`hasOwnProperty.call` guard — structural fix layer 1) and
  `services/core/src/integrations/git/providers/index.ts:15-27` (`Object.create(null)`
  construction — structural fix layer 2, defense-in-depth for the shipped manifest). Both layers
  independently verified in this run.

## 6. Verified clean (affirmatively tested and passed, this run)

- **`FND-7c51522045f7`'s fix (CORE-06, PASS/RESOLVED).** See Findings above — full independent
  re-attempt, no bypass found across 10 provider-id candidates and 3 plain-object-literal-guard
  cases.
- **`mockOnly` production gate (AC-10/EC-20, PASS, unchanged).** Re-verified via
  `providerCatalog.test.ts`'s existing pair; no bypass.
- **Credential isolation across providers (GAP-8, PASS, unchanged).** Re-verified via
  `providerCatalog.test.ts`'s "rejects... credentialRef names a secret outside SECRET_NAMES"
  case; no cross-provider leakage found.
- **WEB-07 / ING-04 sibling paths (PASS, unchanged).** Both independently re-verified as
  unaffected by the fix and correctly still passing.
- **GAP-9 full_name validation (CORE-06/ING-08/WEB-02, PASS, unchanged).** `providers/github.ts`
  and `repoFullName.ts` are outside the fix's 3-file scope; re-ran `github.test.ts`'s full
  EC-24/EC-25 matrix (24/24 pass) to confirm no regression.
- **org_id/tenant provenance (CORE-01, PASS, unchanged).** `git status --porcelain=v1 -uall`
  confirms `gitSyncService.ts`/`graphOwnershipStore.ts` are unmodified since the baseline run.
- **Every other one of the 73 selected checks (PASS/NOT_APPLICABLE/UNVERIFIED as applicable,
  UNCHANGED).** The fix's `git status` footprint is confirmed identical to the baseline run's
  41-path set (no new path, no removed path) beyond the 3 declared fix files, so every
  observation outside the CORE-06/WEB-07/ING-04 surface carries over unmodified. Full
  row-by-row detail (73 observations) is in `results.json`.

## 7. Limitations

- The three RED-DEFERRED integration test files (`ownershipGraph.integration.test.ts`,
  `w3-04.acceptance.integration.test.ts`, `jobRetry.integration.test.ts`) require a live Neo4j
  and/or Redis, neither reachable in this local environment; unchanged from the baseline run and
  outside the 3-file fix's scope.
- MP-08 (TLS/endpoint authenticity) and MP-10 (circuit-breaker isolation) remain `UNVERIFIED`, as
  in the baseline run — no live TLS-downgrade test, no load test of the shared worker pool.
- SEC-06 (secret rotation/cache invalidation) and SEC-14 (alerting-rule existence) remain
  `UNVERIFIED`, as in the baseline run — pre-existing, unmodified surfaces outside this fix's
  scope.
- `review.json`'s `stamp` was present and fresh (`check-stamp-freshness.mjs` exit `0`) before this
  run started.

## 8. Cleanup and export

No repository file was created, modified, or left behind by this stage (structurally enforced by
`scripts/guard-checker-readonly.mjs` for `Write`/`Edit`/`NotebookEdit`). The one disposable
dynamic-repro directory (`/var/folders/dw/y01pxx3n6p370q1gfz24d3200000gn/T/w3-04-sec-recheck-7ab21c/`)
was deleted immediately after use, confirmed via a follow-up `ls`. This immutable run directory
(`.pipeline/security-history/20260812T052823000Z-2520ec9-PR_DELTA-48a955/`) is gitignored per the
audit contract; export to an approved access-controlled artifact store before cleaning this
worktree if this history must survive past this machine/session.

## 9. Recheck scope

None outstanding. `FND-7c51522045f7` is `RESOLVED`; no other finding is open. A future run
touching `providerCatalog.ts`, `providers/index.ts`, or `providerRegistry.ts` again should still
re-run `providerCatalog.test.ts`'s reserved-name regression suite as ordinary CI coverage, but no
dedicated security recheck is owed beyond that.
