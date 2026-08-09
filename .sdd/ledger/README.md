# Ledger

Populated as of PL-03c. Every completed pipeline run — one that reached a **terminal `PASS`** (both
`review.md` and `security-report.md` show `PASS`) — gets a durable, committed entry here. A run that
stops earlier (a loop-cap timeout, an abandoned ticket) writes no entry; see `.sdd/pipeline.md`'s
Stage sequence and Routing sections for exactly when this step runs.

## Why this directory exists

`.pipeline/` is gitignored except for its own `README.md` (see `.gitignore`), so every pipeline run
overwrites the previous run's `spec.md`, `changes.md`, `test-results.md`, `review.md`, and
`security-report.md`. That's intentional for the per-run scratch files — committing them would be
noise and merge conflicts — but it means the repo previously had no record that a run ever happened
once the next run started.

The ledger is the fix: one **committed** entry per completed run, distinct from the gitignored
working files it summarizes. The reasoning for *why this matters* (not just that it exists) is
worth restating here rather than only in `docs/sdd-tdad-design.md`: a run that reaches `PASS` at both
gates has, by construction, produced code that follows its spec. So **a bug found later in that code
means the spec was wrong or incomplete** — and the spec is the first artifact worth reading. Before
this ticket, that evidence was destroyed on a cadence of roughly one ticket; now it's permanent.

## What's here, per run

```
.sdd/ledger/<run-id>/
  spec.md      — verbatim copy of that run's .pipeline/spec.md at the moment it reached terminal PASS
  spec.json    — verbatim copy of that run's .pipeline/spec.json (PL-03h round 4 — see below)
  entry.md     — run metadata, human-facing (see "Entry format" below)
  entry.json   — the SAME run metadata, machine-facing and authoritative (see "entry.json is
                 authoritative" below) — scripts/build-ledger-index.mjs reads only this file
  red.json     — copy of that run's .pipeline/red.json, if one existed for this run
  changes.json — copy of that run's .pipeline/changes.json
  review.json  — copy of that run's .pipeline/review.json
  security.json — copy of that run's .pipeline/security.json
  security/    — copy of that run's .pipeline/security-history/<run-id>/ (round 3 — see below)
    manifest.json
    results.json
    report.md
```

### `entry.json` is authoritative (PL-03h round 4)

Every field `scripts/build-ledger-index.mjs` uses to decide whether a run may be indexed, and which
files it touched, now comes from `entry.json`, not from parsing `entry.md`'s markdown. This is not a
cosmetic rename — it is the architectural fix for a defect that survived three rounds of
markdown-parser patching (see `.pipeline/review.md`'s round-3 "On convergence" section and
`scripts/pipeline-contracts.mjs`'s own header for the full argument): a hand-rolled block scanner
tracking fenced-code-block and HTML-comment state closed one exploit per round and, at least once,
introduced a new instance of the same class in the process of closing the last one. `entry.json`
removes the ambiguity surface outright rather than narrowing it further — `JSON.parse` either
succeeds or throws, and `build-ledger-index.mjs`'s own reader validates the result strictly (required
keys present, the `verdicts` object byte-for-byte `{ "review": "PASS", "security": "PASS" }`, every
array actually an array) before a run is ever indexed.

`entry.md` is still written by `scripts/ledger-append.mjs`, from the exact same in-memory data used
to build `entry.json`, and remains the human-facing rendering of a ledger entry — nothing reads it
for a control decision anymore. `.sdd/ledger/20260731T230940936Z-90330fb19231-PR_DELTA-bf73ea/`'s
`entry.json` was backfilled by hand from that run's own `entry.md` (the exact same one-time migration
affordance `entry.md` itself already used, since that run predates both `ledger-append.mjs` and the
JSON sidecar contract) — see that file's own `_comment` field.

