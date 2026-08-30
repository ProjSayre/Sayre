# PL-CI-QUAL — red quality / anti-dupe gate + the remaining CI suites

## Ticket Check

**What I'm about to build**
A quality check that runs over the tests our own pipeline writes, so that a second test covering
exactly the same requirement as an existing one — or a test that looks like a test but never actually
checks anything — gets caught automatically instead of quietly counting as coverage. Alongside it, a
batch of small, already-confirmed defects left behind by the three tickets that shipped just before
this one, including one that is making the automated checks fail on this branch right now.

**What I'm explicitly not doing**
Not changing what "passed" means for a ticket — every existing gate stays exactly as strict as it is
today. Not touching product code (nothing in the visualizer, the API, or the workers changes). Not
adding any requirement that a normal feature ticket edit the build configuration. Not re-checking
things another existing check already covers. Not chasing three unrelated test failures that only
happen on this one laptop and would not happen on the build server.

**How you'll know it worked**
The repository's automated checks go green again — right now one of them is failing because a
bookkeeping list was not updated when new files were added. Beyond that: ask someone to add a
duplicate test covering a requirement an existing test already covers, without saying why — the
pipeline should refuse it and name the requirement being double-covered. Ask them to add a test with
no real check inside it — refused too. And a type error that has been sitting unnoticed in a test file
should start being reported, then go quiet once fixed.

**What I had to guess**
Four things. (1) The original plan said the review stage should run this new quality check; a previous
ticket in this same plan deliberately moved that kind of run out of review and into the tester stage,
so I put it in tester instead and kept review as the consumer — same strictness, consistent with what
already shipped. (2) The plan also asked for a "prefer editing an existing test file over making a
near-twin" rule; that cannot be judged mechanically without false alarms, so it reports as a
non-blocking note rather than a refusal. (3) The plan mentioned starting an empty list of
"CI-critical test globs" — an empty file reads as coverage that isn't there, so I left it out
entirely. (4) One of the fixes could be done two ways — either restore a capability the last ticket
accidentally made unreachable, or simply write down that it is now unreachable. I chose to restore
it, because silently shrinking what the coding stage is allowed to do is the worse of the two.

## Goal

Land the last part of the Pipeline Efficiency Plan: a mechanical red-test quality gate
(`scripts/check-red-quality.mjs`) that blocks undeclared duplicate `@spec` coverage and
assertion-free / tautological "tests", wire it into `red` (self-check) and `tester` (authoritative
gate, consumed by `review`), close the remaining CI-wiring gaps — in particular the
`scripts/tsconfig.json` `include` hole that let `scripts/pipeline-trim-structural.test.mjs` ship with
an unsurfaced TypeScript error — and repair five verified defects left on this branch by
PL-TRIM / PL-INTEGRITY-TESTER / PL-FIXBRIEF, one of which is failing CI today.

## Scope

**In**

- New `scripts/check-red-quality.mjs` + `scripts/check-red-quality.test.mjs`, wired as
  `check:red-quality` / `test:red-quality` with a CI step.
- Optional per-test declaration fields on `.pipeline/red.json` (`duplicateOf`, `justification`,
  `extends`) validated by `scripts/pipeline-contracts.mjs`.
- Optional `redQuality` / `qualityViolations` fields on `.pipeline/red-integrity.json`, same
  contracts file, consumed fail-closed by `review`.
- Stage-file contract updates: `.sdd/stages/red.md` (search-before-authoring, extend-don't-clone,
  mandatory self-run, "red never edits `ci.yml`"), `.sdd/stages/tester.md` (owns the gating run),
  `.sdd/stages/review.md` (consumes the verdict, never re-runs), plus one-line updates to
  `.sdd/pipeline.md`, `.sdd/entrypoints/red.md`, `.sdd/entrypoints/tester.md`, `.pipeline/README.md`,
  `.sdd/stages/CHANGELOG.md`.
- `scripts/tsconfig.json`: add the missing `pipeline-trim-structural.test.mjs` plus the two new
  `check-red-quality` files; sort/dedupe the `include` array.
- Fix the real TypeScript error this surfaces at `scripts/pipeline-trim-structural.test.mjs:617`.
- A new generalized enumeration test in `scripts/sdd-completeness.test.mjs` that makes this class of
  gap impossible to repeat: every `scripts/*.mjs` is either in `scripts/tsconfig.json`'s `include` or
  in a declared exclusion allowlist with a reason.
- `[red-quality]`-tagged structural tests in `scripts/sdd-completeness.test.mjs` pinning the new
  stage-file contracts, following the existing `[fixbrief]` / `[integrity-tester]` convention.
- **Five verified carry-over defects from this branch's prior three tickets** (all confirmed by
  direct execution or grep, none speculative): the failing `repo-structure.test.mjs` preservation
  guard (AC-20); `readReviewJson`/`readSecurityJson` not enforcing their own documented non-empty
  `findings` contract (AC-21); `requireFindingId`'s error message naming a shape its own regex
  rejects (AC-22); two stale step-number cross-references in `.sdd/stages/dev.md` (AC-23); and three
  documentation regressions from the PL-TRIM/PL-FIXBRIEF split — the unreachable red-test amendment
  escape hatch (AC-24), the un-qualified "Never: skip a stage" rule (AC-25), and the two undocumented
  ledger refusal conditions (AC-26).

**Out**

