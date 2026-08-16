# `/pipeline-status`

Read `.sdd/pipeline.md` (core: stage sequence, routing, loop cap, staleness) first. This file is the authoritative, runtime-neutral definition of this command; no other entrypoint file is required to run it.

Reports where a run currently stands. Takes no action — no stage is invoked, no file is written.

1. Check which of `spec.md`, `red.md`, `changes.md`, `test-results.md`, `review.md`,
   `security-report.md` exist under `.pipeline/`, in that order, and compare modification times — an
   older downstream artifact than its upstream dependency likely means that stage hasn't run against
   current input yet. Their JSON sidecars (`spec.json`, `red.json`, `changes.json`, `review.json`,
   `security.json`) should exist and agree with their markdown counterparts wherever the markdown
   does — report a mismatch (one present without the other, or disagreeing verdicts) as its own
   finding, since it means a stage's output is incomplete or inconsistent under the JSON contract.
2. Pull spec.md's Goal, `review.json`'s verdict, and `security.json`'s verdict where present (the
   authoritative source for both — see "JSON sidecars" in `.sdd/pipeline.md` — cross-checked against
   `review.md`'s/`security-report.md`'s own `## Verdict` prose for agreement). If `security.json`
   shows `PASS` following a `PASS` `review.json`, also check whether `.sdd/ledger/index.json`
   already has an entry for this run (i.e. whether the ledger step ran) and report that too — a
   terminal `PASS` with no ledger entry means the ledger step is still owed, not that the run is
   unfinished.
3. Report: Ticket (the Goal, or "no spec.md — pipeline hasn't started"); Furthest stage reached;
   Verdicts so far; a timestamp/staleness flag; and a suggested next action (e.g. "run `/pipeline`
   to continue," "review.json says NEEDS_FIXES — invoke dev," "security.json is BLOCKED — invoke
   dev," "terminal PASS reached but no ledger entry yet — run `node scripts/ledger-append.mjs`," or
   "complete — ready to merge").
