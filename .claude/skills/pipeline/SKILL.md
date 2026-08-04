---
name: pipeline
description: Runs the full Planner -> Dev -> Tester -> Review -> Security pipeline for a feature or ticket. Invoke explicitly with /pipeline <ticket description or path to ticket file> — this always runs on request, never auto-triggers, since it takes real actions (spawns agents, writes to .pipeline/, runs tests).
disable-model-invocation: true
argument-hint: <ticket description or path to a ticket file>
---

Run the full agent pipeline for this ticket/feature request: $ARGUMENTS

Follow `.sdd/pipeline.md`'s "`/pipeline <ticket>`" section exactly — it is the authoritative,
runtime-neutral definition of this command's procedure, the stage sequence, routing, and loop caps.
This file only maps that procedure onto Claude Code's subagents:

1. **planner** → the `planner` subagent
2. **dev** → the `dev` subagent
3. **tester** → the `tester` subagent
4. **review** → the `review` subagent (writes `.pipeline/review.md` directly — see
   `.sdd/runtimes.yml`)
5. **security** → the `security-checker` subagent (writes `.pipeline/security-report.md` directly)

Do not restate or duplicate `.sdd/pipeline.md`'s procedure here — read it fresh each time this
command runs, the same way any other runtime would.
