# PL-FIXBRIEF — scoped `dev` on reroute (gates stay full)

## Ticket Check

- **What I'm about to build** — When a review or security check says "not yet," the next coding
  pass currently re-opens the entire original brief. I'm inserting a small, written-down fix list
  between those two steps so the coding pass works from that list, while the checking steps that
  follow still look at the whole original brief. A later check can still fail the run for a
  regression the short list never mentioned.
- **What I'm explicitly not doing** — I'm not letting the later checks look only at the short list.
  I'm not changing how many times we may try. I'm not moving or weakening the test-tampering check
  that already lives in the testing step. I'm not adding a new quality-gate for duplicate tests —
  that's a later, separate piece of work.
- **How you'll know it worked** — On a run that comes back "not yet," you should see a short fix
  list appear before the coding step is asked to continue, and that coding step should refuse to
  start if the list is missing or out of date. The testing and review steps after the fix should
  still cover the original whole brief. A leftover list from some other run must not shrink the
  first coding pass of a new ticket.
- **What I had to guess** — Four things, all resolved in this spec rather than left open. First, the
  plan said the allowed-file list is an overlap with "affected files" on the machine-readable spec,
  but that field does not exist yet — I am adding it, optional to read (old specs keep parsing) and
  required to write from now on; a missing list means the overlap is empty and the generator
  refuses. Second, review and security currently record only a pass/fail word, not a structured
  finding list — I am adding an optional findings list, and the generator refuses rather than
  scraping the human-readable report if a failed run has none. Third, a human can invoke the coding
  step on its own; that path must generate the same list, not skip it. Fourth, the lane that skips
  the coding step entirely (`/inline-edit`) does not get a scoped-coding list, because there is no
  coding step to scope.

## Goal

On `NEEDS_FIXES` / `BLOCKED`, the coordinator writes a stamped `.pipeline/fix-brief.json` (plus a
human `.pipeline/fix-brief.md` and a `spec-slice.md`) **before** re-invoking `dev`. Fix-loop `dev`
reads that brief first, stays inside `allowedPaths`, and maps Fixes applied 1:1 to finding IDs.
Tester, review, and security stay **full-ticket** gates. Integrity stays in tester
(PL-INTEGRITY-TESTER). The 3-attempt cap does not change. First-attempt `dev` still reads full
`spec.md`.

## Scope

**In:**

- Coordinator routing: `.sdd/pipeline.md` Routing (short), `.sdd/entrypoints/pipeline.md`,
  `.sdd/entrypoints/pipeline-lite.md`, `.sdd/entrypoints/dev.md`.
- Stage files: `.sdd/stages/dev.md` (fix-loop vs first-attempt), `.sdd/stages/planner.md`
  (`affectedFiles` on `spec.json`), `.sdd/stages/review.md` (`findings[]` on `NEEDS_FIXES`),
  `.sdd/stages/security.md` (`findings[]` on `BLOCKED`), `.sdd/stages/tester.md` (one explicit
  "fix-brief does not shrink this stage" sentence).
- Contracts: `scripts/pipeline-contracts.mjs` (`readFixBriefJson`; additive `findings` /
  `affectedFiles` on existing readers), `scripts/check-stamp-freshness.mjs` (seventh sidecar).
- New generator: `scripts/write-fix-brief.mjs` (+ its test file). Writes `.pipeline/fix-brief.json`,
  `.pipeline/fix-brief.md`, and `.pipeline/spec-slice.md`. Never parses markdown reports.
- Docs/skills that would otherwise stay false: `.pipeline/README.md`, `.sdd/stages/CHANGELOG.md`,
  `.claude/skills/dev/SKILL.md`, `.claude/skills/pipeline/SKILL.md`, CLAUDE.md's one routing
  sentence, `.sdd/entrypoints/review.md` (continuing from `NEEDS_FIXES` means generate then `/dev`),
  `.sdd/entrypoints/inline-edit.md` and `.sdd/entrypoints/re-gate.md` (explicit non-use).
