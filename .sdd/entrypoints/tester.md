# `/tester`

Read `.sdd/pipeline.md` (core: stage sequence, routing, loop cap, staleness) first. This file is the authoritative, runtime-neutral definition of this command; no other entrypoint file is required to run it.

Runs only **tester**, against whatever `.pipeline/spec.md` and `.pipeline/red.md` currently hold.

1. Require `.pipeline/spec.md` and `.pipeline/red.md` to exist (tester's own required inputs — see
   `.sdd/stages/tester.md`); if either is missing, say which of planner/red needs to run first, and
   stop.
2. Invoke **tester**. It does not author behavioral tests (see `.sdd/stages/tester.md`) — it runs
   the red suite, runs `scripts/check-red-integrity.mjs` and `scripts/check-red-quality.mjs` (the
   authoritative red-quality run) and applies the judgment rules, runs the impact-resolver regression
   set when usable, and reports gaps rather than filling them.
3. Report `test-results.md`'s Result summary and Reported behavioral gaps, plus the
   `red-integrity.json` sidecar's `redIntegrity` verdict and any blocking judgments. Report where
   both files live. Continuing means invoking **review** (`/review`).
