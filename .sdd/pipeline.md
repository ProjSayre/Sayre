# Pipeline — stage sequence, loop caps, and command stubs

This is the single, runtime-neutral definition of how the six stages
(`planner` → `red` → `dev` → `tester` → `review` → `security`, see `.sdd/stages/`) compose into a
run, plus the ledger-append step run after all stages pass, and of every way a human can
invoke this pipeline's tooling: the full sequence (`/pipeline`); each stage on its own (`/planner`
through `/security`, plus aliases `/spec-only`/`/security-recheck`); a status check
(`/pipeline-status`); the sanctioned path back to a verdict after a hand-edit (`/re-gate`); the
proportionate lane for a genuinely small, mechanically-eligible change (`/pipeline-lite`), which
deliberately skips `red` and `security`; the MVP audit-and-gap-fill lane (`/pipeline-gapfill`),
which runs `gap-scout` then gap-scoped `planner`/`red`/`dev`/`tester`/`review`/`security`;
`/gap-scout-only` for triage without the rest of the lane; the sanctioned, spec-first front door for
a direct, in-session edit (`/inline-edit`), which deliberately skips `red` and `dev`; and `/hotfix`,
which deliberately runs none of the stages above (see `.sdd/hotfix.md`). `/spec-only` and
`/security-recheck` are thin aliases of `/planner` and `/security` respectively.

Each entry point's full procedure lives in `.sdd/entrypoints/<cmd>.md`. This core file governs only
the shared sequencing — stage order, loop cap, staleness policy. Historical archaeology
(JSON-sidecar rounds, staleness-stamp rationale, divergence backstory) lives in
`.sdd/pipeline-history.md`; no stage or command needs it to run.

**JSON sidecars (PL-03h round 4).** Every stage writes a small `.pipeline/*.json` sidecar next to
its markdown report, and every script making a control decision reads only those JSON files, never
the markdown. See `.sdd/pipeline-history.md` for the archaeology behind this contract.

## Staleness stamps (PL-04)

Every `.pipeline/*.json` sidecar carries a `stamp` field recording the tree state when it was
written. Two scripts implement this: `scripts/write-stamp.mjs` (producer — each stage runs it as
its last step) and `scripts/check-stamp-freshness.mjs` (consumer — exit `0` = not stale, `1` =
stale, `2` = check failed). Every required input on every stage is exactly one of:

| Policy | Meaning | On stale |
|---|---|---|
| **re-derived** | Stage computes the fact itself from the current tree | Irrelevant |
| **trusted-fresh** | Stage depends on the input describing the current tree | `security` refuses; every other stage flags and proceeds |
| **advisory** | Background context only; never a control decision | Note it, never refuse |

`planner` has no `.pipeline/` input to classify — it is always stage 1.

## Stage sequence

1. **planner** — reads the ticket, writes `.pipeline/spec.md` and `.pipeline/spec.json`.
2. **red** — reads `spec.md`/`spec.json`, authors a behavioral test for every `AC-*`/`EC-*` item
   before `dev` runs, classifies each `RED-CORRECT`/`RED-DEFERRED`, writes `.pipeline/red.md` and
   `.pipeline/red.json`.
3. **dev** — reads `spec.md`/`spec.json` and `red.md`/`red.json`, implements, writes
   `.pipeline/changes.md` and `.pipeline/changes.json`.
4. **tester** — reads `spec.md`, `red.md`; runs the red suite; runs `scripts/check-red-integrity.mjs`
   and `scripts/check-red-quality.mjs` (the authoritative red-quality run) and applies the judgment
   rules; writes `.pipeline/test-results.md` and `.pipeline/red-integrity.json`.
5. **review** — reads `spec.md`, `changes.md`, `test-results.md`, `red-integrity.json`; runs its own
   `git diff`; no longer reads `red.md` for integrity (consumes `red-integrity.json` instead);
   writes `.pipeline/review.md` and `.pipeline/review.json` (`{ "verdict": "PASS" | "NEEDS_FIXES" }`).
6. **security** — runs only once `review.json` shows `PASS`; writes
   `.pipeline/security-report.md` and `.pipeline/security.json`
   (`{ "verdict": "PASS" | "BLOCKED", "runId": "..." }`).
