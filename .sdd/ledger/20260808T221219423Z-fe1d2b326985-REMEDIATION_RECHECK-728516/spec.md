# PL-11 — A proportionate lite lane for genuinely small tickets

> **Coordinator action required — planner could not execute one step of its own procedure.**
> `.sdd/stages/planner.md` step 5 requires `node scripts/write-stamp.mjs .pipeline/spec.json` as this
> stage's last action. This planner run had no shell/Bash tool available, so `spec.json` was written
> in step 4 **without** its `stamp` field. Run that command now, before invoking `red`. Everything
> downstream that reads `spec.json`'s freshness (`red`, `dev`, `tester`, `review`, and
> `ledger-append.mjs`'s `--re-gate`/`--lite` stamp-presence checks) depends on it; an unstamped
> `spec.json` reads `"unknown"`, never `"fresh"`, from every consumer. This is stated rather than
> silently skipped, per this ticket's own standing rule that an unrunnable step is disclosed, never
> omitted.

## Ticket Check

- **What I'm about to build** — a lighter, officially-blessed way to run a very small change (a typo,
  a one-file cleanup, a doc fix) through the same quality machinery, instead of either paying for the
  full six-stage review every time or quietly editing the file and telling nobody. The small lane
  still leaves a permanent, honest record of what was done and — just as importantly — what was
  *not* checked.

- **What I'm explicitly not doing** — not making the small lane available for anything that isn't
  provably small: a computer counts the files, the lines, and (as of this ticket's security-fix
  round — see "Amendment" below) the length of any single changed line, and refuses if the change
  grew along any of those axes, or if it touches a *curated, best-effort* list of sensitive areas
  (customer-data separation, permissions, secrets, webhook checks, the parts of the system that
  decide who can see what) or the pipeline's own rulebook — curated and best-effort, not a complete
  classifier of every security-sensitive path, exactly as `.sdd/pipeline.md`'s own "Honest limits"
  paragraph already discloses; this bullet originally overstated that gate as more complete than it
  is, corrected here rather than left standing. Not weakening the emergency bypass we already have
  for outages. Not weakening the full pipeline for anything else. Not removing the human approval
  step at the start.

- **How you'll know it worked** — you can ask for a small change with one command, it finishes
  noticeably faster than the full pipeline, and afterwards the permanent log entry for it is clearly
  stamped as a small-lane run, listing in plain words which checks were skipped. If you then ask for
  a change that is *not* small, the tool stops and tells you to use the full pipeline instead —
  it does not quietly let the big change through the small door.

- **What I had to guess** — three things worth your attention. (1) How small is "small": I set the
  limit at 5 files and 150 changed lines, written in one settings file so you can change the number
  later without anyone touching code. (2) Whether a small-lane change should still answer the
  question "which plan governs this file?" when someone debugs it months later: I said yes, but with
  the qualification visible right there in the answer, because the change really was planned and
  really was reviewed — just not security-audited. (3) I made the small lane available to everyone,
  including contributors whose changes are normally fenced to one area, because a fenced person
  fixing a typo in their own area is exactly who this is for; the emergency bypass stays restricted
  as it is today.

## Goal

Give routine, very-small work a sanctioned, proportionate path through the pipeline — a `/pipeline-lite`
lane that runs `planner` → `dev` → `tester` → `review` → ledger, deliberately skipping `red` and
`security`, gated by mechanically-checkable smallness/sensitivity bounds and recorded in the ledger as
a visibly-distinct lite entry that names exactly which stages were skipped. Today the only
alternatives for a one-file maintenance fix are the full six-stage run (disproportionate), `/hotfix`
(requires a production incident), or an unrecorded hand-edit — the D-005 #3 failure the pipeline
exists to prevent.

## Scope

**In scope**

- A new runtime-neutral entry point, `/pipeline-lite <ticket>`, defined as its own section in
  `.sdd/pipeline.md`, plus a thin `.claude/skills/pipeline-lite/SKILL.md` shim.
- Mechanical eligibility: a new `lite_eligibility:` block in `.sdd/bounds.yml`, a human-facing
  section in `.sdd/bounds.md`, and a new committed script `scripts/check-lite-eligible.mjs` that
  computes the verdict (exit `0`/`1`/`2`), reusing `scripts/check-bounds.mjs`'s existing glob matcher
  and bounds reader rather than re-implementing either.
- A `--lite` code path on `scripts/ledger-append.mjs` that writes a visibly-marked, honestly-labelled
  ledger entry, re-checking eligibility against the live diff before writing anything.
- `scripts/build-ledger-index.mjs` support for indexing a lite entry and carrying its qualification
  into every `index.json` record it produces.
- One narrow amendment to `.sdd/stages/tester.md` (red.md's absence is a legitimate state on this
  lane), plus discoverability edits to `.sdd/hotfix.md`, `.sdd/README.md`, `CLAUDE.md`, and
  `.sdd/ledger/README.md`.
- Test coverage in the existing suites for every script touched, plus a new suite for the new script,
  wired into `package.json`, `.github/workflows/ci.yml`, and `scripts/tsconfig.json`.

**Explicitly out of scope**

- **No new subagent stage.** The surviving gate is `review`, unchanged — see AC-2. Nothing is added
  to `.sdd/runtimes.yml`, and no `.claude/agents/*.md` shim is regenerated by this ticket.
- **No reduced `security` mode.** A `LITE_DELTA` run mode in `security-attacker-agents/` (registry,
  two JSON schemas, both validators) is a materially larger change and is not attempted; the lite
  lane skips `security` outright and says so.
- **No change to `/hotfix`'s eligibility, gates, or ledger shape.** The only edit to `.sdd/hotfix.md`
  is one paragraph routing routine small work to `/pipeline-lite` instead of leaving its "Not for …
  a fix that is 'too small to need a spec'" list with no alternative to point at.
- **No `--lite` + `--re-gate` composition.** Deliberately refused in this ticket — see EC-8 and
  Honest limits.