`entry.json`'s shape (an ordinary, non-`--hotfix` entry): `{ runId, date, ticket, ticketTitle, goal,
filesTouched: [...], verdicts: { review, security }, overrides: [...], bypass, regate, redTestPaths,
redAbsenceNote, securityRunId, commit }` (`scripts/ledger-append.mjs`'s `buildEntryJson` is the single
place this shape is assembled — see that function's own comment for every field). `runId` must equal
the entry's own directory name.

`verdicts.review`/`verdicts.security` must both be exactly the literal string `"PASS"` **unless this
is a sanctioned override entry** (see "Sanctioned override entries" below) — an override entry's
`verdicts` legitimately carries the gate's real, non-`PASS` value, alongside a non-empty `overrides`
array explaining why it was accepted anyway. `scripts/build-ledger-index.mjs`'s `readEntryJson` only
enforces the byte-for-byte `PASS`/`PASS` check when `bypass` is not `true` — see "Entry format" below
for why this is still checked byte-for-byte, not merely well-formed, on every entry the check does
apply to. A `--hotfix` entry (below) is the other, structurally different exception: it carries no
`verdicts` key at all.

**`<run-id>` is reused from the security run that produced this run's terminal `PASS`** — the same id
already at `.pipeline/security-history/<run-id>/`. This is deliberate, not a shortcut: security-checker
already refuses to reuse or overwrite a run id (`.sdd/stages/security.md`'s Required artifacts
section), so reusing that id here means a ledger entry inherits collision-safety for free instead of
a second script re-implementing timestamp+nonce uniqueness, and it makes a ledger entry and its
security run trivially correlatable — given either one, the other's path is the same string.

`scripts/ledger-append.mjs` writes `spec.md`/`entry.md` and copies `security/` on a terminal `PASS`,
re-verifying the precondition itself (it does not trust the caller's word that both gates passed)
before writing anything. `.sdd/ledger/20260731T230940936Z-90330fb19231-PR_DELTA-bf73ea/` is entry
#1 — PL-03a's own run, migrated by hand as part of PL-03c since it predates both the ledger and
`scripts/ledger-append.mjs` themselves; its `security/` subdirectory was backfilled in round 3 (see
that entry's own provenance note) from that same run's `.pipeline/security-history/` directory, so
the first ledger entry is complete rather than partial.

### `security/`: why a copy, not a move (round 3)

`.pipeline/security-history/<run-id>/` was, before round 3, the *only* copy of a completed security
audit — durable on whichever machine ran `security-checker`, but gitignored (see `.gitignore` and
`.pipeline/README.md`) and therefore lost the moment a worktree is wiped, exactly like every other
`.pipeline/` working file. For a product whose pitch is auditability, that made the security half of
"a run reached terminal `PASS`" the one part of the story with no durable, committed record — only
`spec.md`/`entry.md` (the review half) survived.

`scripts/ledger-append.mjs`'s `copySecurityHistoryIntoLedger()` closes that gap by **copying** (never
moving) `manifest.json`, `results.json`, and `report.md` into `.sdd/ledger/<run-id>/security/` in the
same step that writes `spec.md`/`entry.md`. Copy, not move, for a load-bearing reason:
`.pipeline/security-history/` is itself immutable and is where `findCompletedSecurityRun` (and
`.sdd/stages/security.md`'s own progress-baseline contract) looks up a *later* run's baseline —
removing it from `.pipeline/` the moment it's promoted here would break that lookup for the very next
security run. The two copies now serve different purposes: `.pipeline/security-history/<run-id>/` is
the live baseline source for future runs (ephemeral per machine, per `.gitignore`); `.sdd/ledger/<run-id>/security/`
is the durable, committed audit record for humans and the query path below.

The same overwrite guard the top-level run directory already has applies to `security/`
specifically: a second attempt to populate an already-existing `.sdd/ledger/<run-id>/security/`
refuses rather than overwriting, so neither an ordinary re-run nor a repeated backfill can silently
replace immutable audit history.

## Entry format

`entry.md` and `entry.json` carry the same information — one for humans, one for
`scripts/build-ledger-index.mjs` (see "`entry.json` is authoritative" above). For an ordinary
(non-`--hotfix`) run, `entry.md` uses exactly these headings, in this order, purely for human
legibility; nothing parses its markdown for a control decision anymore (`scripts/ledger-append.mjs`'s
`buildEntryMarkdown` is the single place this order is assembled — see that function's own comment).
`## Re-gate` and `## Overrides` are two sections this list originally omitted (**CORRECTED, review
pass 1**: this section used to say "exactly these headings" while actually listing only seven of the
nine a real, non-`--hotfix` `entry.md` always or conditionally carries — `## Commit` was missing too,
folded in below) — a `--hotfix` entry's headings are structurally different again; see "Hotfix bypass
entries" below rather than this list. The PL-03a migration (`scripts/ledger-append.mjs` didn't exist
yet) is a **one-time migration affordance**, not a general invitation to hand-author future entries —
every ordinary run's entry should come from `scripts/ledger-append.mjs` itself, which re-verifies its
own preconditions before writing anything. If a hand-authored entry is ever needed again, both
`entry.md` and `entry.json` must be authored, matching each other, and `entry.json`'s `verdicts` must
read exactly `{ "review": "PASS", "security": "PASS" }` — `buildIndex()` refuses to index (and
`--check` fails loudly on) any entry whose `entry.json` doesn't match that literally, so a
hand-authored entry can never claim a pass the tooling didn't itself verify:

