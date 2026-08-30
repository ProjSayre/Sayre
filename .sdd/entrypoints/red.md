# `/red`

Read `.sdd/pipeline.md` (core: stage sequence, routing, loop cap, staleness) first. This file is the authoritative, runtime-neutral definition of this command; no other entrypoint file is required to run it.

Runs only **red**, against whatever `.pipeline/spec.md` currently holds.

1. Require `.pipeline/spec.md` to exist; if it doesn't, say **planner** (`/planner <ticket>`) needs
   to run first, and stop.
2. Invoke **red**. It authors and classifies a behavioral test for every `AC-*`/`EC-*` item per
   `.sdd/stages/red.md`, refusing on its own to finish with any `RED-BROKEN` test left in it, and
   self-runs `node scripts/check-red-quality.mjs` before finishing (a self-check only — `tester` is
   the authoritative gating invocation).
3. Report `red.md`'s Impact map paragraph, the test/classification counts (`RED-CORRECT` vs.
   `RED-DEFERRED`), and where `red.md`/`red.json` live. Continuing means invoking **dev** (`/dev`),
   not restarting via `/pipeline`.