- **No second, lighter-still tier** (e.g. a docs-only lane that skips `dev` too). Not asked for; the
  bounds file is where that would be expressed later if it ever is.
- **No change to the loop cap, routing, or `review`'s own procedure.**
- **No PRD edit.** `docs/PRD_Tickets.md` is not touched by this ticket (PL-11 is a working id).

## Affected files

**New**

- `scripts/check-lite-eligible.mjs` — the mechanical eligibility check (CLI + exported library).
- `scripts/check-lite-eligible.test.mjs` — its suite.
- `.claude/skills/pipeline-lite/SKILL.md` — the Claude Code shim for the new entry point.

**Modified**

- `.sdd/pipeline.md` — the authoritative `### `/pipeline-lite <ticket>`` section; the intro paragraph
  and the "Entry points" preamble list gain the new command; `### `/hotfix <what's broken>`` gains one
  disambiguating sentence.
- `.sdd/bounds.yml` — new `lite_eligibility:` block.
- `.sdd/bounds.md` — new "Lite-lane eligibility" section, including the lane-vs-lane naming
  disambiguation.
- `.sdd/hotfix.md` — one paragraph in "When this is the right call" routing routine small work to
  `/pipeline-lite`.
- `.sdd/ledger/README.md` — new "Lite-lane entries" section.
- `.sdd/README.md` — the directory map's parenthetical entry-point list, and the
  `.claude/skills/*/SKILL.md` paragraph, gain `/pipeline-lite`.
- `.sdd/stages/tester.md` — Required inputs item 1 and the Output contract's "Red suite result"
  bullet.
- `.sdd/stages/CHANGELOG.md` — a `## PL-11` section recording the `tester` amendment.
- `CLAUDE.md` — the "Agent pipeline" section's related-commands list.
- `scripts/check-bounds.mjs` — `readBounds()` also returns `liteEligibility`.
- `scripts/check-bounds.test.mjs` — cases for the above.
- `scripts/ledger-append.mjs` — the `--lite` path.
- `scripts/ledger-append.test.mjs` — `[lite]`-tagged cases.
- `scripts/build-ledger-index.mjs` — `readLiteField`, the verdicts branch, the index-record
  decoration.
- `scripts/build-ledger-index.test.mjs` — cases for the above.
- `scripts/sdd-completeness.test.mjs` — doc-structure assertions for the new lane.
- `package.json` — `check:lite-eligible` and `test:lite-eligible`.
- `.github/workflows/ci.yml` — a step running `npm run test:lite-eligible`.
- `scripts/tsconfig.json` — `"check-lite-eligible.mjs"` and `"check-lite-eligible.test.mjs"` added to
  `include`.
- `.sdd/ledger/index.json` — regenerated (no content change expected; `npm run check:ledger-index`
  must still pass).

## Interfaces / signatures

### `.sdd/bounds.yml` — new block

```yaml
# Lite-lane eligibility (PL-11). A different axis from `lanes:` above: `lanes` fence WHICH PATHS a
# ticket may touch; this block bounds HOW SMALL a change must be to skip `red` and `security` via
# /pipeline-lite. All three bounds are checked mechanically by scripts/check-lite-eligible.mjs and
# re-checked against the live diff by scripts/ledger-append.mjs --lite before it writes anything.
#
# There is deliberately NO third barred-path list here: the lite lane's barred set is the computed
# union of `hotfix_barred_paths` and `deny_for_fenced_lanes` above (see
# scripts/check-lite-eligible.mjs's `liteBarredPaths`).
lite_eligibility:
  max_files: 5
  max_changed_lines: 150
  max_line_length: 500
```

> **Amended in this ticket's security-fix round** (originally shipped with only `max_files` and
> `max_changed_lines`) — see "Amendment (security-fix round)" at the end of this document for the
> finding, the reasoning, and the exact redTestChanges declaration.

### `scripts/check-bounds.mjs`

```js
// return shape gains one key; every existing key and every existing caller is unchanged
export function readBounds(): {
  lanes: Record<string, string[]>,
  denyForFenced: string[],
  hotfixBarredPaths: string[],   // widened by this ticket's security-fix round — see Amendment below
  liteEligibility: { maxFiles: number, maxChangedLines: number, maxLineLength: number } | null,  // null when absent/malformed
}
```

`liteEligibility` is `null` — never a `die()` — when the block is missing or any one of the three
keys is absent or not a non-negative integer. `readBounds()` is imported by `ledger-append.mjs`'s
`--hotfix` path, and `die()` calls `process.exit(2)`; failing closed is the *consumer's* job (see
EC-16), so this reader stays non-fatal for a fact `--hotfix` does not use.

### `scripts/check-lite-eligible.mjs` (new)

```
Usage:
  node scripts/check-lite-eligible.mjs                        # live working tree (default)
  node scripts/check-lite-eligible.mjs --files <path...>      # explicit list; path/count checks only
  node scripts/check-lite-eligible.mjs --base main            # merge-base <base>..HEAD
  node scripts/check-lite-eligible.mjs --json

Exit 0 = eligible. Exit 1 = ineligible. Exit 2 = the check could not be performed.
```

The `1`/`2` split is the same one `check-bounds.mjs` already documents and for the same reason:
collapsing "the check failed" into "the change is clean" is how a broken gate reads as a passing one.
`--files` consumes every remaining argument and must be last (the convention `check-bounds.mjs` and
`ledger-append.mjs --hotfix` already use).

