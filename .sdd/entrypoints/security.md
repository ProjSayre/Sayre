# `/security [--mode PR_DELTA|REMEDIATION_RECHECK]`

Read `.sdd/pipeline.md` (core: stage sequence, routing, loop cap, staleness) first. This file is the authoritative, runtime-neutral definition of this command; no other entrypoint file is required to run it.

Runs only **security** — the canonical per-stage entry point for this stage. Default mode is
`PR_DELTA`.

1. Require `.pipeline/spec.md` and `.pipeline/changes.md` to exist; if either is missing, say the
   pipeline hasn't produced enough to security-check yet, and recommend `/pipeline` or `/dev`
   instead.
2. Invoke **security** with the given (or default) mode. Security's own procedure
   (`.sdd/stages/security.md`) already refuses to run a full check unless `.pipeline/review.json`'s
   verdict is `PASS` — this command relies on the subagent enforcing that gate, it does not
   duplicate it.
3. Report the resulting `security.json`/`security-report.md` verdict, run ID, baseline run ID,
   finding transitions, and coverage gains/losses.
4. If `BLOCKED`, route fixes through **dev** (`/dev`) and re-run `/security` afterward — this
   command does not re-run tester or review automatically. If `PASS`, this run has produced a
   terminal `PASS` exactly as much as reaching it via `/pipeline` does — the ledger step must still
   run, but which command depends on whether **planner** actually ran earlier in this same round
   (CORRECTED, SEC-10 v2 fix round — FND-bd78355b6ae7, HIGH: this step used to instruct the plain
   command unconditionally, with no branch for "no planner ran this round," which is exactly the
   documented happy path a stale or mismatched `spec.md`/`spec.json` pair — left over from an
   earlier ticket, with no `planner` invocation in between — walks straight through):
   - **planner ran this round** (`.pipeline/spec.md`/`spec.json` were freshly (re)written by
     planner for the ticket this run is actually about): run the same **ledger** step
     (`node scripts/ledger-append.mjs`) and report the resulting entry path.
   - **planner did not run this round**: use `/re-gate --ticket <id>` instead (see the `/re-gate`
     stub in `.sdd/pipeline.md` for the full procedure), supplying the ticket this run is actually about as your own
     independent assertion — the same precondition `/re-gate` already requires because it is the
     one entry point that reaches the ledger without planner ever having run. `scripts/ledger-append.mjs`'s own
     `spec.json`/`spec.md` agreement check (unconditional on every path as of this fix — see
     "Stage sequence" in `.sdd/pipeline.md`) still refuses a straight mismatch between the two
     files either way, but only `--re-gate --ticket <id>` catches the narrower case that check
     alone cannot: `spec.json` and `spec.md` agreeing with each other while both are stale
     leftovers from a different ticket than this round's real work.
