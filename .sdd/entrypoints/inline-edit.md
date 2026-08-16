# `/inline-edit <ticket>`

Read `.sdd/pipeline.md` (core: stage sequence, routing, loop cap, staleness) first. This file is the authoritative, runtime-neutral definition of this command; no other entrypoint file is required to run it.

A sanctioned, spec-first front door for a direct, in-session edit — no prior pipeline run, no
production incident. This lane mechanically refuses to let any code change happen before a real,
ratified `spec.md`/`spec.json` exists for the ticket, then runs `tester` -> `review` -> `security` in
full against the edited tree, states at every stop exactly what is still owed for the record, and ends
in a ledger entry that is visibly and structurally distinct from a full run — naming `red` and `dev` as
**deliberately skipped**, never merely omitted. Today, without this lane, that path is either an
unrecorded hand-edit (the D-005 #3 failure) or a disproportionate full `/pipeline` run.

**Not this lane:**

- Production is broken, and there is no time for a spec at all → `/hotfix`.
- A `review.json` already exists for this ticket from a prior run, and the tree was hand-edited after
  it → `/re-gate` — re-verifying a run that already happened is a different job from gating one being
  made deliberately.
- You want an agent to implement it from the spec → `/pipeline` (or `/pipeline-lite` if the change is
  small and mechanically eligible).
- The change is one where a genuinely spec-first test would earn its keep → `/pipeline` — the one
  prohibition worth enforcing socially here, since this lane runs `security` in full and gives up
  nothing on that axis (see "Honest limits" below).
- **Lite vs. inline (D-3):** the two lanes differ on two axes at once — who implements, and which
  gates run. `/pipeline-lite` keeps `dev`-stage isolation and skips `security`; `/inline-edit` runs
  `security` in full and gives up `dev`-stage isolation. If you are not actually making the edit
  yourself, by hand, in this live session, use `/pipeline-lite` (when eligible) or `/pipeline` — this
  lane's whole premise is an edit a human, or the live session itself, is genuinely making by hand.

**The lane, and the obligation created at each of its five stops.** Each stop states what has been
produced so far and where it lives, which gates remain owed, the exact ledger command that applies,
and what gets recorded where — a person learns what they will owe *before* they incur it, which is
the whole point of gating first.

**STOP A — before any edit exists.** Refuse/route first (see "Not this lane" above), then invoke
**planner**. Nothing may be edited until `.pipeline/spec.md` AND `.pipeline/spec.json` exist for the
ticket being worked, `spec.json` carries a `stamp`, and its ticket matches. Produced so far: a
ratified spec, nothing else. Still owed: the edit itself, then every remaining gate — `tester`,
`review`, `security` — and the ledger step. Ledger command: the one named at STOP E below, or that
same command composed with `--override-review "<reason>"`/`--override-security "<reason>"` for a
non-`PASS` outcome. Recorded where: nothing yet — nothing has happened yet.

**STOP B — after the edit.** Make the edit directly, in this session — bounded by `spec.md`'s
Affected files. There is no `dev` subagent on this lane; the implementation is made directly, inline,
by the person or session already here. Then author `.pipeline/changes.md` and
`.pipeline/changes.json` yourself, per `.sdd/stages/dev.md`'s own output contract (its steps 7-8),
then run `node scripts/write-stamp.mjs .pipeline/changes.json` — say so plainly in `changes.md`'s own
first line, that it was authored by the inline editor, not the `dev` stage. Produced so far: the
edit, `changes.md`, `changes.json`. Still owed: `tester`, `review`, `security`, the ledger step.
Ledger command: unchanged from STOP A. Recorded where: nothing yet.

**STOP C — after tester.** Invoke **tester**. Produced so far: `test-results.md`. Still owed:
`review`, `security`, the ledger step. Ledger command: unchanged. Recorded where: nothing yet.

**STOP D — after review and security.** Invoke **review**; if `PASS`, invoke **security**. Produced
so far: `review.json`/`review.md`, and, on a `PASS`, `security.json`/`security-report.md`. Still
owed: on a terminal `PASS`, only the ledger step; on a stop at `NEEDS_FIXES`/`BLOCKED`, another inline
edit (see "Routing on a non-terminal stop" below). Ledger command: the plain one at STOP E on a
`PASS`, or that command composed with `--override-review`/`--override-security` to record a
non-`PASS` outcome deliberately. Recorded where: nothing yet.

**STOP E — after the ledger step.** `node scripts/ledger-append.mjs --inline --ticket <id>
--why-inline "<reason>"`. Produced so far: everything above. Still owed: nothing. Recorded where:
`.sdd/ledger/<run-id>/`, titled `(INLINE)` (composed with `(OVERRIDE)` if a non-`PASS` verdict was
recorded that way), `entry.json` carrying the `inline` object, and every `index.json` record this
run's files produce carrying `inline: { skippedStages }`.

**The abnormal-stop obligation.** Entering this lane creates an obligation that only two things
discharge: finishing it (a ledger entry, plain or composed with `--override-review`/
`--override-security`), or reverting the edit. An abandoned inline lane — walking away, or stopping
here because a gate said no — leaves an unrecorded hand-edit on disk: no ledger entry, nothing
recorded, exactly the D-005 #3 failure this lane exists to replace, one level up. "The gates said no,
so I stopped" is **not a discharge** unless the edit is also reverted or the outcome is recorded via
`--override-*` — it is still an unfinished obligation either way.

**Honest limits.** This lane gives up real things, named plainly rather than left implicit:

- `red` does not run, so any test covering this change was written *after* the diff already existed —
  the D-018 inversion, reintroduced deliberately here, as it is on the lite lane, but **at any size**,
  with no mechanical size bound. Lite's size/barred-path bound is deliberately **not** imported here
  (D-2): that bound exists because the lite lane also skips `security`; this lane does not, so the
  same bound here would be reasoned from a premise that does not hold.
- No `dev`-stage isolation — the implementer and the session are one context, and `changes.md`/
  `changes.json` are self-reported by the editor rather than written by an agent that only ever saw
  the spec.
- The "do not run `/red` on this lane" rule is **unenforced** — a `red.json` written this round is
  indistinguishable at ledger time from a leftover, because `red` runs before the edit exists and its
  own stamp is therefore stale by construction on this lane, the same unenforceable shape `--lite`
  already carries for its own leftover `red.json`.
- `--ticket` verifies *which ticket* `spec.json`/`spec.md` are about, and the `stamp` check verifies
  only presence and shape — neither proves `planner` actually ran this round, the same honest limit
  `/re-gate` already states.
- `--why-inline` is disclosure, not authorization — nothing verifies who supplied it.

**Routing on a non-terminal stop.** A `NEEDS_FIXES` `review.json` (or `BLOCKED` `security.json`)
routes back to *another inline edit* — never to `/dev`, which does not run on this lane — then
re-runs `tester`/`review`(/`security`), under the existing 3-attempt loop cap (see "Loop cap" in
`.sdd/pipeline.md`); this lane defines no second cap and no second loop. This lane does not
generate or require a `fix-brief` (it skips `dev`). `red` still never runs, and
specifically must not be authored after the fix — that would be the D-018 inversion wearing a
spec-first label. At the loop cap: no ledger entry unless the outcome is recorded via `--override-*`.
