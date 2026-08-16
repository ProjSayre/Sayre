# `/planner <ticket>`

Read `.sdd/pipeline.md` (core: stage sequence, routing, loop cap, staleness) first. This file is the authoritative, runtime-neutral definition of this command; no other entrypoint file is required to run it.

Runs only **planner** and stops before any code changes — the canonical per-stage entry point for
this stage.

1. If `.pipeline/spec.md` already exists, warn that regeneration will replace it (and its
   `spec.json` sidecar) and get confirmation.
2. Invoke **planner** with the ticket.
3. Do not continue to red, dev, tester, review, or security.
4. Report the Goal, Scope, and Open Questions from spec.md; where the file (and `spec.json`) lives;
   that it can be hand-edited before continuing (both files, kept in agreement); and that continuing
   means invoking **red** directly (`/red`, not `/pipeline`, which restarts from planner and would
   overwrite the reviewed spec).
