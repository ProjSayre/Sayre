# `/re-gate [--gates-only] [--ticket <id>]`

Read `.sdd/pipeline.md` (core: stage sequence, routing, loop cap, staleness) first. This file is the authoritative, runtime-neutral definition of this command; no other entrypoint file is required to run it.

The sanctioned path back to a verdict after a hand-edit made **directly to the working tree**,
outside `dev`'s own re-invocation loop — e.g. a small fix applied by hand while reviewing a
`NEEDS_FIXES`/`BLOCKED` result, or any other edit made without going back through `/dev`. This is
not the situation `/hotfix` exists for: `/hotfix` is for when the pipeline never ran at all for
this change (production is broken, there is no spec, nothing has been reviewed). `/re-gate` is for
when `dev`/`tester`/`review` (and maybe `security`) already ran at least once for this ticket —
there is a `review.json` on disk — and the tree has since been hand-edited outside that sequence.
This is a hand-edit path, not a scoped-`dev` reroute: `/re-gate` does not generate or require a
`fix-brief`. If there is no `review.json` yet, this command refuses; use `/pipeline` or the per-stage commands
instead.

Before this command existed, an inline edit made after a `NEEDS_FIXES` review had no sanctioned way
back to a verdict at all: `/security-recheck` refused on anything but a `PASS` `review.json`, and
there was no standalone `/review` to refresh it. That absence is exactly the D-005 #3 failure this
pipeline exists to prevent, reproduced one level up — a human escaping around the tooling by
hand-writing an override, with no record it happened. `/re-gate`'s entire reason to exist is closing
that gap **with a record**, not merely with a working command: skip the ledger step below and this
is once again a fast path for laundering an unreviewed edit into a `PASS`.

