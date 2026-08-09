# Pipeline — stage sequence, routing, and loop caps

This is the single, runtime-neutral definition of how the six stages
(`planner` → `red` → `dev` → `tester` → `review` → `security`, see `.sdd/stages/`) compose into a
run, plus the ledger-append step that follows a terminal `PASS`, and of every way a human can
invoke this pipeline's tooling: the full sequence (`/pipeline`); each stage on its own (six
per-stage entry points, `/planner` through `/security` — PL-04, see "Per-stage entry points" under
Entry points below); a status check (`/pipeline-status`); the sanctioned path back to a verdict
after a hand-edit made outside this sequence (`/re-gate` — PL-04, see below); the proportionate lane
for a genuinely small, mechanically-eligible change (`/pipeline-lite` — PL-11, see below), which
deliberately skips `red` and `security`; and `/hotfix`, which deliberately runs none of the stages
above (see `.sdd/hotfix.md`, and this file's own `/hotfix`
entry point below). `/spec-only` and `/security-recheck` keep working exactly as before — they are
now documented as thin aliases of `/planner` and `/security` respectively, precisely so existing
habits don't break. It replaces two documents that had already drifted apart on one material point (see
"Review persistence" below): `.claude/skills/pipeline/SKILL.md` and `.agents/skills/pipeline/SKILL.md`.
Both are now thin wrappers over this file (Claude Code's is `.claude/skills/pipeline/SKILL.md`; the
equivalent for any other AGENTS.md-reading runtime lives here directly, via `AGENTS.md`).

Each stage's own procedure lives in `.sdd/stages/<stage>.md` — this file only governs the
sequencing between them. Per-runtime invocation mechanics (which tool name to call, what model
tier it runs on, what enforces read-only) live in `.sdd/runtimes.yml`.

`red` is new as of PL-03c (`docs/sdd-tdad-design.md` Section 3): it authors every behavioral test for
`spec.md`'s `AC-*`/`EC-*` items before `dev` runs, so the tests describe the spec rather than the
diff that will eventually satisfy it. The ledger step (also PL-03c) is not a subagent stage — it's a
deterministic script that runs once a run reaches terminal `PASS`, and is documented at the end of
this file's Stage sequence and again under each entry point below.

