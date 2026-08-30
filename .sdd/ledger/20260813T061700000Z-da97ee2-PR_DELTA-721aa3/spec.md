# PL-TRIM — drastically slim `.sdd/pipeline.md` into core + per-command entrypoints

## Ticket Check

**What I'm about to build.** The one document every pipeline run has to read first
(`.sdd/pipeline.md`) has grown to about 950 lines, and almost all of it is instructions for commands
that a given run never uses. I'm splitting it so the shared core stays in one short file and each
command's own instructions move into their own small file, so starting a run reads a fraction of
what it reads today. Nothing about how the pipeline behaves changes — the same stages run in the
same order with the same gates.

**What I'm explicitly not doing.** I'm not changing any stage's own procedure, not changing what a
`PASS` means, not changing the three-attempt fix-loop cap, and not touching the permanent ledger
history. I'm also not doing the other three parts of the efficiency plan (moving the red-test
integrity check to the tester, the fix-loop brief, or the wider CI quality work) — those are
separate tickets on purpose.

**How you'll know it worked.** Running `/pipeline` (or any other command) still works exactly as it
does today and produces the same artifacts, but the coordinator now reads two short files instead of
one very long one. You can see the split directly: `.sdd/pipeline.md` becomes a short document with
a one-line pointer per command, and there is a new `.sdd/entrypoints/` folder with one file per
command. An automated check now fails the build if that long file ever grows back past its budget,
or if a command's instructions and its shortcut file ever stop pointing at each other.

**What I had to guess.** The plan left four mechanical decisions open and I settled all four rather
than asking: the new files are named `.sdd/entrypoints/<command>.md` (one per command, named exactly
after the command); the length budget for `.sdd/pipeline.md` is 300 lines (the plan's own suggested
number); the historical "why we fixed X" material moves into a new `.sdd/pipeline-history.md` rather
than into the existing stage changelog, because that changelog is specifically about stage-file
amendments and this material is not; and each command keeps a short stub heading in the core file
rather than disappearing from it entirely, so that the many existing cross-references elsewhere in
the repo that say "see `.sdd/pipeline.md`'s `/re-gate` section" still land somewhere real.

## Goal

Cut what a `/pipeline` coordinator must read at the start of every run from ~950 lines to the core
file plus one small per-command file, by splitting `.sdd/pipeline.md` into a short core (stage
sequence, routing, loop cap, staleness table, entry-point stubs), one `.sdd/entrypoints/<cmd>.md` per
command, and one `.sdd/pipeline-history.md` for the archaeology no agent needs in order to *run* a
stage — with a CI check that locks the split in place.

## Scope

**In scope**

- Rewrite `.sdd/pipeline.md` as a core document under a 300-line budget.
- Create `.sdd/entrypoints/<cmd>.md` for all 16 documented commands, carrying the full bodies.
- Create `.sdd/pipeline-history.md` for the stamp/JSON-sidecar archaeology and the long
  "why we fixed X" essays.
- Rewrite each pipeline `.claude/skills/*/SKILL.md` to name core + exactly one entrypoint.
- New `scripts/check-pipeline-slim.mjs` + its test suite, wired into `package.json`,
  `.github/workflows/ci.yml`, and `scripts/tsconfig.json`.
- Retarget the existing `.sdd/pipeline.md`-anchored assertions in `scripts/sdd-completeness.test.mjs`
  at their new homes, preserving every guarantee.
- Update `.sdd/README.md`, `CLAUDE.md`, and `AGENTS.md` pointers.

**Explicitly out of scope**

- Parts 2–4 of `docs/product/Pipeline-Efficiency-Plan.md` (PL-INTEGRITY-TESTER, PL-FIXBRIEF,
  PL-CI-QUAL). The only CI work here is this ticket's own slimness check.
- **Any change to `.sdd/stages/*.md`.** Stage agents are unchanged; they already read only their own
  stage file. (Two existing tests assert a two-file allowlist over `git diff -- .sdd/stages`, so
  editing any stage file — including `CHANGELOG.md`, which is not needed here — fails the suite.)
- Any behavior change to `scripts/ledger-append.mjs`, `scripts/check-lite-eligible.mjs`,
  `scripts/check-bounds.mjs`, `scripts/pipeline-contracts.mjs`, `scripts/write-stamp.mjs`,
  `scripts/check-stamp-freshness.mjs`, or `scripts/check-red-integrity.mjs`.
