# PL-INTEGRITY-TESTER — move red-test integrity (mechanical check + judgment) from review to tester

## Ticket Check

- **What I'm about to build** — Right now, two different steps of our own release process each open
  the same big file about the tests, and the later one repeats a check the earlier one could just as
  easily have done. I'm moving that check to the earlier step, and having it write down its result in
  a small, fixed form the later step can simply read. Nothing about how strict we are changes; only
  who does the checking.
- **What I'm explicitly not doing** — I'm not making the check itself weaker, optional, or advisory.
  I'm not removing anyone's ability to say "no, this isn't good enough." I'm not touching the part of
  the process that reviews a pull request after the fact, and I'm not adding new automated
  gatekeeping to our build system — that's a separate, later piece of work.
- **How you'll know it worked** — Ask for a normal run of the process. The earlier step's report will
  now contain a plainly labelled section saying whether the tests were tampered with, and the later
  step's report will cite that answer instead of redoing the work. If someone quietly weakens a test
  without saying so, the run still stops — just one step sooner than before, and the later step still
  refuses to approve it.
- **What I had to guess** — Three things. First, the ticket named five pieces of information for the
  new written-down result; I added a sixth (was a test-writing step even supposed to happen on this
  run?), because without it the later step cannot tell "deliberately skipped" from "went missing."
  Second, the earlier step runs on our cheapest model tier, so I kept the later step's ability to
  overrule a too-lenient answer — it can make things stricter, never looser. Third, one existing
  shortcut in the process ("just re-check the gates, skip the tests") stops being safe under this
  change; I've made it say so out loud rather than quietly losing the check. See Open Questions.

## Goal

Make `tester` the single owner of red-test integrity and `@spec` trace: it runs
`scripts/check-red-integrity.mjs`, applies the judgment rules `review` applies today, and publishes
the outcome in a new `.pipeline/red-integrity.json` sidecar. `review` stops reading `red.md` and stops
running the script; it consumes the sidecar's verdict and blocks on anything that is not a clean
`PASS`. The gate's strength is unchanged — only its owner is.

## Scope

**In:**

- `.sdd/stages/tester.md` — gains the mechanical run, the judgment rules (moved, not summarized),
  the `test-results.md` reporting section, the new sidecar output contract, and its staleness entry.
- `.sdd/stages/review.md` — loses `red.md` as a required input for integrity/spec-trace and loses the
  script invocation; gains `.pipeline/red-integrity.json` as a required input with fail-closed
  handling for `FAIL` / missing / stale / malformed.
- `.sdd/stages/dev.md` — one wording fix: the consequence of an undeclared red-test edit is now
  "tester rehashes, review blocks from tester's result," not "review rehashes."
- `.sdd/pipeline.md` — stage-sequence blurbs 4 and 5 (tester owns integrity; review consumes).
- `.pipeline/README.md` — the sidecar table gains a `red-integrity.json` row; the "Red-test integrity /
  spec trace" paragraph changes owner.
- `.sdd/entrypoints/{tester,review,pipeline,re-gate}.md` — required inputs, reported artifacts, and
  the one `--gates-only` consequence this change creates.
- `scripts/pipeline-contracts.mjs` — a new `readRedIntegrityJson` reader with strict shape validation.
- `scripts/check-stamp-freshness.mjs` — register `red-integrity.json` as a sixth known sidecar (without
  this, `review` has no mechanical way to ask whether the sidecar is stale, and AC-8 would be prose
  with nothing behind it).
- `.sdd/stages/CHANGELOG.md` — the round entry, newest first.
- `scripts/sdd-completeness.test.mjs`, `scripts/pipeline-contracts.test.mjs`,
  `scripts/check-stamp-freshness.test.mjs` — assertion updates for the moved contract (authored by
  `red`, before `dev`).

**Out:**

