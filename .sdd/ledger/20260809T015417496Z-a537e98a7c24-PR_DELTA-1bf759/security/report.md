# Security report — PL-12 (`/inline-edit`: a sanctioned, spec-first front door for a direct in-session edit)

**Run ID:** `20260809T015417496Z-a537e98a7c24-PR_DELTA-1bf759`
**Mode:** PR_DELTA
**Target:** commit `a537e98a7c241b23ff826885973ac39df97e4b28`, branch `fix/pl-04-pipeline-defects`, dirty
**Environment:** local development checkout — static analysis + independently re-run local test/validator
suites only. No live/staging/production target; `authorization.runtime_tests_authorized` is `false`.
**Baseline:** `20260808T221219423Z-fe1d2b326985-REMEDIATION_RECHECK-728516` (verdict `PASS`) — the newest
COMPLETE run whose target commit (`fe1d2b3269858778aaefb41b10776fcf5fd50d77`) is an ancestor of this run's
target (confirmed via `git merge-base --is-ancestor` this session). No human-specified baseline was
supplied.

## Verdict: **PASS**

## 1. Gate preconditions, independently re-verified this session

- `node scripts/check-stamp-freshness.mjs review.json` → exit `0`, `status: "fresh"` (stamp treeHash
  `c819d6fe…`, headSha `a537e98…`). `.pipeline/review.json`'s verdict is `PASS`, pass 1 of this run — the
  precondition for running a full check at all.
- `.pipeline/spec.json`/`.pipeline/red.json` both read `STALE` against the current tree — expected,
  documented mid-run mechanics (red's and dev's own edits moved the tree after each stamp), per this
  stage's own "Staleness of required inputs" policy: `spec.json`/`red.json` are advisory, never
  refuse-worthy, for this gate. Only `review.json`'s stamp is trusted-fresh/refuse-on-stale, and it is
  fresh.
- `node scripts/check-red-integrity.mjs` independently re-run: exit `0`, `status: "clean"`, `violations: []`,
  one declared hash change (`scripts/ledger-append.test.mjs`) matching `changes.json`'s own
  `redTestChanges` declaration and review's own adjudication exactly — independently re-read the declared
  hunk and the file's current content myself (not merely trusted review's account): the fix corrects a
  fixture-reuse defect in an already-red-authored `[inline]` test (a reused `root` fixture that could never
  structurally pass `assertNothingWritten` regardless of implementation correctness), preserves every
  original assertion, and matches the file's actual current diff exactly. Agree with review: a genuine
  harness bug fix, not a softened assertion.
- `node --test scripts/*.test.mjs` independently re-run this session: **458 pass, 1 fail** — the single
  pre-existing, out-of-scope `sdd-completeness.test.mjs` CRLF/`\n`-regex assertion (`".sdd/runtimes.yml
  registers pr-review..."`), confirmed identical before and after this diff (unrelated to PL-12). All
  **39 `[inline]` tests pass** (21 in `ledger-append.test.mjs`, 5 in `build-ledger-index.test.mjs`, 13 in
  `sdd-completeness.test.mjs`), matching `red.md`'s own count exactly. `npx tsc --noEmit` (root) and
  `npx tsc --noEmit -p scripts/tsconfig.json`: both exit `0`.
- `git diff a537e98` inventory independently re-derived (never taken from `changes.md`'s self-report):
  exactly the twelve files `changes.md`/`review.md` declare
  (`.claude/skills/inline-edit/SKILL.md` [new], `.sdd/README.md`, `.sdd/ledger/README.md`,
  `.sdd/pipeline.md`, `.sdd/stages/CHANGELOG.md`, `.sdd/stages/tester.md`, `CLAUDE.md`,
  `scripts/build-ledger-index.mjs`, `scripts/build-ledger-index.test.mjs`, `scripts/ledger-append.mjs`,
  `scripts/ledger-append.test.mjs`, `scripts/sdd-completeness.test.mjs`). `docs/PRD_Tickets.md` is
  present in the working tree's diff but its hunks (read directly) add PL-09/PL-10 content only, no
  `PL-12`/`inline-edit` text anywhere — confirmed out of this run's scope, matching `review.md`'s own
  finding. `package.json`, `.github/workflows/ci.yml`, `scripts/tsconfig.json`, `.sdd/bounds.yml`,
  `.sdd/runtimes.yml`, `.claude/agents/**`, `scripts/check-lite-eligible.mjs` all confirmed UNCHANGED via
  `git diff a537e98 -- <path>` (empty in every case).

## 2. Baseline comparability

Comparable. Same repository, same local-dev-only environment class, same empty `tenant_fixtures`.
PL-11's own landing (`a537e98`, this run's target) sits between the baseline commit
(`fe1d2b326985…`) and this run — findings are compared as persisting/resolved against the baseline's
own observations exactly as any `PR_DELTA` compares against its nearest complete predecessor. Per this
lineage's own established convention (stated explicitly in the baseline's own `manifest.json`), the
generic/unaffected-surface `target_asset` strings (`CORE-*`, most `SEC-*`, all `SC-*`) are reused
**verbatim** from baseline so their `observation_key`s continue to match and produce correct `UNCHANGED`
transitions; only the genuinely new `/inline-edit` surface (`SEC-10` v7–v11) mints new keys.