- Rewriting the many `.sdd/pipeline.md`-section pointers inside `scripts/ledger-append.mjs` (including
  its exported `LITE_NOTE`/`INLINE_NOTE`/`GAPFILL_NOTE` constants and refusal messages). Those strings
  are pinned by `scripts/ledger-append.test.mjs` and are copied verbatim into durable ledger entries;
  the core file's per-command stubs are what keep those pointers resolvable. See Approach step 2 for
  why a stub heading rather than a bare list is the chosen shape.
- Any edit under `.sdd/ledger/**`, `docs/product/PRD-V1.md`, or
  `docs/product/Ticket-Backlog-by-Feature-2.md`.
- Changing the stage sequence, the routing rules, the 3-attempt loop cap, or what terminal `PASS`
  means.

## Affected files

**Created**

| Path | Contents |
|---|---|
| `.sdd/entrypoints/pipeline.md` | body of today's `### `/pipeline <ticket>`` (pipeline.md L330–351) |
| `.sdd/entrypoints/pipeline-lite.md` | L353–438 |
| `.sdd/entrypoints/pipeline-gapfill.md` | L440–501 |
| `.sdd/entrypoints/gap-scout-only.md` | L503–522 |
| `.sdd/entrypoints/planner.md` | L561–573 |
| `.sdd/entrypoints/spec-only.md` | L575–578 (alias of `planner`) |
| `.sdd/entrypoints/red.md` | L580–590 |
| `.sdd/entrypoints/dev.md` | L592–603 |
| `.sdd/entrypoints/tester.md` | L605–616 |
| `.sdd/entrypoints/review.md` | L618–630 |
| `.sdd/entrypoints/security.md` | L632–665 |
| `.sdd/entrypoints/security-recheck.md` | L667–671 (alias of `security`) |
| `.sdd/entrypoints/pipeline-status.md` | L673–694 |
| `.sdd/entrypoints/re-gate.md` | L696–817 |
| `.sdd/entrypoints/inline-edit.md` | L819–916 |
| `.sdd/entrypoints/hotfix.md` | L918–951 (which itself defers to `.sdd/hotfix.md`) |
| `.sdd/pipeline-history.md` | the archaeology moved out of core (see Approach step 3) |
| `scripts/check-pipeline-slim.mjs` | the new CI check |
| `scripts/check-pipeline-slim.test.mjs` | its `node:test` suite |

**Modified**

- `.sdd/pipeline.md` — rewritten as core (≤300 lines).
- `.claude/skills/{pipeline,pipeline-lite,pipeline-gapfill,gap-scout-only,planner,spec-only,red,dev,tester,review,security,security-recheck,pipeline-status,re-gate,inline-edit,hotfix}/SKILL.md`
  — 16 files, each retargeted at core + its own entrypoint.
- `scripts/sdd-completeness.test.mjs` — retarget the pipeline.md-anchored assertions (see AC-11).
- `package.json` — add `check:pipeline-slim` and `test:pipeline-slim`.
- `.github/workflows/ci.yml` — add a `Pipeline slimness check — tests` step running
  `npm run test:pipeline-slim`, placed beside the existing `test:lite-eligible` step.
- `scripts/tsconfig.json` — add `"check-pipeline-slim.mjs"` and `"check-pipeline-slim.test.mjs"` to
  `include`, in the file list's existing alphabetical position.
- `.sdd/README.md` — directory map, the "read this first" paragraph, and the
  `.claude/skills/*/SKILL.md` paragraph.
- `CLAUDE.md` — the "Agent pipeline" section's pointer for where a command's procedure lives.
- `AGENTS.md` — "The pipeline" section's same pointer.

**Deliberately untouched**

`.sdd/stages/**` (every file, including `CHANGELOG.md` and `gap-scout.md`), `.sdd/hotfix.md`,
`.sdd/bounds.md`, `.sdd/bounds.yml`, `.sdd/runtimes.yml`, `.sdd/ledger/**`, `.claude/agents/**`,
`.claude/settings.json`, `.claude/skills/{pr-review,workspace-pack-author}/SKILL.md`, and every
script listed as out of scope above.

## Interfaces / signatures