- **Part 1 (PL-TRIM)** — already landed and verified for this spec: `.sdd/pipeline.md` is 207 lines,
  `scripts/check-pipeline-slim.mjs` exists and exits `0`, `.sdd/entrypoints/` is populated. Do not
  redo, re-slim, or re-split anything.
- **Part 3 (PL-FIXBRIEF)** — no `fix-brief.json`/`fix-brief.md`, no scoped-`dev` reroute.
- **Part 4 (PL-CI-QUAL)** — no `scripts/check-red-quality.mjs`, no new CI suite, no "Integrity
  ownership" workflow step. `.github/workflows/ci.yml` is **not** edited by this ticket; the existing
  `test:sdd-completeness`, `test:pipeline-contracts`, and `test:stamp-freshness` steps already run
  every suite this ticket touches. PL-CI-QUAL will add the dedicated ownership suite later.
- `.sdd/stages/pr-review.md` and `scripts/check-red-integrity.mjs` — unchanged. `pr-review` keeps
  running the script itself against `.pipeline/` or `--dir .sdd/ledger/<run-id>`; the "single owner"
  rule governs a live pipeline run, not a post-hoc PR lens that has no `tester` in its loop.
- `scripts/ledger-append.mjs` — `red-integrity.json` is **not** added to any ledger sidecar set this
  ticket (see Open Questions Q3).
- `package.json`, `scripts/tsconfig.json` — no new script file is created, so neither needs an edit.
- `.sdd/runtimes.yml` and `.claude/agents/**` — no model-tier or tool-grant change (see Open
  Questions Q1).

## Affected files

Modified:

1. `.sdd/stages/tester.md`
2. `.sdd/stages/review.md`
3. `.sdd/stages/dev.md`
4. `.sdd/pipeline.md`
5. `.sdd/stages/CHANGELOG.md`
6. `.pipeline/README.md`
7. `.sdd/entrypoints/tester.md`
8. `.sdd/entrypoints/review.md`
9. `.sdd/entrypoints/pipeline.md`
10. `.sdd/entrypoints/re-gate.md`
11. `scripts/pipeline-contracts.mjs`
12. `scripts/check-stamp-freshness.mjs`
13. `scripts/sdd-completeness.test.mjs` (red authors; see AC-17/AC-18)
14. `scripts/pipeline-contracts.test.mjs` (red authors; see AC-14)
15. `scripts/check-stamp-freshness.test.mjs` (red authors; see AC-15)

Created at runtime, not committed (gitignored under `.pipeline/**`):

16. `.pipeline/red-integrity.json` — written by `tester`, one per run.

Explicitly **not** modified: `.github/workflows/ci.yml`, `package.json`, `scripts/tsconfig.json`,
`scripts/check-red-integrity.mjs`, `scripts/check-red-integrity.test.mjs`, `scripts/ledger-append.mjs`,
`.sdd/stages/pr-review.md`, `.sdd/runtimes.yml`, `.claude/agents/**`.

## Interfaces / signatures

### `.pipeline/red-integrity.json` — written by `tester`

```json
{
  "redIntegrity": "PASS" | "FAIL" | "UNVERIFIED",
  "scriptStatus": "clean" | "violations-found" | "no-red-json" | "error",
  "redExpected": true,
  "violations": ["<the script's own violation strings, verbatim>"],
  "judgments": [
    { "path": "path/to/red-test.test.ts", "verdict": "ok" | "blocking", "reason": "..." }
  ],
  "stamp": { "treeHash": "...", "headSha": "...", "dirty": true, "writtenAt": "..." }
}
```

Field derivation, stated as rules rather than left to taste:

- `scriptStatus` mirrors `check-red-integrity.mjs`'s own `status` field verbatim (`clean`,
  `violations-found`, `no-red-json`), with one addition this contract owns: `"error"`, for the case
  where the script exited non-zero **without** emitting a parseable `status` (a malformed
  `spec.json`/`changes.json`, an unreadable listed file, the top-level `catch`). A tooling failure
  must never be recorded as either a clean run or a substantive violation.
