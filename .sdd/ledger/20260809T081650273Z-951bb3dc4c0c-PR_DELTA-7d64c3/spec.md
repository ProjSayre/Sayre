# PL-14 — Wire PR #78's two dependency suites into package.json and CI

Lane: `/inline-edit` (`.sdd/pipeline.md`'s `### /inline-edit <ticket>` section). This is STOP A — the
session makes the edit itself at STOP B, bounded by **Affected files**, then authors
`changes.md`/`changes.json` and runs `tester` → `review` → `security` in full. No `red`, no `dev`.

Ticket lane (the `.sdd/bounds.yml` path lane from the issue form): **none declared** — not filed
through `.github/ISSUE_TEMPLATE/pipeline-ticket.yml`. Recorded as `null`, not guessed.

> **Amended once** — see **Amendment 1** below, added after STOP B verification surfaced a
> PL-12-era assertion that fails for any uncommitted local edit to this ticket's own wired files.
> All original text is retained; amended items are marked `[AMENDED — A1]` in place.

## Ticket Check

- **What I'm about to build** — CI is failing because two test files that arrived from the main
  branch are never actually run by anything. This adds the two missing "run this test suite" entries
  — one line each in the project's script list, one step each in the CI config.
- **[AMENDED — A1] Also in scope now:** one older test needs a small repair. It currently checks
  "these ten files were not edited" by looking at your *uncommitted local changes*, which means it
  goes red for anyone editing those files for any reason — including this very ticket, and any future
  work. It gets rewritten to check the same thing by reading the files' contents instead. It never
  caught anything on CI (where there are no uncommitted changes), so nothing is being given up.
- **What I'm explicitly not doing** — not changing what those two dependency test suites check, not
  touching any dependency, not reordering or altering any existing script or CI step, and not making
  the new steps non-blocking. **[AMENDED — A1]** and not weakening the older test's intent: it still
  fails if someone actually does the thing it was written to forbid.
- **How you'll know it worked** — PR #83's CI goes green, and the CI run visibly shows two new steps
  that actually execute those suites.
- **What I had to guess** — one of the two suites performs a real, slow dependency install and its
  Python half will report itself skipped on this CI machine (no Poetry there). I chose to wire it
  into the existing suite block anyway rather than into the Python job; that is the one judgment call.

## Goal

Make `scripts/sdd-completeness.test.mjs`'s generalized assertion ("every `scripts/*.test.mjs` suite
has both a package.json `test:*` script and a matching CI step") pass on PR #83, by wiring the two
suites the merge from `origin/main` brought in unwired — `scripts/dependency-baseline.test.mjs` and
`scripts/dependency-install.test.mjs` — following the convention PL-11 used for `check-lite-eligible`.

Root cause, for the record: main's older `sdd-completeness` did not require this, so PR #78 could land
two suites with no wiring; this branch's PL-11-era generalized assertion (line 683) does require it,
and it enumerates every file on disk — so `dependency-install.test.mjs` would trip the identical
assertion the moment the first one is wired. Both are covered here.

## Scope

**In:** two `scripts` entries in `package.json`; two steps in `.github/workflows/ci.yml`'s `node` job;
**[AMENDED — A1]** the transient-state→content conversion in `scripts/sdd-completeness.test.mjs`'s
`[inline] coverage and wiring` test (Amendment 1).
**Out:** the content or behavior of either dependency suite; any dependency, lockfile, or
`DEPENDENCIES.md` change; `scripts/tsconfig.json`; any existing script or CI step. **[AMENDED — A1]**
`scripts/sdd-completeness.test.mjs` was listed here as out of scope; Amendment 1 moves exactly one
test in it into scope and nothing else in that file.

## Affected files

1. `package.json` — **modified.** Exactly two new `scripts` entries.
2. `.github/workflows/ci.yml` — **modified.** Exactly two new steps in the `node` job.
3. **[ADDED — A1]** `scripts/sdd-completeness.test.mjs` — **modified.** Only the `[inline] coverage
   and wiring` test (`@spec AC-21`, ~lines 1368-1416): its `git diff --name-only HEAD` loop and the
   adjacent `.claude/agents/**` diff check become content assertions. Everything else in that file,
   including the sibling untracked-scripts check and the two `docs/PRD_Tickets.md` content clauses,
   is untouched. **This file is on PL-12's red list** (`red.json` entry, preserved at
   `.sdd/ledger/20260809T015417496Z-a537e98a7c24-PR_DELTA-1bf759/red.json`), so `changes.json` must
   declare it in `redTestChanges` with the exact path and reason — see Amendment 1.

