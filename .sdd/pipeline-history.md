# Pipeline — history and archaeology

This file is history, not procedure. No command needs it in order to run a pipeline. It
records the reasoning and archaeology behind structural choices that are now settled — why things
are the way they are, not what to do. All procedural content lives in `.sdd/pipeline.md` and
`.sdd/entrypoints/<cmd>.md`.

---

## JSON sidecars (PL-03h round 4)

Every stage writes a small, strictly-validated JSON file next to its markdown report —
`spec.json`, `red.json`, `changes.json`, `review.json`, `security.json` — and every script that
makes a control decision reads **only** those JSON files, never the markdown.

This replaced three rounds of patching a hand-rolled markdown block scanner
(`scripts/build-ledger-index.mjs`'s old `extractSection`/`scanBlockState`) that tracked fenced-code
and HTML-comment state well enough to close one document-formatting exploit per round while
introducing or leaving open another — see `.pipeline/review.md`'s round-3 "On convergence" section
and `scripts/pipeline-contracts.mjs`'s own header comment for the full argument. `JSON.parse` either
succeeds or throws, so the *markdown-structural* ambiguity surface (a heading, a fence, an HTML
comment, a setext heading, an ATX closing sequence) is gone outright; `scripts/pipeline-contracts.mjs`
validates each sidecar's shape strictly on top of that (required keys present, verdict/classification
literals restricted to their enum, arrays checked to be arrays, ids checked against the `AC-n`/`EC-n`
shape, duplicate ids/paths within one array refused, **and, as of round 5, a duplicate key within one
JSON object refused** — plain `JSON.parse` permits repeating a key and resolves it "last value wins,"
the identical resolution rule the markdown round's duplicate-heading exploit used, one layer down;
review's round-4 report reproduced it end to end, so `scripts/pipeline-contracts.mjs`'s
`parseJsonOrThrow` now runs a strict, duplicate-key-rejecting parser instead of `JSON.parse` directly —
see that file's header for why a strict parser is achievable for JSON's closed grammar and was not for
markdown's unbounded one). The markdown reports are not decorative — they remain the documents a human
reads, and each stage's own file still requires them — but no script parses their prose for a decision
anymore. **Honest limit, stated plainly:** this removes a *third party's* ability to inject a false
reading through document formatting or through a duplicate-key resolution rule (which is what every
demonstrated exploit against the old scanner, and the round-4 duplicate-key exploit, did); it does
not, and cannot, stop a stage from writing a false value into its own JSON in the first place — a
stage that lies about its own verdict still lies, exactly as much as it could by lying in markdown
prose.

---

## Staleness stamps — rationale (PL-04)

Every `.pipeline/*.json` sidecar is *intended* to carry a `stamp` field, recording the tree state
at the moment it wrote the file — what actually guarantees this, concretely, is that each
`.sdd/stages/*.md` file's own numbered procedure runs `scripts/write-stamp.mjs` as its explicit last
step for that sidecar (see e.g. `.sdd/stages/planner.md`'s step 5 and `.sdd/stages/dev.md`'s step 9).
Nothing currently pins that instruction against being silently dropped from a stage file, so this is
a property of the procedure being followed, not an invariant a script enforces on its own — an
artifact written before this contract existed, or by a stage whose own step for it was ever removed,
carries no `stamp` key at all and reads `"unknown"` (never `"fresh"`) from every consumer below, per
`check-stamp-freshness.mjs`'s own three-way status. (`.pipeline/changes.json` shipped unstamped on
this contract's very first opportunity, in this same round, despite the producer and the instruction
both already existing — see `.sdd/stages/CHANGELOG.md`'s "PL-04 review pass 2" entry.)

```json
"stamp": { "treeHash": "...", "headSha": "...", "dirty": true, "writtenAt": "..." }
```

This exists to close a real gap: a downstream stage had no way to tell whether `changes.md`/
`review.md`/etc. describe the tree currently on disk or one that has since moved on (a new commit
landed, or someone hand-edited a file after the artifact describing it was written) — `review` in
particular used to read `changes.md` with no signal it might already be stale. (`test-results.md` is
the one exception: `tester` writes no JSON sidecar at all, so there is no `stamp` for it — see
`.sdd/stages/review.md`'s "Staleness of required inputs" section for how `review` covers that file's
currency without one.)

Two committed scripts, not "implementation detail" left to each stage to improvise, implement this:
`scripts/write-stamp.mjs <path-to-sidecar.json>` is the producer — every stage that writes one of the
five `.pipeline/*.json` sidecars runs it as the last step for that file (see each
`.sdd/stages/*.md` file's own numbered procedure). It shells out to the same read-only `git` commands
`scripts/ledger-append.mjs`'s `currentCommitInfo()` already established: `treeHash` is a SHA-256 over
`git rev-parse HEAD` + `git diff HEAD` + every untracked file's own content (`git ls-files --others
--exclude-standard`, then each file read directly — see `scripts/pipeline-contracts.mjs`'s
`computeTreeHash`), and the stamp's other fields reuse `git rev-parse HEAD` again for `headSha` and
`git status --porcelain` for `dirty`. `scripts/check-stamp-freshness.mjs <sidecar>`
is the consumer — every stage's own "Staleness of required inputs" section below names it by exact
command and exit code (`0` = not stale, `1` = stale, `2` = the check itself failed). Neither script is
optional prose: an agent cannot reproduce a SHA-256 working-tree hash, or compare one against the tree
right now, by reading or writing a file, for the same reason `check-red-integrity.mjs` is a committed
script rather than an instruction to rehash a file by hand. What `.sdd/pipeline.md`, and each
`.sdd/stages/*.md` file's own "Staleness of required inputs" section, specify beyond the two scripts'
own exit codes is the *contract* — what a stage does once an input is known to be stale.

---

## Review persistence — the resolved divergence

The two prior mirrors (`.claude/skills/pipeline/SKILL.md` and `.agents/skills/pipeline/SKILL.md`)
disagreed on *who writes* `.pipeline/review.md`: the Claude Code skill had the `review` subagent
write it directly, confined to `.pipeline/` by a hook guard (real and load-bearing for Claude Code
since PL-03g — see `.sdd/README.md`'s "Note on hook enforcement"); the other mirror had its
coordinator save the subagent's returned markdown verbatim, with no equivalent guard (Codex has no
subagent-isolation mechanism to hang one on). Both are the same contract implemented two different
ways, and the contract is what's neutral:

> `review` (and `security`) produce a report in the shape their stage file defines; that report is
> persisted verbatim to `.pipeline/review.md` (respectively `.pipeline/security-report.md`).

The *mechanism* — a runtime with subagents and hooks lets the stage write its own file directly; a
runtime without them has the coordinator save the returned markdown — is a per-runtime detail and
lives in `.sdd/runtimes.yml`, not here. Do not let a runtime difference in mechanism become a
difference in what gets persisted or in what the coordinator is allowed to alter before saving it:
the coordinator saves the report verbatim, it does not edit, summarize, or selectively drop
sections from it.

The same neutral contract covers each stage's JSON sidecar (PL-03h round 4): `review.json`/
`security.json` are persisted verbatim to `.pipeline/`, by whichever mechanism the runtime uses for
the matching markdown file, at the same time as that markdown file — never as a separate, later step
a runtime could skip. A runtime that persists `review.md` but drops `review.json` (or lets them
disagree) has not implemented this stage correctly, regardless of which persistence mechanism it uses.

---

## Per-stage entry points — observed gap (PL-04)

Before the Per-stage entry points section existed, only **planner** (via `/spec-only`) and
**security** (via `/security-recheck`) could be invoked alone. `red`, `dev`, `tester`, and `review`
could not — and `/security-recheck` refuses to run on anything but a `PASS` `review.json`, so a
hand-edit made after a `NEEDS_FIXES` review had no sanctioned way back to a fresh verdict at all:
there was no standalone `/review` to re-run, and a full `/pipeline` restart both redoes
`dev`/`tester` unnecessarily and, unless declined at its own first prompt, overwrites the very
`spec.md` the fix was made against. An absent legitimate path is what produces an illegitimate one —
see `.sdd/entrypoints/re-gate.md` for the sanctioned fix to that specific situation, and this
ticket's own motivating incident for why that distinction matters.

---

## PL-TRIM — this split's own archaeology

**Round:** PL-TRIM, Aug 2026.

**What changed.** `.sdd/pipeline.md` had grown to ~950 lines, almost entirely command-specific
instructions that any given run never uses. This round split it into:

- A short core (`≤300 lines`) retaining shared sequencing: stage order, routing, loop cap,
  staleness table, entry-point stubs.
- `.sdd/entrypoints/<cmd>.md` — one file per command, carrying the moved body verbatim (substance
  unchanged).
- This file (`pipeline-history.md`) — the archaeology, rationale, and backstory that no agent needs
  in order to run a stage.

**What did not change.** Stage sequence, routing rules, the 3-attempt loop cap, what terminal `PASS`
means, and every stage's own procedure in `.sdd/stages/`. Stage files (`CHANGELOG.md` included) were
deliberately not touched; two existing tests assert a two-file allowlist over `git diff -- .sdd/stages`
and this round is required to pass both.

**Recorded here instead of in `.sdd/stages/CHANGELOG.md`** because that changelog is specifically
the round-by-round record of *stage-file* amendments, and this ticket amended no stage file.