- **Date** — the date the run reached terminal `PASS` (from the security run's own timestamp).
- **Ticket** — a short ticket id on its own first line (what `index.json` records), then the full
  spec title below it for human readers.
- **Spec Goal** — the one-line-or-so human-facing outcome, copied from that run's `spec.md`.
- **Files touched** — one repo-relative path per bullet, no other text on the line.
- **Verdicts** — `- review: <verdict>` followed by `- security: <verdict>`. For an ordinary run this
  is always `PASS`/`PASS` by construction, since that's the precondition for an entry existing at all
  — and, since review Warning 1, the one section `build-ledger-index.mjs` validates byte-for-byte
  rather than merely parses (for a non-`--hotfix` entry only — see "Sanctioned override entries"
  below for the one case where a real, non-`PASS` verdict legitimately appears here, alongside a
  `## Overrides` section explaining why). A `--hotfix` entry has no `## Verdicts` section at all — see
  "Hotfix bypass entries" below.
- **Re-gate** — present only when this run came through `/re-gate` (immediately after `## Verdicts`)
  — see "Re-gate entries" below for its content; absent entirely (not an empty heading) on every other
  run.
- **Overrides** — always present (immediately after `## Re-gate` when that section exists, otherwise
  immediately after `## Verdicts`) — one line per overridden gate, or an explicit "(none — both gates
  passed on their own; nothing here was overridden)" when nothing was — see "Sanctioned override
  entries" below. **The title line also carries an `(OVERRIDE)` marker whenever `overrides` is
  non-empty** (CORRECTED, security-precondition fix round: this was missing until this fix — an
  overridden entry's title read as the bare `# Ledger entry — <runId>`, indistinguishable at a glance
  from a genuine clean pass, even though the body's own `## Overrides` section was always honest) — the
  same visible-at-a-glance treatment `(RE-GATE)`/`(HOTFIX BYPASS)` already get. Composes with `(RE-GATE)`
  when both apply (`# Ledger entry — <runId> (RE-GATE) (OVERRIDE)`), in that order.
- **Red-test paths** — the test paths `red.md` listed for this run, or an explicit statement of why
  there are none (predates the `red` stage, or `red` genuinely produced nothing) — never left blank.
- **Security run ID** — `.pipeline/security-history/<run-id>/`, restated even though it's also the
  directory name, so a reader doesn't have to infer the convention to find it. (Round 3: that
  directory's `manifest.json`/`results.json`/`report.md` are also copied into this same run's own
  `security/` subdirectory — see "What's here, per run" above — so this bullet's path and the local
  `security/` copy describe the same audit run from two different vantage points, not two different
  runs.)
