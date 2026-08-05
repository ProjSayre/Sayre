---
name: security
description: Runs only the current run's automatically selected FAST, FULL, or MILESTONE security gate.
disable-model-invocation: true
argument-hint: (no arguments)
---

Follow `.sdd/pipeline.md`. Require `next: security`, read `state.securityPlan`, invoke
`security-checker` in exactly that mode, and stop after its validated PASS/BLOCKED draft is emitted.
Do not default an ordinary change to the full attacker-registry audit.
