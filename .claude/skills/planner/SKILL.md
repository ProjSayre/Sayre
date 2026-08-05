---
name: planner
description: Initializes a run and produces only its validated spec for human review.
disable-model-invocation: true
argument-hint: <ticket description or path to ticket file>
---

Plan only: $ARGUMENTS

Follow `.sdd/pipeline.md` and initialize/reuse the exact-ticket run. Invoke `planner` only when state
returns `next: planner`; stop after its successful emit.
