---
name: dev
description: Runs only the current run's implementation or routed-fix stage.
disable-model-invocation: true
argument-hint: (no arguments)
---

Follow `.sdd/pipeline.md`. Require `next: dev`, invoke `dev` against current run artifacts/history,
and stop after its validated draft is emitted.
