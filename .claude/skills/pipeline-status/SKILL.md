---
name: pipeline-status
description: Reports which stage the .pipeline/ pipeline is currently at, without running or re-running anything. Use to check where a pipeline run left off.
disable-model-invocation: true
argument-hint: (no arguments)
---

Follow `.sdd/pipeline.md`'s "`/pipeline-status`" section exactly — it is the authoritative,
runtime-neutral definition of this command. Take no action beyond reading `.pipeline/` files and
reporting: don't invoke any subagent, don't write anything.
