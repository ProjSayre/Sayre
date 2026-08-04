# Ledger

Populated as of PL-03c. Every completed pipeline run — one that reached a **terminal `PASS`** (both
`review.md` and `security-report.md` show `PASS`) — gets a durable, committed entry here. A run that
stops earlier (a loop-cap timeout, an abandoned ticket) writes no entry; see `.sdd/pipeline.md`'s
Stage sequence and Routing sections for exactly when this step runs.

## Why this directory exists

`.pipeline/` is gitignored except for its own `README.md` (see `.gitignore`), so every pipeline run
overwrites the previous run's `spec.md`, `changes.md`, `test-results.md`, `review.md`, and
`security-report.md`. That's intentional for the per-run scratch files — committing them would be
noise and merge conflicts — but it means the repo previously had no record that a run ever happened
once the next run started.

The ledger is the fix: one **committed** entry per completed run, distinct from the gitignored
working files it summarizes. The reasoning for *why this matters* (not just that it exists) is
worth restating here rather than only in `docs/sdd-tdad-design.md`: a run that reaches `PASS` at both
gates has, by construction, produced code that follows its spec. So **a bug found later in that code
means the spec was wrong or incomplete** — and the spec is the first artifact worth reading. Before
this ticket, that evidence was destroyed on a cadence of roughly one ticket; now it's permanent.

## What's here, per run

```
.sdd/ledger/<run-id>/
  spec.md      — verbatim copy of that run's .pipeline/spec.md at the moment it reached terminal PASS
  spec.json    — verbatim copy of that run's .pipeline/spec.json (PL-03h round 4 — see below)
  entry.md     — run metadata, human-facing (see "Entry format" below)
  entry.json   — the SAME run metadata, machine-facing and authoritative (see "entry.json is
                 authoritative" below) — scripts/build-ledger-index.mjs reads only this file
  red.json     — copy of that run's .pipeline/red.json, if one existed for this run
  changes.json — copy of that run's .pipeline/changes.json
  review.json  — copy of that run's .pipeline/review.json
  security.json — copy of that run's .pipeline/security.json
  security/    — copy of that run's .pipeline/security-history/<run-id>/ (round 3 — see below)
    manifest.json
    results.json
    report.md
```

### `entry.json` is authoritative (PL-03h round 4)

Every field `scripts/build-ledger-index.mjs` uses to decide whether a run may be indexed, and which
files it touched, now comes from `entry.json`, not from parsing `entry.md`'s markdown. This is not a
cosmetic rename — it is the architectural fix for a defect that survived three rounds of
markdown-parser patching (see `.pipeline/review.md`'s round-3 "On convergence" section and
`scripts/pipeline-contracts.mjs`'s own header for the full argument): a hand-rolled block scanner
tracking fenced-code-block and HTML-comment state closed one exploit per round and, at least once,
introduced a new instance of the same class in the process of closing the last one. `entry.json`
removes the ambiguity surface outright rather than narrowing it further — `JSON.parse` either
succeeds or throws, and `build-ledger-index.mjs`'s own reader validates the result strictly (required
keys present, the `verdicts` object byte-for-byte `{ "review": "PASS", "security": "PASS" }`, every
array actually an array) before a run is ever indexed.

`entry.md` is still written by `scripts/ledger-append.mjs`, from the exact same in-memory data used
to build `entry.json`, and remains the human-facing rendering of a ledger entry — nothing reads it
for a control decision anymore. `.sdd/ledger/20260731T230940936Z-90330fb19231-PR_DELTA-bf73ea/`'s
`entry.json` was backfilled by hand from that run's own `entry.md` (the exact same one-time migration
affordance `entry.md` itself already used, since that run predates both `ledger-append.mjs` and the
JSON sidecar contract) — see that file's own `_comment` field.

`entry.json`'s shape: `{ runId, date, ticket, filesTouched: [...], verdicts: { review, security } }`.
`runId` must equal the entry's own directory name; `verdicts.review`/`verdicts.security` must both be
exactly the literal string `"PASS"` (an entry only exists because both gates already passed — see
"Entry format" below for why this is still checked byte-for-byte, not merely well-formed).

**`<run-id>` is reused from the security run that produced this run's terminal `PASS`** — the same id
already at `.pipeline/security-history/<run-id>/`. This is deliberate, not a shortcut: security-checker
already refuses to reuse or overwrite a run id (`.sdd/stages/security.md`'s Required artifacts
section), so reusing that id here means a ledger entry inherits collision-safety for free instead of
a second script re-implementing timestamp+nonce uniqueness, and it makes a ledger entry and its
security run trivially correlatable — given either one, the other's path is the same string.

