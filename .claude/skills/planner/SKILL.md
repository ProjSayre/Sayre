---
name: planner
description: Runs just the planner stage for a ticket and stops, writing .pipeline/spec.md for human review before dev touches any code. The canonical per-stage entry point for planner; /spec-only is an existing alias with identical behavior, kept working so old habits don't break.
disable-model-invocation: true
argument-hint: <ticket description or path to ticket file>
---

Run only the planning stage for: $ARGUMENTS

Read `.sdd/pipeline.md` (core: stage sequence, routing, loop cap, staleness) then read
`.sdd/entrypoints/planner.md` (the authoritative definition of this command). Invoke the `planner`
subagent for the planning step; do not continue to `red`, `dev`, `tester`, `review`, or
`security-checker` — this command stops after planning, on purpose.
