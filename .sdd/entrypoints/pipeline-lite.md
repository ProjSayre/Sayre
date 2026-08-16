# `/pipeline-lite <ticket>`

Read `.sdd/pipeline.md` (core: stage sequence, routing, loop cap, staleness) first. This file is the authoritative, runtime-neutral definition of this command; no other entrypoint file is required to run it.

The proportionate lane for a genuinely small, mechanically-eligible change (PL-11) — a typo, a
one-file cleanup, a doc fix. A fail-closed, mechanical eligibility gate (step 1 below) runs before
anything else; only a change it confirms small ever reaches the stages that follow, which are
otherwise the ordinary sequence — deliberately skipping `red` and `security` (see "Honest limits"
below for what that costs) — ending in the mandatory ledger step. Available on any lane (including a
fenced one — a fenced contributor fixing a typo inside their own area is exactly who this lane is
for; `/hotfix`'s `full`-only restriction is untouched). It is not a fourth degree of the full
pipeline's own routing or loop cap — both are reused unchanged (see Routing and "Loop cap" in
`.sdd/pipeline.md`); this section only adds the eligibility gate in front of them and the disclosure
that goes into the ledger at the end.

**Not `/hotfix`:** `/hotfix` is for when production is broken and there is no time for a spec at
all; this lane still writes a real spec and still passes `review` before anything lands.
**Not `/re-gate`:** `/re-gate` re-verifies a run that already happened, after a hand-edit outside
`dev`'s loop; this lane is a first, and only, pass through the pipeline for a change small enough to
skip two of its gates going in.

1. **Eligibility first, and it is mechanical, not a judgment call.** `node
   scripts/check-lite-eligible.mjs` computes the verdict — before any stage below ever runs — against
   `.sdd/bounds.yml`'s `lite_eligibility` bounds (`max_files`, `max_changed_lines`, `max_line_length`
   — the last one catches a diff shaped as a very few, very long lines, which `max_changed_lines`
   alone cannot) and the barred-path union (see "Honest limits" below): exit `0` (eligible) continues
   into this lane; exit `1` (ineligible, too big or touches a barred path) or exit `2` (the check
   could not run — ambiguous input, an unresolvable `--base`, a missing `lite_eligibility` block) both
   route to `/pipeline` instead. Ambiguity is ineligibility; the lane is never entered provisionally. The same
   routing table covers two adjacent cases: a small change made during a production incident is
   `/hotfix`, not this lane; a small change on a barred path is `/pipeline`, not this lane.
2. Invoke **planner** with the ticket, exactly as `/pipeline` does.
3. **`red` is skipped.** No test for this ticket is authored before `dev` runs — see "Honest limits"
   below for what that costs.
4. Invoke **dev**.
5. Invoke **tester**. It still runs in full on this lane — `.sdd/stages/tester.md`'s Required inputs
   item 1 treats `red.md`'s absence as legitimate specifically on this lane (state it, don't stop),
   while every other guarantee (no authored behavioral tests, gaps reported rather than filled) stays
   in force, and is *more* consequential here since no `red` stage covered anything to begin with.
6. Invoke **review** — the surviving gate, **unchanged**. This lane adds **no new subagent stage**:
   `review` is still the one that decides `PASS`/`NEEDS_FIXES`, its decision still comes from
   `.pipeline/review.json` (never `review.md`'s prose — the same JSON-sidecar contract every other
   path already uses), and its read-only-with-respect-to-source-code property is still the same
   structural enforcement every other path relies on — `scripts/guard-checker-readonly.mjs`'s
   `READ_ONLY_AGENTS` set, which already lists `review` (see `.sdd/README.md`'s "Note on hook
   enforcement"). `.sdd/runtimes.yml` and every file under `.claude/agents/` are unchanged by this
   lane.
7. **`security` is skipped.** No attacker-brief sweep, no CORE-01..06 pass, no immutable audit record
   for this run — see "Honest limits" below.
8. Once `review.json` shows `PASS`, run the **ledger** step with the lite marker:
   ```sh
   node scripts/ledger-append.mjs --lite
   ```
   which re-checks eligibility against the live diff (never trusting step 1's earlier verdict alone —
   the tree may have moved since), refuses on a `STALE` `review.json` (`refuseIfStale`, unchanged from
   the plain path) or an unstamped `spec.json` (the same hygiene check `/re-gate` already applies, for
   the same reason: there is no security-history cross-check on this lane to compensate), and writes a
   visibly-marked entry — title `(LITE)`, `verdicts: { review: "PASS", security: "SKIPPED_LITE" }`, a
   `## Lite lane` section naming exactly what did not run — that is nonetheless indexed into
   `.sdd/ledger/index.json`'s file→spec map (not excluded, unlike a `--hotfix`/override entry): the
   spec really was ratified and `review` really did pass it against the final tree, the same argument
   `.sdd/ledger/README.md` already makes for a `--re-gate` entry. See that file's "Lite-lane entries"
   section for the exact shape.
9. Report the same things `/pipeline`'s own step 6 reports, plus: that this was a lite-lane run, which
   stages were skipped, and the eligibility numbers it was measured against.

If `review.json` reads `NEEDS_FIXES`, this lane reuses the same routing loop `/pipeline` already has
(write a fix-brief via `scripts/write-fix-brief.mjs` before re-invoking `dev`, then re-run
`tester`/`review`) and the same 3-attempt loop cap — nothing here defines
a second, lite-specific loop. Escalating out of the lane entirely (the change grew, or review surfaces
something this lane's mechanical gate could not have caught) means finishing through the full
pipeline: run `/security` against the current tree, then the plain `node scripts/ledger-append.mjs`
— never retrying `--lite` against a change that has already been found too large or too sensitive for
it.

**Honest limits.** This lane gives up real things, named plainly rather than left implicit:

- `red`'s spec-first ordering. Any test that ends up covering this change was written *after* the
  diff already existed — the exact D-018 inversion the rest of this pipeline exists to prevent,
  reintroduced deliberately, and only here, for a change small enough that the tradeoff is judged
  worth it.
- `security`'s full attacker-brief sweep, the CORE-01..06 mandatory checks, and the immutable
  `.pipeline/security-history/` audit record — none of them run, none of them exist for this run.
- The barred-path list (`hotfix_barred_paths` ∪ `deny_for_fenced_lanes`, computed by
  `scripts/check-lite-eligible.mjs`'s `liteBarredPaths`) is a curated, best-effort list, not a
  complete classifier of every security-sensitive path in this codebase.
- The fail-closed default: ambiguous eligibility — a check that could not run, a bound that could not
  be evaluated, a base that could not be resolved — routes to `/pipeline`, never a provisional entry
  into this lane.
