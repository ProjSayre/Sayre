---
name: inline-edit
description: The sanctioned, spec-first front door for a direct, in-session edit — no prior pipeline run, no production incident. Refuses to let any code change happen before a real, ratified spec.md/spec.json exists for the ticket, then runs tester -> review -> security in full against the edited tree, ending in a ledger entry that names red and dev as deliberately skipped. Invoke explicitly with /inline-edit <ticket description or path to a ticket file>.
disable-model-invocation: true
argument-hint: <ticket description or path to a ticket file>
---

Inline-edit: $ARGUMENTS

Read `.sdd/pipeline.md` (core: stage sequence, routing, loop cap, staleness) then read
`.sdd/entrypoints/inline-edit.md` (the authoritative definition of this lane's obligations
checklist, its abnormal-stop obligation, its "Honest limits," its "Not this lane" routing table,
and the mandatory ledger step).

Four refusals this command rests on, easiest to lose, restated here and nowhere else duplicated:

- **Never edit before the spec exists.** Nothing may be edited until `.pipeline/spec.md` AND
  `.pipeline/spec.json` are ratified for this ticket (STOP A) — a lane that gates after the edit
  has not gated anything.
- **Never derive `--ticket` from `.pipeline/spec.json`.** `--ticket <id>` must come from this
  command's own invocation, as the caller's own, independent assertion of which ticket is being
  worked — reading a value off `spec.json` and handing it back is a tautology that refuses nothing.
- **Never author a red test after the edit.** This lane deliberately never invokes `red` — a test
  written after the diff exists is the D-018 inversion, and authoring one here would wear a
  spec-first label over exactly that.
- **Never leave the lane without either a ledger entry or a revert.** Walking away mid-lane, or
  stopping because a gate said no, leaves an unrecorded hand-edit on disk — the D-005 #3 failure
  this lane exists to replace. Finish it (plain, or composed with `--override-review`/
  `--override-security` for a non-`PASS` outcome) or revert the edit.
