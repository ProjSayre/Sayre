# Security report — PL-11 REMEDIATION_RECHECK (security-fix round: dev round 3, review pass 3)

**Run ID:** `20260808T221219423Z-fe1d2b326985-REMEDIATION_RECHECK-728516`
**Mode:** REMEDIATION_RECHECK
**Target:** commit `fe1d2b3269858778aaefb41b10776fcf5fd50d77`, branch `fix/pl-04-pipeline-defects`, dirty
**Environment:** local development checkout — static analysis + local test/validator suites, plus
dynamic execution of the real, current scripts (including the real `scripts/ledger-append.mjs --lite`
entry point end-to-end, not only the CLI) against isolated throwaway git fixtures built by this run.
No live/staging/production target; `authorization.runtime_tests_authorized` is `false`.
**Baseline:** `20260808T204649727Z-fe1d2b326985-PR_DELTA-a208f9` (this stage's own immediately prior
run, verdict `BLOCKED`) — same commit as this run (no new commit landed; both observe the same
accumulating dirty tree). Explicitly human-specified per the coordinator's instruction.

## Verdict: **PASS**

## 1. Target commit and environment

`review.json`'s verdict was independently re-verified fresh before this run proceeded:
`node scripts/check-stamp-freshness.mjs review.json` -> exit `0`, `status: "fresh"` (stamp treeHash
`a5f0e9ee...`, review pass 3, `PASS`). `check-red-integrity.mjs` independently re-run: exit `0`
("no violations found"), `violations: []`, four declared red-file hash changes in `notes`
(`check-lite-eligible.test.mjs`, `check-bounds.test.mjs` newly touched this round,
`ledger-append.test.mjs`, `sdd-completeness.test.mjs` byte-unchanged since round 2) — matching review
pass 3's own account exactly. Full suite independently re-run: 419/420 (TAP reporter, this session) —
the 1 failure is the same pre-existing, out-of-scope `pr-review` CRLF assertion. Both typecheck
configs (`scripts/tsconfig.json`, root) independently re-run clean.

## 2. Baseline run and comparability

Comparable — this stage's own immediately prior run (`...-PR_DELTA-a208f9`), the run that returned
`BLOCKED`. Same commit_sha as this run (both observe the same accumulating dirty tree; no new commit
landed between the two). Per-observation comparison reuses that run's own `observation_key`/
`target_asset` text verbatim for every check whose underlying scope is unchanged, consistent with this
lineage's established convention.

## 3. Counts by result / transition / finding status / readiness

- **Results:** PASS 15, UNVERIFIED 5, NOT_APPLICABLE 14, FAIL 5 (39 observations; SEC-10 now carries
  six attack-path rows — v1..v6).
- **Result transitions:** UNCHANGED 36, RESOLVED 2, FIRST_OBSERVATION 1.
- **Coverage transitions:** UNCHANGED 38, NOT_COMPARABLE 1.
- **Finding statuses:** OPEN 5, RESOLVED 3.
- **Surface readiness:** IMPLEMENTED 14, unchanged.
- **Readiness transitions:** UNCHANGED 14.
- **Blocking check (per this stage's own gate policy):** no CORE-* FAIL, no current CRITICAL/HIGH FAIL
  or regression, no coverage LOST on a CRITICAL/HIGH boundary, no missing selected-check rows or
  overwritten history, no runtime-dependent critical boundary claimed PASS without dynamic evidence.
  Verdict is `PASS` on the merits, not by omission.

## 4. Per-finding resolution status

### FND-b731f500c5b8 (SEC-10 v4, was HIGH) — **RESOLVED**

Re-ran this stage's own exact reproduction (the ~44KB single-line replacement of
`services/core/src/services/technicalTreeService.ts`) against the fixed code, in a fresh throwaway
fixture: now `eligible: false`, citing a `barred-path` violation against `hotfix_barred_paths`. Live
call to the real, current `liteBarredPaths()`/`readBounds()` confirms all five previously-missing
directories (`services/core/src/services/**`, `services/core/src/routes/**`,
`services/core/src/mcp/**`, `services/workers/**`, `services/gateway/**`) are now barred. Swept every
`readBounds()` consumer in the codebase (`check-bounds.mjs`'s CLI, `ledger-append.mjs`'s `--hotfix`
and `--lite` paths, `check-lite-eligible.mjs`) — none reads a stale or second copy of the barred list;
the fix is a data-only change to an existing, shared list, so every consumer inherits it automatically.
EC-16 fail-closed re-verified with the new required key (a two-key `lite_eligibility` block now reads
`null` and exits `2`, live-tested this session).

