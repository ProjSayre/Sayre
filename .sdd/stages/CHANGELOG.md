# Stage changelog — round-by-round history, kept out of the stage files themselves

`.sdd/stages/review.md` grew from 85 to 143 lines in four days, almost entirely from inline,
round-by-round history ("Corrected, PL-03h round 5 / review Critical 3: this gate previously read
review.md's prose..."). Every agent running a stage pays to read that history on every invocation,
forever, even though it never needs it to run the stage correctly today.

This file is where that history goes instead. The rule each `.sdd/stages/*.md` file now follows:
say what to do and why the rule exists — never which round changed it. If a stranger following that
file's current text would do the right thing without reading a word of this changelog, the split
worked. What stays inline is rationale (why `Bash` isn't covered by the read-only guard; why
`review.json`, not `review.md`'s prose, is authoritative); what moves here is archaeology (which
round found that gap, which review comment number flagged it, what the previous wording said).

**One caution this split has to respect, stated once so it isn't lost in the move:** a rationale
sentence that turns out to be a *false* claim is not archaeology, and deleting it — rather than
correcting it in place — would quietly reintroduce a believed-not-tested premise. (`scripts/
pipeline-contracts.mjs`'s own header once claimed a fix "means every caller inherits it
automatically"; that was false — see the SEC-10 entry below — and the file's own text now says so
directly, rather than being cleaned up into a shorter, confidently wrong sentence.) Moving history
out of a stage file is about removing *dated narration*, never about removing a *correction*.

## Shared: read-only enforcement for `review` / `security-checker` / `pr-review`

- **PL-03a (initial extraction).** The pre-`.sdd/` Claude Code definitions for these three stages
  each declared a `PreToolUse` hook in the subagent's own frontmatter, believed to enforce
  read-only-ness structurally.
- **PL-03a, loop 3 (diagnostic run).** Established that a `PreToolUse` hook declared in subagent
  frontmatter never actually fires on this checkout — only a hook declared under a top-level
  `hooks:` key in `.claude/settings.json` does, and at that point `settings.json` had no such key
  either. So for the entire life of the repo up to this point, `review`/`security-checker` were
  documented as "read-only, enforced by hook" and were in fact unenforced — for `Write` as well as
  `Bash` (D-005 had caught the `Bash` gap and assumed the `Write` matcher worked; it did not). The
  inert hook declarations were deleted rather than left in place making a claim they couldn't back.
- **PL-03g (real fix).** `.claude/settings.json` now declares a top-level `PreToolUse` hook running
  `scripts/guard-checker-readonly.mjs`, confirmed to fire for subagent tool calls (a 2026-08-04
  payload probe found `PreToolUse` receives `agent_type`/`agent_id` alongside `tool_name`/
  `tool_input`, which is what let this be scoped to just the checker stages instead of "block
  everyone or block no one"). `review`, `security-checker`, and `pr-review` are all in that script's
  `READ_ONLY_AGENTS` set. The one gap that did **not** close: the guard covers `Write`/`Edit`/
  `NotebookEdit`, never `Bash` — a command-allowlist over `Bash` was tried and rejected on the
  merits (`docs/PRD_Tickets.md`'s PL-03g section has the rejected-approach catalogue; the short
  version is that a single allowed command which executes project code, e.g. `poetry run pytest`
  running `conftest.py`, makes command-layer default-deny meaningless).

## `red` (introduced PL-03c)

- **PL-03c.** New stage, authored directly at the `.sdd/` layer (no pre-existing `.claude/agents/
  red.md` to extract from) — see `docs/sdd-tdad-design.md` Section 3 for the design rationale and
  D-021's TDAD finding that motivated running structurally before `dev` rather than merely
  instructing "write tests first."
- **PL-03b (wired in later).** The test-impact resolver (`services/workers/scripts/
  affected_tests.py`) became available for this stage to consult, gated on the workers' Poetry
  environment being set up in the checkout.
- **PL-03i (tracked, not fixed here).** The resolver's ranking is distorted by re-export barrels,
  each costing a full BFS depth level exactly like a real import would — this can rank a file's own
  direct test behind one that only reaches it through a barrel.

## `review`

- **PL-03a.** Extracted from the pre-`.sdd/` Claude Code subagent definition, with one
  runtime-specific clause removed (the hook-enforcement mechanism — see "Shared" above).
- **PL-03c (review Critical 3).** Added the Red-test integrity and Spec trace checks, once `red`
  existed and produced `.pipeline/red.md`. Split the mechanical half (hashing, `@spec` resolution)
  into a committed script (`scripts/check-red-integrity.mjs`) rather than asking review to compute a
  SHA-256 digest by reading a file.
- **PL-03h round 4 (architectural).** Retargeted that script's mechanical checks onto JSON sidecars
  (`.pipeline/{spec,red,changes}.json`, via `scripts/pipeline-contracts.mjs`) instead of markdown
  prose. Three straight prior rounds had each patched `scripts/build-ledger-index.mjs`'s hand-rolled
  markdown block scanner (`extractSection`/`scanBlockState`) to close one exploit (a fenced shadow,
  an HTML-comment shadow, a mid-line comment bypass, an ATX closing sequence, a setext heading — the
  last two needing no fence or comment at all) and each round's fix left, or produced, another. The
  fix was to stop parsing prose for a control decision at all, not patch the parser a fourth time.

## `security`

- **PL-03a.** Extracted from the pre-`.sdd/` Claude Code subagent definition. D-005 rated this
  extraction ahead of both comparison estates at the time: the (now-deleted) Codex mirror,
  `.codex/agents/security-checker.toml`, was 13 lines of prose paraphrase with none of the mechanics
  this file has always carried (the registry, checklist IDs, `UNVERIFIED` semantics, the
  content-hashed manifest, the untrusted-evidence clause). One runtime-specific clause was removed
  (the hook-enforcement mechanism — see "Shared" above); nothing else was reworded at that time.
- **PL-03h round 5 (review Critical 1).** `scripts/pipeline-contracts.mjs`'s own header had claimed
  "no ambiguity surface of any kind" for the new JSON-sidecar contract. False: `JSON.parse` (and the
  JSON grammar itself, ECMA-404 / RFC 8259) permits a repeated key within one object and leaves the
  resolution parser-defined — V8 resolves to the *last* occurrence, the identical "last one wins"
  defect the markdown round's duplicate-heading exploit had used, one layer down.
  `{"verdict":"NEEDS_FIXES","verdict":"PASS"}` parsed with plain `JSON.parse` reads as `PASS`.
  Review's own round-4 report reproduced this end to end against the real `ledger-append.mjs`: a
  durable `review: PASS` / `security: PASS` ledger entry for a run whose real, first-written verdict
  was `NEEDS_FIXES` / `BLOCKED`. Fixed by `parseJsonOrThrow`, which now runs `parseStrictJson` — a
  small recursive-descent parser that tracks keys seen so far *within each object literal* and
  throws on a second occurrence — rather than delegating to native `JSON.parse` (a `JSON.parse`
  *reviver* function cannot see the shadowed duplicate at all; it is invoked once per key with only
  the surviving value).
- **PL-03h round 5 (review Critical 3).** This stage's own PASS-gate ("only run a full check if
  `.pipeline/review.json`'s verdict is `PASS`") had, until this round, still read `review.md`'s
  *prose* — the one control decision the round-4 JSON-sidecar migration missed, and reachable by
  every markdown exploit the prior rounds had closed everywhere else. Fixed to read `review.json`
  directly; `review.md`'s own `## Verdict` section must still agree with it for a human reader, but
  this gate no longer parses that section.
- **Security round 6 (SEC-10).** Round 5's fix above (`parseJsonOrThrow`) only protects a caller
  that actually calls it. One real call site had not become a caller: `scripts/ledger-append.mjs`'s
  `findCompletedSecurityRun` still read `security-history/<run-id>/{manifest,results}.json` with
  plain `JSON.parse`, one layer under the already-fixed `security.json` — reproducing the identical
  duplicate-key forgery end to end against the *immutable audit trail* this time: a `results.json`
  whose real verdict was `BLOCKED`, with a duplicate, appended `"verdict":"PASS"` key, read as `PASS`
  and would have been written into a durable ledger entry. Fixed by routing both reads through
  `readJsonFile` (`scripts/pipeline-contracts.mjs`), the same primitive `readJsonSidecar` uses.
- **Security round 6 (SC-12, adjacent to this stage's own audit-run validator).** The strict
  parser's `parseString` accumulated a string value one character at a time, measured roughly 250x
  slower than native `JSON.parse` at 80MB with super-linear growth as size increased. Fixed via
  slice-based run accumulation (append a whole contiguous unescaped run in one `text.slice(...)`
  call, only at an escape or the closing quote), plus a 10MB `MAX_JSON_FILE_BYTES` ceiling checked
  via `statSync` before any file this size is read into memory at all.
- **Security round 6 (GAP-01, on `/hotfix`'s ledger path, not this stage directly).**
  `.sdd/hotfix.md` lists four eligibility gates; `scripts/ledger-append.mjs --hotfix` had, until this
  round, mechanically enforced none of them — only that its five required text fields were
  non-empty. Two of the four are irreducibly human judgment ("is production actually broken," "is
  rollback better") and stay exactly that. The other two are now enforced: `--lane` is required and
  must resolve to the unfenced (`full`) lane, and no touched file may match `.sdd/bounds.yml`'s
  `hotfix_barred_paths` list.

## PL-04 (this round)

- Added per-stage entry points (`/planner` through `/security`) and `/re-gate` — see
  `.sdd/pipeline.md`'s Entry points section. `/spec-only`/`/security-recheck` continue to work as
  aliases.
- Added the `stamp` field (`{ treeHash, headSha, dirty, writtenAt }`) to `scripts/pipeline-contracts.mjs`
  (the reader/comparator, `buildStamp`/`stampFreshness`) and the three-way staleness contract
  (re-derived / trusted-fresh / advisory) each stage file's own "Staleness of required inputs" section
  declared per input — see `.sdd/pipeline.md`'s "Staleness stamps" section. **CORRECTED (review pass
  1 / Blocker 1 / C1):** this line, as originally written, described only half the work and read as
  though the whole contract were live — no stage's own "Exact shape" output contract actually included
  `stamp`, nothing called `buildStamp` outside a test, and `.sdd/stages/security.md`'s "refuse on a
  stale `review.json`" promise could therefore never fire. See "Review pass 1 (fix round)" below for
  the producer (`scripts/write-stamp.mjs`) and consumer (`scripts/check-stamp-freshness.mjs`) that
  close that gap for real.
- Added exact command/exit-code/output-shape documentation for every script a stage invokes, so a
  stage's own file is sufficient without opening `scripts/` — see each stage file's own script
  references.
- This changelog itself: extracted the round-by-round history that had accumulated inline in
  `.sdd/stages/review.md` and `.sdd/stages/security.md`'s leading comments, replacing it with a
  condensed rationale plus a pointer here.
- **Fix pass (same round).** `/re-gate` had been documented (`.sdd/pipeline.md`) and shimmed
  (`.claude/skills/re-gate/SKILL.md`) but its own `scripts/ledger-append.mjs --re-gate --tester-ran
  <true|false>` flag did not exist — and every unrecognized flag on every `scripts/` CLI was silently
  ignored rather than rejected, so the documented command would have written an ORDINARY ledger entry
  on a `PASS` `review.json`, indistinguishable from a genuine pass, which is exactly the laundering
  `/re-gate` exists to prevent. Fixed: `--re-gate --tester-ran <true|false>` implemented as additive
  metadata on the normal (non-`--hotfix`) ledger-append path (still requires PASS/PASS, or an
  `--override-*`), recording `entry.json`'s `regate: { testerRan, gatesOnly, note }` and an
  `entry.md` `(RE-GATE)` title suffix plus `## Re-gate` section — deliberately NOT excluded from
  `index.json`'s file→spec map, unlike `bypass`, since a re-gated run's spec really was ratified
  against the tree it was reviewed against. General fix alongside it: every `scripts/` CLI
  (`ledger-append.mjs`, `check-bounds.mjs`, `build-ledger-index.mjs`, `check-red-integrity.mjs`,
  `generate-agent-shims.mjs`) now fails closed, naming the token, on an argument it doesn't recognize.
- **Fix pass (same round).** `scripts/sdd-completeness.test.mjs` rewritten to assert structure/
  behavior (section-scoped concept co-occurrence, tolerant of wording) rather than pinning exact
  human-written sentences from stage files, per this same file's own "archaeology vs. rationale"
  caution above — a cosmetic rewording of a stage file shouldn't be able to fail this suite, only a
  genuine loss of the guarantee should. Verdict literals, filenames, JSON field names, command names,
  and the PL-03a migrated entry's tamper-evidence content hashes stay pinned exactly — those are the
  contract.
- **Fix pass (same round).** `scripts/tsconfig.json` added — `checkJs` over the SDD pipeline
  control-plane scripts and their test suites (the root `tsconfig.json`'s `include` is `["src"]`
  only, so `npx tsc --noEmit` had never checked anything under `scripts/`). Wired as
  `npm run typecheck:scripts` and a new CI step.

## Review pass 1 (fix round, `fix/pl-04-pipeline-defects`)

Review's first pass on this branch returned `NEEDS_FIXES`: four Critical blockers, all in the same
class this changelog's own opening caution names — documentation asserting a property that does not
exist. See `.pipeline/review.md` for the full reproductions; this entry records what changed, not the
findings themselves.

- **C1 (the headline finding) — the `stamp` contract had a reader and a documented consumption policy
  but no producer anywhere in the repo.** `buildStamp`/`stampFreshness` (`scripts/pipeline-contracts.mjs`)
  had zero non-test callers; no stage's "Exact shape" output contract mentioned `stamp`; every sidecar
  on disk was therefore unstamped and `stampFreshness` could only ever return `unknown`; and
  `.sdd/stages/security.md`'s "refuse on a stale `review.json`" promise — the one place this pipeline's
  three-way staleness policy is supposed to produce a refusal rather than a flag — could never fire.
  Fixed with two committed scripts, not more prose: `scripts/write-stamp.mjs <path>` (the producer —
  every stage that writes one of the five `.pipeline/*.json` sidecars now runs it as the last step for
  that file, right after writing every other field) and `scripts/check-stamp-freshness.mjs <sidecar>`
  (the consumer — exit `0` = not stale, `1` = stale, `2` = the check itself failed; every stage's own
  "Staleness of required inputs" section now names it by exact command). `.sdd/stages/security.md`'s
  PASS-gate paragraph and its own staleness section now name the exact command and exit code its
  refusal is keyed off of, rather than asserting a refusal with no mechanism behind it. Also fixed the
  one structurally-impossible instance: `.sdd/stages/review.md`'s staleness section used to list
  `test-results.md` alongside every stamped input, but `tester` writes no JSON sidecar at all — there
  is no artifact for that stamp to live on, ever. That bullet now says so plainly and describes the
  diff-vs-claim check `review` uses instead (the same mechanism it already applies to `changes.md`'s
  self-report), rather than pointing at a nonexistent stamp. Caught during the same pass:
  `.github/workflows/ci.yml` gates each `scripts/` suite by an individually named `test:*` step, not a
  `scripts/*.test.mjs` glob — the two new suites above shipped with no CI step at all until that was
  noticed and fixed, which would have been the exact "documented but unwired" shape this blocker
  itself is, one level down. Pinned via `sdd-completeness.test.mjs`'s own new "CI runs the two new
  stamp-script test suites" test, the same pattern PL-03c's ledger-index CI-wiring test already
  established.
- **C2 — `.pipeline/changes.json` still described a prior round (PL-03h) after `changes.md` was
  rewritten for this one.** The two are written together per `.sdd/stages/dev.md`'s own output
  contract; only one had been. Rewritten to list this round's actual files, machine and human record
  back in agreement.
- **C3 — `--override-review`/`--override-security` (B2/B3, an earlier fix pass this same round) had no
  documentation outside `ledger-append.mjs`'s own source and a parenthetical mention here.** Added a
  "Sanctioned override entries" section to `.sdd/ledger/README.md`, parallel to "Hotfix bypass entries"
  and "Re-gate entries" (the two flags, the mandatory-reason rule, the `overrides` array, the `##
  Overrides` section, and how `bypass: true` is derived from the verdicts and excludes the entry from
  the index) and corrected that file's `entry.json`-shape line, which asserted `verdicts.review`/
  `verdicts.security` "must both be exactly the literal string `PASS`" with no exception — false for an
  override entry, which legitimately carries a non-`PASS` verdict alongside a non-empty `overrides`
  array explaining why it was accepted anyway. Also named the flags in `.sdd/pipeline.md`'s ledger step
  and Loop cap section, and fixed `/re-gate` step 5 (see W3 below) to say when to reach for them.
  While auditing that section, found and fixed one more instance of the same defect class it was
  already correcting: "Entry format"'s own "`entry.md` uses exactly these headings, in this order"
  claim listed only seven of the nine headings a real, non-`--hotfix` `entry.md` always or
  conditionally carries — `## Re-gate`, `## Overrides`, and `## Commit` were all missing from the list
  (the first two because they postdate when that sentence was written; `## Commit` was never listed at
  all, going back further). Corrected to name all nine, in `buildEntryMarkdown`'s actual order.
- **C4 — the OS-temp write allowance in `scripts/guard-checker-readonly.mjs` no-oped the entire guard
  when the checkout itself lives under `os.tmpdir()`** (a temp `git worktree`, an ephemeral/sandboxed
  checkout, or a CI runner whose workspace is nested under its own `TMPDIR` — all realistic). The
  allowance was computed from the target path's containment in the OS temp root alone; if the repo root
  is also under it, every path in the repo resolves inside it too, so the guard ALLOWed everything,
  silently, while its own header claimed the opposite unqualified. Fixed by requiring the checkout root
  itself NOT be contained in the OS temp root before the allowance applies at all; when it is, this
  falls through to the `.pipeline/`-only rule exactly as if the allowance didn't exist. The header's
  claim is now conditioned on the same check that makes it true.
- **W2 — `check-red-integrity.mjs --dir` took the next token as its value unconditionally**, so `--dir
  --bogus` silently read `"--bogus"` as a (nonexistent) directory and `--dir` as the last token silently
  fell back to `.pipeline/` — both reported the indistinguishable-from-a-typo "no-red-json — nothing to
  check," exit 0. Fixed to validate the value the same way `ledger-append.mjs`'s `readRegateArgs` and
  `check-bounds.mjs`'s `--lane` already do: missing or flag-shaped both throw, naming what was found.
- **W1 — `check-bounds.mjs`'s `normalizeForMatch` only special-cased a single leading `./` and a
  backslash, not the general class.** `.//x`, `././x`, and their backslash equivalents still evaded
  `hotfix_barred_paths` after the earlier round's fix. Replaced the two special cases with backslash
  normalization followed by `path.posix.normalize()` — a real path-segment resolver, not a third special
  case — which closes the class the fix was always meant to close.
- **W3 — `/re-gate` step 5 instructed a single ledger command that refuses on the `NEEDS_FIXES`/
  `BLOCKED` branch it explicitly names**, since that command still requires `review.json`/
  `security.json` to both show `PASS`. Split the step by branch: on a terminal `PASS`, run the command
  as before; on a stop at `NEEDS_FIXES`/`BLOCKED`, either don't run it (no ledger entry, the ordinary
  non-terminal outcome) or compose it with `--override-review`/`--override-security` if a human wants
  the outcome recorded durably. The same absolute instruction ("do not skip the ledger step, ever,
  regardless of the resulting verdict") was also baked into `.claude/skills/re-gate/SKILL.md`, more
  starkly stated — fixed there too.
- **W4 — `scripts/tsconfig.json`'s exclusion comment over-claimed which of the nine excluded scripts
  carry pre-existing `checkJs` findings.** Re-verified directly (not merely re-quoted): five actually
  fail (`check-secret-access.test.mjs`, `export-tree.mjs`, `render-anime-hero.mjs`, `smoke.mjs`,
  `test-waitlist.mjs` — the last two were previously, and wrongly, counted as clean), four are
  genuinely clean today (`og.mjs`, `check-secret-access.mjs`, `check-org-secret-access.mjs`(+`.test.mjs`)).
  The comment now states the verified split and makes clear the "different subsystem" scoping argument
  justifies the exclusion on its own, independent of which files happen to be dirty.

Verify: `node --test scripts/*.test.mjs` — 321/321 pass (was 286/286; +28 across the two new
stamp-script suites (`write-stamp.test.mjs` 15, `check-stamp-freshness.test.mjs` 13), +4 new
`[C4]`-tagged tests in `guard-checker-readonly.test.mjs`, +2 new `[unknown-flag]` tests in
`check-red-integrity.test.mjs`, +1 new CI-wiring test in `sdd-completeness.test.mjs` pinning that the
two new suites above are actually gated in CI, none removed). `npm run typecheck:scripts`,
`npm run check:agent-shims`, and `npm run check:ledger-index` all still pass.

## Review pass 2 (fix round, `fix/pl-04-pipeline-defects`)

Review's second pass returned `NEEDS_FIXES` again: two Critical blockers, both new content in the
pass-1 diff rather than regressions in what pass 1 fixed. See `.pipeline/review.md` for the full
reproductions; this entry records what changed.

- **Critical 1 — `/re-gate`'s mandatory ledger step had no way to tell whether `.pipeline/spec.json`
  actually described the run being gated.** `/re-gate` is the one entry point that reaches
  `scripts/ledger-append.mjs` without ever running `planner`, so unlike every other path nothing
  guaranteed the spec on disk belonged to the ticket being re-gated — concretely, a leftover
  `spec.json` from an unrelated prior ticket, sitting in `.pipeline/` during a `/re-gate` run, would
  have been copied into a durable, immutable ledger entry and attributed to it permanently. A
  stamp-freshness check alone would not have caught this specific case (that `spec.json` predates the
  stamp contract and reads `"unknown"`, not `"stale"`) — and, separately, a freshness check that
  compared against the tree *as it stands right now* would not generalize either: `spec.json` is
  documented elsewhere as trusted-fresh and non-refusing precisely because `dev`/`tester`/`review`'s
  own later edits routinely make it read stale against the whole-tree hash in a fully legitimate run,
  which is exactly the tree movement `/re-gate` exists for. Fixed with two independent checks in
  `scripts/ledger-append.mjs`'s `--re-gate` path, neither sufficient alone: a new, required
  `--ticket <id>` flag that the caller supplies and `main()` cross-checks against
  `extractTicketId(specJson.ticket)` (verifies *content* — the caller's own assertion of which ticket
  it believes it is re-gating, checked rather than trusted), and a requirement that `spec.json` carry
  *some* `stamp` field at all, presence-only rather than exact current-tree freshness (verifies
  *provenance* — that this pipeline's own tooling produced or touched the file at some point, rather
  than it being hand-dropped or left over from something else). `.sdd/pipeline.md`'s `/re-gate` step 1
  and `.claude/skills/re-gate/SKILL.md` now state this precondition explicitly, including that
  `/re-gate` never runs `planner` and so nothing else guarantees the match. 6 new
  `[re-gate]`/`[re-gate / spec integrity]` tests in `scripts/ledger-append.test.mjs` (3 pairing/
  validation refusals for `--ticket` itself, mirroring `--tester-ran`'s own; 3 for the spec-integrity
  checks: mismatch refuses, unstamped refuses, matching-and-stamped succeeds).
- **Critical 2 — two of the security stage's own mechanical gates had no CI step, and one had no test
  suite at all despite being changed this same round.** `test:security-audit-run` (a real, passing
  3-test suite) and `check:security-audit-agents` (the static-config validator over
  `security-attacker-agents/agent-registry.json` and its schemas — G1's A4 converted its `JSON.parse`
  to `parseJsonOrThrow` this same round) were both invoked by name in `.sdd/stages/security.md` but
  neither ran in CI; `validate-security-audit-agents.mjs` had no test suite whatsoever. A control that
  nothing runs is indistinguishable from no control. Fixed: added CI steps for both scripts (
  `check:security-audit-agents` runs directly, like `check:agent-shims`, since it validates committed
  static config, not a per-run artifact); added `scripts/validate-security-audit-agents.test.mjs`
  (`test:security-audit-agents`), covering A4's own change — a duplicate top-level key in
  `agent-registry.json` is rejected outright, not silently resolved to "last one wins," which would
  otherwise narrow which security-attacker briefs run without a diff reviewer reliably noticing.
  Corrected `.github/workflows/ci.yml`'s pre-existing comment, which claimed `test:security-audit-run`
  already ran in CI when it did not. Generalized `sdd-completeness.test.mjs`'s CI-wiring pin (added by
  pass 1's own C1 fix) from two suites named by literal string to one assertion enumerating every
  `scripts/*.test.mjs` file on disk and checking each has both a `package.json` `"test:*"` script and a
  matching `ci.yml` step — the pass-1 pin could only ever catch the two suites it already knew about;
  this one would have caught all three gaps above without anyone naming them individually.
- Smaller fixes folded in: `.sdd/ledger/README.md`'s "generated... from every `entry.md` on disk" claim
  corrected to `entry.json` (the file `build-ledger-index.mjs` actually reads — the same file already
  said so twice elsewhere); its `## Overrides` position sentence in "Hotfix bypass entries"'s sibling
  section corrected to match "Entry format"'s own, earlier statement and `buildEntryMarkdown`'s actual
  emission order (`## Verdicts` → `## Re-gate` when present → `## Overrides`); `.sdd/pipeline.md`'s
  "Staleness stamps" section's flat "every sidecar... carries a `stamp` field" hedged to name what
  actually guarantees it (each stage's own numbered procedure step, not a script-enforced invariant) —
  see that section's own note that `.pipeline/changes.json` shipped unstamped on this very contract's
  first real opportunity, in this same round, despite both the producer and the instruction already
  existing on disk at the time.

Verify: `node --test scripts/*.test.mjs` — 331/331 pass (was 321/321; +6 new `[re-gate]`/
`[re-gate / spec integrity]` tests in `ledger-append.test.mjs`, +3 in the new
`validate-security-audit-agents.test.mjs`, +1 new generalized CI-wiring test in
`sdd-completeness.test.mjs`, none removed). `npm run typecheck:scripts`, `npm run check:agent-shims`,
and `npm run check:ledger-index` all still pass.

## Review pass 3 (fix round, `fix/pl-04-pipeline-defects`)

Pass 3 returned `PASS` — both pass-2 blockers were re-verified genuinely closed (a fresh subject, not
revisited here) — with three Warnings and one already-partially-disclosed item. Full reproductions are
in `.pipeline/review.md`; this entry records what changed.

### Warning 1(a) — the stamp-presence check was described as a provenance check. It isn't one.

Four sites (`scripts/ledger-append.mjs:70-72`, its `main()` comment, its refusal message, and
`.sdd/ledger/README.md`'s "Re-gate entries" section) all said the required, present `stamp` field
"verifies the file was actually produced by this pipeline's own tooling... rather than being
hand-dropped." `scripts/pipeline-contracts.mjs`'s `readStamp` validated shape only (four fields,
correctly typed) — review proved the gap concretely: a hand-written `stamp` with `treeHash: "0"×64`,
`headSha: "0"×40` (values no real `git` invocation produces) was accepted, exit 0, entry written.

**Fix, in two parts, per review's own stated preference ("make the prose true," plus a cheap
plausibility check since one was genuinely available):**

- **Prose corrected** at all four sites (plus the parenthetical in `.claude/skills/re-gate/SKILL.md`
  and a new precondition paragraph in `.sdd/pipeline.md`'s `/re-gate` step 1) to state plainly that
  presence is a hygiene signal that the file went through the documented authoring path
  (`write-stamp.mjs`), not proof that it did — a stamp is four unauthenticated JSON fields, and a
  hand-written one of the right shape satisfies the check exactly as well as a genuine one. No signing
  scheme was built; none was asked for.
- **`readStamp` (`scripts/pipeline-contracts.mjs`) now also checks `treeHash`/`headSha` against the hex
  shape `buildStamp()` always produces** (64 / 40 lowercase hex characters, `headSha` alternatively the
  literal `"(none)"` no-`HEAD` fallback) — the same `/^[0-9a-f]{64}$/i` pattern `validateRedTest` already
  applies to `red.json`'s `sha256` field, applied here to the other two hash-shaped fields in this file.
  Stated precisely in the same doc comment: this is a SHAPE check, not a provenance one — it rejects an
  obviously-wrong value (`"unknown"`, a placeholder, the wrong length); it does not and cannot
  distinguish a hand-crafted-but-correctly-shaped stamp (review's own `"0"×64`/`"0"×40` example) from a
  genuine one. 4 new test rows in `pipeline-contracts.test.mjs` (2 rejecting malformed `treeHash`/
  `headSha`, 1 accepting the `"(none)"` fallback) plus 2 existing rows widened from single-character
  placeholders to full-length hex filler so they still fail for the field they were actually testing
  (`dirty`), not on the new, unrelated hex-format check.

### Warning 1(b) — the generalized CI pin's "would have caught all three gaps" claim covered one gap, not three.

`sdd-completeness.test.mjs`'s comment and `.sdd/stages/CHANGELOG.md`'s "Review pass 2" entry both
claimed the file-enumeration CI-wiring test "would have caught all three gaps above." Of pass 2's three
named gaps: (1) `test:security-audit-run` (a suite on disk, no CI step) — genuinely caught, since it is
exactly the shape the test enumerates; (2) `check:security-audit-agents` (a `check:*` script with no CI
step, not a `*.test.mjs` file) and (3) `validate-security-audit-agents.mjs` (no test suite at all) are
both structurally outside a walk over test files that already exist on disk — there is nothing there to
enumerate for either one.

**Fix:** narrowed the claim in both places to name exactly what's covered, and closed shape (3) for
real with a new test: every `"check:<suffix>"` script in `package.json` must have a matching
`"test:<suffix>"` script naming a real `scripts/*.test.mjs` file — the naming convention every existing
`check:*`/`test:*` pair in this codebase already follows (verified directly: temporarily removing
`test:security-audit-agents` from `package.json` reproduces the historical gap and this new test fails
with it, then the change was reverted). Shape (2) — a `check:*` script's own CI step, as opposed to its
test suite's — was deliberately NOT generalized the same way: `check:bounds`/`check:red-integrity`/
`check:security-audit-run`/`check:stamp-freshness` all legitimately have no CI step for their own
command (each validates a specific per-run/gitignored `.pipeline/` artifact that doesn't exist on a bare
checkout — confirmed directly: each one exits non-zero with a "missing required argument" error when run
with no arguments, except `check-red-integrity.mjs`, which exits 0 but checks nothing). A blanket rule
here would be wrong about four real scripts, not merely silent about a hypothetical one — narrowing the
claim rather than inventing a rule that misclassifies real, already-reviewed design decisions.

### Warning 2 / "the half-done path" — `--ticket` was never checked against `spec.md`, only `spec.json`.

`spec.md`, not `spec.json`, is what `scripts/ledger-append.mjs` copies verbatim into the ledger and what
`index.json`'s `spec` pointer resolves to (`.sdd/ledger/README.md`'s query path) — but `--ticket`'s
cross-check only ever read `spec.json`'s own `ticket` field. A matching, correctly-stamped `spec.json`
sitting beside a leftover `spec.md` from a different ticket passed every check that existed and filed
the wrong spec body under a right-looking ticket name — review rated this a Warning, not a Critical,
because the resulting entry contradicts itself in the open (`ticket`/`ticketTitle`/`goal` say the right
thing; the spec body's own heading says something else) rather than agreeing on a lie, but named it as
the minimal action that would otherwise clear the gate.

**Fix:** a new `extractTicketIdFromSpecMarkdown` helper (`scripts/ledger-append.mjs`) reads `spec.md`'s
own first-line heading and extracts its ticket id the same way `extractTicketId` already does for
`spec.json`'s `ticket` field — deliberately narrow (exactly one line, no heading/fence/comment ambiguity
to resolve), consistent with PL-03h round 4's "no markdown parsing for a control decision" principle
elsewhere in this file, since there is only one candidate line and no shadowing surface. `main()`'s
`--re-gate` path now refuses if this doesn't match `--ticket`'s value either, with its own dedicated
message naming both. 1 new `[re-gate / spec integrity]` test (Case B: a matching, stamped `spec.json`
next to a `spec.md` from a different ticket still refuses) plus a strengthening of the existing
"matching-and-stamped succeeds" test, which previously asserted only `status === 0` and directory
existence — the one test whose subject is attribution, and the one that didn't check it (review's own
Suggestion 1, folded in as a free byproduct of touching this same test file).

### Warning 3 — `/re-gate`'s `--ticket` had no documented way to be supplied, making the check circular in practice.

`.claude/skills/re-gate/SKILL.md`'s `argument-hint` was `[--gates-only]` — no `--ticket`. The only
on-disk candidate for an agent to derive a `--ticket` value from was `.pipeline/spec.json` itself, and a
value read off `spec.json` and then compared against `spec.json` is a tautology that refuses nothing —
defeating the entire point of Blocker 1's fix (an *independent* assertion) at exactly the moment it
matters.

**Fix:** `argument-hint` widened to `[--gates-only] [--ticket <id>]`; both `.claude/skills/re-gate/SKILL.md`
and `.sdd/pipeline.md`'s `/re-gate` step 1 now state explicitly, in a dedicated paragraph, that
`--ticket`'s value must come from the `/re-gate --ticket <id>` invocation itself — the caller's own,
independent knowledge of which ticket is being re-gated — and that deriving it by reading
`.pipeline/spec.json` and handing it back defeats the check. `.sdd/pipeline.md`'s command heading and
step 5 updated to match.

### Verify

```
node --test scripts/*.test.mjs
```
→ **334/334 pass** (was 331/331; +2 new rows exercised via `pipeline-contracts.test.mjs`'s existing
table-driven loop plus 1 new standalone test there — the `"(none)"` `headSha` acceptance case, +1 new
`[re-gate / spec integrity]` test in `ledger-append.test.mjs`, +1 new `check:*`/`test:*` pairing test in
`sdd-completeness.test.mjs`, none removed).

```
npm run typecheck:scripts    # tsc --noEmit -p scripts/tsconfig.json  → exit 0
npm run check:agent-shims    # all 7 shim(s) up to date
npm run check:ledger-index   # up to date (35 file(s), 1 run(s))
```

All green.

## Security-precondition round (fix round, `fix/pl-04-pipeline-defects`)

Security refused to run its own full check against this branch because `review.json`'s stamp was
stale — correctly (a stale `PASS` is not a passed gate). Three advisory findings surfaced while it
verified that staleness, none blocking on their own but all closed before re-gating. Full reasoning is
in `.pipeline/changes.md`'s own "Security-precondition round" section; this entry records what changed.

- **Finding 1 (the severe one) — `ledger-append.mjs` never checked the freshness of the verdicts it
  records.** Every check this script ran against `review.json`/`security.json` asked which ticket or
  which verdict, never whether the cited verdict was still current for the tree being attributed to
  it — a stale-but-`PASS` pair, left over from before a later, never-reviewed edit, could be recorded
  durably with a live-diff `filesTouched` list that gate never saw. Arguably the more severe version of
  exactly the problem `/re-gate` exists to solve, reachable without `--re-gate` at all: `/re-gate`'s
  procedure ("re-run the gates, then write the entry") was enforced only by prose, never by this
  script. Fixed: a new `refuseIfStale` helper runs `stampFreshness` against both sidecars'
  `stamp` fields, unconditionally and before either `--override-*` flag's own acceptance — refusing on
  `STALE` the same way `security.md` already refuses on a stale `review.json`. `spec.json` is
  deliberately exempt, per the same trusted-fresh/non-refusing reasoning `dev.md` already documents for
  it. 6 new `[freshness]` tests, using a new `realGitignoreFixtureRepo` fixture helper (the real
  `.gitignore`, not the default minimal one, is load-bearing here — see that helper's own comment for
  why the self-reference otherwise breaks the embedded-stamp fixtures).
- **Finding 2 — the read-only guard's temp allowance had an unguarded mirror case.** C4 (review pass 1)
  only ever guarded "checkout nested under the OS temp directory"; its mirror — the OS temp directory
  nested inside the checkout (`TMP`/`TEMP` pointed at a path under the repo) — reproduced identically,
  contradicting the file's own "still blocked exactly as before" header claim. Rated MEDIUM (an unusual
  host configuration) but the identical defect shape. Fixed symmetrically: the temp allowance now
  requires that *neither* root be nested inside the other. Scoping the allowance to a run-specific
  subdirectory, rather than the whole OS temp root, was considered and deliberately deferred (stated in
  the file's own header) — wider than needed, but nothing downstream reads from there. 3 new
  `[C4-mirror]` tests, using a new `invokeWithEnv` helper (this reproduction needs `TMP`/`TEMP`/
  `TMPDIR` set on the guard's own process, not just the JSON payload).
- **Finding 3 — an override entry was indistinguishable from a clean pass at a glance, and the docs
  overclaimed authority where only disclosure exists.** `buildEntryMarkdown` gave `--re-gate`/
  `--hotfix` entries a title marker but not an override; fixed with a new `(OVERRIDE)` marker
  (composing with `(RE-GATE)` when both apply). Separately, every site describing
  `--override-review`/`--override-security` (`ledger-append.mjs`'s own comments and messages,
  `.sdd/ledger/README.md`, `.sdd/pipeline.md`, `.claude/skills/re-gate/SKILL.md`) described this as
  recorded "on a human's own authority" — the same overclaiming-prose defect class as review pass 3's
  Warning 1(a) (its fifth instance this round, not a new class), since nothing here checks who invokes
  either flag. Corrected throughout to state this is a disclosure requirement, not an authorization
  check; no authorization scheme was built. Existing `[B2]`/`[re-gate]` tests extended with the new
  title-marker assertions rather than duplicated.

### Verify

```
node --test scripts/*.test.mjs
```
→ **343/343 pass** (was 334/334; +6 new `[freshness]` tests in `ledger-append.test.mjs`, +3 new
`[C4-mirror]` tests in `guard-checker-readonly.test.mjs`, none removed).

```
npm run typecheck:scripts    # tsc --noEmit -p scripts/tsconfig.json  → exit 0
npm run check:agent-shims    # all 7 shim(s) up to date
npm run check:ledger-index   # up to date (35 file(s), 1 run(s))
npx tsc --noEmit             # root — unaffected; still exit 0
```

All green.
