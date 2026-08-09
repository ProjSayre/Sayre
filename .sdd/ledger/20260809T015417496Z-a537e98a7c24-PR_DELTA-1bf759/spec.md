# PL-12 — /inline-edit: a sanctioned, spec-first front door for a direct in-session edit

## Ticket Check

**What I'm about to build.** A new, named way to make a change: you say what you want, the system
writes down what it's going to do *before* anything is edited, then you make the edit yourself in
the conversation, and the usual checks run afterward. At every pause it tells you plainly what is
still owed before the change counts as properly recorded, and when it's finished it files a
permanent record that says, in so many words, "a person made this edit by hand — an assistant did
not build it from the plan."

**What I'm explicitly not doing.** I am not making it possible to skip the write-it-down step — the
whole point is that it refuses to let an edit happen until a plan exists. I am not building a way
around the emergency path or the re-check path; those keep working exactly as they do today. I am
not changing anything about how the existing ways of running the pipeline behave, and I am not
touching the product itself — this is entirely about the process the team uses to make and record
changes.

**How you'll know it worked.** Ask for a small change this new way. Before anything is edited you
should see a written plan and a plain list of what you'll owe by the end. After the edit and the
checks, look in the permanent record folder: there should be a new entry whose very first line is
marked as an inline edit, with a section saying which steps were deliberately skipped, your stated
reason for doing it by hand, and how large the change actually was. If you try to file that record
without having written a plan first, or without naming which piece of work it belongs to, the
command should refuse rather than file it anyway.

**What I had to guess.** Three things the request left open, each resolved one way rather than the
other. First, I decided this new path does *not* borrow the size limit the existing "small change"
path uses — that limit exists because the small-change path skips the security review, and this one
doesn't, so importing it would be a rule with no reason behind it. Instead the size is measured and
written into the record without blocking anything, so it is visible rather than pretended away.
Second, I decided the person must type a short reason for editing by hand, the same way the
emergency path already demands a written reason — no reason, no record. Third, I decided a new,
clearly-labelled record type is genuinely necessary rather than reusing an existing label: every
existing label carries a fixed sentence that would be factually untrue about this kind of change.

## Goal

