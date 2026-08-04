---
name: security
description: Runs just the security stage — the canonical per-stage entry point for security-checker. Default mode PR_DELTA; /security-recheck is an existing alias for --mode REMEDIATION_RECHECK, kept working so old habits don't break. On a PASS immediately following an already-PASS review.json, also runs the ledger step.
disable-model-invocation: true
argument-hint: [--mode PR_DELTA|REMEDIATION_RECHECK]
---

Run only the security stage. $ARGUMENTS

Follow `.sdd/pipeline.md`'s "`/security [--mode PR_DELTA|REMEDIATION_RECHECK]`" section exactly —
it is the authoritative, runtime-neutral definition of this command. Invoke the `security-checker`
subagent with the given (or default `PR_DELTA`) mode; it writes `.pipeline/security-report.md`
directly (see `.sdd/runtimes.yml`). Require `.pipeline/spec.md` and `.pipeline/changes.md` to exist
first. Security's own procedure (`.sdd/stages/security.md`) already refuses to run a full check
unless `.pipeline/review.json` shows `PASS` — this command relies on that, it does not duplicate
the gate. If the result is a `PASS` immediately following an already-`PASS` `review.json`, this is
a terminal `PASS` exactly as much as reaching it via `/pipeline` — the ledger step must still run,
but which command depends on whether `planner` actually ran earlier in this same round (CORRECTED,
SEC-10 v2 fix round — FND-bd78355b6ae7, HIGH: this used to instruct the plain command
unconditionally here, with no branch for "no planner ran this round," which is exactly the
documented happy path a stale or mismatched `spec.md`/`spec.json` pair walks straight through):

- **`planner` ran this round** (`.pipeline/spec.md`/`spec.json` were freshly (re)written by
  `planner` for the ticket this run is actually about): run `node scripts/ledger-append.mjs` (the
  plain command) and report the resulting entry path.
- **`planner` did NOT run this round** (a hand-edit/fix-round shape — `dev`/`tester`/`review`/
  `security` iterated directly against a `spec.md`/`spec.json` left over from an earlier ticket or
  round, with no `planner` invocation in between): do **not** use the plain command. Use
  `/re-gate --ticket <id>` instead, supplying the ticket this run is actually about as your own
  independent assertion — exactly the precondition `/re-gate` already requires because it is the
  one entry point that reaches the ledger without `planner` ever having run. `scripts/
  ledger-append.mjs`'s own `spec.json`/`spec.md` agreement check (unconditional on every path,
  including the plain one, as of this fix) still refuses a straight *mismatch* between the two
  files either way — but only `--re-gate --ticket <id>` catches the narrower case that check cannot:
  `spec.json` and `spec.md` agreeing with each other while both are stale leftovers from a
  different ticket than this round's real work (this repo's own `.pipeline/` carried exactly that
  shape going into this fix).
