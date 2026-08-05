---
name: review
description: Runs only read-only review after deterministic verification PASS.
disable-model-invocation: true
argument-hint: (no arguments)
---

Follow `.sdd/pipeline.md`. Require `next: review`, invoke `review`, and stop after its validated
PASS/NEEDS_FIXES draft is emitted. Do not rerun verification or edit source.
