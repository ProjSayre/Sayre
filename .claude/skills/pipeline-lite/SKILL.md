---
name: pipeline-lite
description: The proportionate lane for a genuinely small, mechanically-eligible change (a typo, a one-file cleanup, a doc fix) — runs planner -> dev -> tester -> review -> ledger, deliberately skipping red and security. Gated by scripts/check-lite-eligible.mjs against .sdd/bounds.yml's lite_eligibility bounds and the barred-path union; ambiguous or ineligible routes to /pipeline instead. Invoke explicitly with /pipeline-lite <ticket description or path to ticket file>.
disable-model-invocation: true
argument-hint: <ticket description or path to a ticket file>
---

Run the lite pipeline lane for this ticket/feature request: $ARGUMENTS

Follow `.sdd/pipeline.md`'s "`/pipeline-lite <ticket>`" section exactly — it is the authoritative,
runtime-neutral definition of this lane's eligibility gate, procedure, routing/loop-cap reuse, the
ledger step, and its "Honest limits."

Do not restate or duplicate that procedure here — read it fresh each time this command runs, the
same way `/pipeline`'s own shim (`.claude/skills/pipeline/SKILL.md`) does for the full sequence.
