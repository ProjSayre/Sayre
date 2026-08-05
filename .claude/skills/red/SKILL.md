---
name: red
description: Runs only the current run's red/coverage stage before implementation.
disable-model-invocation: true
argument-hint: (no arguments)
---

Follow `.sdd/pipeline.md`. Require `next: red`, invoke the `red` agent, and stop after its validated
draft is emitted. Never use a shared legacy `.pipeline/spec.*`.
