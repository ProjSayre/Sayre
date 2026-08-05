# Sayre SDD pipeline

The pipeline keeps the design and security gates while moving bookkeeping into one small control
plane. Agents reason about a stage; `scripts/pipeline-run.mjs` owns run identity, validation,
routing, verification, rendering, retry limits, and ledger promotion.

Start with `.sdd/pipeline.md`. Stage instructions live in `.sdd/stages/`; runtime/model wiring lives
only in `.sdd/runtimes.yml`. Historical rationale belongs in `.sdd/stages/CHANGELOG.md`, not in live
prompts.

## Run layout

Each invocation gets an isolated directory:

```text
.pipeline/current.json
.pipeline/runs/<run-id>/
  state.json
  drafts/           # short agent-authored JSON inputs
  artifacts/        # validated JSON plus generated Markdown
  history/          # immutable attempt snapshots
  logs/              # deterministic verification output
  security-history/ # FULL/MILESTONE audit evidence only
```

The JSON artifact is canonical. Markdown is generated for humans. Every artifact carries the run
ID and a tree stamp, so files from another ticket cannot satisfy the current run.

## Invariants

- A behavioral change reaches `dev` only after planner and, when tests are required, red.
- Each AC/EC declares `test`, `review`, or `manual` verification. Existing tests and justified
  non-test checks are valid; gratuitous test creation is not required.
- Verification is deterministic and cannot edit files: commands are recorded as argv arrays and
  run once by the control plane without a shell.
- Review and security are judgment gates. Review remains read-only with respect to source files.
- Normal changes use FAST security; sensitive paths select FULL automatically; MILESTONE is
  explicit. Tenant/RBAC, secret, webhook, and ingestion boundaries remain blockers.
- At most three development attempts are allowed.
- Only verification/review/security PASS can be promoted to `.sdd/ledger/<run-id>/`.

Legacy ledger entries and `/hotfix` remain supported. New normal runs use the v2 runner.