- Wiring the new script's own tests: `package.json` `test:fix-brief`, `scripts/tsconfig.json`
  include, one CI step next to `test:pipeline-contracts`. This is this ticket's own suite, not
  PL-CI-QUAL (`check-red-quality.mjs` / anti-dupe / remaining CI suites).
- Assertion updates in existing suites `red` will author: `scripts/pipeline-contracts.test.mjs`,
  `scripts/check-stamp-freshness.test.mjs`, `scripts/sdd-completeness.test.mjs`.

**Out:**

- **Part 1 (PL-TRIM)** — already on this tree. Do not re-slim, re-split, or rewrite entrypoints
  except the routing sentences this ticket needs.
- **Part 2 (PL-INTEGRITY-TESTER)** — already on this tree. Tester already owns
  `check-red-integrity.mjs` + judgment and writes `.pipeline/red-integrity.json`. Review already
  consumes that sidecar and does not read `red.md` for integrity. Do not reverse, duplicate, or
  re-home that gate.
- **Part 4 (PL-CI-QUAL)** — no `scripts/check-red-quality.mjs`, no anti-duplicate `@spec` gate, no
  `.sdd/ci-critical-tests.yml`, no "Integrity ownership" / "Routing contract" extra CI suites beyond
  this ticket's own `test:fix-brief` step.
- Shrinking tester / review / security to findings-only context.
- Changing the 3-attempt loop cap.
- Re-running `planner` or `red` in the fix loop.
- Making stage agents re-read full `.sdd/pipeline.md`.
- Scraping `review.md` / `security-report.md` for findings (fail closed instead).
- `scripts/ledger-append.mjs` — `fix-brief.json` is ephemeral working state, not a ledger sidecar.
- `.sdd/stages/pr-review.md`, `.sdd/runtimes.yml`, `.claude/agents/**` (generated shims; no model or
  tool-grant change).
- Product code under `apps/`, `services/`, `packages/`.

## Affected files

Modified:

1. `.sdd/pipeline.md` — Routing: coordinator writes a fix-brief before re-invoking `dev`; missing /
   stale brief refuses the fix-loop `dev`; 3-attempt cap unchanged; file stays ≤300 lines.
2. `.sdd/stages/dev.md` — first attempt vs fix-loop; refuse missing/stale brief; `allowedPaths`;
   full red suite; Fixes applied 1:1; escalate-don't-widen.
3. `.sdd/stages/planner.md` — `spec.json` gains `affectedFiles` (required to write, optional to
   read).
4. `.sdd/stages/review.md` — `findings[]` on `review.json` when `NEEDS_FIXES`; full spec↔diff
   unchanged; integrity sidecar consumption unchanged.
5. `.sdd/stages/security.md` — `findings[]` on `security.json` when `BLOCKED`; still a full check.
6. `.sdd/stages/tester.md` — one sentence: a `fix-brief.json` on disk does not shrink this stage.
7. `.sdd/stages/CHANGELOG.md` — `## PL-FIXBRIEF` above `## PL-INTEGRITY-TESTER`.
8. `.sdd/entrypoints/pipeline.md`
9. `.sdd/entrypoints/pipeline-lite.md`
10. `.sdd/entrypoints/dev.md`
11. `.sdd/entrypoints/review.md`
12. `.sdd/entrypoints/inline-edit.md` — explicit: this lane skips `dev`, so it does not generate or
    require a fix-brief.
13. `.sdd/entrypoints/re-gate.md` — explicit: hand-edit path, not a scoped-`dev` reroute.
14. `.pipeline/README.md`
15. `.claude/skills/dev/SKILL.md`
16. `.claude/skills/pipeline/SKILL.md`
17. `CLAUDE.md` — the one sentence that currently says the pipeline routes back to `dev` with the
    fix list; it must name the fix-brief step.
18. `scripts/pipeline-contracts.mjs`
19. `scripts/pipeline-contracts.test.mjs` (red authors)
20. `scripts/check-stamp-freshness.mjs`
21. `scripts/check-stamp-freshness.test.mjs` (red authors)
22. `scripts/sdd-completeness.test.mjs` (red authors)
23. `package.json`
24. `scripts/tsconfig.json`
25. `.github/workflows/ci.yml` — one step running `npm run test:fix-brief`.

