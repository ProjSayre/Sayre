---
name: tester
description: Compatibility command that runs deterministic verification for the current pipeline run; no tester agent is invoked.
disable-model-invocation: true
argument-hint: (no arguments)
---

Follow `.sdd/pipeline.md`. Require `next: verify`, run `node scripts/pipeline-run.mjs verify`, report
its result/log paths, and stop. Do not invoke an agent or edit source/tests.
