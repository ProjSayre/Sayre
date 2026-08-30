---
name: dev
description: Runs just the dev stage against the current .pipeline/spec.md (and red.md/review.md/security-report.md when present), implementing or fixing code. Use to (re)run dev on its own, including to pick up a NEEDS_FIXES/BLOCKED finding list without restarting the whole pipeline.
disable-model-invocation: true
argument-hint: (no arguments)
---

Run only the dev stage.

Read `.sdd/pipeline.md` (core: stage sequence, routing, loop cap, staleness) then read
`.sdd/entrypoints/dev.md` (the authoritative definition of this command). On a fix-loop
(`NEEDS_FIXES`/`BLOCKED`), generate-then-invoke: run `scripts/write-fix-brief.mjs` before invoking
the `dev` subagent, and do not invoke `dev` if the generator or freshness check refuses. Do not send
fix-loop `dev` at full `spec.md` or scrape `review.md`. It writes `.pipeline/changes.md`/`changes.json`
directly. Require `.pipeline/spec.md` to exist first — if it doesn't, say planner needs to run instead
of improvising a spec. Do not continue to `tester`, `review`,
or `security-checker` — this command stops after dev, on purpose.