### `scripts/check-pipeline-slim.mjs`

A plain-JS ES module CLI, same conventions as `scripts/check-lite-eligible.mjs` (shebang, header
comment stating the exit-code contract, exported pure helpers so the test suite can drive it without
a subprocess for every case, plus subprocess cases for the CLI surface itself).

```js
/** The line budget .sdd/pipeline.md must stay under. 300 per PL-TRIM; the plan's target body is 150–250. */
export const PIPELINE_LINE_BUDGET = 300;

/** Max non-blank body lines allowed between a `### `/<cmd>`` stub heading and the next heading. */
export const STUB_BODY_LINE_BUDGET = 8;

/** Skills that legitimately have no entrypoint: not pipeline entry points at all. */
export const EXEMPT_SKILLS = new Set(['pr-review', 'workspace-pack-author']);

/** alias command -> the canonical entrypoint it is permitted to defer to, and only that one. */
export const ALIAS_ENTRYPOINTS = new Map([['spec-only', 'planner'], ['security-recheck', 'security']]);

/** The six violation kinds this check can report. */
export const SLIM_VIOLATION_KINDS = [
  'budget', 'stub-body', 'missing-entrypoint', 'orphan-entrypoint', 'skill-pointer', 'unstubbed-entrypoint',
];

/** @typedef {{ kind: string, path: string, detail: string }} SlimViolation */

/**
 * Pure evaluator over already-read file contents, so the test suite can construct fixtures without
 * writing a temp repo for every case.
 * @param {{ pipeline: string, entrypoints: Map<string,string>, skills: Map<string,string> }} input
 * @returns {{ ok: boolean, lineCount: number, budget: number, violations: SlimViolation[] }}
 */
export function evaluatePipelineSlimness(input);

/** Reads the repo from disk and returns the same shape. @param {string} [repoRoot] */
export function checkPipelineSlim(repoRoot);
```

CLI:

```
node scripts/check-pipeline-slim.mjs           # human-readable report
node scripts/check-pipeline-slim.mjs --json    # { ok, lineCount, budget, violations: [...] }
```

Exit `0` = slim and consistent. Exit `1` = at least one violation. Exit `2` = the check could not be
performed (missing `.sdd/pipeline.md`, missing `.sdd/entrypoints/` directory, missing
`.claude/skills/`, unknown flag). The 1/2 split is the same one `check-bounds.mjs` and
`check-lite-eligible.mjs` already document, for the same reason: collapsing "the check failed" into
"the file is clean" is how a broken gate reads as a passing one. Failure output goes to stderr
prefixed `check-pipeline-slim: `.

**The six rules `evaluatePipelineSlimness` enforces**

1. `budget` — `.sdd/pipeline.md`'s total line count ≤ `PIPELINE_LINE_BUDGET`. Count lines after
   normalizing CRLF (`content.split(/\r?\n/)`), dropping one trailing empty element if the file ends
   with a newline.
2. `stub-body` — for every `### `/<cmd>`` heading in `.sdd/pipeline.md`, the non-blank lines between
   it and the next `##`/`###` heading number ≤ `STUB_BODY_LINE_BUDGET`, and that stub contains the
   literal `.sdd/entrypoints/<cmd>.md`. A body creeping back into core is the specific regression
   this rule exists to catch; the global budget alone would let one long section replace many short
   ones.
3. `missing-entrypoint` — every non-exempt `.claude/skills/<name>/SKILL.md` body contains the literal
   `.sdd/entrypoints/<name>.md`, and that file exists on disk.
4. `orphan-entrypoint` — every `.sdd/entrypoints/*.md` has a matching `.claude/skills/<name>/SKILL.md`
   (bijection with rule 3, minus the exempt set).
5. `skill-pointer` — a non-exempt skill body references no `.sdd/entrypoints/<other>.md` besides its
   own (an alias may additionally reference exactly its `ALIAS_ENTRYPOINTS` target), and contains no
   pipeline.md-section pointer of the shape matched by
   `/\.sdd\/pipeline\.md`?'?s?\s+(?:own\s+)?"?`?\/[a-z][a-z0-9-]*/i` — i.e. no "follow
   `.sdd/pipeline.md`'s `/x` section," which is exactly the "read all of pipeline.md for every lane"
   instruction this ticket removes.