Give a direct, in-session edit — no prior pipeline run, no production incident — a sanctioned front
door: `/inline-edit`, a lane that mechanically refuses to let any code change happen before a real,
ratified `spec.md`/`spec.json` exists for it, then runs `tester` → `review` → `security` in full
against the edited tree, states at every stop exactly what is still owed for the record, and ends in
a ledger entry that is visibly and structurally distinct from a full run — one that says plainly that
the implementation was a direct inline edit and that `red` never ran. Today that path is either an
unrecorded hand-edit (the D-005 #3 failure) or a disproportionate full `/pipeline` run.

## Scope

**In scope**

- A new runtime-neutral entry point, `### \`/inline-edit <ticket>\``, in `.sdd/pipeline.md`, including
  its obligations checklist, its routing/refusal table, and its "Honest limits" paragraph.
- A thin Claude Code shim at `.claude/skills/inline-edit/SKILL.md`.
- A new `--inline` flag family on `scripts/ledger-append.mjs` (`--inline --ticket <id> --why-inline
  "<reason>"`), disclosure-only, relaxing no gate.
- The matching `inline` field read/carry in `scripts/build-ledger-index.mjs`.
- Documentation of the new entry shape in `.sdd/ledger/README.md`.
- The one stage-file amendment the lane requires: `.sdd/stages/tester.md`'s treatment of an absent
  `red.md`, widened from "`/pipeline-lite` only" to also cover this lane, plus a `.sdd/stages/CHANGELOG.md`
  entry recording it.
- Discoverability edits: `CLAUDE.md`'s related-commands list, `.sdd/README.md`'s directory map and its
  `.claude/skills/*/SKILL.md` paragraph.
- `[inline]`-tagged test coverage in the three existing suites that cover the touched scripts and docs.

**Explicitly out of scope**

- `docs/PRD_Tickets.md` — the ticket forbids editing it. PL-12 is not registered there by this run.
- Any new stage. `.sdd/runtimes.yml` and `.claude/agents/**` are untouched; `/inline-edit` is an entry
  point that composes existing stages, exactly as `/pipeline-lite` is.
- Any new bounds block. `.sdd/bounds.yml` is untouched — see Recorded decision D-2 for why the lite
  size/barred-path gate is deliberately **not** imported onto this lane, and no third list is added.
- Any new script file. PL-12 adds flags to two existing scripts and therefore needs no new
  `package.json` script, no new `.github/workflows/ci.yml` step, and no new `scripts/tsconfig.json`
  include.
- `scripts/check-lite-eligible.mjs` — imported as a library for its existing `countChangedLines`/
  `maxChangedLineLength` exports (already imported by `ledger-append.mjs` today); not modified.
- `/pipeline-status` — not taught about the inline lane in this ticket (PL-11 likewise did not teach
  it about the lite lane); noted rather than silently skipped.
- `.sdd/hotfix.md` — unchanged. Its "not for a fix too small to need a spec" item already routes to
  `/pipeline-lite`; an inline edit is not "too small to need a spec" (this lane *forces* one), so
  there is no honest hook for a pointer there.
- Any authorization scheme. `--why-inline` is a **disclosure** requirement, exactly like
  `--override-*` and `--hotfix`'s five fields: nothing verifies who invoked it.

## Affected files

Existing files, modified:

- `.sdd/pipeline.md` — new `### \`/inline-edit <ticket>\`` section. **Placement is load-bearing, not
  cosmetic:** put it between the existing `### \`/re-gate [--gates-only] [--ticket <id>]\`` section and
  `### \`/hotfix <what's broken>\``. Two reasons. (a) Semantically it is the third member of the
  outside-the-ordinary-sequence family, in escalating order: `/re-gate` re-verifies after a hand-edit,
  `/inline-edit` gates a hand-edit being made deliberately, `/hotfix` runs no gate at all. (b)
  Mechanically, `scripts/sdd-completeness.test.mjs`'s `pipelineLiteSection()` helper slices
  `sectionBetween(pipeline, '### \`/pipeline-lite', '### Per-stage entry points')` — putting the new
  section anywhere inside that range would silently widen every existing `[lite]` assertion's search
  window (see EC-20). Also add one clause in the file's opening paragraph and one in the
  `## Entry points` preamble.
- `.sdd/ledger/README.md` — new `## Inline-edit entries (PL-12, \`/inline-edit\`)` section, placed after
  `## Lite-lane entries` and before `## The query path`.
- `.sdd/stages/tester.md` — Required inputs item 1 and the Output contract's "Red suite result" bullet.
- `.sdd/stages/CHANGELOG.md` — new `## PL-12` entry, placed above the existing `## PL-11` entry.
- `.sdd/README.md` — the `pipeline.md` line of the directory map; the `.claude/skills/*/SKILL.md`
  paragraph under "The generated surfaces".
- `CLAUDE.md` — the `## Agent pipeline` related-commands list (a new bullet after `/pipeline-lite`).
- `scripts/ledger-append.mjs` — the `--inline` flag family (see Interfaces).
- `scripts/build-ledger-index.mjs` — `readInlineField`, `readEntryJson`'s return shape, `buildIndex`'s
  record decoration.
- `scripts/ledger-append.test.mjs` — `[inline]`-tagged cases.
- `scripts/build-ledger-index.test.mjs` — `[inline]`-tagged cases.
- `scripts/sdd-completeness.test.mjs` — `[inline]`-tagged cases. The section-slicing helper these use
  is `sectionBetween(read('.sdd/pipeline.md'), '### \`/inline-edit', '### \`/hotfix')` — a new helper
  alongside `pipelineLiteSection()`, never a widening of it.

New files, created:

- `.claude/skills/inline-edit/SKILL.md` — does not exist yet; a thin shim in the style of
  `.claude/skills/pipeline-lite/SKILL.md` and `.claude/skills/re-gate/SKILL.md`.

Files deliberately **not** touched (assert this, don't assume it): `docs/PRD_Tickets.md`,
`.sdd/runtimes.yml`, `.sdd/bounds.yml`, `.sdd/bounds.md`, `.sdd/hotfix.md`, `.claude/agents/**`,
`scripts/check-lite-eligible.mjs`, `scripts/check-bounds.mjs`, `scripts/pipeline-contracts.mjs`,
`package.json`, `.github/workflows/ci.yml`, `scripts/tsconfig.json`, and every `.sdd/stages/*.md`
file other than `tester.md`/`CHANGELOG.md`.

## Interfaces / signatures

### `scripts/ledger-append.mjs`

New usage line (added to the file's own header usage block):

```
node scripts/ledger-append.mjs --inline --ticket <id> --why-inline "<reason>"
  [--override-review "<reason>"] [--override-security "<reason>"]
```

New module-level constants (exported, so tests and the ledger README pin the same strings the script
actually writes — the same reason `REGATE_NOTE`/`LITE_NOTE`/`LITE_SKIPPED_STAGES` are constants):

```js
/** Fixed, derived — never caller-supplied. `dev` is listed because the stage did not run, not
 *  because no implementation happened: the implementation was made directly, inline. */
export const INLINE_SKIPPED_STAGES = ['red', 'dev'];

/** The fixed inline-lane disclosure sentence entry.json's `inline.note` carries verbatim. */
export const INLINE_NOTE = '...';   // exact text below, under Approach step 6

/** The fixed red-absence note for this lane — never the plain path's
 *  "predates the red stage / genuinely produced nothing" disjunction, which is false here. */
export const INLINE_RED_ABSENCE_NOTE = '...';   // exact text below, under Approach step 6

/** Everything the default set carries except red.json — the same "never manufacture evidence of a
 *  stage that did not run this round" reasoning LITE_SIDECAR_NAMES already uses. */
const INLINE_SIDECAR_NAMES = ['spec.json', 'changes.json', 'review.json', 'security.json'];
```

New/changed functions:

```js
/** Reads `--ticket`'s value off argv. Returns null when the flag is absent; fails loudly (naming
 *  the flag) when present-but-empty or flag-shaped. Extracted from readRegateArgs so --re-gate and
 *  --inline share one implementation of "read this caller assertion," not two. */
function readTicketFlag(argv): string | null

/** Returns null when `--inline` is absent. Otherwise `{ ticket, reason }`, both non-empty —
 *  refusing, naming the missing flag, if `--ticket` or `--why-inline` is absent/empty/flag-shaped. */
function readInlineArgs(argv): { ticket: string, reason: string } | null

/** CHANGED SIGNATURE. `--ticket` is legal with `--re-gate` OR `--inline`; the existing
 *  "--ticket was given without --re-gate" refusal now fires only when neither is present. */
function readRegateArgs(argv, { inline = false } = {}): { testerRan, gatesOnly, ticket } | null

/** Disclosure-only measurement of how large the change that skipped `red` actually was. Reuses the
 *  already-imported countChangedLines/maxChangedLineLength. Returns null (never throws, never
 *  refuses) when either measurement fails — this is a recorded fact, not a gate. */
function measureInlineSize(files: string[]):
  { fileCount: number, changedLines: number, maxLineLength: number, unsizable: string[] } | null

/** CHANGED SIGNATURE — one new optional field, defaulting to null, matching how `regate`/`lite`
 *  were each added. */
export function buildEntryMarkdown({ /* ...existing... */, inline = null })
export function buildEntryJson({ /* ...existing... */, inline = null })
```

`entry.json`'s `inline` object (always present as a key; `null` on every non-`--inline` run):

```json
"inline": {
  "skippedStages": ["red", "dev"],
  "reason": "<--why-inline's value, verbatim>",
  "note": "<INLINE_NOTE, verbatim>",
  "size": { "fileCount": 3, "changedLines": 84, "maxLineLength": 118, "unsizable": [] }
}
```

`size` is `null` when measurement failed (EC-13). `unsizable` lists paths that could not be
line-counted (binary or unreadable), so `changedLines` is never silently understated (EC-14).

`entry.md` for a `--inline` run: title `# Ledger entry — <runId> (INLINE)`; markers compose in the
order `(RE-GATE)(INLINE)(LITE)(OVERRIDE)` (only `(INLINE)` and `(INLINE) (OVERRIDE)` can actually
occur — `--inline` refuses `--re-gate` and `--lite`); a `## Inline edit` section placed immediately
after `## Verdicts` (the same slot `## Lite lane`/`## Re-gate` claim; all three are mutually
exclusive), rendering `note` verbatim, then the skipped stages, then the reason, then the measured
size or an explicit "could not be measured" line. `## Security run ID` and `## Red-test paths` behave
as on the plain path except that the latter renders `INLINE_RED_ABSENCE_NOTE`.

### `scripts/build-ledger-index.mjs`

```js
/** The exact twin of readLiteField: strict, fail-closed, `null` for an entry with no `inline` key
 *  (back-compat — every entry written before PL-12 has none). Only `skippedStages` is carried into
 *  index.json; `reason`/`note`/`size` are entry.json-only detail. */
function readInlineField(raw, label): { skippedStages: string[] } | null

// readEntryJson's return shape gains one field:
//   { runId, ticket, date, filesTouched, bypass, regate, lite, inline }

// buildIndex()'s per-record decoration gains one line, mirroring regate/lite exactly:
if (entry.inline) record.inline = { skippedStages: entry.inline.skippedStages };
```

The verdicts gate is **unchanged**: an inline entry's `verdicts` is the ordinary byte-for-byte
`{ "review": "PASS", "security": "PASS" }`. `inline` is not a widening case the way `lite`'s
`SKIPPED_LITE` is, because `security` genuinely ran on this lane.

### `.sdd/pipeline.md`'s new section — the lane, as a numbered procedure

```
### `/inline-edit <ticket>`
  0. Refuse/route first (see the "Not this lane" table).
  1. Invoke planner. Nothing may be edited until .pipeline/spec.md AND .pipeline/spec.json exist,
     spec.json carries a stamp, and its ticket matches the ticket being worked. STOP A.
  2. Make the edit directly, in this session. No `dev` subagent. Bounded by spec.md's Affected files.
  3. Author .pipeline/changes.md and .pipeline/changes.json per `.sdd/stages/dev.md`'s output
     contract (steps 7-8), then `node scripts/write-stamp.mjs .pipeline/changes.json`. Say in
     changes.md's own first line that it was authored by the inline editor, not the `dev` stage.
     STOP B.
  4. Invoke tester. STOP C.
  5. Invoke review; if PASS, invoke security. STOP D.
  6. node scripts/ledger-append.mjs --inline --ticket <id> --why-inline "<reason>". STOP E.
```

## Approach

Build in this order.

**1. `.sdd/pipeline.md`'s section (do this first — it is the authoritative definition every other
artifact points at).** Write the numbered procedure above, then five things it must also carry:

- **The obligations checklist, at each of five named stops.** Each stop states, in the same shape:
  what has been produced so far and where it lives; which gates are still owed; which ledger command
  will apply at the end (`node scripts/ledger-append.mjs --inline --ticket <id> --why-inline
  "<reason>"`, or that same command composed with `--override-review`/`--override-security` for a
  non-`PASS` outcome); and what will be recorded where (`.sdd/ledger/<run-id>/`, the `(INLINE)`
  marker, `entry.json`'s `inline` object, and the `inline: { skippedStages }` decoration on every
  `index.json` record for this run's files). Stop A states the whole list *before the edit exists*,
  which is the point: a person learns what they will owe before they incur it.
- **The abnormal-stop obligation.** Entering this lane creates an obligation that only two things
  discharge: finishing it (a ledger entry, plain or `--override-*`), or reverting the edit. Say
  plainly that an abandoned inline lane leaves an unrecorded hand-edit on disk — the exact D-005 #3
  failure this lane exists to replace — and that "the gates said no, so I stopped" is not a
  discharge unless the edit is also reverted or the outcome recorded.
- **The "Not this lane" routing table.** Production is broken → `/hotfix`. A `review.json` already
  exists for this ticket from a prior run and the tree was hand-edited after it → `/re-gate`. You
  want an agent to implement it from the spec → `/pipeline` (or `/pipeline-lite` if small). The
  change is one where a spec-first test would genuinely have earned its keep → `/pipeline`. Include
  the lite-vs-inline decision (D-3 below) in prose here.
- **"Honest limits"**, naming at minimum: (a) `red` does not run, so any test covering this change
  was written after the diff existed — the D-018 inversion, reintroduced deliberately here as it is
  on the lite lane, but **at any size**, with no mechanical size bound (see D-2); (b) no `dev`-stage
  isolation — the implementer and the session are one context, and `changes.md`/`changes.json` are
  self-reported by the editor rather than by an agent that only ever saw the spec; (c) the "do not
  run `/red` on this lane" rule is **unenforced** — a `red.json` written this round is
  indistinguishable at ledger time from a leftover, because `red` runs before the edit and its stamp
  is therefore stale by construction (the same unenforceable shape `--lite` already carries for
  `red.json`); (d) `--ticket` verifies *which ticket* `spec.json`/`spec.md` are about, and the
  `stamp` check verifies only presence and shape — neither proves `planner` actually ran this round,
  the same honest limit `/re-gate` already states; (e) `--why-inline` is disclosure, not
  authorization — nothing verifies who supplied it.
- **The routing/loop-cap reuse sentence.** `NEEDS_FIXES`/`BLOCKED` routes back to *another inline
  edit* (not `/dev`), then re-runs `tester`/`review`(/`security`), under the existing 3-attempt cap.
  This lane defines no second cap and no second loop. `red` still never runs — and specifically must
  not be run *after* the fix, which would be the D-018 inversion wearing a spec-first label.

Also add `/inline-edit` to the file's opening paragraph and to the `## Entry points` preamble.

**2. `.claude/skills/inline-edit/SKILL.md`.** Frontmatter: `name: inline-edit`, a one-paragraph
`description`, `disable-model-invocation: true`, `argument-hint: <ticket description or path to a
ticket file>`. Body: point at `.sdd/pipeline.md`'s section as authoritative, say "do not restate the
procedure here," and restate only the refusals most easily lost, in the style
`.claude/skills/re-gate/SKILL.md` uses: never edit before the spec exists; never derive `--ticket`
from `spec.json` (same circularity warning `/re-gate` carries — the value is the caller's own
assertion); never author a red test after the edit; never leave the lane without either a ledger
entry or a revert. Keep it under 60 lines.

**3. `scripts/ledger-append.mjs` — argv and refusals.** Add `--inline` and `--why-inline` to
`MAIN_KNOWN_FLAGS`; add `--why-inline` to `MAIN_VALUE_FLAGS` (`--ticket` is already there). Extract
`readTicketFlag`; thread `{ inline }` into `readRegateArgs`. In `main()`, immediately after the
existing `--lite` mutual-exclusion block and **before any `.pipeline/` file is read**, add the
`--inline` mutual-exclusion block (`--inline --lite`, `--inline --re-gate`), so those refusals can
never be confused with a later check firing for an unrelated reason.

**4. `scripts/ledger-append.mjs` — preconditions.** All additive; none relaxes an existing check.
Extend the existing `if (regate || lite)` stamp-presence check to `if (regate || lite || inline)`,
with the inline-specific clause in its message: the inline lane has no `dev` stage whose own
procedure guarantees a freshly-written `spec.json`, so presence-and-shape is the one hygiene signal
available. Add the `--inline` ticket cross-check next to `--re-gate`'s (identical body; the
unconditional `spec.json`↔`spec.md` agreement check already above it covers `spec.md` transitively —
do not duplicate it). Add existence checks for `.pipeline/changes.md`, `.pipeline/changes.json`, and
`.pipeline/test-results.md`, each with its own named refusal explaining why this lane specifically
requires it.

**5. `scripts/ledger-append.mjs` — red handling.** Force `redJson = null` on the inline path, the
same way the lite path already does (`const redJson = (lite || inline) ? null : readRedJson(...)`),
and set `redTestPaths = []` and `redAbsenceNote = INLINE_RED_ABSENCE_NOTE`. Pass
`INLINE_SIDECAR_NAMES` to `copySidecarsIntoLedger`. `copySecurityHistoryIntoLedger(runId)` still runs
— unlike lite, there is a real security run — and `runId`/`securityRunId` still come from
`findCompletedSecurityRun`, not a minted id.

**6. `scripts/ledger-append.mjs` — the disclosure.** Build `inlineInfo = { skippedStages:
INLINE_SKIPPED_STAGES, reason: inlineArgs.reason, note: INLINE_NOTE, size: measureInlineSize(candidateFiles) }`
and thread it into `buildEntryMarkdown`/`buildEntryJson`, plus a `console.log` line on success in the
style of the existing `--re-gate`/`--lite` lines, stating that the entry is **not** excluded from
`index.json`'s file→spec map and why. Exact fixed strings:

> `INLINE_NOTE` — "this run took the inline-edit lane (`.sdd/pipeline.md`'s `/inline-edit`): the
> implementation was a direct edit made in a live session, not a `dev`-stage run, so
> `changes.md`/`changes.json` are the editor's own self-report rather than a separate agent's; and
> `red` did not run, so any test covering this change was written after the diff already existed. A
> real `spec.md`/`spec.json` was ratified before the edit, and `tester`, `review`, and `security` all
> ran in full against the edited tree. This lane has no mechanical size bound — the measured size of
> the change is recorded below so a reader can judge for themselves how much skipped `red`."

> `INLINE_RED_ABSENCE_NOTE` — "The `red` stage was deliberately not invoked on the inline-edit lane
> (`.sdd/pipeline.md`'s `/inline-edit`) — this is neither a legacy ticket predating `red`'s own
> existence nor a run where `red` ran and produced nothing; it was never invoked for this run at all."

**7. `scripts/build-ledger-index.mjs`.** Add `readInlineField` as the exact twin of `readLiteField`,
thread `inline` through `readEntryJson`'s return, add the one `buildIndex` decoration line. Touch the
verdicts gate not at all.

**8. `.sdd/ledger/README.md`.** New `## Inline-edit entries` section: the exact `entry.json` shape,
the `(INLINE)` title marker and `## Inline edit` section, the `index.json` decoration, why the entry
is **indexed rather than excluded** (the same argument the re-gate and lite sections already make: a
real, ratified spec that `review` — and here also `security` — genuinely passed against the final
tree), and what it structurally lacks (**no `red.json`**, and why a leftover is never copied).

**9. `.sdd/stages/tester.md` + `.sdd/stages/CHANGELOG.md`.** Widen Required inputs item 1's "one
legitimate exception (PL-11)" to name both lanes, and the Output contract's "Red suite result"
bullet likewise. Keep the D-018 guarantee's wording untouched. Add a `## PL-12` changelog entry above
`## PL-11` naming `tester.md` as the only stage file amended and why.

**10. Discoverability, then tests.** `CLAUDE.md`, `.sdd/README.md` (both sites). Then `[inline]`-tagged
cases in the three suites, following the two conventions the `[lite]` block's header already records
(wrap every `coOccurs` alternation in a non-capturing group; no `$` anchors, `\r?\n` for literal
newlines — every file read is CRLF here).

### Recorded decisions (with reasoning), rather than open questions

**D-1 — Scripts ARE touched: a new `--inline` flag is necessary, and no existing entry shape can
honestly record this run.** Checked against all four existing shapes:

- **Plain path.** Renders byte-identically to a full six-stage run: `regate: null`, `lite: null`,
  `overrides: []`, no title marker. It would also write `redAbsenceNote`'s existing disjunction ("either
  it predates the `red` stage… or this run genuinely produced no ledger-relevant tests") — **both
  branches false here**, exactly the reason PL-11 gave lite its own note. Fails the ticket's "never
  disguised as a full run" requirement outright.
- **`--re-gate`.** Mechanically it would run, but `REGATE_NOTE` is a fixed constant whose second
  clause — "changes.md/changes.json describe the tree as it stood **before** that edit" — is **false**
  on this lane, where `changes.md` is written *after* and *about* the edit. Writing a known-false
  fixed sentence into an append-only record is disqualifying. `.sdd/ledger/README.md` additionally
  defines a re-gate entry as one where the pipeline "already ran at least once for this ticket," and
  `/re-gate`'s own step 1 requires a pre-existing `review.json` — an inline run has neither. Reusing
  it would require either faking a precondition or lying in a durable record.
- **`--lite`.** Records `verdicts.security: "SKIPPED_LITE"` and `skippedStages: ["red","security"]`.
  Security genuinely runs on this lane, so both are false; it would also re-check lite eligibility and
  refuse any change over the size bound (see D-2), and would refuse outright on a fresh `security.json`
  — which is precisely what this lane produces.
- **`--override-*`.** The only free-text channel on the whole script, but a flag against an
  already-`PASS` gate is inert by design and produces no `overrides` entry — there is no way to attach
  a disclosure to a clean-`PASS` entry through it.

Conclusion: no existing shape can carry "the implementation was a direct inline edit, not a dev-stage
run" without writing something false. The new flag is modeled as closely as possible on `--re-gate` —
a **disclosure-only marker on the plain path that relaxes no gate** — and reuses `--lite`'s existing
patterns for red-exclusion, sidecar-set narrowing, the fixed-note constant, and the `index.json`
`{ skippedStages }` decoration, rather than inventing parallel machinery for any of them.

**D-2 — the lite size/barred-path gate is deliberately NOT imported onto this lane.** `/pipeline-lite`'s
bounds exist because that lane skips `security`: `.sdd/bounds.yml`'s `hotfix_barred_paths` header says
in as many words that these are "the paths where the adversarial pass is load-bearing," and
`max_files`/`max_changed_lines`/`max_line_length` bound how much code escapes both `red` and `security`.
On this lane `security` runs in full, so the barred-path half has no applicable rationale, and the size
half would be a bound reasoned from a premise that does not hold — it would look rigorous while blocking,
for example, a legitimate inline fix under `services/core/src/services/**` that the security stage does
in fact cover. Importing it would also re-open the gap the ticket names: a live-session edit of eight
files would again have no sanctioned door, which is where unrecorded hand-edits come from. What replaces
the bound is disclosure with real numbers: the change's size is measured with the same helpers lite uses
and written into the entry, **never gating anything**, so an auditor can later ask "how big were the
changes that skipped `red`?" and get an answer. A third bounds block was rejected for the reason
`.sdd/bounds.yml` already states about itself: no third list.

**D-3 — lite-vs-inline is a stated human choice, not a computed one, and neither is a fallback for the
other.** They differ on two axes at once (who implements; which gates run), and neither dominates:
`/pipeline-lite` keeps `dev`-stage isolation and skips `security`; `/inline-edit` runs `security` and
gives up `dev`-stage isolation. So the recorded rule is: **if you are not actually making the edit
yourself, use `/pipeline-lite` (when eligible) or `/pipeline` — this lane's premise is an edit a human or
the live session is genuinely making by hand.** The founder's "must not be used for routing around
`/pipeline-lite` eligibility" is recorded as stated, with the honest observation that routing that way
gets you *more* gates, not fewer (security runs), so the real prohibition worth enforcing socially is the
other one: do not use this lane to skip `red` on work where a spec-first test would have earned its keep.

**D-4 — `--ticket <id>` is required on `--inline`, and is the mechanically-checkable half of "spec-first,
forced."** `/re-gate` needs it because it is the one path reaching the ledger with no `planner` run; the
inline lane's whole premise is that `planner` *did* run, so requiring the flag costs one argument and buys
the one check that catches "spec.md/spec.json are leftovers from a different ticket" — i.e. the failure
mode in which the lane's central promise was silently not kept. Unlike the plain `/security` path (where
the founder's SEC-10 v3 concern lives, and where no independent ticket assertion exists in the call chain),
`/inline-edit <ticket>` already carries the human's assertion at invocation, so the check is non-circular.
The same circularity warning `/re-gate` states is restated in this lane's section and shim.

**D-5 — tester always runs; there is no `--gates-only`/`--tester-ran` knob on this lane.** `/re-gate` needs
`--tester-ran` because skipping tester is a legitimate, ledger-visible choice there. Here the lane already
gives up `red`; making `tester` optional too would leave a change with no test gate at all. Tester's having
run is mechanically evidenced by the required `.pipeline/test-results.md`, so nothing needs recording.

**D-6 — available on any lane, including a fenced one.** `/hotfix` is `full`-only because it removes the
human check a fence exists to guarantee. This lane removes no such check — `review` and `security` both run
in full — so, exactly like `/pipeline-lite`, it is available on any lane, and `.sdd/bounds.yml`'s
`deny_for_fenced_lanes` keeps applying through the ordinary lane mechanism, unchanged.

**D-7 — `changes.md` remains non-durable, and that is not a regression.** Considered copying `changes.md`
into the ledger entry so the editor's prose survives; rejected as scope creep that would change the
ledger's per-run file set for one lane only. `--why-inline`'s recorded reason plus `changes.json`'s
`filesChanged` carry the durable half, which is the same durability every other lane already has.

### Verification (per CLAUDE.md)

`npx tsc --noEmit` (the two touched `.mjs` scripts are covered by `scripts/tsconfig.json`'s `checkJs`),
then `npm run test`, then `npm run lint`. Also run `node scripts/build-ledger-index.mjs --check` — it must
still report the index as up to date against the pre-existing entries (EC-17).

**Coordinator note:** this planner run cannot execute shell commands. Before `red` starts, the coordinator
must run `node scripts/write-stamp.mjs .pipeline/spec.json` — `.sdd/stages/planner.md` step 5. Without it
`spec.json` carries no `stamp`, and this ticket's own `--inline` stamp-presence check (and `--re-gate`'s,
and `--lite`'s) would refuse at the end of a run against it.

## Acceptance criteria

- **AC-1** — `.sdd/pipeline.md` gains a `### \`/inline-edit <ticket>\`` section, placed between
  `### \`/re-gate ...\`` and `### \`/hotfix ...\``, defining the lane runtime-neutrally end to end:
  refuse/route → `planner` (spec-first gate) → the direct inline edit (no `dev` subagent) →
  editor-authored `changes.md`/`changes.json` + `write-stamp.mjs` → `tester` → `review` → `security` →
  `node scripts/ledger-append.mjs --inline --ticket <id> --why-inline "<reason>"`, naming `red` and `dev`
  as **deliberately skipped** rather than merely omitting them.
- **AC-2** — that section states the obligations checklist at five named stops (after planner/before any
  edit; after the edit; after tester; after review+security; after the ledger step), and each stop names
  what has been produced, which gates remain owed, which exact ledger command applies, and what gets
  recorded where.
- **AC-3** — that section states the abnormal-stop obligation explicitly: an abandoned inline lane writes
  no ledger entry and leaves an unrecorded hand-edit on disk (the D-005 #3 failure), and is discharged only
  by finishing the lane (plain, or composed with `--override-review`/`--override-security` for a non-`PASS`
  outcome) or by reverting the edit.
- **AC-4** — that section carries an "Honest limits" paragraph naming, at minimum: no `red` (tests written
  after the diff — the D-018 inversion, **at any size**, with no mechanical size bound and why lite's is
  deliberately not imported); no `dev`-stage isolation and self-reported `changes.md`; the "do not run
  `/red` here" rule being unenforced and why it cannot be detected at ledger time; and that `--ticket` plus
  the `stamp` check verify which ticket and shape, never that `planner` ran this round.
- **AC-5** — that section carries a "not this lane" routing table covering a production incident
  (`/hotfix`), re-verifying a run that already has a `review.json` (`/re-gate`), wanting an agent to
  implement it (`/pipeline` or `/pipeline-lite`), and a change where a spec-first test would earn its keep
  (`/pipeline`) — plus the recorded lite-vs-inline rule (D-3) in prose.
- **AC-6** — `/inline-edit` is named in `.sdd/pipeline.md`'s opening paragraph and in its `## Entry points`
  preamble, not only inside its own section.
- **AC-7** — `.claude/skills/inline-edit/SKILL.md` exists, opens with YAML frontmatter carrying `name:
  inline-edit`, a non-empty `description`, `disable-model-invocation: true`, and a non-empty
  `argument-hint`; its body points at `.sdd/pipeline.md` as authoritative, restates only the
  easily-lost refusals, and stays under 60 lines.
- **AC-8** — `.sdd/ledger/README.md` gains an "Inline-edit entries" section documenting the exact
  `entry.json` shape (pinning the literals `skippedStages`, `reason`, `note`, `size`), the `(INLINE)`
  title marker and `## Inline edit` section, the condensed `index.json` `inline: { skippedStages }`
  decoration, the reason the entry is **indexed rather than excluded**, and the fact that it carries no
  `red.json`.
- **AC-9** — `.sdd/stages/tester.md`'s Required inputs item 1 and its Output contract "Red suite result"
  bullet name the `/inline-edit` lane alongside `/pipeline-lite` as legitimate `red.md`-absent cases, with
  the D-018 guarantee unchanged; `.sdd/stages/CHANGELOG.md` gains a `## PL-12` entry naming `tester.md` as
  the only stage file amended; no other `.sdd/stages/*.md` file is modified.
- **AC-10** — `/inline-edit` is discoverable from `CLAUDE.md`'s `## Agent pipeline` related-commands list,
  `.sdd/README.md`'s directory-map `pipeline.md` line, and `.sdd/README.md`'s `.claude/skills/*/SKILL.md`
  paragraph.
- **AC-11** — `scripts/ledger-append.mjs --inline` is a disclosure-only marker on the plain (non-`--hotfix`)
  path that relaxes **no** gate: `review.json` and `security.json` must both still show `PASS` (or be
  accepted via `--override-*`), `refuseIfStale` still runs unconditionally on both, the unconditional
  `spec.json`↔`spec.md` agreement check still runs, `findCompletedSecurityRun` still independently
  re-verifies the cited run against its own immutable `manifest.json`/`results.json`, and the run id is
  reused from that security run rather than minted.
- **AC-12** — `--inline --lite` and `--inline --re-gate` are each refused, with a distinct message naming
  why the lanes differ, **before any `.pipeline/` file is read**.
- **AC-13** — `--inline` requires `--ticket <id>` (non-empty, not flag-shaped) and refuses unless
  `extractTicketId(specJson.ticket)` equals it; `--ticket` supplied with neither `--re-gate` nor `--inline`
  still fails, with the message widened to name both.
- **AC-14** — `--inline` requires `--why-inline "<reason>"`, non-empty and not flag-shaped, and refuses
  without it ("no reason, no inline entry," the same posture `--override-*` takes); the reason is recorded
  verbatim in `entry.json`'s `inline.reason` and rendered in `entry.md`'s `## Inline edit` section.
- **AC-15** — `--inline` additionally requires `.pipeline/spec.json` to carry a `stamp` (presence and shape
  via `readStamp`, never freshness), and `.pipeline/changes.md`, `.pipeline/changes.json`, and
  `.pipeline/test-results.md` to exist — each with its own named refusal explaining why this lane requires
  it.
- **AC-16** — `--inline` never reads and never copies `.pipeline/red.json`; the entry's `redTestPaths` is
  `[]` and its `redAbsenceNote` is the fixed `INLINE_RED_ABSENCE_NOTE`, never the plain path's
  "predates / produced nothing" disjunction.
- **AC-17** — `entry.json` for a `--inline` run carries `inline: { skippedStages: ["red","dev"], reason,
  note, size }` with `skippedStages` and `note` derived from exported script constants and never
  caller-supplied (there is no `--skipped-stages`/`--inline-note` flag); the `inline` key is always present
  and is `null` on every other run.
- **AC-18** — `entry.md` for a `--inline` run is titled `# Ledger entry — <runId> (INLINE)` and carries a
  `## Inline edit` section immediately after `## Verdicts`, rendering `note` verbatim plus the skipped
  stages, the reason, and the measured size (or an explicit "could not be measured" statement); markers
  compose in the documented order `(RE-GATE)(INLINE)(LITE)(OVERRIDE)`.
- **AC-19** — the change's size is measured via the already-imported `countChangedLines`/
  `maxChangedLineLength` for **disclosure only** — it never gates anything, and a measurement failure
  records `size: null` plus a printed note rather than refusing or silently omitting the field.
- **AC-20** — `scripts/build-ledger-index.mjs` reads `entry.json`'s `inline` field strictly (fail-closed on
  a malformed one) and carries `inline: { skippedStages }` into every `index.json` record for that run's
  files, omitted entirely (not `null`) for every other run; the byte-for-byte `{ "review": "PASS",
  "security": "PASS" }` verdicts gate is unchanged, and `inline` is not a widening case.
- **AC-21** — coverage and wiring: `[inline]`-tagged cases exist in `scripts/ledger-append.test.mjs`,
  `scripts/build-ledger-index.test.mjs`, and `scripts/sdd-completeness.test.mjs`; no new script file is
  added, so `package.json`, `.github/workflows/ci.yml`, and `scripts/tsconfig.json` are unchanged; and
  `.sdd/runtimes.yml`, `.sdd/bounds.yml`, `.claude/agents/**`, and `docs/PRD_Tickets.md` are all untouched.

## Edge cases

- **EC-1** — `--inline` with no `--ticket`: refuse, naming the flag and stating that it is the caller's own
  assertion, never derived from `spec.json`.
- **EC-2** — `--inline --ticket X` where `extractTicketId(specJson.ticket)` is `Y`: refuse, and say plainly
  that retrying with a fabricated `--ticket` is not the fix — ratify the correct spec first.
- **EC-3** — `spec.json` and `spec.md` disagree on the ticket: the existing unconditional agreement check
  fires first, on the inline path exactly as on every other; the `--inline` ticket check is not a
  replacement for it.
- **EC-4** — `--inline` with an unstamped `spec.json`: refuse, with the inline-specific clause in the
  message (no `dev` stage guarantees a freshly-written sidecar on this lane).
- **EC-5** — `--inline` with `.pipeline/changes.md` and/or `changes.json` missing: refuse, naming which one
  and why this lane requires it (there is no `dev` stage that would have written them).
- **EC-6** — `--inline` with `.pipeline/test-results.md` missing: refuse — `tester` is mandatory here.
- **EC-7** — `--why-inline` absent, empty, whitespace-only, or immediately followed by another `--flag`:
  refuse in every case, the same fail-closed shape `readOverrideReason` already uses.
- **EC-8** — `--inline --lite` and `--inline --re-gate`: each refused before any `.pipeline/` read, with
  distinct messages.
- **EC-9** — a `STALE` `review.json` or `security.json`: `refuseIfStale` refuses, unchanged by this lane,
  and is not bypassable by `--inline` or by any override.
- **EC-10** — a non-`PASS` `review.json` or `security.json`: refuses without the matching `--override-*`;
  with it, the entry carries `bypass: true`, is excluded from `index.json`, and is titled `(INLINE)
  (OVERRIDE)` — the inline disclosure survives on the entry regardless, orthogonally, the same way `regate`
  and an override already compose.
- **EC-11** — a leftover `.pipeline/red.json` on disk: never read, never copied, never contributes to
  `redTestPaths`; no refusal, because a genuine same-round `red.json` is indistinguishable from a leftover
  at ledger time (its stamp is stale by construction on this lane) — stated as an honest limit rather than
  papered over with a check that cannot work.
- **EC-12** — the working tree is already clean at ledger time (the inline edit was committed first):
  `filesTouched` falls back to `changes.json`'s `filesChanged`; a `changes.json` with an **empty**
  `filesChanged` against a clean tree still fails loudly, unchanged.
- **EC-13** — `countChangedLines` or `maxChangedLineLength` throws (git unavailable, an unresolvable ref,
  an unreadable file): `measureInlineSize` returns `null`, `entry.json` records `"size": null`,
  `entry.md` says so explicitly, a note is printed, and the write proceeds — measurement is disclosure,
  never a gate, so a failed measurement must not fail-closed into refusing a legitimate record.
- **EC-14** — the change includes a binary or otherwise unsizable file: its path is recorded in
  `size.unsizable`, so `changedLines` is never read as a complete count.
- **EC-15** — `.sdd/ledger/<runId>/` already exists (a second append for the same security run): the
  existing overwrite guard refuses, reached on the inline path too; likewise
  `copySecurityHistoryIntoLedger`'s own guard on an existing `security/` directory.
- **EC-16** — `build-ledger-index.mjs` encounters an `entry.json` whose `inline` is malformed (not an
  object, `skippedStages` absent or not an array of strings): it fails closed, and `--check` fails loudly
  rather than reporting the index as up to date.
- **EC-17** — back-compat: every ledger entry written before PL-12 carries no `inline` key at all;
  `readInlineField` must treat an absent key as `null` (never a validation failure), every existing
  `entry.md`/`entry.json` must be untouched, and `node scripts/build-ledger-index.mjs --check` must still
  pass against the pre-existing entries.
- **EC-18** — the lane is entered and abandoned after the edit but before the gates: nothing is recorded.
  The section must name this outcome and its two discharges (finish, or revert), because this is exactly
  the unrecorded hand-edit the lane exists to replace, and a lane that invites a human to edit is the one
  most likely to be walked away from.
- **EC-19** — `review.json` reads `NEEDS_FIXES` (or `security.json` `BLOCKED`) on this lane: route back to
  another **inline** edit (not `/dev`), re-run `tester`/`review`(/`security`), under the existing 3-attempt
  cap; `red` still never runs, and specifically must not be authored after the fix. At the cap: no ledger
  entry unless the outcome is recorded via `--override-*`.
- **EC-20** — the existing PL-11 assertions in `scripts/sdd-completeness.test.mjs` must keep passing:
  (a) the stage-file allowlist test permits only `.sdd/stages/tester.md` and `.sdd/stages/CHANGELOG.md` in
  `git diff --name-only HEAD -- .sdd/stages`, which PL-12 must not exceed; (b) `pipelineLiteSection()`
  slices between `### \`/pipeline-lite` and `### Per-stage entry points`, so the new section must be placed
  **outside** that range — hence the `/re-gate`→`/hotfix` placement in Affected files — and a new
  `inlineEditSection()` helper anchored on `### \`/inline-edit` … `### \`/hotfix` must be added rather than
  widening the existing one; (c) the `[lite]` tester.md assertions use 400-character `coOccurs` windows, so
  the inline-lane wording added to `tester.md` must not push `lite` and `red.md`/`state` further apart than
  that; (d) the generalized `### \`/<command>\`` ↔ `.claude/skills/<command>/SKILL.md` test will
  automatically demand the new shim, and its `commands.length >= 10` floor still holds.

## Open questions

None blocking. Every ambiguity the ticket left open is resolved above under "Recorded decisions"
(D-1 through D-7) with its reasoning, per the ticket's own instruction to prefer recorded decisions.

One item is flagged for the approver's judgment rather than left ambiguous: **D-2** (this lane has no
mechanical size bound) is the single decision that most changes the lane's risk profile, and it is the
one an approver might reasonably reverse. If it is reversed, the change is small and local — gate step 1
on `node scripts/check-lite-eligible.mjs` and route exit `1`/`2` to `/pipeline`, exactly as
`/pipeline-lite`'s step 1 already does — but AC-4's "at any size" clause and the `INLINE_NOTE` constant
would both need rewording, and D-2's reasoning (that lite's bound is justified by lite skipping
`security`, which this lane does not) would need an explicit rebuttal in its place rather than silent
removal.