**JSON sidecars (PL-03h round 4).** Every stage below writes a small, strictly-validated JSON file
next to its markdown report — `spec.json`, `red.json`, `changes.json`, `review.json`, `security.json`
— and every script that makes a control decision (`scripts/build-ledger-index.mjs`,
`scripts/check-red-integrity.mjs`, `scripts/ledger-append.mjs`) reads **only** those JSON files, never
the markdown. This replaced three rounds of patching a hand-rolled markdown block scanner
(`scripts/build-ledger-index.mjs`'s old `extractSection`/`scanBlockState`) that tracked fenced-code
and HTML-comment state well enough to close one document-formatting exploit per round while
introducing or leaving open another — see `.pipeline/review.md`'s round-3 "On convergence" section
and `scripts/pipeline-contracts.mjs`'s own header comment for the full argument. `JSON.parse` either
succeeds or throws, so the *markdown-structural* ambiguity surface (a heading, a fence, an HTML
comment, a setext heading, an ATX closing sequence) is gone outright; `scripts/pipeline-contracts.mjs`
validates each sidecar's shape strictly on top of that (required keys present, verdict/classification
literals restricted to their enum, arrays checked to be arrays, ids checked against the `AC-n`/`EC-n`
shape, duplicate ids/paths within one array refused, **and, as of round 5, a duplicate key within one
JSON object refused** — plain `JSON.parse` permits repeating a key and resolves it "last value wins,"
the identical resolution rule the markdown round's duplicate-heading exploit used, one layer down;
review's round-4 report reproduced it end to end, so `scripts/pipeline-contracts.mjs`'s
`parseJsonOrThrow` now runs a strict, duplicate-key-rejecting parser instead of `JSON.parse` directly —
see that file's header for why a strict parser is achievable for JSON's closed grammar and was not for
markdown's unbounded one). The markdown reports are not decorative — they remain the documents a human
reads, and each stage's own file still requires them — but no script parses their prose for a decision
anymore. **Honest limit, stated plainly:** this removes a *third party's* ability to inject a false
reading through document formatting or through a duplicate-key resolution rule (which is what every
demonstrated exploit against the old scanner, and the round-4 duplicate-key exploit, did); it does
not, and cannot, stop a stage from writing a false value into its own JSON in the first place — a
stage that lies about its own verdict still lies, exactly as much as it could by lying in markdown
prose.

## Staleness stamps (PL-04)

Every `.pipeline/*.json` sidecar above is *intended* to carry a `stamp` field, recording the tree
state at the moment it wrote the file — what actually guarantees this, concretely, is that each
`.sdd/stages/*.md` file's own numbered procedure runs `scripts/write-stamp.mjs` as its explicit last
step for that sidecar (see e.g. `.sdd/stages/planner.md`'s step 5 and `.sdd/stages/dev.md`'s step 9).
Nothing currently pins that instruction against being silently dropped from a stage file, so this is
a property of the procedure being followed, not an invariant a script enforces on its own — an
artifact written before this contract existed, or by a stage whose own step for it was ever removed,
carries no `stamp` key at all and reads `"unknown"` (never `"fresh"`) from every consumer below, per
`check-stamp-freshness.mjs`'s own three-way status. (`.pipeline/changes.json` shipped unstamped on
this contract's very first opportunity, in this same round, despite the producer and the instruction
both already existing — see `.sdd/stages/CHANGELOG.md`'s "PL-04 review pass 2" entry.)

```json
"stamp": { "treeHash": "...", "headSha": "...", "dirty": true, "writtenAt": "..." }
```

This exists to close a real gap: a downstream stage had no way to tell whether `changes.md`/
`review.md`/etc. describe the tree currently on disk or one that has since moved on (a new commit
landed, or someone hand-edited a file after the artifact describing it was written) — `review` in
particular used to read `changes.md` with no signal it might already be stale. (`test-results.md` is
the one exception: `tester` writes no JSON sidecar at all, so there is no `stamp` for it — see
`.sdd/stages/review.md`'s "Staleness of required inputs" section for how `review` covers that file's
currency without one.)

Two committed scripts, not "implementation detail" left to each stage to improvise, implement this:
`scripts/write-stamp.mjs <path-to-sidecar.json>` is the producer — every stage that writes one of the
five `.pipeline/*.json` sidecars runs it as the last step for that file (see each
`.sdd/stages/*.md` file's own numbered procedure). It shells out to the same read-only `git` commands
`scripts/ledger-append.mjs`'s `currentCommitInfo()` already established: `treeHash` is a SHA-256 over
`git rev-parse HEAD` + `git diff HEAD` + every untracked file's own content (`git ls-files --others
--exclude-standard`, then each file read directly — see `scripts/pipeline-contracts.mjs`'s
`computeTreeHash`), and the stamp's other fields reuse `git rev-parse HEAD` again for `headSha` and
`git status --porcelain` for `dirty`. `scripts/check-stamp-freshness.mjs <sidecar>`
is the consumer — every stage's own "Staleness of required inputs" section below names it by exact
command and exit code (`0` = not stale, `1` = stale, `2` = the check itself failed). Neither script is
optional prose: an agent cannot reproduce a SHA-256 working-tree hash, or compare one against the tree
right now, by reading or writing a file, for the same reason `check-red-integrity.mjs` is a committed
script rather than an instruction to rehash a file by hand. What this file, and each
`.sdd/stages/*.md` file's own "Staleness of required inputs" section, specify beyond the two scripts'
own exit codes is the *contract* — what a stage does once an input is known to be stale.

Every required input, on every stage, is exactly one of three policies:

- **re-derived** — the stage computes the underlying fact itself, directly against the current
  tree, rather than trusting the input's recorded value for that fact. Staleness of the input is
  irrelevant to this fact specifically, because the input's `stamp` was never what the stage relied
  on for it: `security` already runs its own `git diff` rather than trusting `changes.json`'s
  `filesChanged` list for what changed; `red`/`tester` invoke the impact resolver fresh every run
  rather than reading a stored result.
- **trusted-fresh** — the stage depends on the input describing the current tree to behave
  correctly. On a stale stamp: **`security` refuses** — the same posture it already takes toward a
  `NEEDS_FIXES` `review.json`; a stale gate is not a passed gate — while **every other stage flags
  the staleness explicitly in its own report and proceeds anyway**, against the input's current
  on-disk content rather than a silently-trusted freshness claim. This is the same "state it, don't
  imply it away" discipline every other disclosure in this pipeline already follows (the impact
  resolver's presence/absence, `red`'s `RED-DEFERRED` classification) — a flag a human can see beats
  a silent assumption, and only `security`, the last gate before merge, is positioned to make
  refusing the safer default rather than the disruptive one. (The **ledger** step below — not itself a
  subagent stage — applies this identical refusal to its own two trusted-fresh inputs,
  `review.json`/`security.json`: a stale `PASS` cited there would durably attribute a live-diff
  `filesTouched` list to a verdict that never saw it, which is worse than a stage merely behaving
  incorrectly for one run, so it is held to `security`'s refusing posture rather than to every other
  stage's flag-and-proceed one — see step 7's own exit-`1` conditions.)
- **advisory** — the stage reads the input for background/context, never for a control decision. It
  notes staleness if it happens to notice, but never refuses and never changes its own procedure
  because of it — `tester`'s existing read of `changes.md` ("not an input for deriving assertions")
  is the model this category generalizes.

`planner` has no `.pipeline/` input to classify — it is always stage 1; the `stamp` it writes into
`spec.json` is simply the tree state at the moment `spec.md`/`spec.json` were written, for every
downstream stage to compare against.

## Stage sequence

1. **planner** — reads the ticket, writes `.pipeline/spec.md` **and** `.pipeline/spec.json` (see
   `.sdd/stages/planner.md` for its exact shape: `{ ticket, goal, acceptanceCriteria, edgeCases }`).
   Every Acceptance Criterion and Edge Case gets a stable `AC-*`/`EC-*` ID, present in both files —
   `red` cites these on every test it authors, so they have to exist before it runs, and
   `check-red-integrity.mjs`'s spec-trace check resolves against `spec.json`'s copy of them, not
   `spec.md`'s prose.
2. **red** — reads `spec.md`/`spec.json`, and the impact map from PL-03b's test-impact resolver when
   it's usable in the current checkout (it is wired in; usability depends on the workers' Poetry
   environment — Python 3.12 + Tree-sitter's native grammars — being available). `red` states the
   resolver's usable/unavailable status explicitly either way, via `red.json`'s required
   `impactMapPresent` boolean, rather than silently proceeding. Authors a behavioral test for every
   `AC-*`/`EC-*` item **before `dev` runs**, so no test can have been shaped by the diff it will later
   verify. Classifies each as `RED-CORRECT`, `RED-DEFERRED` (an item that needs infrastructure this
   checkout doesn't have, e.g. a live Neo4j), or — only transiently, never in a finished `red.md`/
   `red.json` — `RED-BROKEN` (a literal `red.json`'s `classification` field does not even accept).
   Writes `.pipeline/red.md` (test paths, `@spec` mapping, observed failure output, classification,
   and a SHA-256 content hash per test file, for human readers) **and** `.pipeline/red.json` (the same
   facts, structured — see `.sdd/stages/red.md` for its exact shape) — `check-red-integrity.mjs` reads
   only the latter.
3. **dev** — reads `spec.md`/`spec.json`, `red.md`/`red.json` if they exist (their test list and
   `@spec` mapping are the definition of done; runs the red suite itself before writing changes.md),
   and `review.md` if this is a re-invocation, writes `.pipeline/changes.md` **and**
   `.pipeline/changes.json` (`{ filesChanged, redTestChanges }` — see `.sdd/stages/dev.md`). If dev
   modifies a file `red.json` lists, it must declare the exact path and reason as an entry in
   `changes.json`'s `redTestChanges` array (and describe it in `changes.md`'s matching section for
   human readers) — `review`'s red-test-integrity check treats an undeclared change as `NEEDS_FIXES`
   regardless of intent.
4. **tester** — reads `spec.md`, `red.md`, and the impact map if present. **Does not read
   `changes.md` to decide what to test** — that was D-018's finding against the pre-PL-03c version of
   this stage. Runs every test `red.md` lists (each must now pass, or be reported as a failure) and
   adds only non-behavioral coverage (fixtures, harness, type-level checks). If it spots a behavioral
   gap, it reports the gap in `.pipeline/test-results.md` rather than writing the test itself.
5. **review** — reads `spec.md`, `changes.md`, `test-results.md`, and `red.md`; runs its own
   `git diff`; produces a report whose shape is defined in `.sdd/stages/review.md`. As of PL-03c it
   also rehashes every file `red.json` lists (an undeclared change is `NEEDS_FIXES` unless
   `changes.json` declares it) and confirms every new behavioral test cites a resolvable `@spec` ID —
   both checks read only the JSON sidecars (`scripts/check-red-integrity.mjs`), never `red.md`'s or
   `changes.md`'s prose. That report is persisted to `.pipeline/review.md` (for human readers) **and**
   `.pipeline/review.json` (`{ "verdict": "PASS" | "NEEDS_FIXES" }` — see `.sdd/stages/review.md`),
   which is what `scripts/ledger-append.mjs` actually reads to confirm a terminal `PASS`.
6. **security** — runs only once `review.md`/`review.json` shows `PASS`. Reads `spec.md`,
   `changes.md`, `review.md`, applies the registered attacker briefs per
   `.sdd/stages/security.md`, writes the immutable artifacts under
   `.pipeline/security-history/<run-id>/`, and produces a report persisted to
   `.pipeline/security-report.md` (for human readers) **and** `.pipeline/security.json`
   (`{ "verdict": "PASS" | "BLOCKED", "runId": "<run-id>" }` — see `.sdd/stages/security.md`), which
   is what `scripts/ledger-append.mjs` actually reads to confirm a terminal `PASS` and to locate the
   run to reuse as the ledger id.
7. **ledger** (not a subagent stage) — runs once, only when `security-report.md`/`security.json`
   shows `PASS` immediately after `review.md`/`review.json` also showed `PASS` (a "terminal `PASS`" —
   see Routing below). Run `node scripts/ledger-append.mjs`: it reads `security.json`'s `runId`
   directly (no markdown scanning or fallback chain — see `scripts/pipeline-contracts.mjs`), verifies
   that run independently against its own immutable `manifest.json`/`results.json` under
   `.pipeline/security-history/`, writes `.sdd/ledger/<run-id>/{spec.md,entry.md,entry.json}` plus a
   verbatim copy of whichever `.pipeline/*.json` sidecars existed for this run (`spec.json` always;
   `red.json`/`changes.json` when present; `review.json`/`security.json` always — see
   `.sdd/ledger/README.md`), reusing that run's own id (see `.sdd/ledger/README.md` for why the two
   ids are the same string — it's what makes a ledger entry and its security run trivially
   correlatable), and regenerates `.sdd/ledger/index.json` itself (via
   `scripts/build-ledger-index.mjs`'s exported logic, which reads only each run's `entry.json` — not
   `entry.md`'s prose — for the verdicts gate and the files-touched list; there is no separate manual
   regeneration step). Exit `0` on success, printing two `ledger-append:` lines naming what it wrote
   and the regenerated `index.json`'s file count; exit `1` (a `ledger-append: <message>` line on
   stderr) if `review.json`/`security.json` don't both show `PASS`, if either sidecar's own `stamp`
   reads `STALE` against the tree right now (`scripts/ledger-append.mjs`'s `refuseIfStale` — closing the
   gap where a stale-but-`PASS` pair, left over from before a later, never-reviewed edit, could
   otherwise be attributed a live-diff `filesTouched` list that gate never actually saw; this check is
   unconditional, run before either `--override-*` flag is even considered), if `spec.json`'s own
   `ticket` field disagrees with `spec.md`'s own first-heading ticket (CORRECTED, SEC-10 v2 fix round
   — FND-bd78355b6ae7, HIGH: this agreement check used to run only under `--re-gate`; it is now
   unconditional on every ledger write, since it needs no caller-supplied `--ticket` to check the two
   files against each other — see "Per-stage entry points"'s `/security` step 4 below for the residual
   case it cannot catch and why `/re-gate --ticket <id>` is the fix for that case specifically), if
   the cited security run can't be independently verified, or if the target run directory already
   exists — never a partial write. A run that never reaches terminal `PASS` writes no ledger entry — deliberate,
   see spec.md's edge cases for PL-03c. **The sanctioned exception** (PL-04 / B2, B3): a run whose
   real, terminal `review.json`/`security.json` verdict was `NEEDS_FIXES`/`BLOCKED` can still be
   recorded, deliberately and for a stated reason, via
   `node scripts/ledger-append.mjs --override-review "<reason>" [--override-security "<reason>"]` —
   see `.sdd/ledger/README.md`'s "Sanctioned override entries" section. This is a **disclosure**
   requirement, not an authorization check: nothing verifies who invokes either flag, only that doing
   so leaves a durable, visibly-marked record rather than a silent one. This is not a second, looser
   ledger step; it is the same script, widening exactly which verdict literal is acceptable on the
   gate(s) named, and it still refuses without a non-empty reason for each gate overridden.

## Routing

- If `review.json`'s verdict is **NEEDS_FIXES**: go back to **dev**. Re-invoking dev is how it picks
  up `review.md`'s fix list — dev's own procedure (`.sdd/stages/dev.md`) already reads it
  automatically. Then repeat **tester** and **review**. `red` does **not** re-run in this loop — it
  already produced the tests `dev` is now fixing against. The one exception is the "spec was wrong"
  edge case: if the fix genuinely requires amending `spec.md` (e.g. `dev` finds a signature that
  can't work as written), `dev` amends the affected red test(s) directly and declares exactly what
  changed and why in `changes.md`/`changes.json` — `red` is not re-invoked to redo work `dev` can
  describe inline, and `review`'s red-test-integrity check is what verifies the declaration is honest
  rather than a quiet weakening of the test.
- If `review.json`'s verdict is **PASS**: continue to **security**.
- If `security.json`'s verdict is **BLOCKED**: go back to **dev** with the security findings as
  the fix list (same handling as a `NEEDS_FIXES` review). Repeat **tester**, **review**, and
  **security**. `red` still does not re-run, for the same reason as above.
- If `security.json`'s verdict is **PASS**: the run has reached terminal `PASS`. Run the
  **ledger** step (above) before reporting the run complete.

(`review.json`/`security.json` are the fields the routing decision above actually depends on, per the
JSON-sidecar contract — `review.md`/`security-report.md`'s own `## Verdict` sections must agree with
them, for the human reading the run, but nothing in this routing logic parses those sections anymore.)

**Loop cap:** three total `dev` attempts across both routing loops (review fix-loop and security
fix-loop combined is the existing cap the prior two skills already agreed on — this ticket does not
change it). If still not passing after three rounds, stop and hand the situation to the user with a
summary of what keeps failing, rather than looping indefinitely. No ledger entry is written for a run
that stops here — a run that never reaches terminal `PASS` leaves no ledger record, by default (see
spec.md's edge cases). A human can still choose to record that outcome durably, on their own
authority and for a stated reason, via `--override-review`/`--override-security` (see the ledger
step above and `.sdd/ledger/README.md`'s "Sanctioned override entries" section) — that is a
deliberate, reasoned action a person takes after the loop cap stops things, never something the loop
itself does automatically.

**Never:** skip a stage, let a later stage synthesize or improvise a missing earlier-stage
artifact, or run dependent stages in parallel. If a required `.pipeline/` file is missing, stop and
say which stage needs to run first. (This governs automatic routing within `/pipeline`, `/re-gate`,
and a re-invocation loop — not a human's explicit choice to run one stage alone via the per-stage
commands under Entry points below, which is exactly what those commands are for.)

## Review persistence — the resolved divergence

The two prior mirrors disagreed on *who writes* `.pipeline/review.md`: the Claude Code skill had
the `review` subagent write it directly, confined to `.pipeline/` by a hook guard (real and
load-bearing for Claude Code since PL-03g — see `.sdd/README.md`'s "Note on hook enforcement"); the
other mirror had its coordinator save the subagent's returned markdown verbatim, with no equivalent
guard (Codex has no subagent-isolation mechanism to hang one on). Both are the same contract
implemented two different ways, and the contract is what's neutral:

> `review` (and `security`) produce a report in the shape their stage file defines; that report is
> persisted verbatim to `.pipeline/review.md` (respectively `.pipeline/security-report.md`).

The *mechanism* — a runtime with subagents and hooks lets the stage write its own file directly; a
runtime without them has the coordinator save the returned markdown — is a per-runtime detail and
lives in `.sdd/runtimes.yml`, not here. Do not let a runtime difference in mechanism become a
difference in what gets persisted or in what the coordinator is allowed to alter before saving it:
the coordinator saves the report verbatim, it does not edit, summarize, or selectively drop
sections from it.

The same neutral contract covers each stage's JSON sidecar (PL-03h round 4): `review.json`/
`security.json` are persisted verbatim to `.pipeline/`, by whichever mechanism the runtime uses for
the matching markdown file, at the same time as that markdown file — never as a separate, later step
a runtime could skip. A runtime that persists `review.md` but drops `review.json` (or lets them
disagree) has not implemented this stage correctly, regardless of which persistence mechanism it uses.

## Running stages in a single context (no subagent boundary)

A runtime without subagent isolation (e.g. one where the coordinator itself executes each stage's
`.sdd/stages/*.md` procedure in sequence, in one continuous context) does not get a structural
guarantee that, say, `review` can't see what `dev` was thinking. That guarantee does not exist for
that runtime — it is an accepted, recorded cost (see `.sdd/README.md`), not something this document
can restore. What this document *can* still require, and does, is that the coordinator behave as if
the boundary were real:

- Before starting a stage, **freshly read** that stage's required inputs from the `.pipeline/` files
  on disk — don't carry forward assumptions from having just written them as the previous stage.
- **Don't skip a stage** because "I already know what dev did" — tester, review, and security each
  have their own required-inputs list in their stage file; read it in full every time.
- **Don't improvise a missing input.** If `changes.md` is missing when tester is supposed to start,
  stop and say dev needs to run first, the same as a runtime with real subagent isolation would.
- **Don't let review or security silently reuse conclusions** the coordinator already formed while
  acting as dev/tester in the same session. Re-derive the verdict from the artifacts, not from
  memory of writing them.
- **`red` specifically:** a coordinator without subagent isolation must still literally write
  `.pipeline/red.md` to disk and finish that stage before starting `dev`'s turn in the same session —
  and while acting as `dev`, must read `red.md` and `spec.md` fresh rather than reasoning from
  whatever internal notes it formed while acting as `red` moments earlier. The whole guarantee this
  stage exists to provide is ordering; a coordinator that mentally skips ahead while "being" `red`
  destroys that guarantee just as completely as a runtime that literally reordered the stages would.

## Entry points

The commands below compose the stages above and below — the full sequence (`/pipeline`); six
per-stage commands that each run exactly one stage alone (`/planner`, `/red`, `/dev`, `/tester`,
`/review`, `/security`, plus their pre-existing aliases `/spec-only`/`/security-recheck`); a status
check (`/pipeline-status`); the sanctioned re-verification path after a hand-edit (`/re-gate`); the
proportionate lane for a genuinely small, mechanically-eligible change (`/pipeline-lite`), which
skips `red` and `security` deliberately; and `/hotfix`, which deliberately runs none of the stages
at all (see this file's intro and `.sdd/hotfix.md`). Each is documented at the neutral level here;
each runtime's shim (`.claude/skills/<name>/SKILL.md`, or the equivalent invocation in a runtime
without a skills mechanism) is a thin pointer to the matching section below.

### `/pipeline <ticket>`

Runs the full stage sequence and routing above, end to end.

1. If `.pipeline/spec.md` already exists, ask whether to reuse it as-is (e.g. it came from
   `/spec-only` and may have been hand-edited) or regenerate it. Only invoke **planner** if it's
   missing or the user confirms regeneration.
2. Otherwise invoke **planner** with the ticket.
3. If `spec.md` contains non-trivial Open Questions, stop and surface them before continuing — don't
   let `red` (next) or `dev` start against an ambiguous spec. `red` reads spec.md immediately after
   planner, so an ambiguous spec produces ambiguous or wrong tests just as readily as it produces
   wrong code.
4. Run stages 2–6 above (`red` through `security`) with their routing.
5. Once `security.json` shows `PASS` immediately following a `PASS` `review.json`, run the
   **ledger** step (`node scripts/ledger-append.mjs`, which regenerates `index.json` itself).
6. Report back: overall result (ready to merge, or stopped and why); a one-line summary of what was
   built (from spec.md's Goal); links to all `.pipeline/` artifacts, markdown and JSON alike
   (`spec.md`/`spec.json`, `red.md`/`red.json`, `changes.md`/`changes.json`, `test-results.md`,
   `review.md`/`review.json`, `security-report.md`/`security.json`); the security run ID, baseline
   run ID, immutable artifact directory, and finding/coverage trajectory; the ledger entry path
   (`.sdd/ledger/<run-id>/`) if a terminal `PASS` was reached; and any non-blocking
   Warnings/Suggestions from `review.md` or `security-report.md`.

### `/pipeline-lite <ticket>`

The proportionate lane for a genuinely small, mechanically-eligible change (PL-11) — a typo, a
one-file cleanup, a doc fix. A fail-closed, mechanical eligibility gate (step 1 below) runs before
anything else; only a change it confirms small ever reaches the stages that follow, which are
otherwise the ordinary sequence — deliberately skipping `red` and `security` (see "Honest limits"
below for what that costs) — ending in the mandatory ledger step. Available on any lane (including a
fenced one — a fenced contributor fixing a typo inside their own area is exactly who this lane is
for; `/hotfix`'s `full`-only restriction is untouched). It is not a fourth degree of the full
pipeline's own routing or loop cap — both are reused unchanged (see Routing and "Loop cap" above);
this section only adds the eligibility gate in front of them and the disclosure that goes into the
ledger at the end.

**Not `/hotfix`:** `/hotfix` is for when production is broken and there is no time for a spec at
all; this lane still writes a real spec and still passes `review` before anything lands.
**Not `/re-gate`:** `/re-gate` re-verifies a run that already happened, after a hand-edit outside
`dev`'s loop; this lane is a first, and only, pass through the pipeline for a change small enough to
skip two of its gates going in.

1. **Eligibility first, and it is mechanical, not a judgment call.** `node
   scripts/check-lite-eligible.mjs` computes the verdict — before any stage below ever runs — against
   `.sdd/bounds.yml`'s `lite_eligibility` bounds (`max_files`, `max_changed_lines`, `max_line_length`
   — the last one catches a diff shaped as a very few, very long lines, which `max_changed_lines`
   alone cannot) and the barred-path union (see "Honest limits" below): exit `0` (eligible) continues
   into this lane; exit `1` (ineligible, too big or touches a barred path) or exit `2` (the check
   could not run — ambiguous input, an unresolvable `--base`, a missing `lite_eligibility` block) both
   route to `/pipeline` instead. Ambiguity is ineligibility; the lane is never entered provisionally. The same
   routing table covers two adjacent cases: a small change made during a production incident is
   `/hotfix`, not this lane; a small change on a barred path is `/pipeline`, not this lane.
2. Invoke **planner** with the ticket, exactly as `/pipeline` does.
3. **`red` is skipped.** No test for this ticket is authored before `dev` runs — see "Honest limits"
   below for what that costs.
4. Invoke **dev**.
5. Invoke **tester**. It still runs in full on this lane — `.sdd/stages/tester.md`'s Required inputs
   item 1 treats `red.md`'s absence as legitimate specifically on this lane (state it, don't stop),
   while every other guarantee (no authored behavioral tests, gaps reported rather than filled) stays
   in force, and is *more* consequential here since no `red` stage covered anything to begin with.
6. Invoke **review** — the surviving gate, **unchanged**. This lane adds **no new subagent stage**:
   `review` is still the one that decides `PASS`/`NEEDS_FIXES`, its decision still comes from
   `.pipeline/review.json` (never `review.md`'s prose — the same JSON-sidecar contract every other
   path already uses), and its read-only-with-respect-to-source-code property is still the same
   structural enforcement every other path relies on — `scripts/guard-checker-readonly.mjs`'s
   `READ_ONLY_AGENTS` set, which already lists `review` (see `.sdd/README.md`'s "Note on hook
   enforcement"). `.sdd/runtimes.yml` and every file under `.claude/agents/` are unchanged by this
   lane.
7. **`security` is skipped.** No attacker-brief sweep, no CORE-01..06 pass, no immutable audit record
   for this run — see "Honest limits" below.
8. Once `review.json` shows `PASS`, run the **ledger** step with the lite marker:
   ```sh
   node scripts/ledger-append.mjs --lite
   ```
   which re-checks eligibility against the live diff (never trusting step 1's earlier verdict alone —
   the tree may have moved since), refuses on a `STALE` `review.json` (`refuseIfStale`, unchanged from
   the plain path) or an unstamped `spec.json` (the same hygiene check `/re-gate` already applies, for
   the same reason: there is no security-history cross-check on this lane to compensate), and writes a
   visibly-marked entry — title `(LITE)`, `verdicts: { review: "PASS", security: "SKIPPED_LITE" }`, a
   `## Lite lane` section naming exactly what did not run — that is nonetheless indexed into
   `.sdd/ledger/index.json`'s file→spec map (not excluded, unlike a `--hotfix`/override entry): the
   spec really was ratified and `review` really did pass it against the final tree, the same argument
   `.sdd/ledger/README.md` already makes for a `--re-gate` entry. See that file's "Lite-lane entries"
   section for the exact shape.
9. Report the same things `/pipeline`'s own step 6 reports, plus: that this was a lite-lane run, which
   stages were skipped, and the eligibility numbers it was measured against.

If `review.json` reads `NEEDS_FIXES`, this lane reuses the same routing loop `/pipeline` already has
(back to `dev`, then re-run `tester`/`review`) and the same 3-attempt loop cap — nothing here defines
a second, lite-specific loop. Escalating out of the lane entirely (the change grew, or review surfaces
something this lane's mechanical gate could not have caught) means finishing through the full
pipeline: run `/security` against the current tree, then the plain `node scripts/ledger-append.mjs`
— never retrying `--lite` against a change that has already been found too large or too sensitive for
it.

**Honest limits.** This lane gives up real things, named plainly rather than left implicit:

- `red`'s spec-first ordering. Any test that ends up covering this change was written *after* the
  diff already existed — the exact D-018 inversion the rest of this pipeline exists to prevent,
  reintroduced deliberately, and only here, for a change small enough that the tradeoff is judged
  worth it.
- `security`'s full attacker-brief sweep, the CORE-01..06 mandatory checks, and the immutable
  `.pipeline/security-history/` audit record — none of them run, none of them exist for this run.
- The barred-path list (`hotfix_barred_paths` ∪ `deny_for_fenced_lanes`, computed by
  `scripts/check-lite-eligible.mjs`'s `liteBarredPaths`) is a curated, best-effort list, not a
  complete classifier of every security-sensitive path in this codebase.
- The fail-closed default: ambiguous eligibility — a check that could not run, a bound that could not
  be evaluated, a base that could not be resolved — routes to `/pipeline`, never a provisional entry
  into this lane.

### Per-stage entry points

Six commands — `/planner`, `/red`, `/dev`, `/tester`, `/review`, `/security` — invoke exactly one
stage's own subagent, per that stage's `.sdd/stages/<stage>.md` procedure, and then stop. None of
them chains into the next stage automatically; that is what `/pipeline` is for.

This closes a real, observed gap, not a theoretical one: before this section existed, only
**planner** (via `/spec-only`) and **security** (via `/security-recheck`) could be invoked alone.
`red`, `dev`, `tester`, and `review` could not — and `/security-recheck` refuses to run on anything
but a `PASS` `review.json`, so a hand-edit made after a `NEEDS_FIXES` review had no sanctioned way
back to a fresh verdict at all: there was no standalone `/review` to re-run, and a full `/pipeline`
restart both redoes `dev`/`tester` unnecessarily and, unless declined at its own first prompt,
overwrites the very `spec.md` the fix was made against. An absent legitimate path is what produces
an illegitimate one — see `/re-gate` below for the sanctioned fix to that specific situation, and
this ticket's own motivating incident for why that distinction matters.

Every one of the six follows the same contract:

1. **Check that stage's own required inputs exist**, per its `.sdd/stages/<stage>.md` file. Never
   invent a missing one. If a hard-required upstream artifact is absent, stop and say plainly which
   stage needs to run first — the same "never improvise a missing input" rule this file's Routing
   section already states for the full sequence (see the parenthetical note there).
2. **Invoke that one subagent** and let it run its full procedure exactly as documented in its own
   `.sdd/stages/<stage>.md` file — this section and the matching `.claude/skills/<name>/SKILL.md`
   shim never restate or duplicate that procedure.
3. **Report that stage's own output artifacts** (paths, verdict where applicable) and stop.
   Continuing to the next stage is a human decision made after reading this report — or an explicit
   `/pipeline` run — never something a per-stage command does on its own.
4. **Never run the ledger step**, with one named exception: `/security`, when it produces a `PASS`
   immediately following an already-`PASS` `review.json` (a terminal `PASS` reached through this
   door instead of through `/pipeline`), runs the ledger step exactly as `/pipeline`'s own step 5
   and `/security-recheck`'s existing step 4 already do. This is not new behavior — it is named
   here once so the six commands' contract is stated consistently rather than re-derived per command.
   Which ledger *command* that is depends on whether `planner` actually ran earlier in this same
   round — see `/security`'s own step 4 below (CORRECTED, SEC-10 v2 fix round) for the branch: the
   plain `node scripts/ledger-append.mjs` when it did, `/re-gate --ticket <id>` when it did not.

### `/planner <ticket>`

Runs only **planner** and stops before any code changes — the canonical per-stage entry point for
this stage.

1. If `.pipeline/spec.md` already exists, warn that regeneration will replace it (and its
   `spec.json` sidecar) and get confirmation.
2. Invoke **planner** with the ticket.
3. Do not continue to red, dev, tester, review, or security.
4. Report the Goal, Scope, and Open Questions from spec.md; where the file (and `spec.json`) lives;
   that it can be hand-edited before continuing (both files, kept in agreement); and that continuing
   means invoking **red** directly (`/red`, not `/pipeline`, which restarts from planner and would
   overwrite the reviewed spec).

### `/spec-only <ticket>`

Alias of `/planner <ticket>`, above — identical behavior, kept working under its original name so
existing habits don't break.

### `/red`

Runs only **red**, against whatever `.pipeline/spec.md` currently holds.

1. Require `.pipeline/spec.md` to exist; if it doesn't, say **planner** (`/planner <ticket>`) needs
   to run first, and stop.
2. Invoke **red**. It authors and classifies a behavioral test for every `AC-*`/`EC-*` item per
   `.sdd/stages/red.md`, refusing on its own to finish with any `RED-BROKEN` test left in it.
3. Report `red.md`'s Impact map paragraph, the test/classification counts (`RED-CORRECT` vs.
   `RED-DEFERRED`), and where `red.md`/`red.json` live. Continuing means invoking **dev** (`/dev`),
   not restarting via `/pipeline`.

### `/dev`

Runs only **dev**, against whatever `.pipeline/spec.md` (and, if present, `red.md`/`review.md`/
`security-report.md`) currently holds.

1. Require `.pipeline/spec.md` to exist; if it doesn't, say **planner** needs to run first, and
   stop.
2. Invoke **dev**. Its own procedure (`.sdd/stages/dev.md`) already knows to treat a re-invocation
   after a `NEEDS_FIXES` `review.json` or a `BLOCKED` `security.json` as required fixes rather than
   a fresh implementation — this command does not need to detect or announce that case separately.
3. Report `changes.md`'s Files changed / Decisions made / Deviations / Fixes applied sections, and
   where `changes.md`/`changes.json` live. Continuing means invoking **tester** (`/tester`).

### `/tester`

Runs only **tester**, against whatever `.pipeline/spec.md` and `.pipeline/red.md` currently hold.

1. Require `.pipeline/spec.md` and `.pipeline/red.md` to exist (tester's own required inputs — see
   `.sdd/stages/tester.md`); if either is missing, say which of planner/red needs to run first, and
   stop.
2. Invoke **tester**. It does not author behavioral tests (see `.sdd/stages/tester.md`) — it runs
   the red suite, the impact-resolver regression set when usable, and reports gaps rather than
   filling them.
3. Report `test-results.md`'s Result summary and Reported behavioral gaps, and where the file lives.
   Continuing means invoking **review** (`/review`).

### `/review`

Runs only **review**, against whatever `.pipeline/spec.md`, `changes.md`, `test-results.md`, and
`red.md` currently hold.

1. Require `.pipeline/spec.md`, `.pipeline/changes.md`, and `.pipeline/test-results.md` to exist; if
   any is missing, say which stage needs to run first, and stop. (`.pipeline/red.md`/`red.json`
   being absent is a legitimate state — a ticket that predates `red` — see `.sdd/stages/review.md`.)
2. Invoke **review**. It is read-only with respect to source code (enforced structurally — see
   `.sdd/runtimes.yml`); it reports and routes, it never fixes.
3. Report the verdict (`PASS`/`NEEDS_FIXES`), the Critical/Warning/Suggestion findings, and the fix
   list if `NEEDS_FIXES`. If `PASS`, continuing means invoking **security** (`/security`); if
   `NEEDS_FIXES`, continuing means re-invoking **dev** (`/dev`) with the fix list.

### `/security [--mode PR_DELTA|REMEDIATION_RECHECK]`

Runs only **security** — the canonical per-stage entry point for this stage. Default mode is
`PR_DELTA`.

1. Require `.pipeline/spec.md` and `.pipeline/changes.md` to exist; if either is missing, say the
   pipeline hasn't produced enough to security-check yet, and recommend `/pipeline` or `/dev`
   instead.
2. Invoke **security** with the given (or default) mode. Security's own procedure
   (`.sdd/stages/security.md`) already refuses to run a full check unless `.pipeline/review.json`'s
   verdict is `PASS` — this command relies on the subagent enforcing that gate, it does not
   duplicate it.
3. Report the resulting `security.json`/`security-report.md` verdict, run ID, baseline run ID,
   finding transitions, and coverage gains/losses.
4. If `BLOCKED`, route fixes through **dev** (`/dev`) and re-run `/security` afterward — this
   command does not re-run tester or review automatically. If `PASS`, this run has produced a
   terminal `PASS` exactly as much as reaching it via `/pipeline` does — the ledger step must still
   run, but which command depends on whether **planner** actually ran earlier in this same round
   (CORRECTED, SEC-10 v2 fix round — FND-bd78355b6ae7, HIGH: this step used to instruct the plain
   command unconditionally, with no branch for "no planner ran this round," which is exactly the
   documented happy path a stale or mismatched `spec.md`/`spec.json` pair — left over from an
   earlier ticket, with no `planner` invocation in between — walks straight through):
   - **planner ran this round** (`.pipeline/spec.md`/`spec.json` were freshly (re)written by
     planner for the ticket this run is actually about): run the same **ledger** step
     (`node scripts/ledger-append.mjs`) and report the resulting entry path.
   - **planner did not run this round**: use `/re-gate --ticket <id>` instead (see `/re-gate`
     below), supplying the ticket this run is actually about as your own independent assertion —
     the same precondition `/re-gate` already requires because it is the one entry point that
     reaches the ledger without planner ever having run. `scripts/ledger-append.mjs`'s own
     `spec.json`/`spec.md` agreement check (unconditional on every path as of this fix — see
     "Stage sequence" step 7 above) still refuses a straight mismatch between the two files either
     way, but only `--re-gate --ticket <id>` catches the narrower case that check alone cannot:
     `spec.json` and `spec.md` agreeing with each other while both are stale leftovers from a
     different ticket than this round's real work.

### `/security-recheck`

Alias of `/security --mode REMEDIATION_RECHECK`, above — identical behavior, kept working under its
original name. As before: pass along any prior finding IDs or remediation references that prompted
the recheck when available; never instruct it to skip sibling or bypass paths.

### `/pipeline-status`

Reports where a run currently stands. Takes no action — no stage is invoked, no file is written.

1. Check which of `spec.md`, `red.md`, `changes.md`, `test-results.md`, `review.md`,
   `security-report.md` exist under `.pipeline/`, in that order, and compare modification times — an
   older downstream artifact than its upstream dependency likely means that stage hasn't run against
   current input yet. Their JSON sidecars (`spec.json`, `red.json`, `changes.json`, `review.json`,
   `security.json`) should exist and agree with their markdown counterparts wherever the markdown
   does — report a mismatch (one present without the other, or disagreeing verdicts) as its own
   finding, since it means a stage's output is incomplete or inconsistent under the JSON contract.
2. Pull spec.md's Goal, `review.json`'s verdict, and `security.json`'s verdict where present (the
   authoritative source for both — see "JSON sidecars" above — cross-checked against `review.md`'s/
   `security-report.md`'s own `## Verdict` prose for agreement). If `security.json` shows `PASS`
   following a `PASS` `review.json`, also check whether `.sdd/ledger/index.json` already has an entry
   for this run (i.e. whether the ledger step ran) and report that too — a terminal `PASS` with no
   ledger entry means the ledger step is still owed, not that the run is unfinished.
3. Report: Ticket (the Goal, or "no spec.md — pipeline hasn't started"); Furthest stage reached;
   Verdicts so far; a timestamp/staleness flag; and a suggested next action (e.g. "run `/pipeline`
   to continue," "review.json says NEEDS_FIXES — invoke dev," "security.json is BLOCKED — invoke
   dev," "terminal PASS reached but no ledger entry yet — run `node scripts/ledger-append.mjs`," or
   "complete — ready to merge").

### `/re-gate [--gates-only] [--ticket <id>]`

The sanctioned path back to a verdict after a hand-edit made **directly to the working tree**,
outside `dev`'s own re-invocation loop — e.g. a small fix applied by hand while reviewing a
`NEEDS_FIXES`/`BLOCKED` result, or any other edit made without going back through `/dev`. This is
not the situation `/hotfix` (below) exists for: `/hotfix` is for when the pipeline never ran at
all for this change (production is broken, there is no spec, nothing has been reviewed). `/re-gate`
is for when `dev`/`tester`/`review` (and maybe `security`) already ran at least once for this
ticket — there is a `review.json` on disk — and the tree has since been hand-edited outside that
sequence. If there is no `review.json` yet, this command refuses; use `/pipeline` or the per-stage
commands above instead.

Before this command existed, an inline edit made after a `NEEDS_FIXES` review had no sanctioned way
back to a verdict at all: `/security-recheck` refused on anything but a `PASS` `review.json`, and
there was no standalone `/review` to refresh it. That absence is exactly the D-005 #3 failure this
pipeline exists to prevent, reproduced one level up — a human escaping around the tooling by
hand-writing an override, with no record it happened. `/re-gate`'s entire reason to exist is closing
that gap **with a record**, not merely with a working command: skip the ledger step below and this
is once again a fast path for laundering an unreviewed edit into a `PASS`.

1. Require `.pipeline/spec.md`, `.pipeline/changes.md`, and `.pipeline/review.json` to exist. If any
   is missing, say the pipeline hasn't produced enough to re-gate, and recommend `/pipeline` or the
   per-stage commands above instead. **`/re-gate` never runs `planner`** — unlike every other path to
   the ledger, nothing else on disk guarantees `.pipeline/spec.json`/`spec.md` actually describes the
   ticket being gated here, so this precondition is stated as its own item rather than folded into the
   existence check above: `.pipeline/spec.json` must (a) genuinely be about the ticket you are
   re-gating, (b) agree with `.pipeline/spec.md`'s own first-heading ticket on that same question (PL-04
   review pass 3 / Warning 2 — a matching `spec.json` next to a leftover `spec.md` from a different
   ticket is not enough, since `spec.md` is what gets copied into the ledger and what `index.json`'s
   `spec` pointer resolves to), and (c) carry a `stamp` field — i.e. have gone through
   `scripts/write-stamp.mjs` at some point (`planner` does this automatically as its own last step; a
   hand-authored or retroactive `spec.json` must run it explicitly). All three are enforced
   mechanically, not merely asked for: step 5's ledger command below requires a `--ticket <id>` flag
   naming the ticket, and refuses outright if `spec.json`'s own ticket doesn't match it, if `spec.md`'s
   own first-heading ticket doesn't match it, or if `spec.json` carries no `stamp` at all — see
   `scripts/ledger-append.mjs`'s own header for why a stamp-freshness check alone (as opposed to
   ticket-identity plus presence) would not be enough: a `spec.json` from a different ticket against an
   otherwise-unmoved tree still reads "fresh."

   **`--ticket <id>`'s value must be independent of the files it checks, or the check is a no-op.**
   `--ticket` is the caller's own assertion of which ticket is being re-gated, supplied at this
   command's own invocation (`/re-gate --ticket <id>`, e.g. `/re-gate --gates-only --ticket "PL-04"` —
   see this command's own `argument-hint` in `.claude/skills/re-gate/SKILL.md` or the equivalent
   runtime shim). Reading a `--ticket` value off `.pipeline/spec.json` and then handing that same value
   back to step 5's `--ticket` flag is circular: the cross-check would compare `spec.json` against
   itself and refuse nothing, precisely when a wrong `spec.json` is what needs catching. If the human
   invoking this command did not already state which ticket is being re-gated, stop and ask — do not
   infer it from `spec.json` and treat that as equivalent to an independent assertion.

   **The `stamp`-presence check (c) is a hygiene signal, not a provenance guarantee** (CORRECTED, PL-04
   review pass 3 / Warning 1a, from this section's prior wording): a `stamp` is four unauthenticated
   JSON fields (`treeHash`, `headSha`, `dirty`, `writtenAt`); `scripts/pipeline-contracts.mjs`'s
   `readStamp` checks that they are present, correctly typed, and — as of this same fix — that
   `treeHash`/`headSha` are hex strings of the length `buildStamp()` actually produces. That rejects an
   obviously-wrong shape; it does not, and cannot, prove the file went through
   `scripts/write-stamp.mjs` rather than being hand-written to the same shape, since there is no
   signature or secret behind any of the four fields. Treat "carries a `stamp`" as "shows the minimal
   signal its documented authoring path always leaves," never as "is proven to have come from that
   path."
2. State explicitly, before invoking anything, that `.pipeline/changes.md`/`changes.json` describe
   the tree as it stood **before** this hand-edit — never silently treat them as still accurate.
   This acknowledgment is not optional color; it is why this command exists instead of quietly
   re-running `review`/`security` as if nothing had happened. (The same "flag, don't imply away"
   staleness discipline every stage's own trusted-fresh inputs follow — see "Staleness stamps"
   above — applied here at the point a human, not a stage, is the source of the staleness.) Give
   `.pipeline/spec.md`/`spec.json` the same explicit treatment, but state a different fact about them:
   they are trusted for **which ticket** this run is about (checked mechanically by step 5's
   `--ticket` flag, per step 1 above) — never assumed to describe the tree's current implementation
   state, since the whole premise of this command is that the tree has moved since `spec.json` was
   last written.
3. Unless `--gates-only` is passed, invoke **tester** against the current tree. A hand-edit can
   introduce a regression the red suite would have caught had it run through the normal sequence;
   skipping that silently is exactly the shortcut this command exists not to be. Use `--gates-only`
   only when the edit is small enough that a human is confident no new test-coverage question is in
   play — and see step 5 for why that choice must still be visible afterward, not merely convenient
   in the moment.
4. Invoke **review**, then — only if `review.json` shows `PASS` — **security**, exactly as this
   file's Routing section already describes for a `NEEDS_FIXES`/`BLOCKED` loop. `/re-gate` changes
   how the loop is entered, not what runs inside it.
5. Once the run reaches a verdict, what happens next depends on which verdict it is — the command
   below **requires `review.json`/`security.json` to both show `PASS`** (or be accepted via
   `--override-review`/`--override-security`, see below) before it writes anything, so it cannot be
   run unconditionally on every branch this step might be reached from:
   - **Terminal `PASS`** (both gates passed): run the ledger step with the re-gate marker:
     ```sh
     node scripts/ledger-append.mjs --re-gate --tester-ran <true|false> --ticket <id>
     ```
     `--tester-ran true` unless `--gates-only` was passed (then `false`) — whichever value was
     actually used must reach the ledger entry unchanged, so a fast re-gate is visibly distinct from
     a full one. `--ticket <id>` is the ticket you were told, or independently already knew, you were
     re-gating — the same value supplied to `/re-gate --ticket <id>` at this command's own invocation
     (see step 1's circularity warning: never derive this value by reading `.pipeline/spec.json` and
     handing it back here, since that compares `spec.json` against itself and refuses nothing).
     `ledger-append.mjs` refuses if `.pipeline/spec.json`'s own ticket doesn't match it, if
     `.pipeline/spec.md`'s own first-heading ticket doesn't match it either (step 1(b)), or if
     `spec.json` carries no `stamp` field at all (see step 1). All three checks are additive to the
     normal (non-`--hotfix`) preconditions in `scripts/ledger-append.mjs`. Unlike `--hotfix`, `--re-gate`
     is not a bypass of those checks —
     only a mandatory disclosure on top of a run that actually passed them. See
     `.sdd/ledger/README.md`'s "Re-gate entries" section for the resulting entry's exact shape
     (`entry.json`'s `regate: { testerRan, gatesOnly, note }` object, and `entry.md`'s dedicated
     `## Re-gate` section) — that record is the entire point, not a cosmetic label. If this command
     refuses on the spec-identity check instead of the PASS/PASS check, that means review/security
     produced real verdicts against a tree with no ledger-worthy spec behind them yet — report that
     plainly (don't retry with a fabricated `--ticket` value) and either author/ratify the correct
     spec.md/spec.json first, or record the terminal PASS without a ledger entry and say why.
   - **A stop at `NEEDS_FIXES`/`BLOCKED`**: the command above refuses (exit `1`) — do not run it as
     written. Either stop here and report the failure (no ledger entry, the same as an ordinary
     non-terminal stop — see "Loop cap" above), or, to record this real, non-`PASS` outcome durably and
     disclosed (not authorized — see `.sdd/ledger/README.md`'s "Sanctioned override entries" section for
     why this is a disclosure requirement, not a check on who may do it), compose `--re-gate
     --tester-ran <true|false> --ticket <id>` with `--override-review "<reason>"`/
     `--override-security "<reason>"` — all flags are designed to compose freely on one command. There
     is no third option where the plain command above succeeds against a non-`PASS` verdict; it is not
     merely slow or unhelpful on that branch, it is refusing on purpose.
6. Report the same things `/pipeline`'s own step 6 reports, plus: that this was a re-gate rather
   than a fresh run, whether `--gates-only` was used, and the step-2 pre-edit-state acknowledgment.

**Honest limit:** this command re-verifies the gates against the tree as it now stands; it cannot
retroactively verify that the hand-edit itself was made carefully. That is exactly why running
tester is the default rather than the exception, and why `--gates-only` — skipping it — is a named,
ledger-recorded choice rather than a silent one.

### `/hotfix <what's broken>`

The sanctioned bypass (D-005 #3) — the one entry point that runs no stage at all. Not part of the
stage sequence or routing above; not a shortcut through it, and not the same door as `/re-gate`
above (`/hotfix` is for when nothing has run yet; `/re-gate` is for re-verifying a run that already
has). Nor is it the same door as `/pipeline-lite` above: a small change with no production incident
attached still runs the full lane through `planner`/`dev`/`tester`/`review` (skipping only `red`/
`security`), never this bypass, which requires production actually being broken. Follow
`.sdd/hotfix.md` exactly — it is the authoritative, runtime-neutral definition of this
path, including:

1. The four eligibility gates (production is actually broken and the fix is small and obvious; the
   author is on an unfenced `full` lane; the change doesn't touch `org_id` handling, RBAC filtering,
   MCP key issuance, the async worker fleet, the WebSocket gateway's RBAC re-filtering, secrets,
   webhook validation, the core service layer or its routes, or the Graph Query Service — the full,
   curated `hotfix_barred_paths` list in `.sdd/bounds.yml`, widened by security round
   FND-b731f500c5b8; rolling back isn't the better option). If any gate fails, say so plainly and
   route to `/pipeline` instead of proceeding.
2. What it skips: `planner`, `red`, `dev`, `tester`, `review`, and `security` as a sequence — the
   author implements directly.
3. What it still requires, non-negotiably, before the incident is closed:
   - `node scripts/ledger-append.mjs --hotfix --what-broke <text> --what-changed <text> --why-skipped
     <text> --not-verified <text> --follow-up-ticket <text>` — writes a bypass entry under
     `.sdd/ledger/<run-id>/`, stamped `"bypass": true` so `scripts/build-ledger-index.mjs` excludes
     its files from `index.json`'s file→spec map entirely (see `.sdd/ledger/README.md`'s "Hotfix
     bypass entries" section) — a hotfix entry must never satisfy a query asking which spec governs a
     file, because no spec does.
   - A follow-up ticket, opened before the incident closes, to bring the change back through the
     normal path or to justify why it does not need to.

This entry point deliberately does not invoke **planner**, **red**, **dev**, **tester**, **review**,
**security**, or the normal **ledger** step described in the Stage sequence above — `ledger-append.mjs
--hotfix` is a distinct code path from a plain `ledger-append.mjs` run, precisely because it requires
neither `review.json` nor `security.json` to exist.
