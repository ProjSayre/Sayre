---
name: re-gate
description: The sanctioned re-verification path after a hand-edit made directly to the working tree, outside dev's own re-invocation loop. Re-runs review and security (and tester, unless --gates-only) against the CURRENT tree, and records in the ledger that code was changed outside the pipeline. Requires an existing review.json, and a caller-supplied --ticket <id> naming which ticket is being re-gated — for a change with no prior pipeline run at all, use /hotfix or /pipeline instead.
disable-model-invocation: true
argument-hint: [--gates-only] [--ticket <id>]
---

Re-gate: $ARGUMENTS

Follow `.sdd/pipeline.md`'s "`/re-gate [--gates-only] [--ticket <id>]`" section exactly — it is the
authoritative, runtime-neutral definition of this command.

Five things this command must not do, restated here because they are the ones most easily lost:

- **Do not derive `--ticket` from `.pipeline/spec.json`.** `--ticket <id>` must be supplied at this
  command's own invocation (`/re-gate --ticket <id>`, e.g. `/re-gate --gates-only --ticket "PL-04"`)
  as the human/caller's own, independent assertion of which ticket is being re-gated — the whole point
  of the check is that it is independent of the file it's being checked against. Reading `--ticket`'s
  value off `.pipeline/spec.json` (whether `spec.json`'s `ticket` field, or any other on-disk artifact)
  and then handing that same value back to `scripts/ledger-append.mjs --ticket` is a tautology: the
  cross-check would be comparing `spec.json` against itself, and would refuse nothing. If the caller
  did not state which ticket this is before you started, stop and ask — do not infer it from `spec.json`
  and proceed as if that were the same thing.
- **Do not treat `changes.md`/`changes.json` as still accurate.** State plainly, before invoking
  anything, that they describe the tree as it stood before this hand-edit.
- **Do not treat `.pipeline/spec.json` (or `spec.md`) as necessarily describing the run being gated.**
  `/re-gate` never runs `planner` — it is the one entry point that reaches the ledger without it — so,
  unlike every other path, nothing on disk guarantees either file is actually about this ticket. State
  plainly which ticket you believe you are re-gating (see the first bullet above for where that
  assertion must come from), and pass it as `--ticket <id>` on the ledger command below;
  `scripts/ledger-append.mjs` refuses if `spec.json`'s own ticket disagrees, if `spec.md`'s own
  first-heading ticket disagrees (a matching `spec.json` next to a leftover `spec.md` from a different
  ticket is not enough — PL-04 review pass 3 / Warning 2), or if `spec.json` carries no `stamp` field at
  all. That last check is a hygiene signal that `spec.json` went through `scripts/write-stamp.mjs` at
  some point — **not proof that it did**: a `stamp` is four unauthenticated JSON fields, and a
  hand-written one of the right shape (including a hex-format check on `treeHash`/`headSha` as of this
  fix — see `scripts/pipeline-contracts.mjs`'s `readStamp`) satisfies it exactly as well as a genuine
  one. Do not retry a refusal here by guessing a different `--ticket` value to make it pass — a mismatch
  means the wrong spec (or the wrong spec body) is on disk; author/ratify the correct one first.
- **Do not silently drop the ledger question, regardless of the resulting verdict.** On a terminal
  `PASS`, run `node scripts/ledger-append.mjs --re-gate --tester-ran <true|false> --ticket <id>` —
  this succeeds on that branch given a `spec.json` and `spec.md` that both name `--ticket`'s ticket, a
  stamped `spec.json` (see above), and `review.json`/`security.json` whose own `stamp` is not STALE
  against the tree right now (`scripts/ledger-append.mjs`'s `refuseIfStale` — this is precisely what
  makes step 3's "invoke review, then security, against the current tree" a real precondition rather
  than merely a recommendation: a `--re-gate` run that skipped, or long preceded, that step would carry
  a stale stamp and refuse here), plus the normal preconditions every other run already has (no
  pre-existing run directory for this id, a `findCompletedSecurityRun` match, a non-empty
  `filesTouched` — see `scripts/ledger-append.mjs` for the full list). On a stop at
  `NEEDS_FIXES`/`BLOCKED`, that exact command refuses (it still requires both gates to show `PASS`) —
  do not run it expecting it to work. Either report the stop with no ledger entry (the ordinary
  non-terminal outcome), or, to record this real, non-`PASS` outcome durably and disclosed (not
  authorized — nothing checks who invokes this), compose `--re-gate --tester-ran <true|false> --ticket
  <id>` with `--override-review "<reason>"`/`--override-security "<reason>"` — see `.sdd/pipeline.md`'s
  `/re-gate` step 5 and `.sdd/ledger/README.md`'s "Sanctioned override entries" section. The record that
  code was changed outside the pipeline — and whether `--tester-ran` was `true` or `false` — is the
  entire reason this command exists rather than being an unsanctioned shortcut; that record must never
  be attempted via a command invocation that is guaranteed to refuse.
- **Do not run this command in place of `/hotfix` or `/pipeline`.** It requires an existing
  `review.json` on disk; if there isn't one, say so and route to `/pipeline` (nothing has run yet)
  or `/hotfix` (production is broken and there is no time for either) instead.
