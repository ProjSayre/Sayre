---
name: re-gate
description: The sanctioned re-verification path after a hand-edit made directly to the working tree, outside dev's own re-invocation loop. Re-runs review and security (and tester, unless --gates-only) against the CURRENT tree, and records in the ledger that code was changed outside the pipeline. Requires an existing review.json, and a caller-supplied --ticket <id> naming which ticket is being re-gated — for a change with no prior pipeline run at all, use /hotfix or /pipeline instead.
disable-model-invocation: true
argument-hint: [--gates-only] [--ticket <id>]
---

Re-gate: $ARGUMENTS

Read `.sdd/pipeline.md` (core: stage sequence, routing, loop cap, staleness) then read
`.sdd/entrypoints/re-gate.md` (the authoritative definition of this command).

Five things this command must not do, restated here because they are the ones most easily lost:

- **Do not derive `--ticket` from `.pipeline/spec.json`.** `--ticket <id>` must be supplied at this
  command's own invocation (`/re-gate --ticket <id>`) as the human/caller's own, independent
  assertion of which ticket is being re-gated — reading it off `spec.json` and handing it back is a
  tautology: the cross-check would compare `spec.json` against itself, refusing nothing. Stop and
  ask if the caller did not state which ticket this is.
- **Do not treat `changes.md`/`changes.json` as still accurate.** State plainly, before invoking
  anything, that they describe the tree as it stood before this hand-edit.
- **Do not treat `.pipeline/spec.json` (or `spec.md`) as necessarily describing the run being
  gated.** `/re-gate` never runs `planner` — state plainly which ticket you believe you are
  re-gating, and pass it as `--ticket <id>` on the ledger command.
- **Do not silently drop the ledger question, regardless of the resulting verdict.** On a terminal
  `PASS`, run `node scripts/ledger-append.mjs --re-gate --tester-ran <true|false> --ticket <id>`.
  On a stop at `NEEDS_FIXES`/`BLOCKED`, either report the stop with no ledger entry, or compose
  with `--override-review`/`--override-security` — see `.sdd/entrypoints/re-gate.md` and
  `.sdd/ledger/README.md`'s "Sanctioned override entries" section. Never attempt the command
  expecting it to work on a non-`PASS` outcome.
- **Do not run this command in place of `/hotfix` or `/pipeline`.** Requires an existing
  `review.json`; if there isn't one, say so and route to `/pipeline` or `/hotfix` instead.