## 3. Counts

- **Results:** PASS 20, UNVERIFIED 5, NOT_APPLICABLE 14, FAIL 5 (44 observations — `SEC-10` now carries
  eleven attack-path rows, v1–v11).
- **Result transitions:** UNCHANGED 39, FIRST_OBSERVATION 5.
- **Coverage transitions:** UNCHANGED 39, NOT_COMPARABLE 5.
- **Finding statuses:** OPEN 5, RESOLVED 3.
- **Surface readiness:** IMPLEMENTED 44 (14 surfaces), all UNCHANGED.
- **Blocking check (this stage's own gate policy):** no CORE-* FAIL, no current CRITICAL/HIGH FAIL or
  regression, no coverage LOST on a CRITICAL/HIGH boundary, no missing selected-check rows or overwritten
  history, no runtime-dependent critical boundary claimed PASS without dynamic evidence. Verdict is
  `PASS` on the merits.

## 4. The new surface this round: `/inline-edit`'s own attack model (SEC-10 v7–v11)

This is the primary adversarial target of this run — the ticket's own new lane. Cold model first (entry
points, trust boundaries), then verification against code, then against the `[inline]` test suite, per
the audit contract's two-phase method.

**v7 — ticket-identity cross-check (laundering a run onto the wrong ticket).** Traced `readInlineArgs`
and the `specTicketId !== inlineArgs.ticket` refusal directly. `--inline` refuses with no `--ticket` at
all, and refuses on any mismatch against `spec.json`'s own ticket. Tried to smuggle a forged ticket via
a second `--ticket` occurrence (`--ticket <correct> --ticket <forged>`): `readTicketFlag` uses
`argv.indexOf('--ticket')`, which resolves the FIRST occurrence — the forged second value is never
consulted. Separately confirmed the *recorded* `ticketId` in `entry.json` comes from `specJson.ticket`
itself, never from the `--ticket` flag's value at all, so even a successful flag manipulation could not
change what is durably written. **PASS.**