Created:

26. `scripts/write-fix-brief.mjs` (does not exist yet)
27. `scripts/write-fix-brief.test.mjs` (does not exist yet; red authors)

Created at runtime, not committed (gitignored under `.pipeline/**`):

28. `.pipeline/fix-brief.json`
29. `.pipeline/fix-brief.md`
30. `.pipeline/spec-slice.md`

Explicitly **not** modified: `scripts/check-red-integrity.mjs`, `scripts/ledger-append.mjs`,
`.sdd/stages/red.md`, `.sdd/stages/pr-review.md`, `.sdd/runtimes.yml`, `.claude/agents/**`,
`scripts/check-red-quality.mjs` (must not be created).

## Interfaces / signatures

### Finding object (shared)

Used in `review.json.findings`, `security.json.findings`, and `fix-brief.json.findings`.

```ts
type Finding = {
  id: string;            // /^[RS]\d+[a-z]?$/  — review writes R1, R2, …; security writes S1, S2, …
  summary: string;       // non-empty
  paths: string[];       // non-empty; repo-relative; no duplicates within one finding
  relatedAc: string[];   // optional at write time; reader defaults missing to []; each value matches SPEC_ID_PATTERN
  requiredOutcome: string; // non-empty
};
```

A finding with empty `paths`, empty `id`/`summary`/`requiredOutcome`, a duplicate `id` within the
same array, or a `relatedAc` entry that is not `AC-n`/`EC-n` fails shape validation.

### `.pipeline/review.json` — additive `findings`

```json
{ "verdict": "PASS" | "NEEDS_FIXES", "findings": [ /* Finding */ ], "stamp": {} }
```

`findings` is **optional** at read time: absent (every review.json on disk today) parses as
`findings: []`. When present, it must be an array of valid Finding objects. `readReviewJson` must
not start requiring `findings`. `review` **writes** a non-empty `findings` array whenever
`verdict` is `NEEDS_FIXES`. A `PASS` may omit the field or write `[]`.

### `.pipeline/security.json` — additive `findings`

```json
{ "verdict": "PASS" | "BLOCKED", "runId": "<run-id>", "findings": [ /* Finding */ ], "stamp": {} }
```

Same optionality as review. `security` writes a non-empty `findings` array whenever `verdict` is
`BLOCKED`. A `PASS` may omit the field or write `[]`.

### `.pipeline/spec.json` — additive `affectedFiles`

```json
{
  "ticket": "...",
  "goal": "...",
  "acceptanceCriteria": [{ "id": "AC-1", "text": "..." }],
  "edgeCases": [{ "id": "EC-1", "text": "..." }],
  "lane": "full" | null,
  "affectedFiles": ["path/a.ts", "path/b.ts"],
  "stamp": {}
}
```

`affectedFiles` is **optional** at read time: absent parses as `affectedFiles: []` (or `null`
normalized to `[]` by `readSpecJson`). When present, it is an array of non-empty unique
repo-relative strings. `planner` **writes** it going forward as the exact path list from spec.md's
Affected files section (the committed paths only — not the gitignored runtime artifacts). Duplicate
paths fail validation.

### `.pipeline/fix-brief.json` — written by `write-fix-brief.mjs`

```json
{
  "source": "review" | "security",
  "attempt": 2,
  "findings": [ /* Finding, copied from the source sidecar */ ],
  "allowedPaths": ["..."],
  "fullSpecStillGoverns": true,
  "stamp": {}
}
```

- `source` is exactly `"review"` or `"security"`.
- `attempt` is an integer `>= 2` (the `dev` attempt about to run; first attempt has no brief).
- `findings` is a non-empty array of Finding objects, copied from the source sidecar (not
  re-derived from markdown).
- `allowedPaths` is the sorted unique intersection described below; must be non-empty (the
  generator refuses before writing if it would be empty).
- `fullSpecStillGoverns` is the literal boolean `true`. A `false` value fails `readFixBriefJson`.
- `stamp` is attached last via `node scripts/write-stamp.mjs .pipeline/fix-brief.json`.

