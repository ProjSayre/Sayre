---
name: pipeline
description: Runs the full Planner -> Dev -> Tester -> Review -> Security pipeline for a feature or ticket. Invoke explicitly with /pipeline <ticket description or path to ticket file> — this always runs on request, never auto-triggers, since it takes real actions (spawns agents, writes to .pipeline/, runs tests).
disable-model-invocation: true
argument-hint: <ticket description or path to a ticket file>
---

Run the full agent pipeline for this ticket/feature request: $ARGUMENTS

Read `.sdd/pipeline.md` (core: stage sequence, routing, loop cap, staleness) then read
`.sdd/entrypoints/pipeline.md` (the authoritative definition of this command) — together they are
the complete procedure.

This file only maps that procedure onto Claude Code's subagents:

1. **planner** → the `planner` subagent
2. **red** → the `red` subagent (writes `.pipeline/red.md` directly, before `dev` runs)
3. **dev** → the `dev` subagent. On a `NEEDS_FIXES`/`BLOCKED` reroute, generate-then-invoke: run
   `scripts/write-fix-brief.mjs` before re-invoking `dev`. Do not send fix-loop `dev` at full
   `spec.md` or scrape `review.md`.
4. **tester** → the `tester` subagent
5. **review** → the `review` subagent (writes `.pipeline/review.md` directly — see
   `.sdd/runtimes.yml`)
6. **security** → the `security-checker` subagent (writes `.pipeline/security-report.md` directly)
7. **ledger** → not a subagent; on a terminal `PASS`, run `node scripts/ledger-append.mjs` directly
   (it regenerates `.sdd/ledger/index.json` itself)
