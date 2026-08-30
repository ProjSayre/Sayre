---
name: pipeline-status
description: Reports which stage the .pipeline/ pipeline is currently at, without running or re-running anything. Use to check where a pipeline run left off.
disable-model-invocation: true
argument-hint: (no arguments)
---

Read `.sdd/pipeline.md` (core: stage sequence, routing, loop cap, staleness) then read
`.sdd/entrypoints/pipeline-status.md` (the authoritative definition of this command). Take no
action beyond reading `.pipeline/` files and reporting: don't invoke any subagent, don't write
anything.
