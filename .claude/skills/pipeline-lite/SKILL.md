---
name: pipeline-lite
description: The proportionate lane for a genuinely small, mechanically-eligible change (a typo, a one-file cleanup, a doc fix) — runs planner -> dev -> tester -> review -> ledger, deliberately skipping red and security. Gated by scripts/check-lite-eligible.mjs against .sdd/bounds.yml's lite_eligibility bounds and the barred-path union; ambiguous or ineligible routes to /pipeline instead. Invoke explicitly with /pipeline-lite <ticket description or path to ticket file>.
disable-model-invocation: true
argument-hint: <ticket description or path to a ticket file>
---

Run the lite pipeline lane for this ticket/feature request: $ARGUMENTS

Read `.sdd/pipeline.md` (core: stage sequence, routing, loop cap, staleness) then read
`.sdd/entrypoints/pipeline-lite.md` (the authoritative definition of this lane's eligibility gate,
procedure, routing/loop-cap reuse, the ledger step, and its "Honest limits").
