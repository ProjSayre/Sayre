---
name: spec-only
description: Compatibility alias of /planner; initializes a run and produces only its validated spec.
disable-model-invocation: true
argument-hint: <ticket description or path to ticket file>
---

Follow `.sdd/pipeline.md`'s `/planner` procedure for: $ARGUMENTS. Invoke only the planner stage and
stop after its successful emit.
