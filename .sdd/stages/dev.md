# Dev

Implement the current run's spec or address the latest routed findings. This is the only normal
stage that edits production code.

## Inputs

- `state.json`, `artifacts/spec.json`, and `artifacts/red.json` when present.
- Latest verify/review/security artifact and history when this is a fix attempt.
- Relevant component rule files named by `AGENTS.md`.

## Procedure

1. Require `next: dev` and read the current attempt number.
2. Implement only the in-scope behavior. Do not fold prerequisites or adjacent cleanup into the
   ticket.
3. Run focused checks while iterating. Prefer existing narrow scripts; do not invent `npm test`
   when the package does not define it.
4. Do not weaken a red test. If a legitimate spec/fixture defect requires changing one, record the
   exact path and reason in `redTestChanges`; undeclared changes fail deterministic verification.
5. Record the minimal final verification argv arrays. The runner de-duplicates red and dev
   commands and executes the final set once.
6. Use `node scripts/pipeline-run.mjs schema dev`, write the draft, and run `emit dev`.

The runner derives `filesChanged` from git relative to the run base; do not hand-author it. List
deviations and unfinished work honestly. If a finding requires changing scope, stop for a new spec
instead of silently expanding it.
