---
name: spec-only
description: Alias of /planner — runs just the planner stage for a ticket and stops, writing .pipeline/spec.md for human review before dev touches any code. Kept working under this name so existing habits don't break; use /planner for the same behavior under its canonical name.
disable-model-invocation: true
argument-hint: <ticket description or path to ticket file>
---

Run only the planning stage for: $ARGUMENTS

Read `.sdd/pipeline.md` (core: stage sequence, routing, loop cap, staleness) then read
`.sdd/entrypoints/spec-only.md` — it is a thin alias of `/planner <ticket>`, deferring to
`.sdd/entrypoints/planner.md` (see that file), kept working under this name so existing habits
don't break. Invoke the `planner` subagent for the planning step; do not continue to `red`, `dev`,
`tester`, `review`, or `security-checker` — this command stops after planning, on purpose.