- **Commit** — the commit SHA the security run audited (from that run's own `manifest.json`), with a
  parenthetical note when the worktree was dirty at that moment (the commit that actually lands the
  work may differ once it's committed) — the last section, always present.

## Hotfix bypass entries (D-005 #3, `/hotfix`)

`scripts/ledger-append.mjs --hotfix` writes a different kind of entry — see `.sdd/hotfix.md` for the
eligibility gates, and `.claude/skills/hotfix/SKILL.md` for the command. A hotfix never ran planner,
red, dev, tester, review, or security, so its `.sdd/ledger/<run-id>/` directory looks structurally
different from every entry described above:

- **No `spec.md`/`spec.json`.** There is no spec — that is the entire point of a bypass.
- **No `security/` copy.** There is no security run to copy.
- **`entry.json` carries `"bypass": true` with no `verdicts` object at all** (unlike a sanctioned
  override entry, below, which carries both a real `verdicts` object and `bypass: true` together —
  a hotfix never ran review/security in the first place, so it has no verdicts to carry), plus
  `whatBroke`, `whatChanged`, `whyPipelineSkipped`, `notVerified`, and `followUpTicket` —
  `.sdd/hotfix.md`'s four non-negotiable disclosures plus the required follow-up ticket reference.
  `ticket` holds that same follow-up ticket reference, so the field every other entry.json requires
  still has something real in it.
- **`entry.md` is headed `(HOTFIX BYPASS)`** and opens with a `## Bypass` section stating plainly
  that this is not a completed run, so a human skimming `.sdd/ledger/` can never mistake it for one.

**The one property that actually matters: `build-ledger-index.mjs` excludes a bypass entry's files
from `index.json`'s file→spec map entirely** — `bypass: true` is the stamp it reads to skip both the
`spec.md`-must-exist check and the indexing step for that run. This is deliberate and stronger than
merely labeling the entry: a hotfix-touched file must never appear in `index.json[<file>]` at all,
because if it did, a caller asking "which spec governs this file" could receive a bypass entry back
and mistake the *absence* of a spec for the *presence* of one — exactly the confusion `.sdd/hotfix.md`
says a bypass entry "must never be confusable" with. A hotfix's own directory (`entry.md`/
`entry.json`) is still real and discoverable — by `git log`, by listing `.sdd/ledger/`, or by
grepping for `"bypass": true` — just never through the buggy-file→governing-spec query path below.

## Sanctioned override entries (PL-04 / B2, B3, `--override-review` / `--override-security`)

`scripts/ledger-append.mjs --override-review "<reason>"` and/or `--override-security "<reason>"`
write a normal (non-`--hotfix`) entry for a run whose real, terminal `review.json` and/or
`security.json` verdict was `NEEDS_FIXES`/`BLOCKED` — recorded anyway, durably, and disclosed, for a
stated reason, because that is what actually happened and is worth keeping rather than letting it
vanish the way every non-`PASS` terminal run did before this flag existed (`ledger-append.mjs`'s own
"Sanctioned overrides" section states the motivating incident: "there was no sanctioned way to say
'proceed anyway,' so the override happened by hand-editing a subagent prompt instead... An override
that is easier to use than to record is the same failure again"). Unlike `--hotfix`, the pipeline DID
run: there is a real `review.json`/`security.json` from an actual review/security pass, and (unlike a
hotfix) an override entry still copies `spec.md`/`spec.json`/`red.json`/`changes.json`/`review.json`/
`security.json` and the `security/` audit history into the ledger, exactly like an ordinary `PASS`
run — the one thing that changes is index exclusion (below).

**CORRECTED (security-precondition fix round, this branch):** the paragraph above, `ledger-append.mjs`'s
own comments, and its two refusal messages used to describe this as recorded "on a human's own
authority" — language implying an authorization check. There is no such check: nothing here verifies
who invoked either flag, so any agent or human with shell access to this repo can supply one. What this
mechanism actually is, and all that is claimed here, is **disclosure**: the reason is permanently
recorded and the resulting entry is visibly marked (see "Entry format" above), not silently
indistinguishable from a clean pass. It is not a control over who may accept a non-PASS verdict, only a
guarantee that doing so leaves a durable, legible trace. No authorization scheme was built, and none is
implied by this section.

Each flag requires its own non-empty reason string in the same command — "no reason, no override," by
design. Passing `--override-review` (or `--override-security`) with no value, or an empty or
flag-shaped one, fails closed rather than silently accepting it. Either, both, or neither flag may be
supplied independently; a flag is only recorded as "used" (and only appears in `overrides`, below) if
that specific gate's own verdict actually was not `PASS` — passing it against an already-`PASS` gate
is inert, not an error, since there was nothing on that gate to override.

- **`entry.json`** carries an `overrides` array — always present (`[]` when nothing was overridden,
  the same "say something explicit" convention `redTestPaths`/`regate` already use below), one entry
  per overridden gate:
  ```
  "overrides": [ { "gate": "review" | "security", "verdict": "NEEDS_FIXES" | "BLOCKED", "reason": "<the reason string supplied on the command line>" } ]
  ```
  `entry.json` also still carries a `verdicts` object with the gate's real, non-`PASS` value — an
  override entry does not pretend the verdict was `PASS`; it records what actually happened plus the
  reason it was accepted anyway. `verdicts` and `overrides` are both real here, together, which is
  what structurally distinguishes an override entry from a `--hotfix` entry (above): a hotfix has no
  `verdicts` object at all, because it never ran review/security to produce one.
- **`entry.json`'s `bypass`** is `true` whenever `verdicts.review`/`verdicts.security` are not BOTH
  literally `"PASS"` — derived from the verdicts themselves, the exact same field and derivation a
  `--hotfix` entry's `bypass: true` uses (`buildEntryJson`), not a second, parallel flag. This is what
  excludes an override entry's files from `index.json`'s file→spec map, below (same mechanism, same
  section) — a non-`PASS` run never had its spec ratified against the final tree, so "which spec
  governs this file" must not resolve to it, the same reasoning `.sdd/hotfix.md` states for a hotfix.
- **`entry.md`** carries a `## Overrides` section, always present — immediately after `## Re-gate`
  when that section exists (an override and `--re-gate` may compose freely, below), otherwise
  immediately after `## Verdicts` (see "Entry format" above, and `buildEntryMarkdown`'s actual emission
  order, for this same statement): one line per overridden gate (`- review: actual verdict was
  NEEDS_FIXES, accepted anyway. Reason: <reason>`), or `(none — both gates passed on their own; nothing
  here was overridden)` when the `overrides` array is empty — an empty section here is itself a
  positive, checkable claim, not silence a reader has to interpret.

An override and `--re-gate` (below) may compose freely on the same command — when they do, `bypass:
true` comes from the override (the verdicts were not both `PASS`), never from `regate`, and the entry
is excluded from `index.json` on that basis; `regate`'s own disclosure is still carried on the entry
regardless, since the two concepts are orthogonal (`ledger-append.test.mjs` covers this precedence
directly, tagged `[re-gate]`).

## Re-gate entries (PL-04, `/re-gate`)

`scripts/ledger-append.mjs --re-gate --tester-ran <true|false> --ticket <id>` writes a normal,
non-bypass entry — see `.sdd/pipeline.md`'s `/re-gate` section for the eligibility and preconditions
(there is nothing here for `--hotfix`'s barred-path/lane checks to apply to, since `--re-gate` still
requires `review.json`/`security.json` to both show `PASS`, exactly like a plain run; it is not a
bypass of those checks). The point of `--re-gate` is not to relax anything — it is to record,
permanently, that the tree these two `PASS` verdicts describe was hand-edited outside `dev`'s own loop
before this run, and whether `tester` was re-run against that edit or skipped (`--gates-only`).

**`--ticket <id>` (PL-04 review pass 2 / Critical 1) is required** and is checked, not merely
recorded: `/re-gate` is the one entry point that reaches this script without `planner` having just
run, so nothing else guarantees `.pipeline/spec.json` on disk describes the ticket actually being
gated. Its value must come from the `/re-gate --ticket <id>` invocation itself — the caller's own,
independent assertion of which ticket they believe they are re-gating — never derived by reading
`.pipeline/spec.json`'s `ticket` field and echoing it back here: a `--ticket` sourced from the very
file it is being checked against makes the cross-check a tautology that refuses nothing (see
`.sdd/pipeline.md`'s `/re-gate` section and `.claude/skills/re-gate/SKILL.md`, both of which now say
this explicitly).

`main()` runs three checks, each a refusal, none of them sufficient alone:

1. **`extractTicketId(specJson.ticket)` must equal `--ticket`'s value.** `/re-gate` is the one entry
   point that reaches this script without `planner` having just run, so nothing else guarantees
   `.pipeline/spec.json` on disk describes the ticket actually being gated.
2. **`extractTicketId` over `spec.md`'s own first-line heading must ALSO equal `--ticket`'s value**
   (PL-04 review pass 3 / Warning 2). Check 1 alone is not enough: `spec.md` — not `spec.json` — is
   what gets copied verbatim into the ledger and what `index.json`'s `spec` pointer resolves to (see
   "The query path" below), so a `spec.json` that names the right ticket sitting beside a `spec.md`
   left over from a different one would pass check 1 and still file the wrong spec body under the
   right-looking ticket name. This check closes that gap.
3. **`spec.json` must carry a `stamp` field at all** (see "Staleness stamps" in `.sdd/pipeline.md`) —
   presence and shape, not exact freshness against the tree right now, since `spec.json` is documented
   elsewhere as trusted-fresh and routinely reads stale in a fully legitimate run. **This is a hygiene
   signal, not a provenance guarantee** (CORRECTED, PL-04 review pass 3 / Warning 1a, from this
   section's own prior wording): a `stamp` is four unauthenticated JSON fields (`treeHash`, `headSha`,
   `dirty`, `writtenAt`); `readStamp` (`scripts/pipeline-contracts.mjs`) checks that they are present,
   correctly typed, and — as of this same fix — that `treeHash`/`headSha` are hex strings of the length
   `buildStamp()` actually produces. That last check rejects an obviously-wrong shape (e.g. `treeHash:
   "unknown"`); it does not, and cannot, prove the file was genuinely produced by
   `scripts/write-stamp.mjs` rather than hand-written to the same shape — there is no signature or
   secret behind it. Checks 1 and 2 verify content (which ticket); check 3 verifies only that the file
   at least carries the shape its documented authoring path always attaches.

None of the three checks alone would have been enough: a stamp-freshness check alone cannot tell a
*wrong* spec from a *stale* one (a mismatched spec.json against an otherwise-unmoved tree still reads
"fresh"); ticket identity against `spec.json` alone says nothing about whether `spec.md` agrees; and
presence/shape of a `stamp` says nothing about which ticket the file is about. All three are refusals,
not warnings — a `/re-gate` run that fails any one of them writes nothing.

A re-gate entry has the exact same shape as a normal completed run (`spec.md`, `spec.json`,
`entry.md`, `entry.json`, the JSON sidecars, and the `security/` copy — see "What's here, per run"
above), **plus**:

- **`entry.json`** carries an additional `regate` object:
  ```
  "regate": { "testerRan": true | false, "gatesOnly": false | true,
              "note": "code was changed in the working tree outside the pipeline's dev stage before
                       this run; changes.md/changes.json describe the tree as it stood before that
                       edit" }
  ```
  `testerRan` and `gatesOnly` are exact inverses of each other by construction — both are recorded,
  rather than just one, so a reader never has to infer one from the absence of the other.
- **`entry.md`**'s title line reads `# Ledger entry — <runId> (RE-GATE)` (visibly distinct at a
  glance, the same reasoning `(HOTFIX BYPASS)` uses below, though a re-gate entry — unlike a hotfix
  — really did pass both gates), and carries a `## Re-gate` section, placed immediately after
  `## Verdicts`, stating plainly that the gates were re-executed against a tree hand-edited after
  `changes.md` was written, and whether `tester` ran on this pass or was skipped via `--gates-only`.