```js
// LITE_VIOLATION_KINDS gains 'line-length' in this ticket's security-fix round — see Amendment below.
export const LITE_VIOLATION_KINDS = ['barred-path', 'file-count', 'changed-lines', 'unsizable', 'line-length'];

/** union(hotfixBarredPaths, denyForFenced), deduped and sorted — no third list in bounds.yml. */
export function liteBarredPaths(bounds): string[]

/** Live working tree: `git diff --name-only HEAD` plus `git ls-files --others --exclude-standard`.
 *  Same two commands scripts/ledger-append.mjs's `filesTouched` already uses. */
export function resolveWorktreeFiles(cwd?: string): string[]

/** added+deleted across `files`. Tracked changes come from `git diff --numstat` (HEAD, or
 *  `merge-base <base>..HEAD` when `base` is given); an untracked file contributes its own line
 *  count. A numstat row reporting `-`/`-` (binary) yields no number — its path lands in
 *  `unsizable` and the change is ineligible (EC-4). */
export function countChangedLines(files: string[], options?: { cwd?: string, base?: string | null }):
  { changedLines: number | null, unsizable: string[] }

/** NEW in this ticket's security-fix round (see Amendment below / EC-21): the length of the single
 *  longest content line added or removed across `files`, tracked (a full `git diff`, not `--numstat`,
 *  which reports counts only) or untracked (the file's own longest line, read directly). Returns `0`
 *  for an empty `files` list. The orthogonal size dimension `countChangedLines` cannot express — a
 *  diff shaped as a very few, very long lines measures as deceptively few "changed lines." */
export function maxChangedLineLength(files: string[], options?: { cwd?: string, base?: string | null }): number

/** Pure. `changedLines: null` (and, independently, `lineLength: null`) means "not measured" (the
 *  `--files` path-only mode), which sets `changedLinesChecked`/`lineLengthChecked` to `false` and
 *  does NOT by itself make a change ineligible — the refusing check is the one ledger-append.mjs runs
 *  against the live diff. `lineLength` is NEW in this ticket's security-fix round. */
export function evaluateLiteEligibility(input: {
  files: string[],
  changedLines: number | null,
  unsizable?: string[],
  lineLength?: number | null,
  bounds?: ReturnType<typeof readBounds>,
}): {
  eligible: boolean,
  fileCount: number,
  changedLines: number | null,
  changedLinesChecked: boolean,
  lineLength: number | null,
  lineLengthChecked: boolean,
  maxFiles: number | null,
  maxChangedLines: number | null,
  maxLineLength: number | null,
  violations: Array<{ kind: string, path?: string, detail: string }>,
}
```

`evaluateLiteEligibility` throws (CLI: exit `2`) when `bounds.liteEligibility` is `null` — a missing
bound is never read as "no bound."

### `scripts/ledger-append.mjs`

```js
// Usage (new):
//   node scripts/ledger-append.mjs --lite [--override-review "<reason>"]

export const LITE_SKIPPED_STAGES = ['red', 'security'];      // fixed, derived — never caller-supplied
export const LITE_SECURITY_VERDICT = 'SKIPPED_LITE';
export const LITE_NOTE = '<the fixed disclosure sentence — see below>';

/** One implementation of the `<timestamp>-<shortsha>-<MODE>-<random>` id shape. */
export function generateRunId(mode: string, options?: { cwd?: string }): string
export function generateHotfixRunId(options?: { cwd?: string }): string  // delegates to generateRunId('HOTFIX', ...)

export function buildEntryMarkdown({ /* existing */, lite = null }): string
export function buildEntryJson({ /* existing */, lite = null }): object
function copySidecarsIntoLedger(runId: string, names?: string[]): void
```

`LITE_NOTE` is a fixed constant (the same reasoning `REGATE_NOTE` already uses — a fixed string cannot
quietly drift from what `.sdd/ledger/README.md` documents it as):

