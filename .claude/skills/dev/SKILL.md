---
name: dev
description: Runs just the dev stage against the current .pipeline/spec.md (and red.md/review.md/security-report.md when present), implementing or fixing code. Use to (re)run dev on its own, including to pick up a NEEDS_FIXES/BLOCKED finding list without restarting the whole pipeline.
disable-model-invocation: true
argument-hint: (no arguments)
---

Run only the dev stage.

Follow `.sdd/pipeline.md`'s "`/dev`" section exactly — it is the authoritative, runtime-neutral
definition of this command. Invoke the `dev` subagent; it writes `.pipeline/changes.md`/
`changes.json` directly. Require `.pipeline/spec.md` to exist first — if it doesn't, say planner
needs to run instead of improvising a spec. `dev` already knows, from its own stage file
(`.sdd/stages/dev.md`), to treat a `NEEDS_FIXES` `review.json` or a `BLOCKED` `security.json` on
disk as required fixes rather than a fresh implementation — this command does not need to detect or
announce that case itself. Do not continue to `tester`, `review`, or `security-checker` — this
command stops after dev, on purpose.