- **`index.json`** carries the same disclosure too (PL-04 / item 3), condensed: every record
  `build-ledger-index.mjs`'s `buildIndex()` writes for a re-gated run's files gets an additional
  `"regate": { "testerRan": true | false }` field alongside `runId`/`ticket`/`date`/`spec` — small on
  purpose (a query index, not a record), so it deliberately drops `gatesOnly` (the exact inverse) and
  the fixed `note` string. Absent entirely (not `null`) from an ordinary run's records.

A re-gate entry is **not** excluded from `index.json`'s file→spec map the way a hotfix entry is —
`review`/`security` genuinely ran against the current tree and produced a real `PASS`, so
`.sdd/ledger/<run-id>/spec.md` genuinely is the spec that tree was reviewed against, and a later
"which spec governs this file" query should be able to find it. What the `regate` field adds is
disclosure, not exclusion: a reader auditing this entry later can see, from `entry.json` alone,
that the tree passed review through a re-gate rather than through `dev`'s ordinary loop, and whether
that re-gate re-ran tester — the fact this ticket exists to make impossible to hide, not a reason to
hide the entry itself. And, since PL-04 / item 3, that same disclosure is visible one hop earlier,
directly in `index.json`'s own record — a reader following the fast path (buggy file -> index.json)
sees the attribution is qualified, and whether `tester` ran, without a second lookup into
`entry.json` at all; before this fix, only that second lookup could reveal it, which in practice
meant nobody did.