Plus the usual `.pipeline/` artifacts.

## Interfaces / exact strings

What the failing assertion actually requires, per `scripts/sdd-completeness.test.mjs:683-708`: for
each `scripts/*.test.mjs` on disk, some `package.json` script's **value** must match
`/scripts\/([\w.-]+\.test\.mjs)\b/` for that filename (the key is never derived from the filename);
that key must start with `test:`; and `.github/workflows/ci.yml` must contain the key as a substring.

`package.json`, inserted after `"test:readonly-guard"` and before `"typecheck:scripts"` (the same
shape as PL-11's `"test:lite-eligible": "node --test scripts/check-lite-eligible.test.mjs"`):

```json
"test:dependency-baseline": "node --test scripts/dependency-baseline.test.mjs",
"test:dependency-install": "node --test scripts/dependency-install.test.mjs",
```

`.github/workflows/ci.yml`, appended to the `node` job's scripts-suite block — after the
`Checker read-only guard — tests` step and before `Pipeline control-plane scripts — typecheck` —
with a comment in the style of the neighbouring steps recording why each is here:

```yaml
      - name: Dependency baseline (W0-00) — tests
        run: npm run test:dependency-baseline

      - name: Dependency install (W0-00, real `npm ci`) — tests
        run: npm run test:dependency-install
```

The comment must name three facts: these two suites arrived via main unwired (PR #78); the second one
deliberately re-runs a real root `npm ci` (clean-state by design, ~8-minute internal timeout), so it
is slow and reinstalls `node_modules` mid-job; and its `poetry install` half self-skips on this runner
because Poetry is not installed there (recorded via `t.skip`, not a silent pass).

## Approach

1. Add the two `package.json` entries.
2. Add the two `ci.yml` steps at the tail of the scripts-suite block, in the same relative order.
3. **[ADDED — A1]** Convert the `[inline]` test's diff assertions to content assertions (Amendment 1).
4. Run `npm run test:dependency-baseline` locally (pure file inspection — it must pass here).
5. Run `npm run test:sdd-completeness` — the assertion under repair, plus the converted `[inline]`
   test, both against the dirty working tree carrying steps 1-3.
6. Do **not** run `npm run test:dependency-install` locally on Windows; see EC-4.

**Placement choice:** the `node` job (ubuntu-latest), with the other scripts suites, rather than the
`python-workers` job. The Python job would exercise `dependency-install`'s Poetry half for real, but
placing these with the existing suite block is the convention the assertion's neighbours all follow,
and this ticket is a wiring change. EC-5 records the alternative as the follow-up if the Poetry half's
coverage is wanted.

## Acceptance criteria

- **AC-1** — `npm run test:sdd-completeness` passes, including the line-683 assertion, for all 17
  `scripts/*.test.mjs` files currently on disk.
- **AC-2** — `package.json` gains exactly two scripts: `test:dependency-baseline` and
  `test:dependency-install`, each with the value `node --test scripts/<name>.test.mjs`. No existing
  key is renamed, reordered, retargeted, or removed.
- **AC-3** — `.github/workflows/ci.yml` gains exactly two steps in the `node` job, each
  `run: npm run <key>`, placed at the tail of the existing scripts-suite block, each carrying the
  comment described above. No existing step is reordered, renamed, or changed. Neither new step uses
  `continue-on-error` or any other non-gating modifier.
- **AC-4** — `npm run test:dependency-baseline` passes on this working tree. A failure here is a real
  DEPENDENCIES.md/manifest drift, to be reported (EC-3), never wired around.
- **AC-5** — Both suites are expected-green on `ubuntu-latest`, with the evidence stated in
  `changes.md`: (a) `dependency-baseline.test.mjs` performs zero `spawnSync`/`execFileSync` calls —
  it only reads the five workspace manifests, `pyproject.toml`, and `DEPENDENCIES.md` — so it is
  platform-independent, and it was green at W0-00's terminal PASS
  (`.sdd/ledger/20260804T055818422Z-e7d473db5a-PR_DELTA-d441aa/`); (b) `dependency-install.test.mjs`'s
  npm half runs the same `npm ci`, against the same lockfile, that the job's existing
  `Install dependencies (root, single pass)` step already exits 0 on today, and its Poetry half
  self-skips where Poetry is absent. The known `spawnSync('npm', …)` ENOENT is **Windows-only** (`npm`
  resolves to `npm.cmd`, which Node will not spawn without `shell: true`), lives in
  `dependency-install.test.mjs` (line 47) and not in the baseline suite, and does not occur on a Linux
  runner.
- **AC-6** — **[AMENDED — A1]** Nothing outside the **three** Affected files is modified
  (`package.json`, `.github/workflows/ci.yml`, `scripts/sdd-completeness.test.mjs`), and within the
  third, nothing outside the `[inline] coverage and wiring` test. *(Original text: "Nothing outside
  the two Affected files (package.json, .github/workflows/ci.yml) is modified.")*
- **AC-7** — **[ADDED — A1]** `scripts/sdd-completeness.test.mjs`'s `[inline] coverage and wiring`
  test no longer asserts against `git diff --name-only HEAD`. Its ten-path loop and the adjacent
  `.claude/agents/**` diff check are replaced by content assertions pinning the same underlying facts
  — at minimum: `package.json` declares no inline-edit-style script (no `scripts` key or value naming
  `inline`); `.github/workflows/ci.yml` runs no inline-edit step (no `npm run …inline…`);
  `scripts/tsconfig.json`'s file list gained no inline-edit entry; `.sdd/runtimes.yml` and
  `.claude/agents/` declare no `inline-edit` agent or stage; `.sdd/bounds.yml`, `.sdd/bounds.md`, and
  `.sdd/hotfix.md` carry no inline-edit lane/bound/bypass entry; and `scripts/check-lite-eligible.mjs`,
  `scripts/check-bounds.mjs`, and `scripts/pipeline-contracts.mjs` contain no `--inline` handling.
  Each converted assertion must (a) pass on the current tree, (b) key on a token unique to PL-12's
  feature so it still fails if the thing PL-12 forbade were actually done, and (c) carry a comment
  recording the conversion and its reason, citing the `docs/PRD_Tickets.md` precedent documented
  immediately below it in the same test. The sibling untracked-scripts check
  (`git ls-files --others --exclude-standard scripts`) and both `docs/PRD_Tickets.md` content clauses
  are left exactly as they are. `npm run test:sdd-completeness` must pass with PL-14's own
  uncommitted `package.json`/`ci.yml` edits present in the working tree — that dirty-tree pass is the
  proof the conversion worked, not a clean-tree run.

## Edge cases

- **EC-1** — `dependency-install`'s own `npm ci` deletes and reinstalls the root `node_modules`
  mid-job. Every later step in that job re-resolves against the fresh install, so this is safe but
  costs one extra install (~1–3 minutes). Stated, not discovered later.
- **EC-2** — That suite is *stricter* than the existing install step: `findConflictLines` fails on any
  `npm warn … peer …` / `ERESOLVE` line even when `npm ci` exits 0. Before merging, read PR #83's
  existing `Install dependencies (root, single pass)` log for those strings. If any appear, the wiring
  is still correct and the dependency graph is what needs fixing — report it as its own finding, do
  not weaken the step.
- **EC-3** — A dependency added since W0-00 without a `DEPENDENCIES.md` row makes
  `test:dependency-baseline` red. That is the suite doing its job; report it and open a separate
  ticket rather than editing the suite from this run (it is outside Affected files).
- **EC-4** — Running `npm run test:dependency-install` on this Windows host fails at
  `assert.equal(result.status, 0)` with `status: null` / ENOENT. Pre-existing, platform-local, not
  introduced by this ticket and explicitly not fixed by it. Do not "repair" the suite here.
- **EC-5** — The Poetry half never runs in CI on the `node` job, so the Python install path stays
  unexercised. Honest limit, accepted for a wiring change; the follow-up option is a second step in
  the `python-workers` job (Python 3.12 + Poetry already installed there).
- **EC-6** — `continue-on-error: true`, or a step that runs something other than the suite, would
  satisfy the assertion's literal `ci.includes(scriptKey)` substring check while gating nothing.
  Rejected: a step that cannot fail is indistinguishable from no step, which is precisely the defect
  this assertion exists to catch.
- **EC-7** — Placement is a convention choice, not a correctness one (the assertion checks presence
  only). Keep the two new `package.json` keys and the two new CI steps in the same relative order in
  both files so the pairing stays obvious.
- **EC-8** — No other suite is missing wiring: all 17 `scripts/*.test.mjs` files are accounted for by
  the 15 existing `test:*` scripts plus these two. If a third turns up unwired at AC-1, something else
  landed in the same merge — report it rather than silently widening this ticket.
- **EC-9 (accepted residual)** — **[ADDED — A1]** A content assertion cannot notice an *unrelated*
  edit to those ten files; the diff assertion could. That was never this test's job: it exists to pin
  what PL-12 itself must not have done, and it only had a diff available because it happened to be
  written during PL-12's own run. "Did this ticket touch a file it shouldn't" is owned by each
  ticket's own `review` gate and, for lane bounds, by `scripts/check-bounds.mjs` — not by a permanent
  regression suite. Also recorded plainly: the diff assertion gated nothing in CI anyway (a clean
  checkout diffs empty), so it only ever fired on local, in-progress trees — the opposite of where a
  regression gate should bite. The sibling untracked-scripts check stays git-state-based on purpose:
  "no new file was added" is an absence with no content to assert.

## Amendment 1 — transient-state assertion → content assertion (post-STOP-B verification)

**What happened.** STOP B verification ran `npm run test:sdd-completeness` against the working tree
carrying PL-14's own two-file wiring edit. The line-683 assertion this ticket exists to repair now
passes; a *different*, PL-12-era test in the same file fails: `[inline] coverage and wiring`
(`@spec AC-21`, ~line 1368). Lines 1389-1406 read `git diff --name-only HEAD` and assert that ten
named paths — `package.json` and `.github/workflows/ci.yml` among them — plus everything under
`.claude/agents/`, appear nowhere in it.

**Why it must change rather than be worked around.** That pin was correct *during* PL-12's own run,
when "these files are unmodified right now" and "PL-12 did not modify these files" were the same
statement. As a permanent regression test they are not the same statement: the assertion now fails
for **any** uncommitted local edit to those ten files, by anyone, for any reason — PL-14's legitimate
wiring today, and routinely during upcoming work. It is also strictly local harassment: on CI the
checkout is clean, the diff is empty, and the loop passes unconditionally, so it gates nothing where
gating would matter. Working around it (committing first, or stashing) trades a real defect for a
ritual and leaves the next ticket to hit it again.

**The pattern is already documented in this same test.** Lines 1408-1415 assert the
`docs/PRD_Tickets.md` clause **by content, not by diff**, with the reason written out: that file was
already dirty for unrelated reasons, so a `changed.includes(...)` assertion "would fail for a reason
that has nothing to do with this ticket and could only be 'fixed' by reverting someone else's
in-flight work." Amendment 1 applies that same, already-ratified reasoning to the ten-path loop and
the `.claude/agents/**` check beside it. PL-12's actual intent is preserved verbatim in content form
(AC-7's list): no inline-edit wiring in `package.json`/`ci.yml`/`scripts/tsconfig.json`, no
`inline-edit` agent or stage, no inline lane/bound/bypass entry, no `--inline` handling in the three
sibling scripts.

**Red-test declaration.** `scripts/sdd-completeness.test.mjs` is on PL-12's red list (that run's
`red.json`, preserved at
`.sdd/ledger/20260809T015417496Z-a537e98a7c24-PR_DELTA-1bf759/red.json`). `changes.json` must declare
this file in `redTestChanges` with its exact path and this reason, and `changes.md` must describe it
in the matching section — an undeclared change to a red-listed test is `NEEDS_FIXES` regardless of
intent. Note honestly: there is **no `.pipeline/red.json` on disk for this run** (no `red` stage runs
on the `/inline-edit` lane), so `check-red-integrity.mjs` has nothing to rehash against — the
self-declaration is the only record, which is a reason to be more explicit about it, not less.

## Open questions

None blocking. The one genuinely open judgment — `node` job vs. `python-workers` job for
`test:dependency-install` — is decided (node job, for convention) and its cost is recorded as EC-5.

**Coordinator note:** this planner has no Bash. Run `node scripts/write-stamp.mjs .pipeline/spec.json`
before making (or resuming) the STOP B edit — `/inline-edit` STOP A requires a stamped sidecar, and
this amendment rewrote both files.
