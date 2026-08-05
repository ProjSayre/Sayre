# Pipeline scratch space

Only this README is tracked. `scripts/pipeline-run.mjs` creates isolated, gitignored work under
`.pipeline/runs/<run-id>/` and points `.pipeline/current.json` at the active run.

Do not create shared `.pipeline/spec.*`, `changes.*`, or verdict files. Agents author one draft JSON
inside the current run; the runner validates it and generates the canonical JSON and human-readable
Markdown under `artifacts/`. Successful runs are promoted atomically to `.sdd/ledger/<run-id>/`.

Inspect without mutation:

```text
node scripts/pipeline-run.mjs status
```