> this run took the lite lane (`.sdd/pipeline.md`'s `/pipeline-lite`): `red` did not author tests
> before `dev` ran, so any test covering this change was written after the diff existed; and the
> `security` stage did not run at all — no attacker-brief sweep, no CORE-01..06 pass, and no immutable
> audit record exists for this run. Eligibility was checked mechanically against `.sdd/bounds.yml`'s
> `lite_eligibility` bounds and the barred-path union, which is a curated, best-effort list, not a
> complete classifier of security-sensitive code.

`--lite` is a **branch inside `main()`**, not a separate `runLite()`: it shares essentially every
precondition `main()` already enforces (`review.json`, the unconditional `spec.json`/`spec.md`
agreement check, `filesTouched`, the run-directory overwrite guard, entry construction). `--hotfix`
is a separate function because it shares almost none of them. A parallel copy here would be the
"copied instead of shared" failure `.sdd/README.md` says this whole directory exists to fix.

`entry.json` for a lite run:

```json
{
  "runId": "20260808T...-<sha>-LITE-<rand>",
  "date": "2026-08-08",
  "ticket": "PL-11",
  "ticketTitle": "...",
  "goal": "...",
  "filesTouched": ["..."],
  "verdicts": { "review": "PASS", "security": "SKIPPED_LITE" },
  "overrides": [],
  "bypass": false,
  "regate": null,
  "lite": {
    "skippedStages": ["red", "security"],
    "note": "<LITE_NOTE>",
    "eligibility": { "fileCount": 2, "changedLines": 37, "maxFiles": 5, "maxChangedLines": 150 }
  },
  "redTestPaths": [],
  "redAbsenceNote": "The `red` stage was deliberately skipped by the lite lane — not a ticket that predates `red`, and not a run where `red` produced nothing.",
  "securityRunId": null,
  "commit": { "sha": "...", "dirty": true }
}
```

`bypass` derivation, amended:

```js
const bypass = reviewVerdict !== 'PASS' || (!lite && securityVerdict !== 'PASS');
```

`entry.md` for a lite run: title `# Ledger entry — <runId> (LITE)` (markers compose in the order
`(RE-GATE)`, `(LITE)`, `(OVERRIDE)`), a `## Lite lane` section immediately after `## Verdicts`,
`## Security run ID` reading `(none — the security stage did not run on this lane; see "## Lite lane"
above)`, and `## Red-test paths` carrying the lite-specific absence note.

### `scripts/build-ledger-index.mjs`

```js
/** Optional, null for every entry.json written before this field existed and for every non-lite run.
 *  Only `skippedStages` is read here — `note`/`eligibility` are entry.json-only detail this query
 *  index deliberately does not duplicate (same reasoning readRegateField already applies). */
function readLiteField(raw, label): { skippedStages: string[] } | null

function readEntryJson(runId): {
  runId, ticket, date, filesTouched, bypass,
  regate: { testerRan: boolean } | null,
  lite: { skippedStages: string[] } | null,
}
```

Verdicts gate, amended (only when `bypass` is falsy):

- `lite` non-null → `verdicts` must be exactly `{ review: "PASS", security: "SKIPPED_LITE" }` **and**
  `lite.skippedStages` must include `"security"`.
- `lite` null → the existing byte-for-byte `{ review: "PASS", security: "PASS" }` check, unchanged.
- `verdicts.security === "SKIPPED_LITE"` with no `lite` object is refused outright (EC-15).

Index record for a lite run gains `lite: { skippedStages }` alongside `runId`/`ticket`/`date`/`spec`,
omitted entirely (not `null`) on every other run — the same shape and reasoning `regate: { testerRan }`
already uses.

### `.sdd/pipeline.md` — new section shape

`### `/pipeline-lite <ticket>``, placed between `### `/pipeline <ticket>`` and
`### Per-stage entry points`, containing: the routing disambiguation (not `/hotfix`, not `/re-gate`),
a numbered procedure (eligibility → planner → *red skipped* → dev → tester → review → *security
skipped* → ledger → report), the routing/loop-cap reuse statement, the escalation route out of the
lane, and an **Honest limits** paragraph.

### `.sdd/stages/tester.md` — amendment

Required inputs item 1 currently stops the stage when `red.md` is missing. Amended so `red.md`'s
absence is legitimate on the lite lane specifically, while keeping the D-018 guarantee intact: tester
still never authors a behavioral test, states plainly in `test-results.md`'s "Red suite result"
section that no red suite exists for this run and why, and reports gaps rather than filling them —
which is *more* consequential on this lane, not less, since no `red` stage covered anything.

## Approach

1. **Bounds first.** Add `lite_eligibility:` to `.sdd/bounds.yml`. Extend `readBounds()` in
   `scripts/check-bounds.mjs` to parse it into `liteEligibility` (or `null`), leaving every existing
   key, caller, and CLI behavior untouched. Add cases to `scripts/check-bounds.test.mjs`.
2. **The eligibility script.** Write `scripts/check-lite-eligible.mjs` per the signatures above,
   importing `readBounds`/`matchesAny` from `check-bounds.mjs` (never re-implementing globbing or the
   YAML read). Guard its `main()` with the same `process.argv[1] === import.meta.url` check
   `check-bounds.mjs` uses, so importing it from `ledger-append.mjs` never triggers its CLI. Write
   `scripts/check-lite-eligible.test.mjs`. Wire `package.json` (`check:lite-eligible`,
   `test:lite-eligible`), `.github/workflows/ci.yml`, and `scripts/tsconfig.json`.
3. **The ledger path.** In `scripts/ledger-append.mjs`: add `--lite` to `MAIN_KNOWN_FLAGS`; extract
   `generateRunId(mode)` and make `generateHotfixRunId` delegate to it; add `LITE_SKIPPED_STAGES` /
   `LITE_SECURITY_VERDICT` / `LITE_NOTE`; parameterize `copySidecarsIntoLedger`; thread `lite` through
   `buildEntryMarkdown`/`buildEntryJson` and amend the `bypass` derivation; add the `--lite` branch to
   `main()` with the preconditions in AC-7's order. Add `[lite]`-tagged cases to
   `scripts/ledger-append.test.mjs`.
4. **The index.** In `scripts/build-ledger-index.mjs`: add `readLiteField`, the verdicts branch, and
   the record decoration. Add cases to `scripts/build-ledger-index.test.mjs`.
5. **The docs.** `.sdd/pipeline.md`'s new section (the authoritative definition), then
   `.sdd/bounds.md`, `.sdd/ledger/README.md`, `.sdd/hotfix.md`, `.sdd/README.md`, `CLAUDE.md`,
   `.sdd/stages/tester.md`, and a `## PL-11` entry in `.sdd/stages/CHANGELOG.md`.
6. **The shim.** `.claude/skills/pipeline-lite/SKILL.md`, thin and consistent with the existing ones
   (frontmatter `name`/`description`/`disable-model-invocation: true`/`argument-hint`; body points at
   `.sdd/pipeline.md`'s section and restates only the things most easily lost).
7. **Doc assertions.** Add the AC-1/AC-2/AC-13/AC-17-shaped structural assertions to
   `scripts/sdd-completeness.test.mjs`, using that file's existing `sectionBetween`/`coOccurs`
   helpers so they pin concepts and section structure, not prose.
8. **Verify**, in CLAUDE.md's order: `npx tsc --noEmit -p scripts/tsconfig.json` (via
   `npm run typecheck:scripts`), then `npm run test:bounds test:lite-eligible test:ledger-append
   test:ledger-index test:sdd-completeness` (individually), then `npm run check:ledger-index`, then
   `npm run lint`.

## Acceptance criteria

- **AC-1** — `.sdd/pipeline.md` contains a `### `/pipeline-lite <ticket>`` section that defines the
  lane runtime-neutrally: the fail-closed eligibility gate first, the exact stages run
  (`planner` → `dev` → `tester` → `review` → ledger), the two stages deliberately skipped (`red`,
  `security`), reuse of the existing routing and 3-attempt loop cap, the mandatory ledger step, and
  the disambiguation from `/hotfix` and `/re-gate`. The command also appears in that file's intro
  paragraph and its "Entry points" preamble list.

- **AC-2** — The lite lane introduces **no new subagent stage**: the surviving review-shaped gate is
  `review` itself, unchanged, and `.sdd/pipeline.md`'s new section says so explicitly, naming
  `scripts/guard-checker-readonly.mjs`'s `READ_ONLY_AGENTS` set as where that stage's read-only
  property is structurally enforced. `.sdd/runtimes.yml` and every file under `.claude/agents/` are
  unchanged by this ticket.

- **AC-3** — The surviving verdict gate keeps the JSON-sidecar contract unchanged: the decision is
  read from `.pipeline/review.json` through `scripts/pipeline-contracts.mjs`'s strict reader, its
  `stamp` comes from `scripts/write-stamp.mjs`, and `--lite` refuses on a `STALE` `review.json` via
  the existing `refuseIfStale`. No markdown file is parsed for any lite control decision anywhere in
  this ticket.

- **AC-4** — `.sdd/bounds.yml` carries a `lite_eligibility:` block with `max_files`,
  `max_changed_lines`, and (added in this ticket's security-fix round — see Amendment below)
  `max_line_length`, and `.sdd/bounds.md` carries a matching human-facing section that (a)
  disambiguates `lanes:` (a path fence) from the lite lane (which stages run), and (b) states that
  lite's barred-path set is the computed union of `hotfix_barred_paths` and `deny_for_fenced_lanes`
  — no third list. `hotfix_barred_paths` itself (one of the two lists the union draws from, not a new
  list) was widened in the same fix round — the "no third list" constraint governs the union
  *mechanism*, not either list's contents, so widening an existing list honors it.

- **AC-5** — `readBounds()` in `scripts/check-bounds.mjs` additionally returns
  `liteEligibility: { maxFiles, maxChangedLines, maxLineLength } | null` (the `maxLineLength` key
  added in this ticket's security-fix round), returning `null` (never exiting) when the block is
  absent or any one of the three keys is missing/malformed. Every existing return key, every existing
  caller (`main()`, and `ledger-append.mjs`'s `--hotfix` path), and `check-bounds.mjs`'s CLI behavior
  are unchanged.

- **AC-6** — `scripts/check-lite-eligible.mjs` exists and computes the eligibility verdict
  mechanically, exiting `0` (eligible) / `1` (ineligible) / `2` (could not run), supporting `--files`,
  `--base`, and `--json`, and refusing an unrecognized argument by name. It imports `readBounds` and
  `matchesAny` from `scripts/check-bounds.mjs` rather than re-implementing glob matching or the
  bounds read, and exports `evaluateLiteEligibility`/`countChangedLines`/`resolveWorktreeFiles`/
  `liteBarredPaths`/`maxChangedLineLength` (the last one added in this ticket's security-fix round)
  for in-process reuse.

- **AC-7** — `node scripts/ledger-append.mjs --lite` writes a lite ledger entry only after every one
  of these holds, checked in this order, refusing with exit `1` and writing nothing (not even a
  partial run directory) on the first failure: `--lite` is not combined with `--override-security` or
  `--re-gate`; `review.json` exists, is not `STALE`, and reads `PASS` (or is accepted via
  `--override-review "<reason>"`); no `FRESH`-stamped `security.json` exists; `spec.md`/`spec.json`
  exist, agree on the ticket, and `spec.json` carries a `stamp`; `.pipeline/test-results.md` exists;
  the live touched-file set is eligible under `evaluateLiteEligibility`; and
  `.sdd/ledger/<runId>/` does not already exist.

- **AC-8** — A lite run's `entry.json` carries `lite: { skippedStages: ["red","security"], note,
  eligibility: { fileCount, changedLines, maxFiles, maxChangedLines } }` with `skippedStages` and
  `note` **derived by the script, never caller-supplied**; `verdicts: { review: "PASS", security:
  "SKIPPED_LITE" }`; `securityRunId: null`; `redTestPaths: []` with a lite-specific
  `redAbsenceNote`; `regate: null`; `overrides: []`; and `bypass: false`.

- **AC-9** — A lite run's `entry.md` is headed `# Ledger entry — <runId> (LITE)` and carries a
  `## Lite lane` section, placed immediately after `## Verdicts`, naming the skipped stages, the
  fixed disclosure note (what was therefore not verified), and the eligibility numbers this run was
  measured against.

- **AC-10** — `buildEntryJson`'s `bypass` derivation is amended to
  `reviewVerdict !== 'PASS' || (!lite && securityVerdict !== 'PASS')`, so an ordinary lite entry is
  `bypass: false` (and therefore indexed) while `--lite --override-review` still produces
  `bypass: true` (and therefore excluded), exactly like any other overridden entry.

- **AC-11** — `scripts/build-ledger-index.mjs` indexes a lite entry rather than excluding it, and
  carries `lite: { skippedStages }` into every `index.json` record that run produces. Its verdicts
  gate accepts `{ review: "PASS", security: "SKIPPED_LITE" }` **only** when the entry declares a
  `lite` object whose `skippedStages` includes `"security"`, and continues to enforce byte-for-byte
  `{ review: "PASS", security: "PASS" }` on every other non-bypass entry.

- **AC-12** — `.sdd/ledger/README.md` carries a "Lite-lane entries" section documenting the exact
  `lite`/`verdicts` shape, the decision to index a lite entry (with its reason, and the contrast
  against a `--hotfix`/override entry's exclusion), and what a lite entry structurally lacks: no
  `security/` copy, no `security.json`, no `red.json`.

- **AC-13** — `.claude/skills/pipeline-lite/SKILL.md` exists, is thin and consistent with the other
  shims (frontmatter `name`, `description`, `disable-model-invocation: true`, `argument-hint`; body
  pointing at `.sdd/pipeline.md`'s section without restating its procedure), and
  `scripts/sdd-completeness.test.mjs` gains a generalized assertion that every `### `/<command>``
  section in `.sdd/pipeline.md` has a matching `.claude/skills/<command>/SKILL.md`.

- **AC-14** — Wiring exists and is gated: `package.json` declares `check:lite-eligible` and
  `test:lite-eligible`; `.github/workflows/ci.yml` runs `npm run test:lite-eligible`;
  `scripts/tsconfig.json`'s `include` lists both new files. (`scripts/sdd-completeness.test.mjs`'s
  two existing generalized assertions — "every `scripts/*.test.mjs` has a `test:*` script and a CI
  step" and "every `check:<suffix>` has a `test:<suffix>` naming a real file" — must pass without
  being weakened.)

- **AC-15** — Test coverage exists for every script touched: a new `scripts/check-lite-eligible.test.mjs`,
  plus `[lite]`-tagged cases added to `scripts/ledger-append.test.mjs`,
  `scripts/build-ledger-index.test.mjs`, and `scripts/check-bounds.test.mjs`. No existing assertion in
  any of those suites is weakened or removed to accommodate this change.

- **AC-16** — `.sdd/stages/tester.md` is amended so `red.md`'s absence is a legitimate state on the
  lite lane (state it, do not stop), while its D-018 guarantee is preserved verbatim in force: tester
  still never authors a behavioral test and still reports gaps rather than filling them. The Output
  contract's "Red suite result" bullet requires an explicit statement when no red suite exists.
  `.sdd/stages/CHANGELOG.md` records the round. No other stage file's procedure is changed.

- **AC-17** — `.sdd/pipeline.md`'s new section carries an "Honest limits" paragraph naming, in the
  same voice the existing docs use, exactly what this lane gives up: `red`'s spec-first ordering (any
  test for this ticket is written after the diff exists — the D-018 inversion, reintroduced
  deliberately and only here), `security`'s full attacker-brief sweep, the CORE-01..06 mandatory
  checks, and the immutable `.pipeline/security-history/` audit record; that the barred-path list is
  curated and best-effort rather than a complete classifier; and the fail-closed default that
  ambiguous eligibility routes to `/pipeline`.

- **AC-18** — The lane is discoverable from where a person actually looks: `.sdd/hotfix.md`'s "When
  this is the right call" section routes "a fix that is 'too small to need a spec'" to
  `/pipeline-lite` instead of leaving that list with no alternative; `CLAUDE.md`'s Agent pipeline
  related-commands list and `.sdd/README.md`'s directory map and skills paragraph both name it.

## Edge cases

- **EC-1** — Eligibility is ambiguous or unknown at entry (the paths cannot be named confidently, or
  `check-lite-eligible.mjs` exits `2`): route to `/pipeline`. Ambiguity is ineligibility; the lane is
  never entered provisionally. The same routing table covers the two adjacent cases: a small change
  during a production incident is `/hotfix`, and a small change on a barred path is `/pipeline`.

- **EC-2** — The realized diff exceeds `max_files`, `max_changed_lines`, or (added in this ticket's
  security-fix round — see EC-21) `max_line_length` at ledger time: `--lite` refuses (exit `1`),
  naming the actual counts, the bounds they exceeded, and the sanctioned escalation (run `/security`,
  then the plain `node scripts/ledger-append.mjs`). No ledger entry and no partial run directory are
  written.

- **EC-3** — The realized diff touches a path in the barred union: `--lite` refuses, naming every
  matching path and which list it came from. The union's `hotfix_barred_paths` half was widened in
  this ticket's security-fix round (see Amendment below) to also cover
  `services/core/src/services/**`, `services/core/src/routes/**`, `services/core/src/mcp/**`,
  `services/workers/**`, and `services/gateway/**` — closing a gap where a change to any of those
  five directories could read as eligible.

- **EC-4** — A binary (or otherwise unsizable) file appears in the diff — `git diff --numstat`
  reports `-`/`-` for it: the change is ineligible. A change that cannot be measured is never
  measured as small.

- **EC-5** — `.pipeline/review.json`'s `stamp` is `STALE`: `--lite` refuses via the existing
  `refuseIfStale`, unchanged from the plain path, and still refuses when `--override-review` is
  supplied (an override accepts a real non-`PASS` verdict, never one computed against a tree that has
  since moved on).

- **EC-6** — `.pipeline/review.json` reads `NEEDS_FIXES`: `--lite` refuses unless
  `--override-review "<reason>"` is supplied; with it, the entry is written, `bypass` is `true`, and
  the entry is excluded from `index.json`'s file→spec map exactly like any other overridden entry.

- **EC-7** — `--lite --override-security`: refused, naming why — there is no security verdict on this
  lane to override, and accepting the flag silently would imply one existed.

- **EC-8** — `--lite --re-gate`: refused in this ticket, naming the route (finish through the full
  lane — run `/security`, then `--re-gate` — or re-run `/review` against the current tree and use
  plain `--lite`, which the non-stale `review.json` requirement already forces).

- **EC-9** — A `.pipeline/security.json` exists whose `stamp` reads `FRESH`: `--lite` refuses and
  points at the plain `node scripts/ledger-append.mjs`. A security run that genuinely happened
  against this tree must never be recorded as `SKIPPED_LITE`.

- **EC-10** — A `.pipeline/security.json` exists whose stamp reads `STALE` or `unknown` (a leftover
  from a prior ticket): it is ignored for this run's verdict, with an explicit printed note saying so,
  and is never copied into the lite entry.

- **EC-11** — A `.pipeline/red.json` exists (a leftover, or `red` genuinely ran earlier in this
  checkout): a lite entry never copies it and never lists its tests as this run's red-test paths.
  `redAbsenceNote` states that `red` was deliberately skipped by the lite lane — not the existing
  "predates the `red` stage" wording, which would be a different and false claim.

- **EC-12** — `.pipeline/test-results.md` is missing: `--lite` refuses, saying `tester` still runs on
  this lane and naming which stage must run first.

- **EC-13** — `.pipeline/spec.json` carries no `stamp`: `--lite` refuses, the same hygiene check
  `--re-gate` already applies, and for a stated reason — `--lite` has no security-history
  cross-check to compensate, so the one signal that `spec.json` went through its documented authoring
  path is required here. As with `--re-gate`, this is presence-and-shape, never proof of provenance.

- **EC-14** — `.pipeline/spec.json`'s ticket disagrees with `.pipeline/spec.md`'s first-heading
  ticket: the existing unconditional agreement check refuses, on the `--lite` path exactly as on
  every other. Pinned as a regression so the new branch cannot accidentally bypass a check that is
  currently unconditional.

- **EC-15** — An `entry.json` claims `verdicts.security: "SKIPPED_LITE"` with no `lite` object, or
  with a `lite.skippedStages` that omits `"security"`: `build-ledger-index.mjs` refuses to index the
  run and `--check` fails loudly. A non-lite entry can never launder a skipped gate into an indexed
  one.

- **EC-16** — `.sdd/bounds.yml`'s `lite_eligibility` block is absent or malformed:
  `readBounds().liteEligibility` is `null`, `check-lite-eligible.mjs` exits `2`, and
  `ledger-append.mjs --lite` refuses. A missing bound is never read as "no bound," and `--hotfix`'s
  own use of `readBounds()` is unaffected.

- **EC-17** — The working tree is already clean (the fix is committed) and there is no
  `changes.json`: `filesTouched`'s existing loud failure applies unchanged, and — where it does
  return a list — eligibility is still evaluated against it; if nothing can be sized, the check
  reports "could not run" and `--lite` refuses rather than recording an unmeasured change as small.

- **EC-18** — `.sdd/ledger/<runId>/` already exists: refuse rather than overwrite, the same guard
  `main()` already applies, reached on the lite path too.

- **EC-19** — A previous run's ledger output (`.sdd/ledger/<prior-run>/…`, `.sdd/ledger/index.json`)
  is still uncommitted in the working tree when the next lite run reaches its ledger step: those
  paths are under `.sdd/**`, which is in the barred union, so the run is refused. The refusal message
  says to commit the previous ledger entry first. Recorded as a known, accepted cost rather than
  carved out — a carve-out for `.sdd/ledger/**` would also permit a lite ticket to rewrite committed
  ledger history with no security pass.

- **EC-20** — A lite run and a full run both touch the same file: `index.json[<file>]` holds both
  records, and the lite one carries `lite: { skippedStages }` so a reader following the fast path
  (buggy file → `index.json`) sees the attribution is qualified without a second hop into
  `entry.json` — the same reasoning `regate: { testerRan }` already uses.

- **EC-21** — (Added in this ticket's security-fix round — security round FND-22ef4b5c746e, MEDIUM.)
  The realized diff is shaped as a very few, very long lines — e.g. one line replaced with tens of
  thousands of characters of new content — such that `changedLines` stays comfortably under
  `max_changed_lines` while the diff carries real, substantial content: `max_line_length` is the
  orthogonal bound `evaluateLiteEligibility`/`maxChangedLineLength` check independently of line count,
  and `--lite` refuses (exit `1`) on it exactly like any other eligibility violation, naming the
  measured length and the bound it exceeded. Enforced fail-closed the same way as the other two
  bounds (EC-16): a `lite_eligibility` block missing `max_line_length` reads as `null`, never as "no
  bound."

## Open questions

**None blocking.** Four judgment calls the ticket left open were resolved here rather than deferred,
each recorded with its reason so a human can overturn one without re-deriving the argument:

1. **The numeric bounds** (`max_files: 5`, `max_changed_lines: 150`, and — added in this ticket's
   security-fix round, see "Amendment" below — `max_line_length: 500`). Chosen to match "small
   maintenance issues or very, very small scope," and placed in `.sdd/bounds.yml` specifically so
   tuning them later needs no code change and leaves a git-reviewed diff.
2. **Lite entries are indexed** into `index.json`'s file→spec map, with the qualification carried
   into the record. A lite run genuinely has a ratified spec that `review` genuinely passed against
   the final tree — the exact argument `.sdd/ledger/README.md` already makes for including a
   `--re-gate` entry. Excluding it would answer "which spec governs this file" with silence when a
   real, reviewed spec exists.
3. **The lite lane is available to fenced lanes**, unlike `/hotfix`. A fenced contributor fixing a
   typo inside their own lane is the archetypal user of this lane; and the barred union already
   contains `deny_for_fenced_lanes`, so no lite run of any lane can touch the pipeline's own
   governing files. `/hotfix`'s `full`-only restriction is untouched.
4. **`--lite` does not compose with `--re-gate`** in this ticket. Refused explicitly rather than left
   undefined, to bound the state space; the non-stale `review.json` requirement already forces the
   gate to be re-run against the current tree, which is most of what a re-gate would have added here.

One architectural-rule check, stated rather than assumed: nothing in this ticket touches `org_id`
handling, RBAC filtering, secrets, webhook validation, or the Graph Query Service, and nothing here
weakens `.claude/rules/security-multitenancy.md`. It does *narrow* when the security stage runs — but
only for changes a committed, mechanically-checked bound proves touch none of those surfaces, which
is the same trade `/hotfix` already makes on strictly weaker terms (it skips `review` as well).
Note the self-referential consequence, worth stating plainly: **PL-11 itself is ineligible for the
lane it builds** — it touches `.sdd/**`, `.claude/**`, `.github/workflows/**`, and
`scripts/check-bounds.mjs`, all of which are in the barred union. This ticket must go through the
full pipeline.

## Amendment (security-fix round)

Written by `dev`, not `planner` — the sanctioned "spec was wrong" edge case this ticket's own pipeline
convention allows a fix round to use directly, per the coordinator's explicit instruction on this
round. Security returned `BLOCKED` on the third (final) dev attempt with two findings, both reproduced
live against this implementation, not hypothetical. Both are fixed; this section is the disclosure.

**FND-b731f500c5b8 (SEC-10 v4, HIGH) — the barred-path union did not cover five product-code
directories.** `liteBarredPaths()`'s union (`hotfix_barred_paths` ∪ `deny_for_fenced_lanes`) did not
include `services/core/src/services/**` (the service layer that stamps `org_id` on every write —
CLAUDE.md's "Architecture rules"), `services/core/src/routes/**` (request entry points ahead of RBAC
filtering), `services/core/src/mcp/**` (MCP tool handlers and key issuance/verification — CLAUDE.md's
"MCP keys" convention), `services/workers/**` (the Python ingestion fleet), or `services/gateway/**`
(the WebSocket gateway's per-push RBAC re-filtering). Security reproduced a ~44KB single-line
replacement of a `services/core/src/services/**` file measuring `changedLines: 2` and reading
ELIGIBLE.

*The AC-4 tension, resolved:* AC-4 requires "no third list" — the fix does not add one. The five paths
were added to `hotfix_barred_paths` itself, the existing list this union already draws from, not to a
new lite-specific list. `hotfix_barred_paths` already documents itself as "which product-code paths a
bypass may never touch, regardless of lane," and these five paths are squarely inside that category —
widening its *contents* is not the same question as adding a *third list*, and AC-4's constraint is on
the latter. The alternative considered and rejected: widening `deny_for_fenced_lanes` instead — rejected
because that list answers a different question ("who may edit the pipeline's own governing rules"), not
"which product code is too sensitive for a bypass to touch"; conflating the two would also silently
change what a *fenced* ticket may touch on the ordinary (non-bypass) path, which neither finding asked
for.

*The disclosed knock-on effect:* `hotfix_barred_paths` is read by `/hotfix` too (`readBounds()` is
shared), so this widening makes `/hotfix` itself refuse a change touching any of the five new
directories — not only `/pipeline-lite`. This is deliberate, not incidental: both bypass a stage that
would otherwise catch exactly this class of defect (`/hotfix` skips `security` entirely;
`/pipeline-lite` skips it conditionally), so the same list correctly governs both, and a fix that
widened it for one lane but not the other would leave `/hotfix` re-exposed to the identical gap.
`.sdd/hotfix.md`'s "Honest limits" and `.sdd/pipeline.md`'s `/hotfix` eligibility-gate list are both
updated to name the widened set.

Changed: `.sdd/bounds.yml` (`hotfix_barred_paths` gains the five entries above, comment updated),
`.sdd/hotfix.md`, `.sdd/pipeline.md` (both the `/hotfix` gate list and `/pipeline-lite` step 1),
`.sdd/bounds.md`. Red-test declaration: `scripts/check-lite-eligible.test.mjs`'s `boundsYml()` fixture
(a synthetic, independent bounds.yml per that suite's own header comment) gains the same five entries,
plus a new test asserting each of the five is barred; `scripts/ledger-append.test.mjs` gains a new
`[lite]` test reproducing a realized diff against each of the five directories. See
`.pipeline/changes.json`'s `redTestChanges` for the exact, re-derived deltas.

**FND-22ef4b5c746e (SEC-10 v5, MEDIUM) — `max_changed_lines` alone is defeated by few, very long
lines.** A diff shaped as a very few, very long lines (the same ~44KB single-line fixture above)
measured `changedLines: 2`, comfortably under `max_changed_lines` (150), while carrying real,
substantial content — `max_changed_lines` counts LINES, not their size.

*The fix:* a second, orthogonal bound, `max_line_length` (500 characters), added to
`.sdd/bounds.yml`'s `lite_eligibility:` block, `scripts/check-bounds.mjs`'s `parseLiteEligibility`
(now requires all three keys — a `lite_eligibility` block missing any one is `null`, exactly EC-16's
existing "a missing bound is never read as 'no bound'" rule extended to the new key), and a new
exported function `scripts/check-lite-eligible.mjs#maxChangedLineLength(files, options)` — the longest
single content line added or removed across the diff (tracked, via a full `git diff`, never
`--numstat`, which reports counts only; or untracked, via the file's own content) — checked by
`evaluateLiteEligibility` as a fifth violation kind, `'line-length'`, added to `LITE_VIOLATION_KINDS`.
Both `scripts/check-lite-eligible.mjs`'s own CLI (`main()`) and `scripts/ledger-append.mjs`'s `--lite`
branch compute and pass it — fail-closed in both entry points, not only the standalone CLI security
exercised.

No AC-4/third-list tension here — this bound lives inside the *existing* `lite_eligibility:` block
(AC-4 already names that block; it does not enumerate its keys), not a new file or list.

`entry.json`'s `lite.eligibility` shape (AC-8: `{ fileCount, changedLines, maxFiles, maxChangedLines
}`) is deliberately **not** widened to also carry the line-length measurement — a scope-minimization
choice, not an oversight: the security-mandated requirement is the mechanical *gate* refusing
fail-closed (which it now does, in both entry points, per above), not the persisted ledger record's
exact shape; widening it would touch `scripts/ledger-append.test.mjs`'s existing exact-keys assertion
(`Object.keys(entryJson.lite.eligibility).sort()`) for no requirement either finding asked for. The
refusal message a caller actually sees already names the measured length and the bound via the
generic per-violation `detail` string, so this is a disclosed reduction in *ledger* completeness, not
in *enforcement*.

Changed: `.sdd/bounds.yml` (`lite_eligibility:` gains `max_line_length: 500`, comment updated),
`scripts/check-bounds.mjs`, `scripts/check-lite-eligible.mjs`, `scripts/ledger-append.mjs`,
`.sdd/bounds.md`, `.sdd/pipeline.md` (step 1's bound list). New edge case **EC-21** above documents
the behavior; **AC-4/AC-5/AC-6** above are amended to reflect the new key/export. Red-test
declaration: `scripts/check-lite-eligible.test.mjs` (the `LITE_VIOLATION_KINDS` array assertion, the
`boundsYml()`/`boundsObject()` default-shape helpers, a new malformed-block case, and new
line-length-bound tests), `scripts/check-bounds.test.mjs` (the real-`bounds.yml` `liteEligibility`
`deepEqual`, a new malformed-block case), `scripts/ledger-append.test.mjs` (a new `[lite]` test
reproducing the exploit shape against a realized diff). See `.pipeline/changes.json`'s
`redTestChanges` for the exact, re-derived deltas.

## Coordinator action required (restated)

`node scripts/write-stamp.mjs .pipeline/spec.json` has **not** been run — planner had no shell tool
available in this run. Run it before invoking `red`.
