---
name: tester
description: Runs just the tester stage against the current .pipeline/spec.md and red.md — runs the red suite and the impact-resolver regression set, and reports gaps rather than filling them. Use to (re)run tester on its own after a dev change, without running the rest of the pipeline.
disable-model-invocation: true
argument-hint: (no arguments)
---

Run only the tester stage.

Follow `.sdd/pipeline.md`'s "`/tester`" section exactly — it is the authoritative, runtime-neutral
definition of this command. Invoke the `tester` subagent; it writes `.pipeline/test-results.md`
directly. Require `.pipeline/spec.md` and `.pipeline/red.md` to exist first — if either is missing,
say which of planner/red needs to run instead of improvising. Do not continue to `review` or
`security-checker` — this command stops after tester, on purpose.
