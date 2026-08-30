---
name: red
description: Runs just the red stage against the current .pipeline/spec.md, authoring and classifying a behavioral test for every AC-*/EC-* item before any implementation exists. Use to (re)run red on its own, without running the rest of the pipeline.
disable-model-invocation: true
argument-hint: (no arguments)
---

Run only the red stage against the current spec.

Read `.sdd/pipeline.md` (core: stage sequence, routing, loop cap, staleness) then read
`.sdd/entrypoints/red.md` (the authoritative definition of this command). Invoke the `red` subagent;
it writes `.pipeline/red.md`/`red.json` directly. Require `.pipeline/spec.md` to exist first — if
it doesn't, say planner needs to run (`/planner <ticket>`) instead of improvising a spec. Do not
continue to `dev`, `tester`, `review`, or `security-checker` — this command stops after red, on
purpose.