- `violations` is the script's `violations` array copied verbatim when it emitted one; `[]` otherwise
  (including the `error` case, where there are no substantive violations to report — the failure is in
  `scriptStatus`). Never omitted.
- `judgments` is one entry per judgment call `tester` actually made: every declared hash mismatch the
  script reported as a note, every unresolvable/absent `@spec` case, and every marker-less
  candidate-new-test the script surfaced. `[]` means "no judgment call was required," never "not
  considered." `verdict` is exactly `ok` or `blocking`; `reason` is a non-empty plain-text sentence.
- `redExpected` is `false` on exactly the lanes that deliberately skip `red` (`/pipeline-lite`,
  `/inline-edit`) and for a ticket that predates the `red` stage; `true` otherwise. This field is **not**
  in the ticket's suggested shape — it is added because without it `review` cannot distinguish "no red
  by design" from "red was supposed to run and its artifacts are gone," and collapsing those two is
  exactly the "nothing was checked reads as checked and clean" failure the script's own header warns
  about.
- `redIntegrity` is derived, never independently asserted:
  - `PASS` — `scriptStatus === "clean"` **and** no `judgments` entry has `verdict: "blocking"`.
  - `FAIL` — `scriptStatus === "violations-found"` **or** any `judgments` entry is `blocking`.
  - `UNVERIFIED` — `scriptStatus` is `"no-red-json"` or `"error"`. Never `PASS`.
- `stamp` is attached by `node scripts/write-stamp.mjs .pipeline/red-integrity.json` as tester's last
  step for this file — omitted when the file is first written, exactly like every other sidecar.

### `scripts/pipeline-contracts.mjs` — new exports

```js
export const RED_INTEGRITY_VERDICTS = ['PASS', 'FAIL', 'UNVERIFIED'];
export const RED_INTEGRITY_SCRIPT_STATUSES = ['clean', 'violations-found', 'no-red-json', 'error'];
export const RED_INTEGRITY_JUDGMENT_VERDICTS = ['ok', 'blocking'];

/** @returns {{ redIntegrity: string, scriptStatus: string, redExpected: boolean,
 *              violations: string[], judgments: {path: string, verdict: string, reason: string}[],
 *              stamp: object|null } | null} */
export function readRedIntegrityJson(pipelineDir, { required = false } = {});
```

Built from the file's existing shared primitives (`requireObject`, `requireEnum`, `requireArray`,
`requireString`, `requireBoolean`, `readStamp`) — no new validation idiom. Returns `null` when the file
is absent and `required` is `false`; `fail()`s otherwise, matching every sibling reader.

### `scripts/check-stamp-freshness.mjs` — one new `READERS` entry

```js
'red-integrity.json': (dir) => readRedIntegrityJson(dir, { required: false }),
```

Its usage banner and the `READERS` doc comment ("deliberately the same five names") are updated to
six. Exit-code semantics are unchanged: `0` fresh/unknown/absent, `1` stale, `2` check failed.

## Approach

Build in this order:

1. **`scripts/pipeline-contracts.mjs`** — add the three exported constant arrays and
   `readRedIntegrityJson`, placed in a new `// --- .pipeline/red-integrity.json — written by tester`
   section after the `changes.json` section (so file order still follows stage order). Validate
   strictly: every field required, `judgments[]` entries fully validated, `stamp` optional via the
   existing `readStamp`.
2. **`scripts/check-stamp-freshness.mjs`** — import the new reader, add the `READERS` entry, update the
   usage banner and the "same five names" comment.