7. **ledger** (not a subagent stage) — `node scripts/ledger-append.mjs`; runs once on terminal `PASS`.
   Writes `.sdd/ledger/<run-id>/{spec.md,entry.md,entry.json}` and regenerates
   `index.json`. Exit `0` on success; exit `1` if either sidecar is stale or non-`PASS`. Two further
   refusal conditions this step enforces, undocumented before this note: the security run
   `security.json` cites must exist, be complete, and be independently confirmed `PASS` (or the
   overridden verdict, under `--override-security`) by its own immutable
   `security-history/<run-id>/{manifest.json,results.json}` — a cited run missing either file, or
   whose own `results.json` disagrees with `security.json`'s claimed verdict, refuses; and an
   already-existing `.sdd/ledger/<run-id>/` (or `<run-id>/security/`) target directory is refused
   rather than overwritten.

## Routing

On `review.json` **NEEDS_FIXES** or `security.json` **BLOCKED**, write a fix-brief
(`node scripts/write-fix-brief.mjs --source review|security --attempt <n>`) **before** re-invoking
**dev**. A missing or stale `.pipeline/fix-brief.json` refuses the invoke — do not send `dev` at
`review.md` prose. Then repeat **tester** and **review** (and **security** after a BLOCKED loop).
`planner` and `red` do not re-run. Tester/review/security stay full-ticket: a fix-brief does not
shrink those gates.

- `review.json` **PASS** → continue to **security**.
- `security.json` **PASS** → terminal `PASS`. Run the **ledger** step before reporting complete.

**Loop cap (3-attempt max):** three total `dev` attempts across both loops combined. If still not
passing after three rounds, stop and hand the situation to the user with a summary of what keeps
failing.

**Never:** skip a stage, let a later stage synthesize a missing input, or run dependent stages in
parallel. This governs **automatic routing within a lane** — the sequencing a coordinator follows
while working through `/pipeline` (or `/pipeline-lite`/`/pipeline-gapfill`/`/inline-edit`, each of
which names its own deliberately-skipped stages up front, not silently). It does not, and cannot,
constrain a human's own explicit choice to invoke a single stage directly — the per-stage commands
(`/planner` through `/security`) and `/re-gate` (which by design never runs `planner`) exist
specifically for that, and the Entry points section below lists all six single-stage commands as
first-class, sanctioned ways to run this pipeline's tooling.

## Review persistence — the resolved divergence

> `review` (and `security`) produce a report in the shape their stage file defines; that report is
> persisted verbatim to `.pipeline/review.md` (respectively `.pipeline/security-report.md`).

The mechanism — a runtime with subagents and hooks lets the stage write its own file directly; a
runtime without them has the coordinator save the returned markdown — is a per-runtime detail in
`.sdd/runtimes.yml`. Coordinators save reports verbatim; they never edit, summarize, or selectively
drop sections. The same neutral contract covers JSON sidecars: `review.json`/`security.json` are
persisted at the same time as their matching markdown file, never as a separate, later step.

## Running stages in a single context (no subagent boundary)

A runtime without subagent isolation must behave as if the boundary were real:

- **Freshly read** that stage's required inputs from `.pipeline/` files on disk before starting each
  stage — don't carry forward assumptions from just having written them.
- **Don't skip a stage** because "I already know what dev did."
- **Don't improvise a missing input.** Stop and say which stage needs to run first.
- **Don't let review or security silently reuse conclusions** formed while acting as dev/tester.
- **`red` specifically:** write `.pipeline/red.md` to disk and finish before starting `dev` — and
  while acting as `dev`, read `red.md` and `spec.md` fresh rather than reasoning from notes formed
  while acting as `red`.

## Entry points

The 16 commands — `/pipeline`, `/pipeline-lite`, `/pipeline-gapfill`, `/gap-scout-only`,
`/planner`, `/spec-only`, `/red`, `/dev`, `/tester`, `/review`, `/security`, `/security-recheck`,
`/pipeline-status`, `/re-gate`, `/inline-edit`, `/hotfix` — each have their full procedure in a
matching `.sdd/entrypoints/<cmd>.md` file. This core file carries a short stub for each so that
existing cross-references (e.g. "see `.sdd/pipeline.md`'s `/re-gate` section") still land somewhere
real.