`scripts/ledger-append.mjs` writes `spec.md`/`entry.md` and copies `security/` on a terminal `PASS`,
re-verifying the precondition itself (it does not trust the caller's word that both gates passed)
before writing anything. `.sdd/ledger/20260731T230940936Z-90330fb19231-PR_DELTA-bf73ea/` is entry
#1 — PL-03a's own run, migrated by hand as part of PL-03c since it predates both the ledger and
`scripts/ledger-append.mjs` themselves; its `security/` subdirectory was backfilled in round 3 (see
that entry's own provenance note) from that same run's `.pipeline/security-history/` directory, so
the first ledger entry is complete rather than partial.

### `security/`: why a copy, not a move (round 3)

`.pipeline/security-history/<run-id>/` was, before round 3, the *only* copy of a completed security
audit — durable on whichever machine ran `security-checker`, but gitignored (see `.gitignore` and
`.pipeline/README.md`) and therefore lost the moment a worktree is wiped, exactly like every other
`.pipeline/` working file. For a product whose pitch is auditability, that made the security half of
"a run reached terminal `PASS`" the one part of the story with no durable, committed record — only
`spec.md`/`entry.md` (the review half) survived.

`scripts/ledger-append.mjs`'s `copySecurityHistoryIntoLedger()` closes that gap by **copying** (never
moving) `manifest.json`, `results.json`, and `report.md` into `.sdd/ledger/<run-id>/security/` in the
same step that writes `spec.md`/`entry.md`. Copy, not move, for a load-bearing reason:
`.pipeline/security-history/` is itself immutable and is where `findCompletedSecurityRun` (and
`.sdd/stages/security.md`'s own progress-baseline contract) looks up a *later* run's baseline —
removing it from `.pipeline/` the moment it's promoted here would break that lookup for the very next
security run. The two copies now serve different purposes: `.pipeline/security-history/<run-id>/` is
the live baseline source for future runs (ephemeral per machine, per `.gitignore`); `.sdd/ledger/<run-id>/security/`
is the durable, committed audit record for humans and the query path below.

The same overwrite guard the top-level run directory already has applies to `security/`
specifically: a second attempt to populate an already-existing `.sdd/ledger/<run-id>/security/`
refuses rather than overwriting, so neither an ordinary re-run nor a repeated backfill can silently
replace immutable audit history.

## Entry format

`entry.md` and `entry.json` carry the same information — one for humans, one for
`scripts/build-ledger-index.mjs` (see "`entry.json` is authoritative" above). `entry.md` uses exactly
these headings, in this order, purely for human legibility; nothing parses its markdown for a control
decision anymore. The PL-03a migration (`scripts/ledger-append.mjs` didn't exist yet) is a **one-time
migration affordance**, not a general invitation to hand-author future entries — every ordinary run's
entry should come from `scripts/ledger-append.mjs` itself, which re-verifies its own preconditions
before writing anything. If a hand-authored entry is ever needed again, both `entry.md` and
`entry.json` must be authored, matching each other, and `entry.json`'s `verdicts` must read exactly
`{ "review": "PASS", "security": "PASS" }` — `buildIndex()` refuses to index (and `--check` fails
loudly on) any entry whose `entry.json` doesn't match that literally, so a hand-authored entry can
never claim a pass the tooling didn't itself verify:

- **Date** — the date the run reached terminal `PASS` (from the security run's own timestamp).
- **Ticket** — a short ticket id on its own first line (what `index.json` records), then the full
  spec title below it for human readers.
- **Spec Goal** — the one-line-or-so human-facing outcome, copied from that run's `spec.md`.
- **Files touched** — one repo-relative path per bullet, no other text on the line.
- **Verdicts** — exactly `- review: PASS` followed by `- security: PASS` (always `PASS`/`PASS` by
  construction, since that's the precondition for an entry existing at all — and, since review
  Warning 1, the one section `build-ledger-index.mjs` validates byte-for-byte rather than merely
  parses).
- **Red-test paths** — the test paths `red.md` listed for this run, or an explicit statement of why
  there are none (predates the `red` stage, or `red` genuinely produced nothing) — never left blank.
- **Security run ID** — `.pipeline/security-history/<run-id>/`, restated even though it's also the
  directory name, so a reader doesn't have to infer the convention to find it. (Round 3: that
  directory's `manifest.json`/`results.json`/`report.md` are also copied into this same run's own
  `security/` subdirectory — see "What's here, per run" above — so this bullet's path and the local
  `security/` copy describe the same audit run from two different vantage points, not two different
  runs.)

## The query path: buggy file → spec that mandated it

```
a file misbehaves
  → .sdd/ledger/index.json[<that file's repo-relative path>]
  → one or more { runId, ticket, date, spec } entries
  → read .sdd/ledger/<runId>/spec.md — the spec the code was actually reviewed and merged against
```

This is the file-granularity version of the `symbol_to_spec.yml` mapping D-005 records Sayre as
lacking, and the answer to "which code realizes PRD §4.5?" that D-005 separately notes is otherwise
approximately what Sayre sells. `index.json` is **generated, never hand-edited** —
`scripts/build-ledger-index.mjs` regenerates it from every `entry.md` on disk; `--check` is the CI
gate that fails if it's stale (same contract as `scripts/generate-agent-shims.mjs --check`).

## Growth, stated rather than solved

Each entry was, through round 2, a small markdown spec plus a short metadata file — cheap per run.
Round 3's `security/` copy changes that arithmetic: `results.json` in particular can run tens of
kilobytes per run (PL-03a's is ~45 KB), so a completed run's ledger footprint is now dominated by the
security artifacts, not `spec.md`/`entry.md`. Nothing here prunes or archives old entries either way.
Worth watching as the ledger accumulates; not a problem this ticket solves (see
`docs/sdd-tdad-design.md`'s open questions for the related question of whether a run that never
reaches `PASS` should also get an entry — currently it does not).
