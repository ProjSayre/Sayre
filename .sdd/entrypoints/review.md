# `/review`

Read `.sdd/pipeline.md` (core: stage sequence, routing, loop cap, staleness) first. This file is the authoritative, runtime-neutral definition of this command; no other entrypoint file is required to run it.

Runs only **review**, against whatever `.pipeline/spec.md`, `changes.md`, `test-results.md`, and
`red-integrity.json` currently hold.

1. Require `.pipeline/spec.md`, `.pipeline/changes.md`, `.pipeline/test-results.md`, and
   `.pipeline/red-integrity.json` to exist; if any of the first three is missing, say which stage
   needs to run first, and stop. If `red-integrity.json` is missing, review still stops with
   `NEEDS_FIXES` — absence is never "nothing to check" (see `.sdd/stages/review.md`). Review no
   longer reads `red.md`/`red.json` directly for integrity; it consumes tester's sidecar.
2. Invoke **review**. It is read-only with respect to source code (enforced structurally — see
   `.sdd/runtimes.yml`); it reports and routes, it never fixes.
3. Report the verdict (`PASS`/`NEEDS_FIXES`), the Critical/Warning/Suggestion findings, and the
   `findings[]` on `review.json` if `NEEDS_FIXES`. If `PASS`, continuing means invoking **security**
   (`/security`); if `NEEDS_FIXES`, continuing means generating a fix-brief
   (`scripts/write-fix-brief.mjs`) then re-invoking **dev** (`/dev`) — not sending `dev` at
   `review.md` prose.