## Lite-lane entries (PL-11, `/pipeline-lite`)

`node scripts/ledger-append.mjs --lite` writes a normal, **non-bypass** entry — see
`.sdd/pipeline.md`'s `/pipeline-lite` section for the full lane (eligibility gate → `planner` →
`dev` → `tester` → `review` → this step, deliberately skipping `red` and `security`) and the
preconditions this command re-checks before writing anything.

**Indexed, not excluded — the same reasoning `.sdd/ledger/README.md` already makes for a `--re-gate`
entry, above.** A lite run has a real, ratified `spec.md`/`spec.json` that `review` genuinely passed
against the final tree — the same fact that keeps a `--re-gate` entry out of the exclusion mechanism.
What it does *not* have is a `security` pass, and that is disclosed on the entry itself (below), not
handled by hiding the entry from `index.json`'s file→spec map. Excluding it would answer "which spec
governs this file" with silence when a real, reviewed spec exists — the opposite of what a
`--hotfix`/override entry's exclusion is for (a run whose spec was never ratified, or whose final
verdict was not `PASS`, genuinely has nothing to point at).

`entry.json`'s exact shape for a lite run:

```json
{
  "verdicts": { "review": "PASS", "security": "SKIPPED_LITE" },
  "bypass": false,
  "regate": null,
  "lite": {
    "skippedStages": ["red", "security"],
    "note": "<the fixed lite disclosure sentence>",
    "eligibility": { "fileCount": 2, "changedLines": 37, "maxFiles": 5, "maxChangedLines": 150 }
  },
  "redTestPaths": [],
  "redAbsenceNote": "<states red was deliberately skipped by the lite lane>",
  "securityRunId": null
}
```

