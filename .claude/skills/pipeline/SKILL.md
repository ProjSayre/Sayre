---
name: pipeline
description: Runs the run-scoped Planner -> optional Red -> Dev -> Verify -> Review -> Security pipeline for a ticket. Invoke explicitly with /pipeline <ticket>; it never auto-triggers.
disable-model-invocation: true
argument-hint: <ticket description or path to ticket file>
---

Run the full pipeline for: $ARGUMENTS

Follow `.sdd/pipeline.md` exactly. Initialize with `scripts/pipeline-run.mjs`, then dispatch only the
stage returned by `next`: `planner`, optional `red`, `dev`, deterministic `verify`, `review`,
`security-checker`, and deterministic `finalize`. Read state after every action and never infer or
hand-route it. The tester agent is intentionally absent.
