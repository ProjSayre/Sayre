---
name: gap-scout-only
description: >-
  Triage-only: run gap-scout for one or more MVP ticket ids and stop. Classifies each as
  ALREADY_COMPLETE / GAPFILL / ESCALATE_FULL_PIPELINE without planner/red/dev/review/security.
  Uses scripts/extract-ticket.mjs so agents never load the full backlog. Invoke with
  /gap-scout-only <ticket-id> [ticket-id…].
disable-model-invocation: true
argument-hint: <ticket-id> [ticket-id…]
---

Gap-scout triage only for: $ARGUMENTS

Follow `.sdd/pipeline.md`'s "`/gap-scout-only <ticket-id>`" section exactly.

For each ticket id:

1. `node scripts/extract-ticket.mjs <id> --with-overlays` — use that stdout only; do not Read the
   full backlog or cheat sheet.
2. Invoke the `gap-scout` subagent with that extract output.
3. Record the verdict.

After all ids: print a summary table (ticket → verdict → non-OK count → next command). Do **not**
continue to planner/dev/review/security/ledger.