### FND-22ef4b5c746e (SEC-10 v5, was MEDIUM) — **RESOLVED** (for the specific reproduced shape)

Re-ran the exact reproduction twice: once isolated on a still-unbarred path (`apps/web/src/widget.ts`)
to prove the `max_line_length` bound catches it independently of the barred-path fix (result:
`eligible: false`, sole violation `line-length`, `lineLength: 44038` against `max_line_length: 500`);
and once end-to-end through the **real** `scripts/ledger-append.mjs --lite` (not only the CLI), in a
full fixture reconstructing every file that script imports plus a schema-valid `.pipeline/` with
`review.json` freshly stamped against the payload-inclusive tree — refused there too, before any
ledger entry was written. `max_line_length` is fail-closed in both entry points, matching spec.md's
Amendment section's own account, independently confirmed rather than accepted on it.

**However:** this fix closes the specific reproduced attack path (a single very long line) completely,
but does **not** close the broader concern the finding named ("can a diff hide substantial content
behind a small `changed-lines`/small-per-line footprint"). See the new finding below, found during this
run's own sibling-path sweep.

### NEW — FND-9735a2fbe37a (SEC-10 v6, MEDIUM, OPEN) — multi-line-spread residual

`max_changed_lines` (150, a TOTAL line-count ceiling) and `max_line_length` (500, a PER-LINE ceiling)
compose multiplicatively rather than bounding total content: a diff shaped as many lines, each
individually just under `max_line_length`, while the total stays at or under `max_changed_lines`, still
passes both bounds independently. Reproduced live: a **new, untracked** 150-line file
(`apps/web/src/payload.ts`, not in any barred list), each line ~489 characters, totaling **73,500
bytes**, reports `eligible: true` via the real, fixed `check-lite-eligible.mjs`. Reproduced end-to-end
through the **real** `scripts/ledger-append.mjs --lite`: it wrote a genuine, permanent, indexed ledger
entry recording this 73.5KB new file as a legitimate `SKIPPED_LITE` lite-lane run — `entry.json`'s
`lite.eligibility` reads `{ fileCount: 1, changedLines: 150, maxFiles: 5, maxChangedLines: 150 }`,
`verdicts.security` reads `SKIPPED_LITE`.

**Why MEDIUM, not HIGH, and not blocking on its own:**

1. The worst case is now hard-bounded (`max_changed_lines x max_line_length` = 75,000 characters,
   ~75KB) — a fundamentally different risk profile than FND-22ef4b5c746e's own original, literally
   unbounded exploit. This is a narrower residual, not a failure of the fix to do what it claimed.
2. `review` still runs on the lite lane (unlike `red`/`security`, which are the two stages this lane
   deliberately skips) and is not itself bypassed — it is not security-adversarially trained to look
   for this specific shape, but it is a surviving check, not zero checks.
3. The shape itself (many lines each suspiciously near a numeric ceiling) is more conspicuous than a
   single long line hidden inside an otherwise-ordinary-looking small diff.
4. `max_changed_lines x max_line_length` is bounded regardless of how a payload is spread across the
   up to 5 allowed files, since `max_changed_lines` is a total across files, not per-file — confirmed
   by reading `evaluateLiteEligibility`'s own violation checks directly.

Remediation (two independent, non-exclusive options): add a third, product-level bound (total changed
bytes/characters across the whole diff), or tighten `max_changed_lines`/`max_line_length` so their
product is closer to what "a typo, a one-file cleanup, a doc fix" (spec.md's own stated use case)
actually looks like — 75,000 characters is generous for that.

## 5. Persisting findings — re-verified on their own merits

- **FND-3043428c5bd1 (SEC-09, LOW, OPEN)** — no actor-identity field in any ledger entry. Independently
  re-grepped `scripts/ledger-append.mjs` this session (`whoami|getuid|USER|user\.name|user\.email`):
  zero matches, unchanged. Round 3's own new `lite` object (threaded through the same
  `buildEntryJson`/`buildEntryMarkdown` functions) does not add an actor field either — an opportunity
  not taken, not a new defect.
- **FND-9ea3ec4bba13 (SEC-10 v3, MEDIUM, OPEN)** — the residual "spec.json/spec.md agree with each
  other, but both are stale leftovers from a different ticket" gap on the plain path is unchanged;
  round 3's diff does not touch the unconditional agreement check or the "no fail-safe default for
  'cannot tell whether planner ran'" gap in `.sdd/pipeline.md`/the skill shim — independently
  confirmed via `git diff` this session (zero lines touched in that region).
- **FND-d26b84ebd646 (SC-03, MEDIUM, OPEN)** — no CI-integrated dependency/SBOM scanning gate.
  `.github/workflows/ci.yml`'s diff since baseline is unchanged from what baseline already observed
  (only the `test:lite-eligible` step, present since before the fix round) — re-confirmed this session.
- **FND-ef0066ad43ed (SC-06, LOW, OPEN)** — GitHub Actions still pinned to major-version tags.
  Unaffected; re-confirmed this session (`grep -n "uses: actions/" .github/workflows/ci.yml`, same
  three lines as baseline).

None regressed. None resolved this round (all four are outside this fix round's own scope).

## 6. Sibling/bypass sweep performed this run (per the coordinator's explicit instruction)

- **Other `readBounds()` consumers:** enumerated all four (`check-bounds.mjs` CLI,
  `ledger-append.mjs --hotfix`, `ledger-append.mjs --lite`, `check-lite-eligible.mjs`). None silently
  accepts a malformed/incomplete `liteEligibility`; the `--hotfix` path doesn't read it at all and is
  therefore unaffected either way, by design.
- **Whole-repository sweep** (`grep -rn "evaluateLiteEligibility|maxChangedLineLength|liteBarredPaths"`,
  excluding `node_modules`) found exactly the two sanctioned entry points
  (`scripts/check-lite-eligible.mjs`'s CLI, `scripts/ledger-append.mjs`'s `--lite` branch) plus
  documentation references — no third, independent reimplementation exists anywhere that could compute
  a stale or looser eligibility verdict.
- **EC-16 fail-closed on the new key:** live-tested with a two-key (pre-fix-shaped) `lite_eligibility`
  block — `readBounds().liteEligibility` reads `null`, `check-lite-eligible.mjs` exits `2`.
- **Flag composition, `--files` CLI mode:** re-confirmed unaffected — `ledger-append.mjs --lite` never
  invokes the CLI's `--files` path; it always computes `changedLines`/`lineLength` from the live tree
  in-process, so a separately-run, differently-scoped CLI invocation cannot feed a stale verdict into
  the actual ledger-writing path (same conclusion as this stage's prior run, re-confirmed against the
  current code).
- **The multi-line-spread gap (SEC-10 v6)** was found and reproduced end-to-end during this sweep — see
  above.

## 7. Coverage gaps and what closes them

Unchanged from baseline: CORE-01/02/04/05 remain `UNVERIFIED` for this diff's own code (still no
application/persistence code touched); SC-14 remains `UNVERIFIED` (none of this run's five OPEN
findings carry an owner/due-date/tracking ticket — including the new SEC-10 v6). SEC-14 remains
`NOT_APPLICABLE` (no detection/alerting code in this diff).

## 8. Cleanup

Three throwaway git fixtures were created and fully deleted this run, each by its own exact logged
path (never a glob): one for the SEC-10 v4/v5 CLI-level reproductions (barred-path + isolated
line-length test), and one full fixture (containing verbatim copies of every file
`scripts/ledger-append.mjs` imports, plus a minimal but schema-valid `.pipeline/`) used for both the
v5 real-`--lite`-path reproduction and the v6 real-`--lite`-path reproduction (the ledger entry it
wrote lived and was deleted inside that same throwaway fixture tree, never touching the real
`.sdd/ledger/`). All deleted via `rm -rf` of their exact logged paths immediately after use. Verified
after deletion: no repository file outside these fixtures was created, modified, or left behind.

## Review pass 3's W-4/W-5 — independently weighed, not inherited

- **W-4 (`maxChangedLineLength` unit-test completeness).** Independently read the cited test lines
  this session: the untracked-file branch genuinely is exercised end-to-end by
  `ledger-append.test.mjs`'s line-length test (an untracked ~20,000-character file), and the export's
  existence is transitively pinned by `ledger-append.mjs`'s own static import (a missing export fails
  every fixture-based test at link time, not silently). What's genuinely missing — direct unit tests of
  multi-file max-across-files behavior and the empty-list-to-`0` early return — is real but does not
  bear on this stage's own mandate (the security-relevant *behavior* is pinned at the CLI, evaluate,
  and real-`--lite` levels, which this run itself independently re-verified rather than trusting).
  **Judged non-blocking, independently, on that basis** — same conclusion review reached, reached
  separately here by re-reading the actual test files and this run's own dynamic reproductions, not by
  deferring to review's rating.