```ts
export function readFixBriefJson(
  pipelineDir: string,
  opts?: { required?: boolean },
): {
  source: "review" | "security";
  attempt: number;
  findings: Finding[];
  allowedPaths: string[];
  fullSpecStillGoverns: true;
  stamp: object | null;
} | null;
```

`required` defaults to `false` (same pattern as `readRedJson`). When `required: true` and the file
is missing, throw. Shape failures always throw (`SidecarError`).

### `scripts/write-fix-brief.mjs` — CLI

```
node scripts/write-fix-brief.mjs --source review|security --attempt <n> [--dir <pipelineDir>] [--cwd <repoRoot>]
```

- `--source` required. `--attempt` required; must parse as an integer `>= 2`.
- `--dir` defaults to `<repoRoot>/.pipeline`. `--cwd` defaults to the real repo root (same
  convention as `write-stamp.mjs`).
- Reads **only** JSON: the source sidecar (`review.json` or `security.json`) via the existing
  readers, and `spec.json` via `readSpecJson`. **Does not open** `review.md`, `security-report.md`,
  or `spec.md`.
- Refuses (exit `1`, write nothing) when any of:
  - source sidecar missing, malformed, or wrong verdict (`review` must be `NEEDS_FIXES`;
    `security` must be `BLOCKED`);
  - `findings` empty after defaulting a missing field to `[]`;
  - a `relatedAc` id is not in `knownSpecIds(specJson)`;
  - `allowedPaths` would be empty.
- `allowedPaths` computation (fail closed if empty):

  ```
  union = unique concatenation of every finding.paths
  allowedPaths = sort(unique(union ∩ (specJson.affectedFiles || [])))
  ```

  A finding path that is not in `affectedFiles` is dropped, not an independent error. If every
  path is dropped, that is the empty-intersection refusal.
- On success: writes `fix-brief.json` (without `stamp`), `fix-brief.md` (human rendering of the
  same fields), and `spec-slice.md` (Goal from `spec.json`; each finding's id/summary/
  requiredOutcome/paths; each `relatedAc` id with its `text` from `spec.json`; `allowedPaths`; a
  one-line notice that `fullSpecStillGoverns` is true and tester/review/security still certify
  every AC/EC). Then runs `node scripts/write-stamp.mjs <dir>/fix-brief.json`. Exit `0`.
- Exit `2` on invocation/tooling error (unrecognized flag, `--attempt` not an integer, reader
  threw for a reason other than the refuse cases above).
- `spec-slice.md` is **not** a JSON sidecar and is not stamped. It is regenerated every successful
  run of this script. It is not a control-decision document.

### Fix-loop refuse (coordinator + `dev`)

Before invoking fix-loop `dev`:

1. Run `node scripts/write-fix-brief.mjs --source <review|security> --attempt <n>`. If it exits
   non-zero, **do not invoke `dev`**.
2. Run `node scripts/check-stamp-freshness.mjs fix-brief.json`. Refuse the invoke unless stdout
   `status` is `"fresh"` (exit `0`). `"stale"` (exit `1`), `"unknown"`, `"absent"`, and exit `2`
   all refuse. This is security-style refusal, not flag-and-proceed.

`dev` itself, when it detects it is on a fix-loop (see below), repeats step 2 and also requires
`readFixBriefJson` to succeed with `fullSpecStillGoverns === true`. Missing/stale/unknown/absent/
malformed → stop, do not implement.

### First attempt vs fix-loop detection

`dev` is on a **fix-loop** when either:

- `.pipeline/review.json` exists, parses, and `verdict === "NEEDS_FIXES"`, or
- `.pipeline/security.json` exists, parses, and `verdict === "BLOCKED"`.

Otherwise it is a **first attempt**: it reads full `spec.md` / `spec.json` as today, and **must
not** read `fix-brief.json` / `fix-brief.md` / `spec-slice.md` even if those files exist
(leftover from another ticket). A leftover brief must not shrink first-attempt context.

When both a current `NEEDS_FIXES` `review.json` and a leftover `BLOCKED` `security.json` exist,
the coordinator passes `--source` for the gate that **just failed this routing step**. `dev` reads
the brief that script just wrote; it does not merge the leftover opposite sidecar.

