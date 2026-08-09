# Pipeline build — overnight handoff, 2026-08-04

Written for review on waking. Read the two **Read this first** items, then the rest as needed.

---

## Read this first

### 1. Neither gate has passed clean on this branch

`review` returned `NEEDS_FIXES` and `security` returned `BLOCKED`. Both findings were fixed and I
verified each fix independently and by hand. **Neither stage has been re-run since.** So the branch
is in "fixed but not re-gated" state, not "green".

`.pipeline/review.json` still records `NEEDS_FIXES` and `.pipeline/security.json` still records
`BLOCKED`, both stale. That is deliberate — I did not want to hand you a refreshed verdict I had
generated to make the state look finished. Re-run both before merging:

```bash
/pipeline
```

Concretely: 277/277 script tests pass, `tsc` is clean, all 7 shims are fresh. That is real evidence,
and it is not the same thing as a passing security gate.

### 2. Nothing has been tested against Codex

The cross-runtime claim — a Codex user gets the same methodology as a Claude Code user — has been
argued structurally in every review round and **never observed against a real Codex session.** It is
the headline claim of the whole effort and the weakest-evidenced thing here. Before Victor relies on
it, open the repo in Codex and run one trivial ticket end to end. It is the highest-value hour
available and it needs your seat, not mine.

---

## Where things are

| Branch | Contents | State |
|---|---|---|
| `feat/sdd-cross-runtime-foundation` | PL-03a, PL-03c | **PR #76**, open |
| `feat/tdad-impact-resolver` | PL-03b | **PR #77**, open, stacked on #76 |
| `fix/pl-03h-structural-extraction` | PL-03h, PL-03g, PL-03d, PL-03e, PL-03f, `/hotfix`, PL-03b merged and wired | Committed, **no PR** as instructed |

The third branch contains the other two, so reviewing it reviews everything. Four commits:
`49a4397`, `36c6a52` (merge), `5ca5eb2`, `a45ccc7`.

---

## The pipeline as it now stands

`planner → red → dev → tester → review → security`, then a ledger append on terminal PASS.
`pr-review` runs separately once a PR exists.

**Two human gates.** Victor approves a four-item plain-English Ticket Check at the top of `spec.md`
— *what I'm about to build · what I'm not doing · how you'll know it worked · what I had to guess* —
then it runs unattended to a PR you review.

**What is actually enforced**, as opposed to instructed:

| Control | Mechanism |
|---|---|
| Tests precede code | Ordering — `red` runs before `dev` exists. Structural, not a rule |
| Checker stages read-only | `PreToolUse` hook, scoped by `agent_type`, live-verified |
| Lane bounds | `check-bounds.mjs`, glob match — never an LLM's opinion |
| Red-test integrity, `@spec` trace | `check-red-integrity.mjs`, rehash + ID resolution |
| Control artifacts | Strict JSON parse rejecting duplicate keys |
| Shim freshness, ledger index | CI staleness gates |

The through-line: **everything that survived is either deterministic code or an ordering property.**
Every control that depended on an agent following an instruction, or on a runtime honouring a
declaration, failed when tested. That is the most useful thing this build produced.

---

## Decisions waiting for you

1. **PL-03i — the resolver's ranking is distorted by re-export barrels.** Changing
   `parsing/coverage.py` ranks its own test 6th at depth 3, behind an unrelated test at depth 2,
   because tests import via the `sayre_workers.parsing` package and every barrel hop inflates depth.
   The resolver works; the ranking misleads. Ticket opened, deliberately unfixed.
2. **`Bash` is still an unguarded write path for the checker stages.** A command allowlist was built
   and abandoned after four rounds found four bypass classes — decisively, `poetry run pytest`
   executes `conftest.py`, so one allowed command is arbitrary code execution. Options are dropping
   `Bash` from those stages (they lose the ability to run repros, which caught real bugs all night)
   or a read-only checkout. Recorded as a deferred control with its consequence stated, per D-016.
3. **One `JSON.parse` remains**, reading the git-tracked attacker registry. Documented in place as
   static config reviewed through a diff rather than per-run agent output. Defensible — a duplicate
   key there would change which checks run, and a diff reviewer might not notice.
4. **`.gitignore` carries a pre-existing `infra/*` hunk** that came along in PR #76, declared in
   that commit message. Not my work; it prevents committing secret-bearing infra scratch files.
5. **PL-03e's environment half is still gated on PL-02.** Victor cannot clone and run the repo yet:
   no Dockerfiles, Doppler by hand, `DEV_ORG_ID` seeding buried in an `.env.example` comment. The
   resolver also needs Python 3.12 + Poetry + Tree-sitter grammars, so even a frontend ticket drags
   in the Python toolchain. **This, not the methodology, is what blocks him starting.**

---

## Findings worth knowing

**Read-only enforcement never worked, and D-005 understated it by half.** Hooks declared in subagent
frontmatter never fire; only settings-file hooks do. So `review` and `security-checker` were
unenforced for `Write` as well as `Bash` — `CLAUDE.md` asserted a security property that had never
existed, in the file every agent reads first. Fixed and live-verified. Your own untracked
`docs/deep-audit-2026-07-31/audit-18-infra-cicd.md` had reached the same conclusion statically.

**Eight exploits, one shape.** Seven against the markdown parser (fenced blocks, HTML comments,
duplicate headings, ATX closing sequences, setext, inline markers, indented openers) and an eighth
against its JSON replacement (duplicate keys, last-wins). Every one produced the same outcome: a
durable ledger entry recording `review: PASS` for a run whose real verdict was `NEEDS_FIXES`. The
lesson is not about markdown — it is that **an unbounded ambiguity surface cannot be secured by
enumerating its bad inputs.** JSON was the right move only because its grammar is closed, which
makes a strict parser achievable where a strict markdown parser was not.

**The most instructive failure was a deleted test.** The JSON migration removed the duplicate-value
attack tests, justified by a code comment asserting "there is no second position in the JSON for an
appended block to occupy." Believed, never tested — so the round retired exactly the coverage that
would have caught the eighth exploit. Then the *fix* for that exploit was scoped to five sidecars and
missed the audit trail, and its regression tests missed the same file. **The gap in the fix was
mirrored by the gap in the tests meant to catch it, twice.** Both header comments that made this
invisible are now corrected.

---

## If you want to try it

```bash
/pipeline <github issue number>
```

`.sdd/README.md` is the entry point and doubles as Victor's documentation. `.sdd/bounds.yml` defines
lanes; a fenced lane cannot touch `.sdd/`, `.claude/`, CI, the guard, the bounds script, `.gitignore`,
`CLAUDE.md`, or `AGENTS.md` — it must not be able to widen its own fence.

The first real run will exercise paths nothing has: no run has yet produced a `red.json`, so
`check-red-integrity` has never had live input, and the ledger has one entry (PL-03a, migrated). Treat
the first ticket as a shakedown rather than production.