- Re-implementing `@spec`-resolvability. `scripts/check-red-integrity.mjs` already resolves every
  `@spec` marker against `spec.json` (see its "Spec trace" section, and `.sdd/stages/tester.md`'s
  judgment rule "Unresolvable `@spec` ID … blocking"). Duplicating it here would be exactly the
  redundancy this ticket exists to prevent.
- `.sdd/ci-critical-tests.yml`. The plan calls it "optional later; start empty" — an empty
  allowlist file is a false signal, so it is deliberately not created.
- Any change to `check-pipeline-slim.mjs`, or to the integrity-ownership split itself. The plan's
  Part-4 table lists `check-pipeline-slim`, "integrity ownership", "fix-brief schema + refuse rules",
  and "routing contract" as CI suites that must land; all four are already wired on this branch
  (`ci.yml` steps `check:pipeline-slim && test:pipeline-slim`, `test:pipeline-trim-structural`,
  `test:sdd-completeness`'s `[integrity-tester]` + `[fixbrief]` blocks, and `test:fix-brief`).
  Nothing is re-specced for them.
- **`repo-structure.test.mjs` tests 14, 16, and 22.** These three fail on this machine both with and
  without this branch's diff (verified by stashing the working tree and re-running), because of
  untracked local artifacts — a `Design System/` directory at the repo root and a gitignored
  `scripts/.fontcache/` (`.gitignore:5`) — that do not exist on a clean CI checkout. They are not
  caused by this branch and must not be "fixed" by deleting local directories. Only test 11 is a real
  regression.
- Any product-code change, any `services/**` or `apps/**` change.
- Changing the 3-attempt loop cap, the full-ticket scope of tester/review/security, or what terminal
  `PASS` means.
- Widening `write-fix-brief.mjs`'s `allowedPaths` computation itself (AC-24 is resolved in `dev.md`'s
  contract plus a header comment, not by changing the intersection logic).
- Adding a per-product-ticket step to `.github/workflows/ci.yml` (this ticket adds exactly one step,
  for its own new suite).

## Affected files

Created:

- `scripts/check-red-quality.mjs` — new
- `scripts/check-red-quality.test.mjs` — new

Modified:

- `scripts/pipeline-contracts.mjs`
- `scripts/pipeline-contracts.test.mjs`
- `scripts/pipeline-trim-structural.test.mjs`
- `scripts/repo-structure.test.mjs`
- `scripts/sdd-completeness.test.mjs`
- `scripts/write-fix-brief.mjs`
- `scripts/write-fix-brief.test.mjs`
- `scripts/tsconfig.json`
- `package.json`
- `.github/workflows/ci.yml`
- `.sdd/pipeline.md`
- `.sdd/stages/red.md`
- `.sdd/stages/dev.md`
- `.sdd/stages/tester.md`
- `.sdd/stages/review.md`
- `.sdd/stages/CHANGELOG.md`
- `.sdd/entrypoints/red.md`
- `.sdd/entrypoints/tester.md`
- `.pipeline/README.md`

## Interfaces / signatures

### `scripts/check-red-quality.mjs`

CLI, matching `check-pipeline-slim.mjs` / `check-red-integrity.mjs` conventions:

```
node scripts/check-red-quality.mjs [--json] [--dir <pipelineDir>] [--cwd <repoRoot>]
```

Exit codes:

- `0` — `status: "clean"` (no blocking violations; advisories may still be present) **or**
  `status: "no-red-json"` (no `.pipeline/red.json` — the `/pipeline-lite` and `/inline-edit` lanes).
- `1` — `status: "violations-found"` (at least one blocking violation).
- `2` — `status: "error"` (the check could not be performed: unknown flag, unreadable/invalid
  `red.json`, or a listed test file that cannot be read).

Human output goes to stdout on success and stderr on failure, prefixed `check-red-quality: `.

Exported surface (so the test suite can drive the rules without a temp repo for every case):

```js
/** @typedef {{ kind: string, path: string, detail: string }} QualityViolation */

export const QUALITY_VIOLATION_KINDS = [
  'duplicate-spec-id', 'no-assertion', 'tautological-only', 'bad-duplicate-declaration',
];

export const QUALITY_ADVISORY_KINDS = ['twin-file'];

/** Substrings/regexes counted as "this segment asserts something". */
export const ASSERTION_PATTERNS: RegExp[];

/** Regexes for assertions that are true by construction and prove nothing. */
export const TAUTOLOGY_PATTERNS: RegExp[];

/**
 * Pure evaluator over already-read inputs.
 * @param {{ tests: Array<{ path: string, specIds: string[], sha256: string,
 *                          classification: string, duplicateOf?: string,
 *                          justification?: string, extends?: string }>,
 *          fileContents: Map<string, string>,
 *          newFiles: Set<string> | null,
 *          siblingTestFiles: Map<string, string[]> }} input
 * @returns {{ ok: boolean,
 *             filesChecked: string[],
 *             violations: QualityViolation[],
 *             advisories: QualityViolation[],
 *             notes: string[] }}
 */
export function evaluateRedQuality(input);

/**
 * Split a test file's content into one segment per `@spec` marker: from the marker line through the
 * line before the next `@spec` marker (or EOF). Text above the first marker is not a segment.
 * @param {string} content
 * @returns {Array<{ specIds: string[], startLine: number, text: string }>}
 */
export function specSegments(content);

/**
 * Reads `.pipeline/red.json` (via pipeline-contracts' readRedJson) and the listed files from disk.
 * Throws on anything that makes the check impossible; the CLI turns that into exit 2.
 * @param {{ pipelineDir?: string, repoRoot?: string }} [opts]
 * @returns {{ status: string, ok: boolean, filesChecked: string[],
 *             violations: QualityViolation[], advisories: QualityViolation[], notes: string[] }}
 */
export function checkRedQuality(opts);
```