6. `unstubbed-entrypoint` — every `.sdd/entrypoints/<cmd>.md` is named by some stub in
   `.sdd/pipeline.md` (the inverse of rule 2's per-stub check, so a new entrypoint cannot be added
   invisibly).

### `.sdd/entrypoints/<cmd>.md` file shape

Each begins with an H1 naming the command exactly as its stub does (e.g. `# `/re-gate [--gates-only]
[--ticket <id>]``), then one line stating what core it assumes:

> Read `.sdd/pipeline.md` (core: stage sequence, routing, loop cap, staleness) first. This file is
> the authoritative, runtime-neutral definition of this command; no other entrypoint file is
> required to run it.

then the moved body, with each `### `/x`` heading demoted to that file's own heading levels and every
former "see the `/y` section" pointer rewritten as `.sdd/entrypoints/y.md`.

### `.claude/skills/<cmd>/SKILL.md` body shape

Frontmatter is unchanged (`name`, `description`, `disable-model-invocation: true`, `argument-hint`).
The body reads, in this order and nothing more:

1. Read `.sdd/pipeline.md` — **core only** (stage sequence, routing, loop cap, staleness table).
2. Read `.sdd/entrypoints/<cmd>.md` — the authoritative definition of this command.
3. The existing runtime mapping (which subagent implements each stage) and the existing
   restated-refusal bullets, unchanged in substance.

Each stays under 60 lines (an existing assertion for two of them; the convention for all).

## Approach

Build in this order.

1. **Create `.sdd/entrypoints/` and move the 16 bodies, substance-verbatim.** Do not rewrite, condense,
   or "improve" any moved prose in this ticket — the [lite] and [inline] assertion blocks in
   `scripts/sdd-completeness.test.mjs` pin load-bearing concepts inside these bodies by
   co-occurrence within 200–600 character windows, and a rewrite that pushes two halves apart fails a
   guarantee rather than a formatting rule. The only permitted edits are: heading level, the added
   preamble line above, and rewriting an intra-pipeline.md section pointer to the matching
   `.sdd/entrypoints/<cmd>.md`.
2. **Rewrite `.sdd/pipeline.md` as core.** Keep, in this order: a short intro (naming every entry
   point, including `/pipeline-lite` and `/inline-edit` — two existing assertions read that
   paragraph); a condensed **JSON sidecars** note (≤8 lines, the contract only, archaeology to
   history); **Staleness stamps** as a compact table plus the two script names and the three-way
   policy (`re-derived` / `trusted-fresh` / `advisory`) — the rationale essay moves to history;
   **Stage sequence** (the seven numbered items, each shortened, keeping the `**planner**` …
   `**security**` bold markers in order and `ledger-append.mjs` and "terminal `PASS`" by name);
   **Routing** plus the **Loop cap** paragraph; a condensed **Review persistence** contract (the
   blockquote and the "runtimes differ in mechanism, not in what is persisted" rule; the
   two-prior-mirrors history moves out); **Running stages in a single context**; then **Entry
   points** — the preamble (naming every command), the shared `### Per-stage entry points` four-item
   contract (kept in core: it is one policy shared by six commands, and splitting it six ways would
   duplicate it six ways), and one `### `/<cmd>`` stub per command in today's order.
   Each stub is at most `STUB_BODY_LINE_BUDGET` non-blank lines: one sentence on what the command is
   for, any "not this command" one-liner worth keeping at a glance, and the line
   `Full definition: `.sdd/entrypoints/<cmd>.md`.` Keeping the `###` heading form is deliberate —
   `.sdd/stages/gap-scout.md` and roughly thirty comments and message strings in
   `scripts/ledger-append.mjs` cite "`.sdd/pipeline.md`'s `/x` section" by name, and neither file may
   be edited by this ticket (stage files are allowlisted; the ledger strings are pinned and durable).
