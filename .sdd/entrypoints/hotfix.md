# `/hotfix <what's broken>`

Read `.sdd/pipeline.md` (core: stage sequence, routing, loop cap, staleness) first. This file is the authoritative, runtime-neutral definition of this command; no other entrypoint file is required to run it.

The sanctioned bypass (D-005 #3) — the one entry point that runs no stage at all. Not part of the
stage sequence or routing in `.sdd/pipeline.md`; not a shortcut through it, and not the same door as
`/re-gate` (`/hotfix` is for when nothing has run yet; `/re-gate` is for re-verifying a run that already
has). Nor is it the same door as `/pipeline-lite`: a small change with no production incident
attached still runs the full lane through `planner`/`dev`/`tester`/`review` (skipping only `red`/
`security`), never this bypass, which requires production actually being broken. Follow
`.sdd/hotfix.md` exactly — it is the authoritative, runtime-neutral definition of this
path, including:

1. The four eligibility gates (production is actually broken and the fix is small and obvious; the
   author is on an unfenced `full` lane; the change doesn't touch `org_id` handling, RBAC filtering,
   MCP key issuance, the async worker fleet, the WebSocket gateway's RBAC re-filtering, secrets,
   webhook validation, the core service layer or its routes, or the Graph Query Service — the full,
   curated `hotfix_barred_paths` list in `.sdd/bounds.yml`, widened by security round
   FND-b731f500c5b8; rolling back isn't the better option). If any gate fails, say so plainly and
   route to `/pipeline` instead of proceeding.
2. What it skips: `planner`, `red`, `dev`, `tester`, `review`, and `security` as a sequence — the
   author implements directly.
3. What it still requires, non-negotiably, before the incident is closed:
   - `node scripts/ledger-append.mjs --hotfix --what-broke <text> --what-changed <text> --why-skipped
     <text> --not-verified <text> --follow-up-ticket <text>` — writes a bypass entry under
     `.sdd/ledger/<run-id>/`, stamped `"bypass": true` so `scripts/build-ledger-index.mjs` excludes
     its files from `index.json`'s file→spec map entirely (see `.sdd/ledger/README.md`'s "Hotfix
     bypass entries" section) — a hotfix entry must never satisfy a query asking which spec governs a
     file, because no spec does.
   - A follow-up ticket, opened before the incident closes, to bring the change back through the
     normal path or to justify why it does not need to.

This entry point deliberately does not invoke **planner**, **red**, **dev**, **tester**, **review**,
**security**, or the normal **ledger** step described in the Stage sequence in `.sdd/pipeline.md` —
`ledger-append.mjs --hotfix` is a distinct code path from a plain `ledger-append.mjs` run, precisely
because it requires neither `review.json` nor `security.json` to exist.