### `scripts/check-stamp-freshness.mjs`

Register `fix-brief.json` as a known sidecar (seventh, after `red-integrity.json`) using
`readFixBriefJson(dir, { required: false })`. Usage banner and READERS comment name seven
sidecars. `node scripts/check-stamp-freshness.mjs fix-brief.json` must not exit `2` with
`"unrecognized sidecar"`.

### npm / CI

- `package.json` gains `"test:fix-brief": "node --test scripts/write-fix-brief.test.mjs"`.
- `scripts/tsconfig.json` `include` gains `write-fix-brief.mjs` and `write-fix-brief.test.mjs`.
- `.github/workflows/ci.yml` gains one step, next to Pipeline JSON-sidecar contract, running
  `npm run test:fix-brief`.

## Approach

1. Extend `scripts/pipeline-contracts.mjs`: Finding validator; optional `findings` on
   `readReviewJson` / `readSecurityJson`; optional `affectedFiles` on `readSpecJson`; export
   `readFixBriefJson` plus `FINDING_ID_PATTERN` (and keep using existing `SPEC_ID_PATTERN` for
   `relatedAc`).
2. Register `fix-brief.json` in `scripts/check-stamp-freshness.mjs`.
3. Implement `scripts/write-fix-brief.mjs` per the CLI contract. Call `write-stamp.mjs` as the
   last successful step. Never `Read` a markdown report.
4. Update `.sdd/stages/planner.md` so step 4's `spec.json` shape includes `affectedFiles`.
5. Update `.sdd/stages/review.md` output contract: on `NEEDS_FIXES`, write non-empty `findings`
   matching the Fix list (ids `R1`… in list order). Keep full spec↔diff. Do not change integrity
   sidecar consumption.
6. Update `.sdd/stages/security.md` output contract: on `BLOCKED`, write non-empty `findings`
   (ids `S1`…). Keep a full check.
7. Rewrite `.sdd/stages/dev.md` step 2:
   - Detect first-attempt vs fix-loop as specified.
   - First attempt: ignore any leftover brief; full `spec.md`.
   - Fix-loop: refuse unless `fix-brief.json` is fresh; read brief + `spec-slice.md` first; do
     not load full `spec.md` by default; touch only `allowedPaths`; if a required edit is outside
     `allowedPaths`, stop and record the extra paths under **Not done** / **Escalation** — do not
     silently expand; still run the **full** red suite before writing `changes.md`; **Fixes
     applied** maps 1:1 to finding `id`s (every finding id named, none extra).
8. Add one sentence to `.sdd/stages/tester.md`: presence of `fix-brief.json` does not shrink this
   stage — still the full red suite, impact map, and integrity check.
9. Routing: `.sdd/pipeline.md` (keep ≤300 lines), `.sdd/entrypoints/pipeline.md`,
   `pipeline-lite.md`, `dev.md`, `review.md`. `/inline-edit` and `/re-gate` get an explicit
   non-use sentence. Skills and CLAUDE.md routing sentence.
10. CHANGELOG + `.pipeline/README.md`.
11. `package.json` / `tsconfig.json` / one CI step.
12. Do not edit tester's integrity procedure, `check-red-integrity.mjs`, or review's sidecar
    fail-closed rules except to keep them.

## Acceptance criteria

- **AC-1** — `.sdd/pipeline.md` Routing states that on `NEEDS_FIXES` / `BLOCKED` the coordinator
  writes a fix-brief (via `scripts/write-fix-brief.mjs`) before re-invoking `dev`, that a missing
  or stale brief refuses that invoke, that tester/review/security remain full-ticket, and that
  planner/red do not re-run. The 3-attempt cap is unchanged. `node scripts/check-pipeline-slim.mjs`
  still exits 0 and `.sdd/pipeline.md` stays at or under 300 lines.