- **W-5 (doc-prose pins for `max_line_length`/the widened barred set).** Independently confirmed the
  *mechanical* facts (the real `.sdd/bounds.yml`'s three-key block, the five widened directories) are
  pinned against silent regression by `check-bounds.test.mjs`'s real-file `deepEqual` and
  `ledger-append.test.mjs`'s real-`boundsYmlSource` fixture test — re-read directly this session, not
  taken on review's account. What's missing is prose-only (`sdd-completeness.test.mjs` doesn't pin
  `max_line_length` or the widened-set disclosure sentences in `hotfix.md`/`pipeline.md`) — doc drift
  risk, not enforcement risk. **Judged non-blocking, independently**, for the same reason.

Both remain real, worth a follow-up ticket (review's own S-1 already proposes one, alongside W-6's
pre-existing CRLF fix) — but neither withholds this run's `PASS` verdict, on this run's own,
independently-reached adjudication.

## Verified clean (affirmatively tested and passed, this run)

- **FND-b731f500c5b8's exact reproduction** — now refused, live-tested against the fixed code (not the
  test suite's account of it).
- **FND-22ef4b5c746e's exact reproduction** — now refused, live-tested twice (isolated line-length-only
  path, and the full real `--lite` entry point).
- **EC-16 fail-closed on the third key** — live-tested.
- **No sibling `readBounds()` consumer misses the widened list or the new key.**
- **No third/independent reimplementation of lite-eligibility logic exists anywhere in the repository.**

## Limitations

See `manifest.json`'s `limitations` array for the complete list. Notably: CORE-01/02/04/05 UNVERIFIED
for this diff's own code; no dynamic testing against a live service; GAP-02 unaffected; SEC-10 v6 is a
narrower, bounded, disclosed-in-spirit residual, not a regression or an incomplete delivery of what the
fix claimed; `entry.json`'s `lite.eligibility` still omits the measured line-length value (explicitly
disclosed by spec.md's own Amendment section as a deliberate scope reduction, re-confirmed this
session, not a new finding).

## Recheck scope for a future security-checker run

1. Re-run this report's SEC-10 v4/v5 reproductions against any future change to
   `.sdd/bounds.yml`/`liteBarredPaths()`/`maxChangedLineLength()` to confirm no regression.
2. Track SEC-10 v6 (`FND-9735a2fbe37a`) toward a fix (a product-level bound, or tightened individual
   bounds) and re-run its exact reproduction (a new ~150-line, ~489-char-per-line untracked file on a
   non-barred path) once a fix lands.
3. The four persisting findings (SEC-09, SEC-10 v3, SC-03, SC-06) remain open follow-up-ticket
   material, unaffected by this round.