3. **`.sdd/stages/tester.md`** — the substantive move:
   - Required inputs: add an item naming `scripts/check-red-integrity.mjs` as a required run, with its
     exit-code and output-shape contract (lifted from `review.md`'s current text, which is where that
     documentation lives today).
   - Procedure: add a numbered step after the red-suite step — run the script, then apply the judgment
     rules. Move `review.md`'s two judgment-half bullets (red-test integrity, spec trace) here
     substantively intact; do not paraphrase them into something shorter.
   - Output contract: add a **Red-test integrity** section to `test-results.md`, and the
     `red-integrity.json` write plus its `write-stamp` step.
   - Result: state that suite failures **or** `redIntegrity !== "PASS"` mean this run is not clean for
     `review` to treat as green.
   - Staleness: `red-integrity.json` is this stage's own output, so it appears in tester's staleness
     section only as "written last, stamped last," not as an input.
   - Preserve the four `##` heading names and their order — `scripts/sdd-completeness.test.mjs` slices
     tester.md on them, and its `[lite]`/`[inline]` co-occurrence windows are 400 characters wide
     inside Required inputs item 1 and the "Red suite result" bullet. Add new material as new items and
     new bullets; do not interleave it into either of those two windows.
4. **`.sdd/stages/review.md`** — the corresponding removal:
   - Step 1: drop `red.md` from the required-input list; add `.pipeline/red-integrity.json`.
   - Step 3: replace the whole "Red-test integrity and Spec trace" bullet (the `sh` fence, the exit
     codes, the output shape, the four mechanical/judgment sub-bullets) with a **Red-test integrity
     (from tester's sidecar)** bullet that reads the sidecar, applies the verdict rules in AC-8, and
     explicitly forbids re-running the script.
   - Keep the `- **Critical**` bullet naming the undeclared-hash-change and uncited/unresolvable
     `@spec` cases — the findings still exist, they just arrive from the sidecar.
   - Staleness section: delete the now-false "tester writes no JSON sidecar at all … there is nothing
     for `check-stamp-freshness.mjs` to read here" paragraph and replace it with the
     `red-integrity.json` policy (**trusted-fresh**, but with `security`-style refusal: `review` blocks
     rather than flags — see AC-8). Correct the claim rather than deleting it silently; the CHANGELOG
     entry records why.
   - Replace `red.md`'s staleness bullet with a one-line statement that `review` no longer reads
     `red.md`/`red.json` at all.
5. **`.sdd/stages/dev.md`** — step 7's "Red-test changes" bullet: "`review` rehashes every file
   `red.md` lists" becomes "`tester` rehashes every file `red.json` lists and records the result in
   `.pipeline/red-integrity.json`; `review` then treats a non-`PASS` result as `NEEDS_FIXES`." Same
   consequence, correct owner.
6. **`.sdd/pipeline.md`** — stage blurbs 4 and 5 only. Keep the file under 300 lines (207 today) and
   keep every `### /<cmd>` stub untouched, so `check-pipeline-slim.mjs` still exits `0`.
7. **`.pipeline/README.md`** — add the `red-integrity.json` table row (written by tester; read by
   review, check-stamp-freshness) and rewrite the "Red-test integrity / spec trace" paragraph so it
   names tester as the runner and review as the consumer.
8. **Entrypoints** — `tester.md` (step 2 names the integrity run; step 3 reports the sidecar),
   `review.md` (step 1 requires the sidecar, drops the red.md caveat), `pipeline.md` (step 6's artifact
   list gains `red-integrity.json`), `re-gate.md` (step 3: `--gates-only` skips tester, so no fresh
   sidecar exists and `review` will return `NEEDS_FIXES` whenever red artifacts exist for the ticket —
   state it, don't let the lane discover it).
9. **`.sdd/stages/CHANGELOG.md`** — a `## PL-INTEGRITY-TESTER` entry above `## PL-12`, recording the
   move, the corrected `review.md` claim, and the retirement in AC-17.
10. **Test suites** (authored by `red` before step 1 runs, per the pipeline's own ordering) — see
    AC-14, AC-15, AC-17, AC-18.

## Acceptance criteria

- **AC-1** — `.sdd/stages/tester.md`'s Procedure requires running `node scripts/check-red-integrity.mjs`
  after the red suite, and documents its exit codes (`0` = `clean` or `no-red-json`; `1` = violations
  found, an incomplete red-stage output, or any other failure) and its stdout shape
  (`status`/`testPathsChecked`/`hashesChecked`/`candidateNewTests`/`violations`/`notes`).
- **AC-2** — `.sdd/stages/tester.md` carries the judgment rules that live in `.sdd/stages/review.md`
  today, substantively intact: (a) a declared hash mismatch is judged against the reason in
  `changes.json`, with "the spec was wrong and `dev` amended it" as the legitimate case; (b) an
  undeclared hash mismatch is blocking; (c) an unresolvable `@spec` ID, or a listed test citing no
  marker at all, is blocking; (d) a marker-less new test file the script surfaces as a candidate is
  judged behavioral (blocking) or genuinely non-behavioral (fine as-is).
- **AC-3** — `.sdd/stages/tester.md`'s Output contract adds a **Red-test integrity** section to
  `test-results.md` reporting the script's status, every violation, and every judgment with its reason.
  An empty result is stated as a checked-and-clear claim, never left blank.
- **AC-4** — `.sdd/stages/tester.md` specifies writing `.pipeline/red-integrity.json` with exactly the
  shape and derivation rules in Interfaces / signatures, then running
  `node scripts/write-stamp.mjs .pipeline/red-integrity.json` as its last step for that file.
- **AC-5** — `.sdd/stages/tester.md`'s **Result** section states that a red-suite failure **or**
  `redIntegrity !== "PASS"` means this run is not clean for `review` to treat as green.
- **AC-6** — `.sdd/stages/tester.md` states that on `/pipeline-lite` and `/inline-edit`, where `red` is
  deliberately skipped, the sidecar records `scriptStatus: "no-red-json"`, `redIntegrity: "UNVERIFIED"`,
  `redExpected: false`, and that this is disclosed in `test-results.md` — never written or reported as
  a `PASS`.
- **AC-7** — `.sdd/stages/review.md` has zero required read of `red.md`/`red.json` for integrity or
  spec trace, and contains no invocation of `check-red-integrity.mjs` (no `node scripts/check-red-integrity.mjs`,
  no `npm run check:red-integrity`). Its required-input list names `spec.md`, `changes.md`,
  `test-results.md`, and `.pipeline/red-integrity.json`.
- **AC-8** — `.sdd/stages/review.md` specifies fail-closed handling of the sidecar, without re-deriving
  any hash: `redIntegrity === "FAIL"` → `NEEDS_FIXES`; sidecar missing → `NEEDS_FIXES`;
  `node scripts/check-stamp-freshness.mjs red-integrity.json` reporting `stale` (exit `1`) →
  `NEEDS_FIXES`; the sidecar present but failing its own shape validation (exit `2`) → `NEEDS_FIXES`;
  `redIntegrity === "UNVERIFIED"` with `redExpected: true` → `NEEDS_FIXES`; `redIntegrity ===
  "UNVERIFIED"` with `redExpected: false` → not a failure, but reported as an **unverified** lens,
  never as clean.
- **AC-9** — `.sdd/stages/review.md` states that review may **escalate** a tester `ok` judgment to
  `NEEDS_FIXES` when the reason declared in `changes.json` is not legitimate, and may never downgrade a
  `blocking` judgment to a pass. Escalation reads `changes.json`'s declared reasons (which review
  already reads) and the sidecar — never a re-run of the script, and never `red.md`.
- **AC-10** — `.sdd/stages/review.md`'s "Staleness of required inputs" section no longer claims tester
  writes no JSON sidecar; it documents `red-integrity.json`'s policy per AC-8 and drops the
  `red.md`/`red.json` input bullet.
- **AC-11** — `.sdd/stages/dev.md`'s "Red-test changes" bullet attributes the rehash to `tester` and the
  resulting `NEEDS_FIXES` to `review` reading tester's result; it no longer says review rehashes.
- **AC-12** — `.sdd/pipeline.md`'s Stage sequence entry 4 states tester runs the integrity check and
  writes `.pipeline/red-integrity.json`; entry 5 states review consumes that result and no longer reads
  `red.md`. `node scripts/check-pipeline-slim.mjs` exits `0` and the file stays ≤300 lines.
- **AC-13** — `.pipeline/README.md`'s sidecar table has a `red-integrity.json` row (written by tester;
  read by review and `check-stamp-freshness.mjs`), and its "Red-test integrity / spec trace" paragraph
  names tester as the runner and review as the consumer.
- **AC-14** — `scripts/pipeline-contracts.mjs` exports `readRedIntegrityJson` plus the three constant
  arrays, validating strictly: unknown/absent `redIntegrity`, `scriptStatus`, or judgment `verdict`
  values fail; a non-boolean `redExpected` fails; a non-array `violations`/`judgments` fails; a judgment
  entry missing `path` or `reason` fails; `stamp` is optional and read via the existing `readStamp`.
- **AC-15** — `scripts/check-stamp-freshness.mjs` accepts `red-integrity.json` as a known sidecar
  (`node scripts/check-stamp-freshness.mjs red-integrity.json` no longer exits `2` with "unrecognized
  sidecar"), and its usage banner and `READERS` comment name six sidecars rather than five.
- **AC-16** — `.sdd/entrypoints/tester.md`, `.sdd/entrypoints/review.md`, `.sdd/entrypoints/pipeline.md`,
  and `.sdd/entrypoints/re-gate.md` are updated per Approach step 8.
- **AC-17** — Neither `git diff --name-only HEAD -- .sdd/stages` allowlist loop remains in
  `scripts/sdd-completeness.test.mjs` (the PL-11 and PL-12 tests, currently around lines 1026 and
  1315). Each is replaced by content assertions pinning the same underlying guarantee, following the
  precedent already recorded in that file for PL-14/A1 ("a live-diff assertion was a correct pin only
  during that ticket's own run"). `npm run test:sdd-completeness` passes with this ticket's own
  uncommitted edits to `.sdd/stages/{tester,review,dev}.md` present in the working tree.
- **AC-18** — `scripts/sdd-completeness.test.mjs`'s `.sdd/stages/review.md checks red-test integrity and
  spec trace` test is rewritten to assert the new ownership: tester.md carries the mechanical run and
  both judgment halves; review.md consumes the sidecar, names `NEEDS_FIXES` for `FAIL`/missing/stale,
  and contains no `check-red-integrity.mjs` invocation.
- **AC-19** — `.sdd/stages/CHANGELOG.md` gains a `## PL-INTEGRITY-TESTER` entry above `## PL-12`,
  naming every stage file amended, the corrected review.md staleness claim, and AC-17's retirement.
- **AC-20** — `.github/workflows/ci.yml`, `package.json`, `scripts/tsconfig.json`,
  `scripts/check-red-integrity.mjs`, `scripts/ledger-append.mjs`, `.sdd/stages/pr-review.md`, and
  `.sdd/runtimes.yml` are unmodified, and no new file is added under `scripts/`
  (`git ls-files --others --exclude-standard scripts` stays empty — an existing assertion in
  `scripts/sdd-completeness.test.mjs` depends on it).
- **AC-21** — All of these pass locally: `npm run test:sdd-completeness`, `npm run test:pipeline-contracts`,
  `npm run test:stamp-freshness`, `npm run test:red-integrity`, `npm run test:write-stamp`,
  `npm run test:pipeline-slim`, `npm run test:pipeline-trim-structural`, `npm run check:pipeline-slim`,
  and `npm run typecheck:scripts`.

## Edge cases

- **EC-1** — The script exits `1` because of a tooling failure rather than a substantive violation (a
  malformed `spec.json`/`changes.json`, an unreadable listed file, its top-level `catch`). Tester
  records `scriptStatus: "error"`, `redIntegrity: "UNVERIFIED"`, `violations: []`, and states the
  failure in `test-results.md`; review treats it as `NEEDS_FIXES` when `redExpected` is `true`. A gate
  that could not run must never read as a gate that passed.
- **EC-2** — `red.md` exists but `red.json` does not. The script reports `violations-found` (an
  incomplete red-stage output, not "no red stage ran"); tester records `FAIL`, review returns
  `NEEDS_FIXES`.
- **EC-3** — A hash mismatch that **is** declared in `changes.json`'s `redTestChanges` with a legitimate
  reason. Script exits `0` with a note; tester records `verdict: "ok"` with the reason it judged, and
  `redIntegrity: "PASS"`.
- **EC-4** — A hash mismatch that is declared but whose reason is not legitimate (e.g. "the test was
  too strict"). Script exits `0`; tester's judgment is `blocking`, so `redIntegrity` is `FAIL` even
  though the script itself was clean. This is the case that proves the judgment really moved rather
  than being replaced by the exit code.
- **EC-5** — `/pipeline-lite` or `/inline-edit` with a **leftover** `red.json` from an earlier run on
  disk. The script runs against the leftover and may report anything at all; tester must set
  `redExpected: false` and state in `test-results.md` that the result describes a leftover artifact, not
  a `red` stage that ran this round — the same "never manufacture evidence of a stage that never ran"
  rule `ledger-append.mjs`'s lite sidecar set already follows.
- **EC-6** — `.pipeline/red-integrity.json` does not exist when review runs (tester was skipped, or the
  file predates this contract). `NEEDS_FIXES` — review does not run the script "to be helpful," and
  absence is never read as "nothing to check."
- **EC-7** — The sidecar exists but is stale: the tree moved after tester wrote it (a hand-edit, a
  later `dev` pass). `check-stamp-freshness` exits `1`; review returns `NEEDS_FIXES`. This is the
  stricter-than-usual case — every other trusted-fresh input flags and proceeds, and the deviation is
  stated explicitly in review.md rather than left implied.
- **EC-8** — The sidecar exists but fails shape validation (hand-edited, truncated, duplicate key).
  `check-stamp-freshness` exits `2` and `readRedIntegrityJson` throws; review returns `NEEDS_FIXES`,
  never "assume it would have passed."
- **EC-9** — The script surfaces a marker-less new test file as a candidate that is genuinely
  non-behavioral coverage `tester` itself added (a fixture, a harness). Tester records `verdict: "ok"`
  with the reason; it is not a violation. Tester judging its own addition here is the honest cost of
  the move, and must be stated as such in the judgment reason rather than silently resolved.
- **EC-10** — `node scripts/write-stamp.mjs .pipeline/red-integrity.json` exits non-zero. Tester must
  not finish claiming a stamped sidecar — fix the sidecar and re-run, exactly as every other stage
  handles its own `write-stamp` failure.
- **EC-11** — `/re-gate --gates-only` deliberately skips tester, so no fresh sidecar exists and the
  stale one describes the pre-hand-edit tree. Review returns `NEEDS_FIXES` per EC-7. `re-gate.md` must
  say so at step 3: with red artifacts present for the ticket, `--gates-only` now forfeits the
  integrity lens, and the resolution is to run tester (re-gate without `--gates-only`).
- **EC-12** — A ticket that genuinely predates the `red` stage on the full lane. `scriptStatus:
  "no-red-json"`, `redIntegrity: "UNVERIFIED"`, `redExpected: false`; review reports the lens as
  unverified and does not block on it — the same latitude review has today, expressed in the sidecar
  rather than inferred from a missing file.
- **EC-13** — `/pipeline-gapfill`: `gaps.json` handling and review's undeclared-scope check are
  untouched by this ticket. Integrity behaves exactly as on the full lane.
- **EC-14** — `pr-review` on a fresh PR checkout, with no `.pipeline/` and no ledger copy of
  `red-integrity.json` (this ticket adds none). Unchanged: it runs `check-red-integrity.mjs` itself
  against `.pipeline/` or `--dir .sdd/ledger/<run-id>`, and reports the lens **Unverified** when neither
  source exists. The single-owner rule must not be worded so broadly that it forbids this.
- **EC-15** — Tester runs on the `haiku` tier while review runs on `sonnet`, so the judgment moves to a
  cheaper model. Mitigated by AC-9's one-way ratchet (review may escalate, never downgrade) and by
  AC-2's requirement that the judgment rules move substantively intact rather than being compressed.
  Named here rather than left implicit; see Open Questions Q1.
- **EC-16** — The new wording must not break `scripts/sdd-completeness.test.mjs`'s existing 400-character
  co-occurrence windows in tester.md: `lite`↔`red.md`, `lite`↔`state`/`say` inside Required inputs item 1,
  and the `inline-edit`↔"no red suite" pairing inside the "Red suite result" bullet. Add new material as
  new items/bullets rather than inside those two windows.
- **EC-17** — Section anchors other suites slice on must survive: tester.md's `## Required inputs`,
  `## Procedure`, `## Output contract`, `## Staleness of required inputs` (in that order), and
  review.md's `- **Critical**` / `- **Warning**` bullets. Renaming any of them silently breaks an
  assertion elsewhere in the suite.
- **EC-18** — `red` must extend the three existing test files rather than create a new
  `scripts/*.test.mjs`: a new file would be untracked and would fail the existing
  `git ls-files --others --exclude-standard scripts` assertion, and would additionally require
  `package.json`/`ci.yml`/`tsconfig.json` wiring this ticket declares out of scope.
- **EC-19** — Two stages could each believe the other owns the script. The contract is explicit in both
  directions: tester.md says it runs the script; review.md says it must not. Neither file may be edited
  to leave the run unowned.

## Open questions

- **Q1 (model tier).** `tester` runs on `haiku` per `.sdd/runtimes.yml`; the judgment this ticket moves
  is currently performed by `review` on `sonnet`. This spec resolves it **without** a tier change: the
  rules move intact (AC-2) and review keeps a one-way escalation ratchet (AC-9). If you would rather
  promote `tester` to `sonnet`, that is a one-line `.sdd/runtimes.yml` change plus a regenerated shim —
  say so and it becomes its own ticket rather than a silent widening of this one.
- **Q2 (`redExpected`).** The ticket's suggested sidecar shape has five keys; this spec adds a sixth,
  for the reason given in Interfaces / signatures. If you want to hold the shape to exactly the five
  named keys, the fallback is for review to infer "was red expected" from the lane — which means review
  reading lane state it does not otherwise need, to answer a question tester already knew the answer to.
- **Q3 (ledger copy).** The plan floats "later require a ledger copy of the integrity sidecar." This
  ticket does not add `red-integrity.json` to any `*_SIDECAR_NAMES` set in `scripts/ledger-append.mjs`,
  so `pr-review` still cannot read a run's integrity result from the ledger and keeps running the script
  itself (EC-14). Confirm that deferral is what you want.
- **Q4 (`--gates-only`).** EC-11 makes `/re-gate --gates-only` return `NEEDS_FIXES` on any ticket that
  has red artifacts. That is the honest consequence of a hard-fail-on-stale sidecar, but it narrows a
  lane that exists for speed. The alternative — letting review accept a stale sidecar when it judges the
  hand-edit didn't touch a test file — reintroduces exactly the judgment-from-a-stale-artifact shape this
  ticket is trying to remove, so this spec chose the strict reading. Flagging it because it is a real
  behavior change to an existing lane, not a detail.