- **AC-2** — `scripts/write-fix-brief.mjs` exists, implements the CLI in Interfaces, computes
  `allowedPaths` as the sorted unique intersection of finding paths with `spec.json`'s
  `affectedFiles`, fails closed (exit 1, writes nothing) on an empty intersection, empty/missing
  findings, wrong source verdict, or unknown `relatedAc`, and does not open `review.md`,
  `security-report.md`, or `spec.md`.
- **AC-3** — `scripts/pipeline-contracts.mjs` exports `readFixBriefJson` validating the exact
  `fix-brief.json` shape in Interfaces (`source` enum, `attempt` integer `>= 2`, non-empty
  `findings`, non-empty `allowedPaths`, `fullSpecStillGoverns` literally `true`, optional `stamp`).
- **AC-4** — `readReviewJson` accepts a missing `findings` field (legacy `{verdict, stamp}` still
  parses with `findings: []`) and, when `findings` is present, validates it as an array of Finding
  objects. `.sdd/stages/review.md` requires writing a non-empty `findings` array on `NEEDS_FIXES`.
- **AC-5** — `readSecurityJson` has the same additive `findings` contract. `.sdd/stages/security.md`
  requires writing a non-empty `findings` array on `BLOCKED`.
- **AC-6** — `readSpecJson` accepts a missing `affectedFiles` field (legacy spec.json still parses)
  and, when present, validates a unique array of non-empty path strings. `.sdd/stages/planner.md`
  step 4 requires writing `affectedFiles` as the committed paths from Affected files.
