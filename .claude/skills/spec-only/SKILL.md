---
name: spec-only
description: Alias of /planner — runs just the planner stage for a ticket and stops, writing .pipeline/spec.md for human review before dev touches any code. Kept working under this name so existing habits don't break; use /planner for the same behavior under its canonical name.
disable-model-invocation: true
argument-hint: <ticket description or path to ticket file>
---

Run only the planning stage for: $ARGUMENTS

Follow `.sdd/pipeline.md`'s "`/spec-only <ticket>`" section exactly — it is a thin alias of
`/planner <ticket>` (see that section, immediately above it in `.sdd/pipeline.md`), kept working
under this name so existing habits don't break. Invoke the `planner` subagent for the planning
step; do not continue to `red`, `dev`, `tester`, `review`, or `security-checker` — this command
stops after planning, on purpose.
