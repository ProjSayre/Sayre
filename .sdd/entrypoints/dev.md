# `/dev`

Read `.sdd/pipeline.md` (core: stage sequence, routing, loop cap, staleness) first. This file is the authoritative, runtime-neutral definition of this command; no other entrypoint file is required to run it.

Runs only **dev**, against whatever `.pipeline/spec.md` (and, if present, `red.md`/`review.md`/
`security-report.md`) currently holds.

1. Require `.pipeline/spec.md` to exist; if it doesn't, say **planner** needs to run first, and
   stop.
2. If this is a **fix-loop** (`review.json` is `NEEDS_FIXES` or `security.json` is `BLOCKED`): run
   `node scripts/write-fix-brief.mjs --source review|security --attempt <n>` then
   `node scripts/check-stamp-freshness.mjs fix-brief.json`. Do not invoke **dev** if the generator
   or freshness check refuses. First attempt skips this and does not require a fix-brief.
3. Invoke **dev**. Its own procedure (`.sdd/stages/dev.md`) distinguishes first attempt from
   fix-loop — this command still has to generate the brief before a fix-loop invoke.
4. Report `changes.md`'s Files changed / Decisions made / Deviations / Fixes applied sections, and
   where `changes.md`/`changes.json` live. Continuing means invoking **tester** (`/tester`).