- **AC-7** — `scripts/check-stamp-freshness.mjs` accepts `fix-brief.json` as a known sidecar
  (`node scripts/check-stamp-freshness.mjs fix-brief.json` no longer exits 2 with "unrecognized
  sidecar"), and its usage banner / READERS comment name seven sidecars.
- **AC-8** — `.sdd/stages/dev.md` distinguishes first attempt from fix-loop. First attempt ignores
  leftover `fix-brief.json` / `spec-slice.md` and still reads full `spec.md`. Fix-loop reads
  `fix-brief.json` then `spec-slice.md` first, does not load full `spec.md` by default, and
  refuses if the brief is missing, stale, unknown, absent, or malformed.
- **AC-9** — Fix-loop `dev` may touch only `allowedPaths`. If a required edit is outside that set,
  it stops and records the extra paths under Not done / Escalation rather than silently expanding.
  `changes.md`'s Fixes applied maps 1:1 to finding ids.
- **AC-10** — Fix-loop `dev` still runs the full red suite locally before writing `changes.md`
  (same obligation as today's step 4). The brief does not authorize running only the cited tests.
- **AC-11** — `.sdd/stages/tester.md` states that `.pipeline/fix-brief.json` does not shrink this
  stage: full red suite, impact map when usable, and the integrity check (PL-INTEGRITY-TESTER)
  still run. Tester does not read the brief to decide which tests to skip.
- **AC-12** — `.sdd/stages/review.md` still requires full spec↔diff conformance. `relatedAc` on a
  finding is documented as a hint, not a license to ignore other ACs. Integrity remains
  sidecar-consumed (`red-integrity.json`); this ticket does not reintroduce a `red.md` read or a
  `check-red-integrity.mjs` invocation in review.
- **AC-13** — `.sdd/stages/security.md` remains a full check. `.sdd/pipeline.md` / entrypoints
  state that planner and red do not re-run in the fix loop.
- **AC-14** — `.sdd/entrypoints/dev.md` (and `/pipeline` / `/pipeline-lite` coordinators) run
  `write-fix-brief.mjs` immediately before a fix-loop `dev` invoke, and do not invoke `dev` if the
  generator or the freshness check refuses.
- **AC-15** — `.sdd/entrypoints/inline-edit.md` states this lane does not generate or require a
  fix-brief (it skips `dev`; a `NEEDS_FIXES` routes to another inline edit). `.sdd/entrypoints/
  re-gate.md` states `/re-gate` is a hand-edit path, not a scoped-`dev` reroute.
- **AC-16** — `readFixBriefJson` rejects `fullSpecStillGoverns` that is not the literal boolean
  `true` (missing, `false`, `"true"`). The generator always writes `true`.
- **AC-17** — `.sdd/stages/CHANGELOG.md` gains a `## PL-FIXBRIEF` entry above `## PL-INTEGRITY-TESTER`,
  naming every stage file amended and that tester/review/security stay full-ticket.
- **AC-18** — `.pipeline/README.md`'s sidecar table gains `fix-brief.json` / `fix-brief.md` /
  `spec-slice.md` rows, and its Routing paragraph says the coordinator writes a fix-brief before
  re-invoking `dev` rather than sending `dev` at `review.md`'s prose.
- **AC-19** — `package.json` defines `test:fix-brief`; `scripts/tsconfig.json` includes the new
  script and its test; `.github/workflows/ci.yml` runs `npm run test:fix-brief`.
- **AC-20** — `write-fix-brief.mjs` exit 1 (writes nothing) when any finding `relatedAc` id is not
  in `knownSpecIds(specJson)`.
- **AC-21** — `.claude/skills/dev/SKILL.md` and `.claude/skills/pipeline/SKILL.md` name the
  fix-brief generate-then-invoke sequence; they do not instruct fix-loop `dev` to start from full
  `spec.md` or from scraping `review.md`.

## Edge cases

- **EC-1** — Union of finding paths ∩ `affectedFiles` is empty (including `affectedFiles` absent
  or `[]`): generator exit 1, no files written.
- **EC-2** — Source sidecar is `NEEDS_FIXES` / `BLOCKED` but `findings` is missing or `[]`:
  generator exit 1, no markdown scrape.
- **EC-3** — Fix-loop `dev` with `fix-brief.json` missing, stale (`check-stamp-freshness` exit 1),
  unknown (no `stamp`), or failing shape validation: refuse, do not implement.
- **EC-4** — First-attempt `dev` with leftover `fix-brief.json` / `spec-slice.md` on disk: ignore
  them; load full `spec.md`.
- **EC-5** — Some finding paths are in `affectedFiles` and some are not: only the intersection
  becomes `allowedPaths`. If that leftover set is empty, same as EC-1.
- **EC-6** — A brief cites `relatedAc: ["AC-3"]` only: tester still runs the full red suite;
  review still checks every AC/EC. Stage-file text must say this; a test may pin the sentences.
- **EC-7** — Current `review.json` is `NEEDS_FIXES` and a leftover `security.json` is `BLOCKED`:
  coordinator `--source review` for that routing step; do not merge leftover security findings
  into the brief.
- **EC-8** — `--attempt 1` or a non-integer attempt: generator exit 2 (invocation error), writes
  nothing.
- **EC-9** — `write-fix-brief.mjs` source contains no `fs.readFile` / `readFileSync` of
  `review.md`, `security-report.md`, or `spec.md` (asserted by its test via reading the script
  text).
- **EC-10** — After the Routing edit, `.sdd/pipeline.md` is still ≤300 lines and
  `check-pipeline-slim.mjs` exits 0.
- **EC-11** — Widen-escalation (required path outside `allowedPaths`) is recorded as Not done /
  Escalation and counts as one of the three `dev` attempts; `dev` does not rewrite `allowedPaths`.
- **EC-12** — A ledger-shaped `{ "verdict": "PASS" }` `review.json` with no `findings` still
  parses via `readReviewJson` (back-compat). Same for `{ "verdict": "PASS", "runId": "x" }`
  security.json and a spec.json with no `affectedFiles`.
- **EC-13** — `--source review` against a `PASS` `review.json` (or `--source security` against
  `PASS` security.json): generator exit 1.
- **EC-14** — `/inline-edit` on `NEEDS_FIXES` still routes to another inline edit, never to
  scoped-`dev` and never requires `write-fix-brief.mjs` to have succeeded.
- **EC-15** — Duplicate finding `id` in the source sidecar: `readReviewJson` /
  `readSecurityJson` fail closed (same uniqueness rule as `red.json` test paths).

## Open questions

None. Every ambiguity the ticket left (affectedFiles missing on spec.json; findings missing on
review/security JSON; `/dev` vs `/inline-edit`; leftover briefs; Part 4 CI vs this ticket's own
suite) is resolved in Ticket Check and Interfaces.