### Per-stage entry points

Six commands — `/planner`, `/red`, `/dev`, `/tester`, `/review`, `/security` — invoke exactly one
stage's own subagent, per that stage's `.sdd/stages/<stage>.md` procedure, and then stop. Every one
of the six follows the same contract:

1. **Check that stage's own required inputs exist**, per its `.sdd/stages/<stage>.md` file. Never
   invent a missing one.
2. **Invoke that one subagent** and let it run its full procedure exactly as documented in its own
   `.sdd/stages/<stage>.md` file.
3. **Report that stage's own output artifacts** (paths, verdict where applicable) and stop.
4. **Never run the ledger step**, with one named exception: `/security`, when it produces a `PASS`
   immediately following an already-`PASS` `review.json`, runs the ledger step exactly as `/pipeline`
   does. See `.sdd/entrypoints/security.md` for the branch (planner-ran vs. planner-did-not-run).

### `/pipeline`

Runs the full stage sequence end to end: planner → red → dev → tester → review → security → ledger.
Full definition: `.sdd/entrypoints/pipeline.md`.

### `/pipeline-lite`

The proportionate lane for a genuinely small, mechanically-eligible change — skips `red` and
`security` deliberately. Gated by `scripts/check-lite-eligible.mjs` before any stage runs.
Full definition: `.sdd/entrypoints/pipeline-lite.md`.

### `/pipeline-gapfill`

MVP audit-and-gap-fill lane: gap-scout first, then gap-scoped planner/red/dev/tester/review/security.
Full definition: `.sdd/entrypoints/pipeline-gapfill.md`.

### `/gap-scout-only`

Triage only — runs gap-scout for one or more ids and stops; no planner/dev/ledger.
Full definition: `.sdd/entrypoints/gap-scout-only.md`.

### `/planner`

Runs only **planner** and stops — the canonical per-stage entry point for this stage.
Full definition: `.sdd/entrypoints/planner.md`.

### `/spec-only`

Alias of `/planner <ticket>` — identical behavior, kept working under its original name.
Full definition: `.sdd/entrypoints/spec-only.md`.

### `/red`

Runs only **red**, against whatever `.pipeline/spec.md` currently holds.
Full definition: `.sdd/entrypoints/red.md`.

### `/dev`

Runs only **dev**, against whatever `.pipeline/spec.md` (and red.md/review.md/security-report.md) holds.
Full definition: `.sdd/entrypoints/dev.md`.

### `/tester`

Runs only **tester**, against whatever `.pipeline/spec.md` and `.pipeline/red.md` currently hold.
Full definition: `.sdd/entrypoints/tester.md`.

### `/review`

Runs only **review**, against whatever `.pipeline/spec.md`, `changes.md`, `test-results.md`, and
`red.md` currently hold.
Full definition: `.sdd/entrypoints/review.md`.

### `/security`

Runs only **security** — the canonical per-stage entry point for this stage. Default mode `PR_DELTA`.
Full definition: `.sdd/entrypoints/security.md`.

### `/security-recheck`

Alias of `/security --mode REMEDIATION_RECHECK` — identical behavior, kept working under its
original name.
Full definition: `.sdd/entrypoints/security-recheck.md`.

### `/pipeline-status`

Reports where a run currently stands. Takes no action — no stage is invoked, no file is written.
Full definition: `.sdd/entrypoints/pipeline-status.md`.

### `/re-gate`

The sanctioned path back to a verdict after a hand-edit made directly to the working tree, outside
`dev`'s own re-invocation loop. Requires an existing `review.json`; use `/pipeline` if none exists.
Full definition: `.sdd/entrypoints/re-gate.md`.

### `/inline-edit`

The sanctioned, spec-first front door for a direct, in-session edit — no prior pipeline run, no
production incident. Refuses to let any code change happen before a real, ratified spec exists.
Full definition: `.sdd/entrypoints/inline-edit.md`.

### `/hotfix`

The sanctioned bypass (D-005 #3) — the one entry point that runs no stage at all. Follow
`.sdd/hotfix.md` exactly.
Full definition: `.sdd/entrypoints/hotfix.md`.
