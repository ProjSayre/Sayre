# `/gap-scout-only <ticket-id> [ticket-id…]`

Read `.sdd/pipeline.md` (core: stage sequence, routing, loop cap, staleness) first. This file is the authoritative, runtime-neutral definition of this command; no other entrypoint file is required to run it.

Triage-only front door for MVP polish. Runs **only** `gap-scout` for one or more ticket ids, then
stops. Purpose: classify a batch of Wave 0–4 tickets (`ALREADY_COMPLETE` / `GAPFILL` /
`ESCALATE_FULL_PIPELINE`) without paying for planner/red/dev/tester/review/security.

1. For each id, run `node scripts/extract-ticket.mjs <id> --with-overlays` (fail closed on missing
   id / missing YAML entry — skip that id and report it, continue others).
2. Invoke **gap-scout** once per id. Write `.pipeline/gaps.md` + `gaps.json` for the **last** id
   processed (same paths as the gapfill lane). Also print a per-id summary table to the user:
   ticket → verdict → non-OK count → recommended next command (`(none)` /
   `/pipeline-gapfill <id>` / `/pipeline <id>`).
3. **Do not** invoke planner, red, dev, tester, review, security, or ledger. There is nothing to
   append: scout is verification/triage, not an implementation PASS.
4. If the caller passed a single id and wants to continue immediately, tell them to run
   `/pipeline-gapfill <id>` only when verdict is `GAPFILL` (reuse the gaps artifacts already on
   disk — gapfill's step 2 may skip re-scouting if `gaps.json` is fresh for that ticket).

**Honest limits.** A scout-only pass is not a merge gate. `ALREADY_COMPLETE` is an audit claim for
this tree right now, not a ledger PASS.