`verdicts.security` is the distinct literal `"SKIPPED_LITE"` — never `"PASS"` (a stage that did not
run cannot have passed) and never `"BLOCKED"` (nothing ran to block). `scripts/build-ledger-index.mjs`'s
verdicts gate widens by exactly this one shape: `{ "review": "PASS", "security": "SKIPPED_LITE" }` is
accepted **only** from an entry that also declares a `lite` object whose `skippedStages` includes
`"security"` — every other non-bypass entry still enforces the byte-for-byte `{ "review": "PASS",
"security": "PASS" }` check, unchanged. An entry claiming `"SKIPPED_LITE"` with no `lite` object, or
one whose `skippedStages` omits `"security"`, is a non-lite entry attempting to launder a skipped gate
into an indexed one — `build-ledger-index.mjs` refuses to index it, and `--check` fails loudly rather
than reporting the index as up to date.

`entry.md`'s title reads `# Ledger entry — <runId> (LITE)` (markers compose `(RE-GATE)(LITE)
(OVERRIDE)`, in that order, when more than one applies — though `--lite` refuses `--re-gate` outright
in this ticket, so `(RE-GATE)(LITE)` together does not currently occur), and carries a `## Lite lane`
section, placed immediately after `## Verdicts`, naming the skipped stages, the fixed disclosure note
verbatim, and the eligibility numbers this run was measured against. `## Security run ID` reads
`(none — the security stage did not run on this lane; see "## Lite lane" above)` rather than pointing
at a security-history directory that does not exist for this run.