3. **Create `.sdd/pipeline-history.md`.** Move here: the JSON-sidecar archaeology (today's L36–62 —
   the markdown-scanner rounds, the duplicate-key exploit, the honest-limit paragraph), the staleness
   rationale beyond the table (L66–77 and L82–105's narrative half), the "Review persistence — the
   resolved divergence" backstory (L266–271), and the "This closes a real, observed gap" essay under
   Per-stage entry points (L530–538). Head the file with one line saying it is history, not
   procedure, and that no stage or command needs it in order to run. Link it once from core and once
   from `.sdd/README.md`'s directory map. Record PL-TRIM's own round here — **not** in
   `.sdd/stages/CHANGELOG.md`, which is for stage-file amendments and which this ticket may not edit.
4. **Rewrite the 16 SKILL.md bodies** to the shape above.
5. **Write `scripts/check-pipeline-slim.mjs`**, then wire it: `package.json`
   (`"check:pipeline-slim": "node scripts/check-pipeline-slim.mjs"`,
   `"test:pipeline-slim": "node --test scripts/check-pipeline-slim.test.mjs"` — both required, since
   an existing assertion demands a `test:<suffix>` for every `check:<suffix>`), a CI step running
   `npm run test:pipeline-slim`, and both filenames in `scripts/tsconfig.json`'s `include`.
   Unlike `check:bounds`/`check:lite-eligible`, this check needs no per-run arguments, so CI may also
   run `npm run check:pipeline-slim` directly — do so, in the same step, since that is what actually
   gates the split rather than gating only the check's own unit tests.
6. **Retarget `scripts/sdd-completeness.test.mjs`** (see AC-11 for the exact list). Change only which
   file each assertion reads; never delete an assertion because its anchor moved, and never widen a
   `coOccurs` window to make a moved body pass.
7. **Update `.sdd/README.md`, `CLAUDE.md`, `AGENTS.md`.**
8. **Verify.** `npm run check:pipeline-slim`, `npm run test:pipeline-slim`,
   `npm run test:sdd-completeness`, `npm run test:ledger-append`, `npm run test:lite-eligible`,
   `npm run typecheck:scripts`, and `git diff --name-only HEAD -- .sdd/stages` (must be empty).

## Acceptance criteria

- **AC-1** `.sdd/pipeline.md` is at most 300 lines and retains, in order: an intro naming every entry
  point, a condensed JSON-sidecar note, a Staleness stamps section presenting the three-way policy as
  a compact table, a Stage sequence section whose `**planner**`/`**red**`/`**dev**`/`**tester**`/
  `**review**`/`**security**` markers appear in that order and which names `ledger-append.mjs` and
  terminal `PASS`, a Routing section with the 3-attempt loop cap, a Review persistence contract, a
  "Running stages in a single context" section, and an Entry points section.
- **AC-2** `.sdd/entrypoints/<cmd>.md` exists for exactly these 16 commands: `pipeline`,
  `pipeline-lite`, `pipeline-gapfill`, `gap-scout-only`, `planner`, `spec-only`, `red`, `dev`,
  `tester`, `review`, `security`, `security-recheck`, `pipeline-status`, `re-gate`, `inline-edit`,
  `hotfix` — and no others.
- **AC-3** Each entrypoint file carries its command's full body from `.sdd/pipeline.md`, substance
  unchanged: every numbered step, every "Not this lane"/"Not `/x`" routing item, every "Honest
  limits" list, and every named ledger command survives the move.
- **AC-4** No entrypoint file requires reading another entrypoint file, except `spec-only.md` and
  `security-recheck.md`, which are aliases and defer to `planner.md`/`security.md` respectively and
  say so explicitly.
- **AC-5** `.sdd/pipeline.md` carries a `### `/<cmd>`` stub for each of AC-2's 16 commands, each with
  at most 8 non-blank body lines and each naming `.sdd/entrypoints/<cmd>.md`.
- **AC-6** `.sdd/pipeline-history.md` exists, opens by stating it is history rather than procedure and
  that no stage or command needs it in order to run, carries the JSON-sidecar archaeology, the
  staleness-stamp rationale beyond the table, the review-persistence backstory, and the per-stage
  entry-point "observed gap" essay, and records PL-TRIM's own round.
- **AC-7** Each of the 16 pipeline `SKILL.md` files names `.sdd/pipeline.md` as core, names exactly its
  own `.sdd/entrypoints/<cmd>.md` (plus, for the two aliases, their canonical target), contains no
  "follow `.sdd/pipeline.md`'s `/x` section" pointer, keeps its existing frontmatter keys, and stays
  under 60 lines.
- **AC-8** `scripts/check-pipeline-slim.mjs` exists, exports `PIPELINE_LINE_BUDGET` (=300),
  `STUB_BODY_LINE_BUDGET` (=8), `EXEMPT_SKILLS`, `ALIAS_ENTRYPOINTS`, `SLIM_VIOLATION_KINDS`,
  `evaluatePipelineSlimness`, and `checkPipelineSlim`, enforces all six rules in Interfaces, supports
  `--json`, and exits `0`/`1`/`2` per that contract.
- **AC-9** `scripts/check-pipeline-slim.mjs` exits `0` against this repository after the split.
- **AC-10** The check is wired: `package.json` has `check:pipeline-slim` and `test:pipeline-slim`;
  `.github/workflows/ci.yml` runs both `npm run check:pipeline-slim` and `npm run test:pipeline-slim`;
  `scripts/tsconfig.json`'s `include` lists both new filenames; `npm run typecheck:scripts` exits `0`.
- **AC-11** Every `.sdd/pipeline.md`-anchored assertion in `scripts/sdd-completeness.test.mjs` is
  retargeted rather than deleted or weakened, specifically: `pipelineLiteSection()` and
  `inlineEditSection()` read their entrypoint files; the `/hotfix` entry-point test reads
  `.sdd/entrypoints/hotfix.md` for `.sdd/hotfix.md`, `ledger-append.mjs --hotfix`, and "follow-up
  ticket"; the `### `/<command>`` → skill enumeration becomes an enumeration of `.sdd/entrypoints/*.md`
  with its `>= 10` floor intact; the two "named in the intro paragraph and the Entry points preamble"
  discoverability tests still read `.sdd/pipeline.md`; the two SKILL.md shim tests accept the
  entrypoint pointer; and the `/re-gate` → `/inline-edit` → `/hotfix` ordering assertion becomes an
  ordering assertion over core's stubs.
- **AC-12** `npm run test:sdd-completeness`, `npm run test:pipeline-slim`, `npm run test:ledger-append`,
  and `npm run test:lite-eligible` all pass.
- **AC-13** `git diff --name-only HEAD -- .sdd/stages` is empty: no stage file is modified, so stage
  agents are unchanged and still read only `.sdd/stages/<stage>.md`.
- **AC-14** A `/pipeline` coordinator can run the full sequence from `.sdd/pipeline.md` plus
  `.sdd/entrypoints/pipeline.md` alone — those two files together state the stage sequence, the
  routing and loop cap, the staleness policy, the spec-reuse prompt, the Open-Questions stop, the
  ledger step, and the final report contents, with no other entrypoint file required.
- **AC-15** No behavior change to `scripts/ledger-append.mjs`, `check-lite-eligible.mjs`,
  `check-bounds.mjs`, `pipeline-contracts.mjs`, `write-stamp.mjs`, `check-stamp-freshness.mjs`, or
  `check-red-integrity.mjs`; their existing `.sdd/pipeline.md`-section pointers still resolve, via
  core's stubs, to a real section naming the command.
- **AC-16** `.sdd/README.md`'s directory map lists `entrypoints/` and `pipeline-history.md`, still
  names `/pipeline-lite` and `/inline-edit`, its "read this first" paragraph names the
  core-plus-one-entrypoint reading order, and its `.claude/skills/*/SKILL.md` paragraph says each skill
  points at its own entrypoint file.
- **AC-17** `CLAUDE.md`'s Agent pipeline section and `AGENTS.md`'s "The pipeline" section both state
  that a command's exact procedure lives in `.sdd/entrypoints/<cmd>.md`, with `.sdd/pipeline.md` as
  the shared core; `CLAUDE.md`'s "Related commands:" list still names every command it names today.

## Edge cases

- **EC-1** A skill directory with no matching entrypoint file (e.g. a new command shimmed but never
  documented) → `missing-entrypoint`, exit `1`, naming the skill and the path it expected.
- **EC-2** An entrypoint file with no matching skill → `orphan-entrypoint`, exit `1`.
- **EC-3** `.sdd/pipeline.md` at exactly 300 lines passes; at 301 lines → `budget`, exit `1`, with the
  actual count and the budget in the message.
- **EC-4** `pr-review` and `workspace-pack-author` have no entrypoint file and must not be reported —
  neither is a pipeline entry point (`pr-review` runs outside the per-ticket sequence and points at
  `.sdd/stages/pr-review.md`; `workspace-pack-author` is unrelated R&D).
- **EC-5** `spec-only`/`security-recheck` reference both their own entrypoint and their canonical
  target; that is permitted for exactly those two, and referencing any third entrypoint is not.
- **EC-6** A skill naming two unrelated entrypoints → `skill-pointer`, exit `1`.
- **EC-7** A stub section that grows a real body back into core (>8 non-blank lines) → `stub-body`,
  exit `1`, even while total line count is still under budget.
- **EC-8** A stub that exists but names no entrypoint path → `stub-body`, exit `1`.
- **EC-9** `.sdd/entrypoints/` missing entirely, or `.sdd/pipeline.md` unreadable, or
  `.claude/skills/` missing → exit `2` (cannot perform), never exit `0` and never exit `1`.
- **EC-10** An unknown CLI flag → exit `2` with a usage message, matching
  `check-lite-eligible.mjs`'s `assertKnownFlags` posture.
- **EC-11** **CRLF.** Every file in this working tree uses CRLF. Line counting must use
  `split(/\r?\n/)`; no assertion or script regex may use a `$` anchor against these documents, and any
  literal newline match must be `\r?\n`. (This is a recorded, previously-bitten failure mode in
  `scripts/sdd-completeness.test.mjs`'s own header.)
- **EC-12** Non-`.md` files or a nested directory under `.sdd/entrypoints/` → ignored by rules 4 and 6
  rather than reported as an orphan, so an editor swap file cannot fail CI.
- **EC-13** `--json` on a passing run prints `{ "ok": true, ..., "violations": [] }` and exits `0`;
  on a failing run prints the same shape with a populated `violations` array and exits `1`. The JSON
  goes to stdout on both.
- **EC-14** An entrypoint body left carrying a pointer to a pipeline.md section that no longer holds a
  body (a dangling "see `.sdd/pipeline.md`'s `/re-gate` section" inside `inline-edit.md`) must be
  rewritten to `.sdd/entrypoints/re-gate.md` during the move.
- **EC-15** A moved body whose `coOccurs`-pinned halves drift apart (e.g. reflowing
  `/pipeline-lite`'s Honest limits so `red` and `after`/`order` exceed 300 characters apart) fails an
  existing guarantee — treat any such failure as a bad move, not as a stale assertion to widen.
- **EC-16** Two skills naming the same entrypoint → reported for both (`skill-pointer` on the one that
  does not own it), so a copy-paste shim cannot silently shadow another command.
- **EC-17** `.sdd/ledger/**` must be excluded from every walk the new script does — a historical
  ledger entry quoting a pipeline.md section is not a skill and not an entrypoint.
- **EC-18** The leftover `.pipeline/` artifacts on disk from an earlier, unrelated run
  (`red.json`, `changes.json`, `review.json`, `security.json` all predate this spec) must not be
  treated as this run's own; the coordinator should clear or ignore them before `red` runs, and no
  downstream stage may read them as evidence for PL-TRIM.

## Open questions

None that block implementation. The four mechanical decisions the plan left open are settled above
and recorded here so a reviewer can overrule any of them cheaply:

1. **Entrypoint naming** — `.sdd/entrypoints/<command>.md`, one file per command, named exactly after
   the skill directory, so the skill↔entrypoint check is a string equality rather than a maintained
   map.
2. **Line budget** — 300 for `.sdd/pipeline.md` (the plan's own suggested ceiling), with 150–250 as
   the target body; plus a second, per-stub budget of 8 non-blank lines, because a global budget alone
   permits one long section to replace many short ones.
3. **History file** — `.sdd/pipeline-history.md`, not `.sdd/stages/CHANGELOG.md`. The changelog is
   specifically the round-by-round record of *stage-file* amendments, and this ticket amends no stage
   file; two existing tests also assert a two-file allowlist over `git diff -- .sdd/stages`, so writing
   there would fail the suite for a reason unrelated to the content.
4. **Stub shape** — each command keeps a `### `/<cmd>`` heading in core rather than collapsing to a
   bare table row, because `.sdd/stages/gap-scout.md` and ~30 comments and durable message strings in
   `scripts/ledger-append.mjs` cite those section names, and neither file is editable by this ticket.
