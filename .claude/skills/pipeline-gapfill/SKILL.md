---
name: pipeline-gapfill
description: >-
  Audit-and-gap-fill lane for already-shipped MVP (Wave 0–4) tickets. Runs gap-scout → planner
  (gap-mode) → red (gap-mode) → dev → tester → review → security → ledger --gapfill. Invents only
  the delta between current code and acceptance criteria — not a full rewrite, not pipeline-lite.
  Invoke explicitly with /pipeline-gapfill <ticket-id or path>.
disable-model-invocation: true
argument-hint: <ticket-id or path to ticket text> [--prior-ledger <run-id>]
---

Run the gapfill pipeline lane for this MVP ticket: $ARGUMENTS

Read `.sdd/pipeline.md` (core: stage sequence, routing, loop cap, staleness) then read
`.sdd/entrypoints/pipeline-gapfill.md` (the authoritative definition of this lane's eligibility,
stage sequence, overlay loading, routing, loop caps, ledger step, and Honest limits).

This file only maps that procedure onto Claude Code's subagents:

1. **gap-scout** → the `gap-scout` subagent (writes `.pipeline/gaps.md` + `gaps.json`)
2. If `gaps.json.verdict` is `ALREADY_COMPLETE` or `ESCALATE_FULL_PIPELINE` → **stop** (do not
   invent planner/dev work; escalate to `/pipeline` when required)
3. **planner** → the `planner` subagent in **gap-mode** (AC/EC only for non-OK gaps)
4. **red** → the `red` subagent in **gap-mode** (tests only for gap ACs)
5. **dev** → the `dev` subagent
6. **tester** → the `tester` subagent
7. **review** → the `review` subagent
8. **security** → the `security-checker` subagent (always on this lane)
9. **ledger** → `node scripts/ledger-append.mjs --gapfill` on terminal PASS

Before starting, load ticket context with:
`node scripts/extract-ticket.mjs <id> --with-overlays`
only — never Read the full backlog or cheat sheet.
