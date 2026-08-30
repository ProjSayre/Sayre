# `/pipeline <ticket>`

Read `.sdd/pipeline.md` (core: stage sequence, routing, loop cap, staleness) first. This file is the authoritative, runtime-neutral definition of this command; no other entrypoint file is required to run it.

Runs the full stage sequence and routing above, end to end.

1. If `.pipeline/spec.md` already exists, ask whether to reuse it as-is (e.g. it came from
   `/spec-only` and may have been hand-edited) or regenerate it. Only invoke **planner** if it's
   missing or the user confirms regeneration.
2. Otherwise invoke **planner** with the ticket.
3. If `spec.md` contains non-trivial Open Questions, stop and surface them before continuing — don't
   let `red` (next) or `dev` start against an ambiguous spec. `red` reads spec.md immediately after
   planner, so an ambiguous spec produces ambiguous or wrong tests just as readily as it produces
   wrong code.
4. Run stages 2–6 above (`red` through `security`) with their routing. On a `NEEDS_FIXES` /
   `BLOCKED` reroute, run `node scripts/write-fix-brief.mjs --source review|security --attempt <n>`
   **before** re-invoking **dev**; do not invoke `dev` if the generator or
   `check-stamp-freshness.mjs fix-brief.json` refuses.
5. Once `security.json` shows `PASS` immediately following a `PASS` `review.json`, run the
   **ledger** step (`node scripts/ledger-append.mjs`, which regenerates `index.json` itself).
6. Report back: overall result (ready to merge, or stopped and why); a one-line summary of what was
   built (from spec.md's Goal); links to all `.pipeline/` artifacts, markdown and JSON alike
   (`spec.md`/`spec.json`, `red.md`/`red.json`, `changes.md`/`changes.json`, `test-results.md`,
   `red-integrity.json`, `review.md`/`review.json`, `security-report.md`/`security.json`); the
   security run ID, baseline run ID, immutable artifact directory, and finding/coverage trajectory;
   the ledger entry path (`.sdd/ledger/<run-id>/`) if a terminal `PASS` was reached; and any
   non-blocking Warnings/Suggestions from `review.md` or `security-report.md`.