`--json` stdout shape:

```json
{ "status": "clean" | "violations-found" | "no-red-json" | "error",
  "filesChecked": ["path/to/first.test.ts"],
  "violations": [{ "kind": "duplicate-spec-id", "path": "…", "detail": "…" }],
  "advisories": [{ "kind": "twin-file", "path": "…", "detail": "…" }],
  "notes": ["…"] }
```

### `scripts/pipeline-contracts.mjs` — `red.json` test entries

`validateRedTest` gains three optional fields, passed through on the returned object (today it
silently drops unknown keys, so a declaration `red` wrote would be invisible to any reader):

```js
// { path, sha256, specIds, classification,
//   duplicateOf?: string, justification?: string, extends?: string }
```

Rules:

- `duplicateOf` — optional non-empty string, a repo-relative path.
- `justification` — optional non-empty string. **Required whenever `duplicateOf` is present**;
  `duplicateOf` present with `justification` absent/empty/whitespace-only fails validation with a
  message naming both fields.
- `extends` — optional non-empty string, a repo-relative path. Independent of the other two.
- A `red.json` carrying none of the three parses exactly as it does today (legacy sidecars, ledger
  copies).

### `scripts/pipeline-contracts.mjs` — `red-integrity.json`

`readRedIntegrityJson` gains two fields alongside the existing `redIntegrity` / `scriptStatus` /
`redExpected` / `violations` / `judgments` / `stamp`:

```js
// redQuality: "PASS" | "FAIL" | "UNVERIFIED"   — absent key reads as "UNVERIFIED", never a throw
// qualityViolations: string[]                  — absent key reads as []
```

The absent-key tolerance follows the `spec.json` `lane` precedent already documented in that file: a
sidecar written before this field existed must read as "unverified", not as a validation failure.

### `scripts/pipeline-contracts.mjs` — findings enforcement (AC-21, AC-22)

Current state, verified: `readFixBriefJson` (line ~1006) calls
`parseFindingsArray(raw.findings, label, { requiredNonEmpty: true })`, but `readReviewJson`
(line ~949) and `readSecurityJson` (line ~980) both call `parseFindingsArray(raw.findings, label)`
with no options — so the non-empty rule `.sdd/stages/review.md` and `.sdd/stages/security.md` both
state is unenforced at the parser layer. New shape:

```js
// readReviewJson:   parseFindingsArray(raw.findings, label, { requiredNonEmpty: verdict !== 'PASS' })
// readSecurityJson: parseFindingsArray(raw.findings, label, { requiredNonEmpty: verdict !== 'PASS' })
```

`verdict` must therefore be parsed before `findings` in both functions. `requireFindingId`'s failure
message (line ~439) changes from the hyphenated `R-n / S-n` to the shape `FINDING_ID_PATTERN`
(`/^[RS]\d+[a-z]?$/`, line 426) actually accepts — e.g. `R1` / `S2a` — since `R-1` is itself rejected
by that regex.

### `scripts/repo-structure.test.mjs` — the failing preservation guard (AC-20)

`SCRIPTS_TSCONFIG_INCLUDE` (line ~440) is a hand-maintained byte-for-byte copy of
`scripts/tsconfig.json`'s `include`, asserted at line ~745 with
`assert.deepEqual(tsconfig.include, SCRIPTS_TSCONFIG_INCLUDE, …)`. PL-TRIM added
`check-pipeline-slim.{mjs,test.mjs}` and PL-FIXBRIEF added `write-fix-brief.{mjs,test.mjs}` to the
real array without updating the constant, so this test fails today. The assertion becomes monotonic:

```js
// PL-15's guarantee was that the restructure did not DROP a control-plane script from typechecking.
// Equality also forbids ADDING one, which is not what PL-15 was protecting and which re-breaks this
// test on every legitimate future addition (twice already on this branch). Superset, not equality:
for (const entry of SCRIPTS_TSCONFIG_INCLUDE) {
  assert.ok(tsconfig.include.includes(entry), `${entry} was dropped from scripts/tsconfig.json's include …`);
}
```

The constant stays as the PL-15 baseline and is **not** re-synced to today's array; AC-16's
generalized test in `sdd-completeness.test.mjs` is what owns "no new script silently escapes".

## Approach

Build in this order. Step 0 first — it is the only item that is red in CI right now.

0. **Unbreak CI (AC-20).** Convert `repo-structure.test.mjs`'s `SCRIPTS_TSCONFIG_INCLUDE` assertion
   from `deepEqual` to the no-dropped-entries superset check above, with a comment recording why
   equality was the wrong shape. Confirm with `node --test scripts/repo-structure.test.mjs` that
   test 11 passes. Tests 14/16/22 will still fail on this machine — they are the local-artifact
   failures named in Scope → out, and must be left alone.

1. **`scripts/check-red-quality.mjs`.** Pure evaluator first (`specSegments`, `evaluateRedQuality`),
   then `checkRedQuality` (disk I/O via `readRedJson` from `pipeline-contracts.mjs` — never a raw
   `JSON.parse` of `red.json`), then the CLI shell with `--json` / `--dir` / `--cwd`, the 0/1/2 exit
   split, and the `realpathSync(process.argv[1])` direct-invocation guard `check-pipeline-slim.mjs`
   uses.

   Rules, in evaluation order:

   - **R1 `duplicate-spec-id` (blocking).** Build `specId -> entries[]` from every entry's `specIds`,
     in `red.json` array order. For any id with ≥2 entries, every entry after the first must declare
     `duplicateOf` naming another entry that also cites that id, plus a non-empty `justification`.
     Also blocking: one entry listing the same id twice in its own `specIds`.
   - **R2 `bad-duplicate-declaration` (blocking).** `duplicateOf` naming a path that is not another
     entry in `red.json`, or naming an entry that shares no `specIds` with the declaring entry. A
     declaration that doesn't describe a real overlap must not buy a pass for one that does.
   - **R3 `no-assertion` (blocking).** For every `@spec` segment in every listed file, at least one
     `ASSERTION_PATTERNS` match. Zero matches → violation naming the file, the segment's `@spec` ids,
     and its start line.
   - **R4 `tautological-only` (blocking).** A segment whose every assertion match also matches
     `TAUTOLOGY_PATTERNS` (`assert.ok(true)`, `expect(true).toBe(true)`, `assert.strictEqual(1, 1)`,
     bare Python `assert True`). At least one non-tautological assertion clears it.
   - **R5 `twin-file` (advisory, never blocking).** For a listed path that does not exist in `HEAD`
     (a new file this run), if a sibling test file in the same directory shares its stem (basename up
     to the first `.`) and the entry declares no `extends`, emit an advisory. `git` unavailable or
     not a repo → skip R5 entirely and push a `notes` line saying so.

2. **`scripts/pipeline-contracts.mjs`.** Four changes, all in this one file:
   - Extend `validateRedTest` (three optional fields + the `duplicateOf` ⇒ `justification` rule).
   - Extend `readRedIntegrityJson` (`redQuality`, `qualityViolations`, absent-key defaults).
   - Thread `{ requiredNonEmpty: verdict !== 'PASS' }` through `readReviewJson` / `readSecurityJson`
     (AC-21), parsing `verdict` before `findings` in both.
   - Correct `requireFindingId`'s message (AC-22).

   Add matching cases to `scripts/pipeline-contracts.test.mjs`, including the legacy-sidecar cases and
   the `PASS`-with-no-findings case that must keep parsing.

3. **`scripts/check-red-quality.test.mjs`.** Temp-repo integration cases (exit codes, `--json`,
   `no-red-json`, unknown flag) plus pure-evaluator cases for R1–R5.

4. **Stage files.**
   - `.sdd/stages/red.md` — before authoring, Grep the existing test tree for the symbols under test
     and for nearby `@spec` ids; if an existing test already covers an `AC-*`/`EC-*`, extend that file
     (recording `extends`) or record the item as already covered with a pointer, rather than cloning
     a twin. Declare a deliberate overlap with `duplicateOf` + `justification` on the `red.json`
     entry. New mandatory step before finishing: run `node scripts/check-red-quality.mjs`; a blocking
     violation may not be left in a finished `red.md`, the same rule `RED-BROKEN` already carries.
     Also state plainly that `red` writes into the test trees CI already runs and never edits
     `.github/workflows/ci.yml`.
   - `.sdd/stages/tester.md` — Procedure gains the authoritative run (`node
     scripts/check-red-quality.mjs`) with its exit codes and stdout shape documented inline, the same
     way the `check-red-integrity.mjs` step is; Output contract gains `redQuality` /
     `qualityViolations` on `red-integrity.json`, derived from that run's status (`clean` → `PASS`,
     `violations-found` → `FAIL`, `no-red-json` → `UNVERIFIED`, `error` → `UNVERIFIED`), and states
     that `redQuality !== "PASS"` means the run is not clean for review. Advisories are reported, never
     promoted to a `FAIL`.
   - `.sdd/stages/review.md` — the Red-test integrity bullet gains the symmetric red-quality rules:
     `redQuality === "FAIL"` → `NEEDS_FIXES`; `"UNVERIFIED"` with `redExpected: true` →
     `NEEDS_FIXES`; `"UNVERIFIED"` with `redExpected: false` → report as unverified, not clean;
     `"PASS"` → proceed. Explicitly: review never runs `check-red-quality.mjs` itself — tester is the
     sole owner of the gating invocation, exactly as with `check-red-integrity.mjs`.
   - `.sdd/stages/dev.md` — three fixes: the two stale step-number cross-references (AC-23), and the
     fix-loop red-test amendment carve-out (AC-24).
   - `.sdd/pipeline.md` — stage-4 line names the red-quality run (AC-19); the "Never:" rule regains
     its scope qualifier (AC-25); the ledger step regains its two undocumented refusal conditions
     (AC-26).
   - `.sdd/entrypoints/red.md`, `.sdd/entrypoints/tester.md`, `.pipeline/README.md`,
     `.sdd/stages/CHANGELOG.md` (a `PL-CI-QUAL` entry above the `PL-FIXBRIEF` one).

5. **tsconfig + the type error.** Add `pipeline-trim-structural.test.mjs`, `check-red-quality.mjs`,
   `check-red-quality.test.mjs` to `scripts/tsconfig.json`'s `include`, and sort/dedupe the array
   (`write-fix-brief.*` currently sits out of order after `write-stamp.*`). Then fix the error this
   surfaces:

   ```
   scripts/pipeline-trim-structural.test.mjs(617,27): error TS2339:
     Property 'test' does not exist on type 'string | RegExp'.
   ```

   The array literal at lines 610–616 is inferred as `(string | RegExp)[][]`. Fix by giving the
   literal an explicit tuple type (`/** @type {Array<[RegExp, string]>} */`) and destructuring in the
   loop head — do **not** cast at the use site, and do **not** weaken the assertion.

6. **`scripts/sdd-completeness.test.mjs`.** Two additions:
   - The generalized tsconfig-coverage test (see AC-16), placed with the existing generalized
     enumeration tests (the `scripts/*.test.mjs` ⇒ `test:*` ⇒ ci.yml walk at line ~678 and the
     `check:*` ⇒ `test:*` walk at line ~731), with its exclusion allowlist declared as `path -> reason`
     entries. Note while writing it: the committed `scripts/tsconfig.json` header comment claims "Only
     the four secret-scanning scripts remain" excluded, which is already false — 15 `scripts/*.mjs`
     files are outside `include` today (the four secret-scanning ones plus `extract-ticket.*`,
     `generate-secret-denylist.*`, `dependency-baseline.test.mjs`, `dependency-install.test.mjs`,
     `repo-structure-verify.mjs`, `repo-structure.test.mjs`, `test-product-workspace-ux.mjs`, and
     `pipeline-trim-structural.test.mjs`). The allowlist must be derived from the real tree, not from
     that comment.
   - `[red-quality]`-tagged structural tests for the stage-file contracts and the
     package.json/tsconfig/ci.yml wiring.

7. **Wiring.** `package.json` gains `"check:red-quality": "node scripts/check-red-quality.mjs"` and
   `"test:red-quality": "node --test scripts/check-red-quality.test.mjs"`. `.github/workflows/ci.yml`
   gains one step running `npm run test:red-quality`, placed beside the existing
   `test:red-integrity` step. `check:red-quality` gets **no** ci.yml step of its own — it validates
   per-run gitignored `.pipeline/` state, the same class as `check:red-integrity` /
   `check:stamp-freshness` (see that file's own comments), and the existing `check:* ⇒ test:*` pairing
   test is satisfied by `test:red-quality`.

8. Run `npm run typecheck:scripts`, `npm run test:sdd-completeness`, `npm run test:red-quality`,
   `npm run test:pipeline-contracts`, `npm run test:pipeline-trim-structural`, `npm run test:fix-brief`,
   `npm run test:repo-structure`, `npm run check:pipeline-slim`, `npm run test:pipeline-slim`.

## Acceptance criteria

- **AC-1** — `scripts/check-red-quality.mjs` exists and runs as a CLI accepting `--json`, `--dir`,
  and `--cwd`. It exits `0` for `status` `"clean"` or `"no-red-json"`, `1` for `"violations-found"`,
  and `2` for `"error"`. It reads `.pipeline/red.json` through `pipeline-contracts.mjs`'s
  `readRedJson`, never by parsing `red.md` or any other markdown, and never re-reads `spec.md`.
- **AC-2** — A spec id cited by two or more `red.json` test entries is a blocking
  `duplicate-spec-id` violation (exit `1`) unless every entry after the first declares `duplicateOf`
  naming another entry that also cites that id **and** a non-empty `justification`. With a valid
  declaration on every later entry, the same input exits `0`.
- **AC-3** — A `@spec` segment containing no match of `ASSERTION_PATTERNS` is a blocking
  `no-assertion` violation whose `detail` names the file, the segment's `@spec` ids, and its start
  line.
- **AC-4** — A `@spec` segment whose every assertion match is also a `TAUTOLOGY_PATTERNS` match is a
  blocking `tautological-only` violation. A segment with at least one non-tautological assertion is
  not flagged.
- **AC-5** — A listed test file that is new in this run (absent from `HEAD`), whose directory holds
  another test file sharing its stem, and whose entry declares no `extends`, produces a `twin-file`
  entry in `advisories` — and `status` stays `"clean"` with exit `0`. Declaring `extends` suppresses
  it. When `git` is unavailable, R5 is skipped and a `notes` line says so.
- **AC-6** — With no `.pipeline/red.json` present, the check reports `status: "no-red-json"` and
  exits `0` — never a fabricated `"clean"` — so the `/pipeline-lite` and `/inline-edit` lanes are not
  falsely credited with a passing quality gate.
- **AC-7** — `scripts/pipeline-contracts.mjs`'s `validateRedTest` accepts and passes through optional
  `duplicateOf`, `justification`, and `extends` on a `red.json` test entry; `duplicateOf` present
  without a non-empty `justification` fails validation with a message naming both fields; a
  `red.json` carrying none of the three parses exactly as it does today.
- **AC-8** — `.sdd/stages/red.md` requires, before authoring, a search of the existing test tree for
  the symbols under test and nearby `@spec` ids, and requires extending an existing file (recording
  `extends`) or citing existing coverage rather than cloning a twin; it documents `duplicateOf` +
  `justification` for a deliberate overlap; and it requires running `node
  scripts/check-red-quality.mjs` before finishing, with a blocking violation barred from a finished
  `red.md` the same way `RED-BROKEN` is.
- **AC-9** — `.sdd/stages/red.md` states that `red` writes product tests into the existing Vitest /
  pytest trees CI already runs and never edits `.github/workflows/ci.yml`.
- **AC-10** — `.sdd/stages/tester.md` names `check-red-quality.mjs` as a tester-owned run, documents
  its exit codes and stdout shape inline, and specifies writing `redQuality` and `qualityViolations`
  onto `.pipeline/red-integrity.json` derived from the run's status (`clean`→`PASS`,
  `violations-found`→`FAIL`, `no-red-json`→`UNVERIFIED`, `error`→`UNVERIFIED`), stating that
  `redQuality !== "PASS"` means the run is not clean for review and that advisories are reported but
  never promoted to `FAIL`.
- **AC-11** — `.sdd/stages/review.md` consumes `redQuality` from the sidecar fail-closed —
  `"FAIL"` → `NEEDS_FIXES`; `"UNVERIFIED"` with `redExpected: true` → `NEEDS_FIXES`; `"UNVERIFIED"`
  with `redExpected: false` → reported as unverified, not clean; `"PASS"` → proceed — and states that
  review never invokes `check-red-quality.mjs` itself. `review.md` contains no invocation of that
  script or of `npm run check:red-quality`.
- **AC-12** — `readRedIntegrityJson` accepts optional `redQuality` (enum
  `"PASS"|"FAIL"|"UNVERIFIED"`) and `qualityViolations` (`string[]`), returning `"UNVERIFIED"` and
  `[]` respectively when the keys are absent, and throwing on a present-but-invalid value.
- **AC-13** — `package.json` declares `check:red-quality` and `test:red-quality`, and
  `.github/workflows/ci.yml` runs `npm run test:red-quality`. No other product or workspace CI step is
  added, moved, or removed by this ticket.
- **AC-14** — `scripts/tsconfig.json`'s `include` contains `pipeline-trim-structural.test.mjs`,
  `check-red-quality.mjs`, and `check-red-quality.test.mjs`, and the array is sorted ascending with
  no duplicates.
- **AC-15** — `npm run typecheck:scripts` exits `0` with the widened `include`, with the TS2339 at
  `scripts/pipeline-trim-structural.test.mjs:617` fixed by typing the pattern/label array as
  `Array<[RegExp, string]>` — not by casting at the call site, deleting the assertion, or narrowing
  what that test checks.
- **AC-16** — `scripts/sdd-completeness.test.mjs` gains a generalized test that enumerates every
  `scripts/*.mjs` file on disk and asserts each is either listed in `scripts/tsconfig.json`'s
  `include` or present in a declared exclusion allowlist carrying a reason string; it additionally
  asserts every `include` entry names a file that exists on disk, and that `include` is sorted and
  duplicate-free. This test fails on the current tree (`pipeline-trim-structural.test.mjs` is neither
  included nor excluded) and passes after AC-14.
- **AC-17** — `scripts/sdd-completeness.test.mjs` gains `[red-quality]`-tagged structural tests
  pinning AC-8 through AC-11 and AC-13's wiring, following the file's existing `[fixbrief]` /
  `[integrity-tester]` naming convention.
- **AC-18** — `.sdd/stages/CHANGELOG.md` gains a `PL-CI-QUAL` entry positioned above the
  `PL-FIXBRIEF` entry, and `.pipeline/README.md`'s sidecar table / red-integrity paragraph names
  `redQuality` and identifies tester as its sole producer.
- **AC-19** — `.sdd/pipeline.md`'s stage-4 (tester) line names the red-quality run, and
  `.sdd/entrypoints/red.md` and `.sdd/entrypoints/tester.md` each name it for their stage;
  `npm run check:pipeline-slim` still exits `0` and `npm run test:pipeline-trim-structural` still
  passes (the 300-line budget, the ≤30-line Stage-sequence limit, and the ≤8-line stub limit all
  still hold).
- **AC-20** — `node --test scripts/repo-structure.test.mjs` test 11
  (`[AC-7] scripts/ holds no marketing-site script…`) passes. The
  `assert.deepEqual(tsconfig.include, SCRIPTS_TSCONFIG_INCLUDE, …)` at line ~745 becomes a
  no-dropped-entries superset assertion over the PL-15 baseline constant, with an inline comment
  recording that equality forbade legitimate additions and had already broken twice on this branch.
  The constant itself is **not** re-synced to today's array, and the guard still fails if any baseline
  entry is removed from `include`.
- **AC-21** — `readReviewJson` and `readSecurityJson` in `scripts/pipeline-contracts.mjs` pass
  `{ requiredNonEmpty: verdict !== 'PASS' }` to `parseFindingsArray`, so a `NEEDS_FIXES` `review.json`
  or a `BLOCKED` `security.json` with a missing or empty `findings` array fails validation at the
  parser layer — the contract `.sdd/stages/review.md` and `.sdd/stages/security.md` already state.
  A `PASS` verdict with `findings` absent or empty still parses.
- **AC-22** — `requireFindingId`'s failure message names the shape `FINDING_ID_PATTERN`
  (`/^[RS]\d+[a-z]?$/`) actually accepts (`R1` / `S2a`), not the hyphenated `R-n / S-n` form that
  regex rejects.
- **AC-23** — `.sdd/stages/dev.md`'s header comment cites the correct current step numbers: the
  re-invocation-paths reference points at step 3 (the fix-loop step), and the `changes.md` file-list
  reference points at step 8. No other prose in that comment changes.
- **AC-24** — `.sdd/stages/dev.md` reconciles the `allowedPaths` restriction (step 3) with the
  red-test amendment escape hatch its own `redTestChanges` contract (step 9) still documents: a red
  test file may be amended during a fix-loop even when outside `allowedPaths`, **only** when declared
  in `changes.json`'s `redTestChanges` with a reason, with tester's existing declared-vs-undeclared
  integrity judgment remaining the gate. `scripts/write-fix-brief.mjs` gains a header note that
  `allowedPaths` (finding paths ∩ `spec.json` `affectedFiles`) does not normally contain a
  red-authored test path — because planner writes `affectedFiles` before `red` authors tests — and
  points at that carve-out. No change to the `allowedPaths` computation itself.
- **AC-25** — `.sdd/pipeline.md`'s `**Never:** skip a stage…` rule regains a scope qualifier stating
  it governs automatic routing within a lane, not a human's explicit choice to run a single stage via
  the per-stage commands (or `/re-gate`, which by design never runs planner) — resolving its current
  contradiction with the Entry points section listing six single-stage commands.
- **AC-26** — `.sdd/pipeline.md`'s ledger step documents the two refusal conditions
  `scripts/ledger-append.mjs` enforces but nothing in `.sdd/` currently states: the cited security run
  must exist, be complete, and be independently confirmed `PASS` by its own
  `security-history/<run-id>/{manifest.json,results.json}`; and an existing
  `.sdd/ledger/<run-id>/` (or `<run-id>/security/`) target directory is refused rather than
  overwritten.

## Edge cases

- **EC-1** — No `.pipeline/red.json` at all (`/pipeline-lite`, `/inline-edit`): `status:
  "no-red-json"`, exit `0`, and tester records `redQuality: "UNVERIFIED"` alongside the existing
  `redExpected: false`. Never reported as `PASS`.
- **EC-2** — `red.json` present but malformed (invalid JSON, missing `tests`, a bad
  `classification`): exit `2`, `status: "error"`, stderr names the contract failure. Never `"clean"`.
- **EC-3** — A path listed in `red.json` that cannot be read (deleted, renamed, permission error):
  exit `2`, `status: "error"` — the quality verdict genuinely cannot be computed. This is not
  reported as a quality violation; `check-red-integrity.mjs` separately reports the missing file as
  an integrity violation, and the two must not double-count it.
- **EC-4** — A listed test file containing zero `@spec` markers: no segments, so R3/R4 produce
  nothing; the file still appears in `filesChecked` and a `notes` entry records the marker-less file.
  It is not a `check-red-quality` violation — `check-red-integrity.mjs` owns "cites no `@spec` marker
  at all".
- **EC-5** — One `@spec` marker followed by several test blocks: the segment runs to the next marker,
  so R3 is satisfied by any one assertion inside it and an assertion-free block later in the same
  segment is not caught. Documented as a known limitation in the script header and in
  `.sdd/stages/red.md`'s instruction to mark every test individually — never presented as full
  per-test coverage.
- **EC-6** — An assertion token appearing only inside a comment or a string literal (e.g. a test that
  asserts on the *text* `"expect("`): counted as an assertion, so R3 can be satisfied spuriously.
  Documented as a known false-negative in the script header rather than claimed as airtight.
- **EC-7** — One entry listing the same spec id twice in its own `specIds` array: blocking
  `duplicate-spec-id`, with a `detail` distinguishing it from the cross-file case.
- **EC-8** — `duplicateOf` naming a path not present in `red.json`, or naming an entry sharing no
  spec id with the declarer: blocking `bad-duplicate-declaration`, and the underlying
  `duplicate-spec-id` violation is still reported — a bad declaration never suppresses the finding it
  claims to explain.
- **EC-9** — `duplicateOf` present with `justification` absent, empty, or whitespace-only: rejected by
  `readRedJson` (contracts-level), so the check exits `2` rather than silently accepting an
  unjustified duplicate.
- **EC-10** — `extends` naming a file that does not exist on disk: the `twin-file` advisory is **not**
  suppressed, and a `notes` line records the dangling `extends`.
- **EC-11** — `git` missing from `PATH`, or the working directory is not a git repository: R5 is
  skipped, a `notes` line says so explicitly, and the exit code is unaffected. A rule that could not
  run is disclosed, never silently treated as passing.
- **EC-12** — Python test files under `services/workers/`: `# @spec AC-3` markers and bare `assert`
  statements are recognized by `specSegments` and `ASSERTION_PATTERNS`; a bare `assert True` is
  caught by R4.
- **EC-13** — An unrecognized CLI flag: exit `2` with a usage line, matching
  `check-pipeline-slim.mjs`'s `assertKnownFlags` behavior. Never a silent default run.
- **EC-14** — A legacy `red.json` or a ledger-copied `red.json` with none of `duplicateOf` /
  `justification` / `extends`: parses and evaluates exactly as before this ticket.
- **EC-15** — A legacy `red-integrity.json` with no `redQuality` key: `readRedIntegrityJson` returns
  `"UNVERIFIED"` (never throws), and review's `redExpected: true` branch turns that into
  `NEEDS_FIXES`. This is the deliberate fail-closed choice — symmetric with the existing
  `redIntegrity: "UNVERIFIED"` rule — and its consequence (an in-flight run whose tester predates this
  ticket must re-run tester) is accepted rather than softened.
- **EC-16** — `scripts/tsconfig.json` gains a new `scripts/*.mjs` file that is neither included nor
  in the exclusion allowlist: AC-16's enumeration test fails by name, which is exactly the gap
  `pipeline-trim-structural.test.mjs` fell into. Conversely, an `include` entry pointing at a
  deleted/renamed file also fails — `tsc` itself is silent about a dead include entry.
- **EC-17** — A `check-red-quality` run inside a temp fixture repo with no `.git` directory: R5's
  git probe must fail soft (EC-11), so the script's own test suite can run in `mkdtemp` fixtures the
  way `check-red-integrity.test.mjs` does.
- **EC-18** — Advisory-only result (`twin-file` present, no blocking violation): `ok: true`,
  `status: "clean"`, exit `0`, and tester records `redQuality: "PASS"` while still surfacing the
  advisory text in `test-results.md`. An advisory must never silently disappear, and must never block.
- **EC-19** — AC-20's superset assertion must still fail when a baseline entry is **removed** from
  `scripts/tsconfig.json`'s `include` (that is PL-15's actual guarantee), while a legitimate future
  addition no longer breaks it. Both directions need a test — a guard loosened until it catches
  nothing is worse than the failing guard it replaced.
- **EC-20** — `review.json` / `security.json` with verdict `PASS` and `findings` absent, or `[]`:
  still parses cleanly under AC-21. The non-empty rule is conditional on the verdict, never blanket —
  a passing review has nothing to report and must not be forced to invent a finding.
- **EC-21** — AC-21 changes *where* an empty-findings `NEEDS_FIXES`/`BLOCKED` sidecar is rejected:
  previously only `write-fix-brief.mjs`'s own explicit guard (its line ~214) caught it; now
  `readReviewJson`/`readSecurityJson` throw a `SidecarError` first, which `write-fix-brief.mjs`
  already converts to `failRefuse` (exit `1`). The existing suite cases
  ("NEEDS_FIXES review.json with missing findings exits 1", "…empty findings array exits 1") must
  still pass; if either asserts on stderr text, update the assertion to the new message rather than
  loosening it. The explicit guard stays — defence in depth, not dead code.
- **EC-22** — After AC-22, `R-1` (hyphenated) is still **rejected** by `FINDING_ID_PATTERN`, and the
  failure message must not name it as a valid shape; `R1`, `S2`, `S2a` are accepted. The fix is to the
  message only — the regex is unchanged.
- **EC-23** — AC-24's carve-out must not open a hole: an **undeclared** red-test edit during a
  fix-loop still fails tester's integrity check (undeclared hash mismatch → blocking), exactly as it
  does today. Only a `redTestChanges`-declared amendment is permitted outside `allowedPaths`, and
  review may still escalate an illegitimate declared reason.
- **EC-24** — AC-25's and AC-26's additions to `.sdd/pipeline.md` must keep it under
  `check-pipeline-slim.mjs`'s 300-line budget (it is 213 today) and must not push the Stage sequence
  section past `pipeline-trim-structural.test.mjs`'s ≤30-non-blank-line limit or any `### /cmd` stub
  past ≤8 non-blank lines. If a qualifier cannot fit inside the budget, it belongs in the matching
  `.sdd/entrypoints/*.md` with a pointer, not dropped again.
- **EC-25** — AC-26's ledger refusal conditions must not contradict what `ledger-append.mjs` actually
  enforces, and must not be duplicated into `.sdd/pipeline-history.md` (which is archaeology, not
  procedure). The documented text is checked against the script's real refusal sites, not written
  from memory.
- **EC-26** — `repo-structure.test.mjs` tests 14, 16, and 22 fail on this working copy both before and
  after this ticket, caused by untracked local artifacts (`Design System/` at the repo root, gitignored
  `scripts/.fontcache/`) absent from a clean checkout. They are out of scope: not to be "fixed" by
  deleting local directories, and not to be counted as a regression introduced here. Only test 11's
  transition from failing to passing is this ticket's claim.

## Open questions

1. **Owner of the gating run (resolved, flagged for the approver).** The plan's Part 4 says
   `check-red-quality.mjs` runs in "review + CI". PL-INTEGRITY-TESTER, already merged on this branch,
   established the opposite rule for exactly this class of script ("Single owner: tester; review
   consumes only"), and `review` is read-only by hook. This spec follows the shipped rule: tester runs
   it and publishes the verdict, review consumes it, `red` additionally self-runs it before finishing
   (the same shape as `dev` running the full red suite locally before a gate re-runs it). If the
   intent was genuinely for review to run it, that conflicts with PL-INTEGRITY-TESTER and needs a
   human decision before dev proceeds on AC-10/AC-11.
2. **`.sdd/ci-critical-tests.yml` (resolved as out-of-scope).** The plan marks it "optional later,
   start empty". An empty allowlist committed now reads as coverage that does not exist — the exact
   defect class this pipeline's own history is full of — so it is not created here. If the approver
   wants it, it should be its own ticket with real globs.
3. **`scripts/tsconfig.json`'s stripped rationale comments.** The committed version of that file
   carries ~50 lines of JSONC comments explaining which scripts are deliberately excluded and why;
   the current working-tree version has none (they were dropped during an earlier ticket on this
   branch). Those comments were also already factually wrong — they claim only four scripts are
   excluded, where 15 are. This spec replaces that prose with AC-16's machine-readable exclusion
   allowlist, which is strictly stronger and derived from the real tree. Restoring the comments
   verbatim is **not** in scope — flagged so the deletion is a recorded decision rather than a silent
   loss.
4. **AC-24's direction (resolved, worth a human glance).** The unreachable escape hatch could be
   fixed either by restoring the capability (a declared red-test amendment is permitted outside
   `allowedPaths`) or by narrowing the documentation to say the hatch is first-attempt-only. This
   spec restores the capability, because the alternative silently ratifies a narrowing of `dev`'s
   previously-documented powers that no ticket ever decided. If the approver would rather `dev` never
   touch a red test during a fix-loop, that is a legitimate call — but it should be made explicitly,
   and `dev.md` step 9's `redTestChanges` contract and `tester.md`'s "declared amendment" judgment
   rule would both then need matching edits, which are not in this spec.
