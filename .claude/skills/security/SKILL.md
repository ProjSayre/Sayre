---
name: security
description: Runs just the security stage — the canonical per-stage entry point for security-checker. Default mode PR_DELTA; /security-recheck is an existing alias for --mode REMEDIATION_RECHECK, kept working so old habits don't break. On a PASS immediately following an already-PASS review.json, also runs the ledger step.
disable-model-invocation: true
argument-hint: [--mode PR_DELTA|REMEDIATION_RECHECK]
---

Run only the security stage. $ARGUMENTS

Read `.sdd/pipeline.md` (core: stage sequence, routing, loop cap, staleness) then read
`.sdd/entrypoints/security.md` (the authoritative definition of this command). Invoke the
`security-checker` subagent with the given (or default `PR_DELTA`) mode; it writes
`.pipeline/security-report.md` directly (see `.sdd/runtimes.yml`). Require `.pipeline/spec.md` and
`.pipeline/changes.md` to exist first. Security's own procedure (`.sdd/stages/security.md`) already
refuses to run a full check unless `.pipeline/review.json` shows `PASS` — this command relies on
that, it does not duplicate the gate. If the result is a `PASS` immediately following an
already-`PASS` `review.json`, this is a terminal `PASS` exactly as much as reaching it via
`/pipeline` — the ledger step must still run, but which command depends on whether `planner`
actually ran earlier in this same round (CORRECTED, SEC-10 v2 fix round — FND-bd78355b6ae7, HIGH):

- **`planner` ran this round** (`.pipeline/spec.md`/`spec.json` were freshly (re)written by
  `planner` for the ticket this run is actually about): run `node scripts/ledger-append.mjs` (the
  plain command) and report the resulting entry path.
- **`planner` did NOT run this round** (a hand-edit/fix-round shape — `dev`/`tester`/`review`/
  `security` iterated directly against a `spec.md`/`spec.json` left over from an earlier ticket or
  round, with no `planner` invocation in between): do **not** use the plain command. Use
  `/re-gate --ticket <id>` instead, supplying the ticket this run is actually about as your own
  independent assertion — see `.sdd/entrypoints/security.md` for the full branch and why
  `scripts/ledger-append.mjs`'s agreement check alone cannot catch the stale-leftover case.