**`index.json`** carries the same disclosure, condensed the same way `regate: { testerRan }` already
is: every record `build-ledger-index.mjs`'s `buildIndex()` writes for a lite run's files gets an
additional `"lite": { "skippedStages": [...] }` field alongside `runId`/`ticket`/`date`/`spec` —
small on purpose (a query index, not a record), so it deliberately drops `note`/`eligibility`, the
entry.json-only detail. Absent entirely (not `null`) from every non-lite run's records — so a reader
following the fast path (buggy file → `index.json`) sees the attribution is qualified without a
second hop into `entry.json`, the same reasoning `regate` already uses.

**What a lite entry structurally lacks**, compared to a normal completed run: **no `security/`
copy** (there is no security-history run to copy), **no `security.json`** (even a leftover one on
disk is deliberately never copied into the run directory — a lite run's own directory must never
manufacture evidence of a security pass that did not happen), and **no `red.json`** (same reasoning —
a leftover `red.json` from a prior ticket is never copied and never contributes to this run's
`redTestPaths`). `spec.md`/`spec.json`/`changes.json`/`review.json` are copied exactly as for a
normal run.

An ordinary lite run's `bypass` is `false` (derived the same way every other entry's is: `false`
exactly when `reviewVerdict` is `'PASS'` — the lite lane's own missing security verdict does not by
itself force `bypass: true`, since there is nothing to have failed on that gate). `--lite
--override-review` still produces `bypass: true` and is excluded from `index.json` exactly like any
other override — the lite disclosure survives on the entry regardless, orthogonal to the override the
same way `regate` and an override already compose freely.

## The query path: buggy file → spec that mandated it

```
a file misbehaves
  → .sdd/ledger/index.json[<that file's repo-relative path>]
  → one or more { runId, ticket, date, spec, regate? } entries
  → read .sdd/ledger/<runId>/spec.md — the spec the code was actually reviewed and merged against
```

`regate` (see "Re-gate entries" above) is present only on a record from a `--re-gate` run — its
absence on a given record means that run's `PASS` came from `dev`'s ordinary loop, not a hand-edit
re-gated after the fact.

This is the file-granularity version of the `symbol_to_spec.yml` mapping D-005 records Sayre as
lacking, and the answer to "which code realizes PRD §4.5?" that D-005 separately notes is otherwise
approximately what Sayre sells. `index.json` is **generated, never hand-edited** —
`scripts/build-ledger-index.mjs` regenerates it from every `entry.json` on disk (see "`entry.json` is
authoritative" above — `entry.md` is existence-checked only, never parsed); `--check` is the CI
gate that fails if it's stale (same contract as `scripts/generate-agent-shims.mjs --check`).

## Growth, stated rather than solved

Each entry was, through round 2, a small markdown spec plus a short metadata file — cheap per run.
Round 3's `security/` copy changes that arithmetic: `results.json` in particular can run tens of
kilobytes per run (PL-03a's is ~45 KB), so a completed run's ledger footprint is now dominated by the
security artifacts, not `spec.md`/`entry.md`. Nothing here prunes or archives old entries either way.
Worth watching as the ledger accumulates; not a problem this ticket solves (see
`docs/sdd-tdad-design.md`'s open questions for the related question of whether a run that never
reaches `PASS` should also get an entry — currently it does not).