1. Require `.pipeline/spec.md`, `.pipeline/changes.md`, and `.pipeline/review.json` to exist. If any
   is missing, say the pipeline hasn't produced enough to re-gate, and recommend `/pipeline` or the
   per-stage commands instead. **`/re-gate` never runs `planner`** — unlike every other path to
   the ledger, nothing else on disk guarantees `.pipeline/spec.json`/`spec.md` actually describes the
   ticket being gated here, so this precondition is stated as its own item rather than folded into the
   existence check above: `.pipeline/spec.json` must (a) genuinely be about the ticket you are
   re-gating, (b) agree with `.pipeline/spec.md`'s own first-heading ticket on that same question (PL-04
   review pass 3 / Warning 2 — a matching `spec.json` next to a leftover `spec.md` from a different
   ticket is not enough, since `spec.md` is what gets copied into the ledger and what `index.json`'s
   `spec` pointer resolves to), and (c) carry a `stamp` field — i.e. have gone through
   `scripts/write-stamp.mjs` at some point (`planner` does this automatically as its own last step; a
   hand-authored or retroactive `spec.json` must run it explicitly). All three are enforced
   mechanically, not merely asked for: step 5's ledger command below requires a `--ticket <id>` flag
   naming the ticket, and refuses outright if `spec.json`'s own ticket doesn't match it, if `spec.md`'s
   own first-heading ticket doesn't match it, or if `spec.json` carries no `stamp` at all — see
   `scripts/ledger-append.mjs`'s own header for why a stamp-freshness check alone (as opposed to
   ticket-identity plus presence) would not be enough: a `spec.json` from a different ticket against an
   otherwise-unmoved tree still reads "fresh."

   **`--ticket <id>`'s value must be independent of the files it checks, or the check is a no-op.**
   `--ticket` is the caller's own assertion of which ticket is being re-gated, supplied at this
   command's own invocation (`/re-gate --ticket <id>`, e.g. `/re-gate --gates-only --ticket "PL-04"` —
   see this command's own `argument-hint` in `.claude/skills/re-gate/SKILL.md` or the equivalent
   runtime shim). Reading a `--ticket` value off `.pipeline/spec.json` and then handing that same value
   back to step 5's `--ticket` flag is circular: the cross-check would compare `spec.json` against
   itself and refuse nothing, precisely when a wrong `spec.json` is what needs catching. If the human
   invoking this command did not already state which ticket is being re-gated, stop and ask — do not
   infer it from `spec.json` and treat that as equivalent to an independent assertion.

   **The `stamp`-presence check (c) is a hygiene signal, not a provenance guarantee** (CORRECTED, PL-04
   review pass 3 / Warning 1a, from this section's prior wording): a `stamp` is four unauthenticated
   JSON fields (`treeHash`, `headSha`, `dirty`, `writtenAt`); `scripts/pipeline-contracts.mjs`'s
   `readStamp` checks that they are present, correctly typed, and — as of this same fix — that
   `treeHash`/`headSha` are hex strings of the length `buildStamp()` actually produces. That rejects an
   obviously-wrong shape; it does not, and cannot, prove the file went through
   `scripts/write-stamp.mjs` rather than being hand-written to the same shape, since there is no
   signature or secret behind any of the four fields. Treat "carries a `stamp`" as "shows the minimal
   signal its documented authoring path always leaves," never as "is proven to have come from that
   path."
2. State explicitly, before invoking anything, that `.pipeline/changes.md`/`changes.json` describe
   the tree as it stood **before** this hand-edit — never silently treat them as still accurate.
   This acknowledgment is not optional color; it is why this command exists instead of quietly
   re-running `review`/`security` as if nothing had happened. (The same "flag, don't imply away"
   staleness discipline every stage's own trusted-fresh inputs follow — see "Staleness stamps"
   in `.sdd/pipeline.md` — applied here at the point a human, not a stage, is the source of the
   staleness.) Give `.pipeline/spec.md`/`spec.json` the same explicit treatment, but state a
   different fact about them: they are trusted for **which ticket** this run is about (checked
   mechanically by step 5's `--ticket` flag, per step 1 above) — never assumed to describe the
   tree's current implementation state, since the whole premise of this command is that the tree
   has moved since `spec.json` was last written.
3. Unless `--gates-only` is passed, invoke **tester** against the current tree. A hand-edit can
   introduce a regression the red suite would have caught had it run through the normal sequence;
   skipping that silently is exactly the shortcut this command exists not to be. Use `--gates-only`
   only when the edit is small enough that a human is confident no new test-coverage question is in
   play — and see step 5 for why that choice must still be visible afterward, not merely convenient
   in the moment.

   **`--gates-only` and the integrity lens:** when `--gates-only` is passed, tester is skipped, so
   no fresh `red-integrity.json` is written. The existing sidecar (if any) describes the pre-hand-edit
   tree and is therefore stale. `review` will return `NEEDS_FIXES` for any ticket that has red
   artifacts, because a stale `red-integrity.json` forces `NEEDS_FIXES` (see
   `.sdd/stages/review.md`'s EC-7 handling). This forfeits the integrity lens for this re-gate run.
   The resolution is to run tester: use `/re-gate` without `--gates-only` to write a fresh sidecar
   before review runs.
4. Invoke **review**, then — only if `review.json` shows `PASS` — **security**, exactly as
   `.sdd/pipeline.md`'s Routing section already describes for a `NEEDS_FIXES`/`BLOCKED` loop.
   `/re-gate` changes how the loop is entered, not what runs inside it.
5. Once the run reaches a verdict, what happens next depends on which verdict it is — the command
   below **requires `review.json`/`security.json` to both show `PASS`** (or be accepted via
   `--override-review`/`--override-security`, see below) before it writes anything, so it cannot be
   run unconditionally on every branch this step might be reached from:
   - **Terminal `PASS`** (both gates passed): run the ledger step with the re-gate marker:
     ```sh
     node scripts/ledger-append.mjs --re-gate --tester-ran <true|false> --ticket <id>
     ```
     `--tester-ran true` unless `--gates-only` was passed (then `false`) — whichever value was
     actually used must reach the ledger entry unchanged, so a fast re-gate is visibly distinct from
     a full one. `--ticket <id>` is the ticket you were told, or independently already knew, you were
     re-gating — the same value supplied to `/re-gate --ticket <id>` at this command's own invocation
     (see step 1's circularity warning: never derive this value by reading `.pipeline/spec.json` and
     handing it back here, since that compares `spec.json` against itself and refuses nothing).
     `ledger-append.mjs` refuses if `.pipeline/spec.json`'s own ticket doesn't match it, if
     `.pipeline/spec.md`'s own first-heading ticket doesn't match it either (step 1(b)), or if
     `spec.json` carries no `stamp` field at all (see step 1). All three checks are additive to the
     normal (non-`--hotfix`) preconditions in `scripts/ledger-append.mjs`. Unlike `--hotfix`, `--re-gate`
     is not a bypass of those checks —
     only a mandatory disclosure on top of a run that actually passed them. See
     `.sdd/ledger/README.md`'s "Re-gate entries" section for the resulting entry's exact shape
     (`entry.json`'s `regate: { testerRan, gatesOnly, note }` object, and `entry.md`'s dedicated
     `## Re-gate` section) — that record is the entire point, not a cosmetic label. If this command
     refuses on the spec-identity check instead of the PASS/PASS check, that means review/security
     produced real verdicts against a tree with no ledger-worthy spec behind them yet — report that
     plainly (don't retry with a fabricated `--ticket` value) and either author/ratify the correct
     spec.md/spec.json first, or record the terminal PASS without a ledger entry and say why.
   - **A stop at `NEEDS_FIXES`/`BLOCKED`**: the command above refuses (exit `1`) — do not run it as
     written. Either stop here and report the failure (no ledger entry, the same as an ordinary
     non-terminal stop — see "Loop cap" in `.sdd/pipeline.md`), or, to record this real, non-`PASS`
     outcome durably and disclosed (not authorized — see `.sdd/ledger/README.md`'s "Sanctioned
     override entries" section for why this is a disclosure requirement, not a check on who may do
     it), compose `--re-gate --tester-ran <true|false> --ticket <id>` with
     `--override-review "<reason>"`/`--override-security "<reason>"` — all flags are designed to
     compose freely on one command. There is no third option where the plain command above succeeds
     against a non-`PASS` verdict; it is not merely slow or unhelpful on that branch, it is refusing
     on purpose.
6. Report the same things `/pipeline`'s own step 6 reports, plus: that this was a re-gate rather
   than a fresh run, whether `--gates-only` was used, and the step-2 pre-edit-state acknowledgment.

**Honest limit:** this command re-verifies the gates against the tree as it now stands; it cannot
retroactively verify that the hand-edit itself was made carefully. That is exactly why running
tester is the default rather than the exception, and why `--gates-only` — skipping it — is a named,
ledger-recorded choice rather than a silent one.