**v8 — lane composition (`--inline` with `--lite`/`--re-gate`/`--hotfix`/`--override-*`).** Traced
`main()`'s exact control-flow order: `assertKnownFlags` → argv-only flag derivation → the
`--lite`/`--inline` mutual-exclusion blocks → `readInlineArgs` → *only then* the first `.pipeline/`
read. `--inline --lite` and `--inline --re-gate` both refuse before any disk read, confirmed against a
deliberately-empty `.pipeline/` fixture (so a refusal there could only come from the argv-only checks).
One non-blocking wrinkle, independently re-derived rather than taken on review's word (matches review's
own Suggestion #2): `--inline --re-gate` *without* `--tester-ran` surfaces `readRegateArgs`'s own
"`--re-gate` requires `--tester-ran`" message rather than the lane-conflict message, because
`readRegateArgs` runs before the mutual-exclusion block — still fails closed, still before any disk
read, still writes nothing; only the wording differs. `--inline --hotfix`: `--hotfix` is dispatched
*before* `main()` even runs, and `runHotfix`'s own `assertKnownFlags` does not recognize `--inline` at
all — traced both flag orderings (`--inline` before vs. after `--hotfix`'s `--files`, which consumes the
rest of argv verbatim): in neither case does `--inline` invoke any inline-lane logic inside a hotfix run
(at worst it is swallowed as a literal, harmless file-path string in `--files`' own list). `--inline`
with `--override-review`/`--override-security`: confirmed as the one composition that *must* succeed —
both flags are read through the same unconditional `readOverrideReason` every other lane uses, and
compose into the same `bypass`/exclusion logic (re-ran and read `[inline] a non-PASS gate accepted via
--override-* composes with the inline disclosure` directly: `bypass: true`, excluded from `index.json`,
`(INLINE) (OVERRIDE)` title, `inline` object intact). **PASS.**

**v9 — leftover `red.json` laundering (EC-11).** Traced the code: `redJson = (lite || inline) ? null :
readRedJson(...)` — `red.json` is never read at all on the inline path, regardless of its content;
`INLINE_SIDECAR_NAMES` omits it from what gets copied into the ledger even if a well-formed one exists on
disk; `redTestPaths` is forced `[]` and `redAbsenceNote` to the fixed, lane-specific
`INLINE_RED_ABSENCE_NOTE` constant unconditionally. Re-ran the exact fixture (a `red.json` naming a
foreign test path from "another ticket") this session: the foreign path appears nowhere in the written
`entry.md`/`entry.json`, and no `red.json` is copied into `.sdd/ledger/<runId>/`. **PASS.**

**v10 — verdicts-gate laundering via a spoofed `inline`/`SKIPPED_*` claim.** Attempted to hand-craft an
`entry.json` that declares `inline` non-null while claiming `verdicts.security: "SKIPPED_LITE"` (borrowing
the lite lane's own widened literal) or a fabricated `"SKIPPED_INLINE"`. Read `build-ledger-index.mjs`'s
`readEntryJson` directly: `isDeclaredLite` reads *only* the `lite` field — `inline` is carried forward for
decoration but never consulted by the verdicts gate at all, so it buys zero widening. Re-ran the exact
positive/negative fixtures this session: a genuine inline entry (PASS/PASS) indexes correctly; both spoofed
variants are refused, non-zero exit, no `index.json` written. **PASS.**

**v11 — D-2 (no mechanical size bound), reviewed from the attacker's chair with a live reproduction.**
This is the item the coordinator specifically asked to be weighed on the merits rather than carried by
citation. Constructed and independently re-ran the exact worst case spec.md itself names as the one
approver-reversible risk: a 9-file, >150-changed-line, >2000-character-line change touching
`services/core/src/services/technicalTreeService.ts` (a path in the *lite* lane's own barred-path union)
submitted through `--inline`. **Result: PASS, not a control gap** — traced why directly: the
`securityJson.verdict !== 'PASS'` gate and `refuseIfStale('security.json', …)` are **unconditional** on
the non-lite branch of `main()`; `inline` never enters that branch's own condition. There is no code path
by which a large `--inline` change reaches `entry.json` without a genuine, independently-verified,
PASS `security.json`/`security-history/` run backing it (or an explicit, disclosed `--override-security`).
This is a categorically different risk shape from `SEC-10` v4/v5/v6 (the *lite* lane's own size-bound
gaps): those are exploitable specifically *because* `security` never runs at all there — size was the
*only* compensating control, and was shown to have real gaps. On `--inline`, `security` is unconditional
and full at every size, so "escape scrutiny via size" is blocked, not merely bounded. What D-2 genuinely
leaves open — tests written after the diff exists, at any size, with no mechanical bound (the D-018
inversion) — is a disclosed, structural Honest-limit property of the lane (`.sdd/pipeline.md`'s own
"Honest limits" (a); spec.md's D-2; review's own "D-2 adjudication" section, which already carries an
honesty note that the red-escape half of lite's own bound rationale does apply here) and is compensated
by `security` reviewing the change in full — the same compensating control the ordinary, full `/pipeline`
lane already relies on today for arbitrarily large `dev`-authored diffs (that lane carries no mechanical
size bound on `dev`'s own output either). D-2 does not lower this lane's risk profile below what an
unbounded `/pipeline` diff already carries; it forgoes only what `/pipeline-lite`'s *skipped* security
stage needed size to compensate for. **Independently concur with review's adjudication to uphold D-2**,
reached separately by tracing the actual gate code and reproducing the worst case, not by inheriting
review's wording.

## 5. Persisting findings — re-verified on their own merits, not carried by citation

- **FND-3043428c5bd1 (SEC-09, LOW, OPEN)** — no ledger actor-identity field. **Re-weighed specifically for
  this lane**, per this run's own instructions: `/inline-edit` is the one lane whose defining property is
  "the implementer and the session are one context" (no `dev`-stage isolation), which makes "who made this
  edit" arguably more practically answerable — and more useful to record — here than on any agent-only
  lane. **Not escalated in severity**, because (a) no lane anywhere in this ledger system records actor
  identity, so this is a systemic, pre-existing gap rather than a PL-12 regression — PL-12 had the same
  opportunity PL-11 had to close it while threading a new object (`inline`) through the same two functions,
  and, like PL-11, did not; (b) `entry.json` still records `commit: { sha, dirty }`, a partial correlation
  path through ordinary git history/blame; (c) `review`/`security` both still gate the diff's actual
  content/security independent of who authored it. Recorded here as a heightened-relevance observation for
  a future round to weigh, not a severity change.
- **FND-9ea3ec4bba13 (SEC-10 v3, MEDIUM, OPEN)** — the plain path's residual "spec.json/spec.md agree with
  each other, but both are stale leftovers from a different ticket" gap is unaffected (the unconditional
  agreement check is untouched by this diff). Checked explicitly whether `--inline` inherits this residual:
  it does not, to the same degree — `--inline` (like `--re-gate`, already excluded from this finding's
  scope) carries its own caller-supplied `--ticket` cross-check, unlike the plain path and unlike `--lite`.
  This does not *resolve* v3 (the check still only verifies presence-and-shape plus which-ticket, never
  that `planner` genuinely ran this round — Honest limit (d) states this explicitly), so v3 remains OPEN on
  its original scope, unaffected either way by this diff.
- **FND-9735a2fbe37a (SEC-10 v6, MEDIUM, OPEN)** — the lite lane's multiplicative size-bound residual
  (~75KB worst case). `scripts/check-lite-eligible.mjs`/`.sdd/bounds.yml` are untouched by this diff;
  `--inline` does not import the lite lane's bounds at all (D-2), so it cannot inherit this specific
  residual — it has its own, distinct size-disclosure surface, evaluated separately above as v11.
- **FND-d26b84ebd646 (SC-03, MEDIUM, OPEN)** — no CI-integrated dependency/SBOM scanning gate.
  `.github/workflows/ci.yml` is untouched by PL-12 (confirmed empty diff) — persisting, out of this
  ticket's own scope.
- **FND-ef0066ad43ed (SC-06, LOW, OPEN)** — GitHub Actions still pinned to major-version tags, not commit
  SHAs. Unaffected; `ci.yml` untouched.

None regressed. Three RESOLVED (v2, v4, v5) carried forward unchanged from prior rounds — the code each
one closes (`findCompletedSecurityRun`, `liteBarredPaths()`, `maxChangedLineLength()`) is untouched by
this diff, confirmed via `git diff`.

## 6. Sibling/bypass sweep performed this run

- Every `readInlineArgs`/`readTicketFlag`/`readWhyInlineReason` call site traced for fail-open shapes
  (empty string, `--flag`-shaped value, absent flag) — all fail closed, matching `EC-1`/`EC-2`/`EC-7`.
- Whole-file sweep of `scripts/ledger-append.mjs`'s `main()` confirmed the `--inline` additions are
  *exclusively* refusals and disclosure (mutual-exclusion checks, required-flag checks, the ticket
  cross-check, the widened stamp-presence check, three required-file existence checks, and the
  `inlineInfo` object) — `readReviewJson` → `refuseIfStale` → `readSecurityJson` → `refuseIfStale` → the
  unconditional `spec.json`/`spec.md` agreement check → `findCompletedSecurityRun` are all untouched and
  unconditional on this path, matching AC-11's own letter. `findCompletedSecurityRun` supplies the run id
  (never minted) exactly as on the plain path.
- Grepped the full diff for `eval|Function(|execSync` and any string-concatenated `git`/shell invocation:
  none found; the sole new git-adjacent call (`measureInlineSize`) reuses the already-array-argument-based,
  unmodified `countChangedLines`/`maxChangedLineLength`.
- Confirmed `.sdd/stages/tester.md`'s widened Required-inputs exception (naming `/inline-edit` alongside
  `/pipeline-lite`) does not weaken the D-018 guarantee's own wording — read directly, unchanged: "you
  still do not author a behavioral test yourself… report a gap rather than filling it."

## 7. Coverage gaps and what closes them

Unchanged from baseline: CORE-01/02/04/05 remain `UNVERIFIED` for this diff's own code (no
application/persistence code touched). SC-14 remains `UNVERIFIED` (none of this run's five OPEN findings
carry an owner/due-date/tracking ticket). SEC-03/05/06/07/11/12/13/14 remain `NOT_APPLICABLE` (no matching
surface in this diff).

## 8. Cleanup

No throwaway git fixture was created directly by this run outside the existing `[inline]`/`[lite]` test
suite's own fixture machinery (`node:test`'s `mkdtemp`-based fixtures, created and torn down entirely
within `node --test`'s own process, never left on disk after the run — verified via `git status`
immediately after the full suite run: no stray fixture paths). This run's own read-only inspection created
no repository file outside `.pipeline/security-history/<run-id>/` itself.

## Review pass 3's Suggestions — independently weighed, not inherited

- **Suggestion #1 (register PL-12 in `docs/PRD_Tickets.md` in a follow-up)** — a documentation/process
  recommendation, not a security finding; no security implication either way. Not re-litigated here.
- **Suggestion #2 (`--inline --re-gate` without `--tester-ran` surfaces the wrong refusal message)** —
  independently re-derived (not taken on review's account) under v8 above: confirmed real, confirmed
  non-blocking (still fails closed, before any disk read, writes nothing — only the message differs).
- **Suggestion #3 (`INLINE_NOTE`'s "was ratified before the edit" phrasing)** — a wording precision point
  about a fixed disclosure string, not a security boundary; the underlying mechanism's actual limits are
  separately, correctly disclosed in Honest limit (d) either way. No security implication.

## Verified clean (affirmatively tested and passed, this run)

- The `/inline-edit` lane's ticket-identity cross-check cannot be bypassed by flag duplication (v7).
- No composition of `--inline` with `--lite`/`--re-gate`/`--hotfix` relaxes a gate or silently no-ops into
  inline-lane behavior (v8).
- A leftover or foreign `red.json` can never be laundered into an inline run's recorded red-test coverage
  (v9).
- `build-ledger-index.mjs`'s verdicts gate cannot be widened by declaring `inline`, including via a
  spoofed `SKIPPED_LITE`/fabricated `SKIPPED_INLINE` claim (v10).
- `--inline`'s lack of a mechanical size bound (D-2) does not create a path to skip `security` scrutiny at
  any size — the security gate is unconditional on this lane regardless of measured size (v11).
- No hardcoded/logged secret, no new injection surface, no new dependency or CI change anywhere in this
  diff (CORE-03/06, SEC-01/02/04, SC-01/02/04/05).

## Limitations

See `manifest.json`'s `limitations` array for the complete list. Notably: CORE-01/02/04/05 UNVERIFIED for
this diff's own code (no application/persistence code touched); no dynamic testing against a live service
(dynamic-adjacent evidence this run: the real `node --test` suite and the real CLI-exercising `[inline]`
tests independently re-run and, for the highest-risk cases, independently re-read); GAP-02 (Bash unguarded
by the read-only hook) unaffected, not re-litigated; SEC-09's heightened relevance on this lane recorded as
a note, not a severity escalation, for the reasons given in section 5.

## Recheck scope for a future security-checker run

1. Re-run `SEC-10` v7–v11's exact reproductions against any future change to `scripts/ledger-append.mjs`'s
   `--inline` branch or `scripts/build-ledger-index.mjs`'s `readInlineField`/verdicts gate, to confirm no
   regression.
2. If a future round adds any new field/flag to the `--inline` disclosure object, re-check whether it is
   consulted by `build-ledger-index.mjs`'s verdicts gate (it must not be, per v10's own finding).
3. The five persisting findings (SEC-09, SEC-10 v3, SEC-10 v6, SC-03, SC-06) remain open follow-up-ticket
   material, unaffected by this round; SEC-09's note above is worth surfacing to a human for a possible
   follow-up ticket given the inline lane's specific relevance.
