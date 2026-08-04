# Pipeline — stage sequence, routing, and loop caps

This is the single, runtime-neutral definition of how the six stages
(`planner` → `red` → `dev` → `tester` → `review` → `security`, see `.sdd/stages/`) compose into a
run, plus the ledger-append step that follows a terminal `PASS`, and of the four ways a human can
invoke them. It replaces two documents that had already drifted apart on one material point (see
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
succeeds or throws, so there is no heading, fence, comment, or ambiguity surface left for an
adversarial or malformed document to exploit; `scripts/pipeline-contracts.mjs` validates each
sidecar's shape strictly on top of that (required keys present, verdict/classification literals
restricted to their enum, arrays checked to be arrays, ids checked against the `AC-n`/`EC-n` shape,
duplicate ids/paths within one array refused). The markdown reports are not decorative — they remain
the documents a human reads, and each stage's own file still requires them — but no script parses
their prose for a decision anymore. **Honest limit, stated plainly:** this removes a *third party's*
ability to inject a false reading through document formatting (which is what every demonstrated
exploit against the old scanner did); it does not, and cannot, stop a stage from writing a false value
into its own JSON in the first place — a stage that lies about its own verdict still lies, exactly as
much as it could by lying in markdown prose.

## Stage sequence

1. **planner** — reads the ticket, writes `.pipeline/spec.md` **and** `.pipeline/spec.json` (see
   `.sdd/stages/planner.md` for its exact shape: `{ ticket, goal, acceptanceCriteria, edgeCases }`).
   Every Acceptance Criterion and Edge Case gets a stable `AC-*`/`EC-*` ID, present in both files —
   `red` cites these on every test it authors, so they have to exist before it runs, and
   `check-red-integrity.mjs`'s spec-trace check resolves against `spec.json`'s copy of them, not
   `spec.md`'s prose.
2. **red** — reads `spec.md`/`spec.json`, and the impact map if PL-03b's test-impact resolver exists
   (it does not yet — `red` states that absence explicitly, via `red.json`'s required
   `impactMapPresent` boolean, rather than silently proceeding). Authors a behavioral test for every
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
   regeneration step). A run that never reaches terminal `PASS` writes no ledger entry — deliberate,
   see spec.md's edge cases for PL-03c.

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
that stops here — a run that never reaches terminal `PASS` leaves no ledger record, by design (see
spec.md's edge cases).

**Never:** skip a stage, let a later stage synthesize or improvise a missing earlier-stage
artifact, or run dependent stages in parallel. If a required `.pipeline/` file is missing, stop and
say which stage needs to run first.

## Review persistence — the resolved divergence

The two prior mirrors disagreed on *who writes* `.pipeline/review.md`: the Claude Code skill had
the `review` subagent write it directly (intended to be confined to `.pipeline/` by a hook guard —
see `.sdd/README.md`'s note on why that guard is not currently load-bearing); the other mirror had
its coordinator save the subagent's returned markdown verbatim. Both are the same contract
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

Four commands compose the stages above. Each is documented at the neutral level here; each
runtime's shim (`.claude/skills/<name>/SKILL.md`, or the equivalent invocation in a runtime without
a skills mechanism) is a thin pointer to the matching section below.

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

### `/spec-only <ticket>`

Runs only **planner** and stops before any code changes.

1. If `.pipeline/spec.md` already exists, warn that regeneration will replace it (and its
   `spec.json` sidecar) and get confirmation.
2. Invoke **planner** with the ticket.
3. Do not continue to red, dev, tester, review, or security.
4. Report the Goal, Scope, and Open Questions from spec.md; where the file (and `spec.json`) lives;
   that it can be hand-edited before continuing (both files, kept in agreement); and that continuing
   means invoking **red** directly (not `/pipeline`, which restarts from planner and would overwrite
   the reviewed spec).

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

### `/security-recheck`

Re-runs only **security**, against whatever is currently on disk, for a fast check after a
hand-edit made outside the pipeline.

1. Require `spec.md` and `changes.md` to exist; if either is missing, say the full pipeline hasn't
   run and recommend `/pipeline` instead.
2. Require `review.json` to show `PASS`. Do not bypass a missing or failed review — a hand-edit made
   after a failed review isn't safe to security-clear in isolation.
3. Invoke **security** in `REMEDIATION_RECHECK` mode against the current working-tree diff (it runs
   its own `git diff`, so it catches hand-edits `changes.md` doesn't mention). Pass along any prior
   finding IDs or remediation references that prompted the recheck when available; never instruct it
   to skip sibling or bypass paths.
4. Report the resulting `security.json`/`security-report.md` verdict, run ID, baseline run ID,
   finding transitions, and coverage gains/losses. If `BLOCKED`, route fixes through dev and re-run
   `/security-recheck` afterward — this command deliberately does not re-run tester or review
   automatically. If `PASS`, this recheck has produced a terminal `PASS` (its `review.json` was
   already `PASS`, or this command would have refused in step 2) exactly as much as reaching `PASS`
   via the full `/pipeline` does — run the same **ledger** step (`node scripts/ledger-append.mjs`)
   and report the resulting entry path.
