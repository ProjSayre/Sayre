# `.sdd/` — the pipeline methodology, runtime-neutral

This directory is the single source of truth for Sayre's five-stage delivery pipeline
(`planner` → `dev` → `tester` → `review` → `security`). Any AI coding tool that can read files in
this repository — Claude Code, Codex, Cursor, or anything else — reads the same methodology from
here. There is no second, tool-specific copy of *what each stage does*.

If you've never touched this pipeline before, read `.sdd/pipeline.md` first (the stage sequence and
the four ways to invoke it), then whichever `.sdd/stages/*.md` file matches the stage you're
running. That's genuinely enough — these files are written to be understandable without knowing
what a Claude Code subagent, hook, or Codex sandbox is.

## Why this exists

Before this directory existed, the pipeline's instructions lived in three places that had already
drifted apart: a Claude Code copy (`.claude/agents/`, `.claude/skills/`), a Codex copy
(`.codex/agents/`), and a skills copy (`.agents/skills/`). Two concrete examples of the drift:

- The Codex copy of the security stage was 13 lines of prose paraphrase; the Claude Code copy was
  99 lines with a registry, checklist IDs, `UNVERIFIED` semantics, a content-hashed manifest, and an
  untrusted-evidence clause. Anyone running the pipeline through Codex got a materially weaker
  security gate that still printed `PASS`.
- The two `pipeline` skill definitions disagreed on who persists the review verdict — one had the
  reviewing agent write `.pipeline/review.md` itself, the other had the coordinator save the
  returned markdown. Same intent, silently different contracts.

Both problems are the same root cause: the methodology was copied instead of shared. `.sdd/` is the
fix — write it once, generate or point to it everywhere else.

The full drift audit — every difference found between the Claude Code, Codex, and skills copies
before the latter two were deleted — is recorded in `docs/sdd-drift-corrections-pl-03a.md`, kept
there rather than only in the (gitignored, overwritten-per-run) `.pipeline/changes.md`.

## What lives here vs. what lives in `.claude/`

The split follows one rule: **if it's true regardless of which tool is running the pipeline, it
belongs in `.sdd/`. If it depends on the specific tool, it belongs in that tool's own config.**

| Lives in `.sdd/` (neutral, every runtime) | Lives in `.sdd/runtimes.yml` → generated into `.claude/` |
|---|---|
| Required inputs and read order | Tool grants |
| Procedure and checks | Model tier |
| Output contract and section names | Hook wiring (attempted for read-only enforcement; see note below — not currently load-bearing) |
| Verdict vocabulary (`PASS` / `NEEDS_FIXES` / `BLOCKED` / `UNVERIFIED`) | Subagent name |
| Which `.pipeline/` artifact is produced | Whether a subagent writes that artifact directly, or a coordinator saves it |

Concretely: `.sdd/stages/review.md` says *"produce a report in this shape; it is persisted to
`.pipeline/review.md`"* and stops there. It does not say whether a Claude Code subagent writes
that file directly (it does) or a Codex-style coordinator saves the subagent's returned markdown
(because Codex has no subagent-isolation equivalent at all). Both are the same contract; the
mechanism is runtime detail and lives in `.sdd/runtimes.yml`. Neither runtime currently confines
that write to `.pipeline/` with a runtime-enforced guard — see the note under "The only generated
surface" below.

## Directory map

```
.sdd/
  README.md          — this file
  pipeline.md         — stage sequence, routing, loop caps, and the four entry-point commands
  runtimes.yml         — per-stage tool grants / model tier / hook wiring for .claude/
  bounds.md            — named lane vocabulary (defined only — nothing enforces it yet, see below)
  stages/
    planner.md
    dev.md
    tester.md
    review.md
    security.md
  ledger/
    README.md          — entry format for a future committed run history (empty — nothing writes here yet)
```

## The only generated surface: `.claude/`

`.claude/agents/*.md` are generated, not hand-authored. `scripts/generate-agent-shims.mjs` reads
`.sdd/runtimes.yml` and writes each stage's frontmatter (tools, model, hooks, subagent name) plus a
fixed one-line body pointing at the matching `.sdd/stages/*.md` file. Never hand-edit a file under
`.claude/agents/` — edit `.sdd/runtimes.yml` (for wiring) or the matching `.sdd/stages/*.md` (for
procedure) and regenerate:

```sh
node scripts/generate-agent-shims.mjs            # writes .claude/agents/*
node scripts/generate-agent-shims.mjs --check    # exit 1 + diff if any shim is stale (CI runs this)
node scripts/generate-agent-shims.mjs --force    # overwrite even a shim with uncommitted changes
```

Regeneration normally refuses to overwrite a shim with uncommitted changes (protects a real
hand-edit from being silently clobbered) — but that same guard also blocks the ordinary iteration
loop of editing `runtimes.yml`, regenerating, and editing `runtimes.yml` again before committing.
`--force` is the escape hatch for that case; it never overrides the separate "neutral file doesn't
exist" failure.

`.claude/` survives as a real, checked-in directory (rather than being deleted like `.codex/` and
`.agents/` were) because it's the one runtime here with subagent isolation actually worth wiring —
`review`/`security-checker` run in their own context, separate from whatever `dev` was just doing.

**Note on hook enforcement (corrected, PL-03a loop 3):** earlier revisions of this document, and of
`.claude/agents/review.md`/`security-checker.md` themselves, claimed Claude Code "enforces this
stage is read-only structurally" via a `PreToolUse` hook. A diagnostic run established that a hook
declared in subagent frontmatter — the only place one was ever wired here — never actually fires on
this checkout; only a hook declared under a top-level `hooks:` key in `.claude/settings.json` does,
and this repo's `settings.json` has none. So neither runtime currently has a working structural
read-only guarantee for these two stages: Claude Code's hook was declared but inert, and Codex never
had an equivalent at all. "Read-only" is, for both runtimes today, an instruction honored by
convention and checked afterward (diff inspection at review time, CI) — not an enforced guarantee.
Real enforcement is tracked as `PL-03g` (`docs/PRD_Tickets.md`), whose first question is whether a
settings.json-level hook can even be scoped to one subagent without also blocking `dev`.

`.claude/skills/*/SKILL.md` (the four entry-point commands — `/pipeline`, `/spec-only`,
`/pipeline-status`, `/security-recheck`) are hand-authored but intentionally thin: each one points
at its matching section of `.sdd/pipeline.md` rather than restating the procedure.

## Accepted costs of this design (recorded so they're recoverable, not forgotten)

Paring the pipeline down to `.sdd/` + `AGENTS.md` + `.claude/` (deleting the Codex and skills
mirrors rather than also generating them) has two real costs:

1. **Loses `sandbox_mode = "read-only"` on the Codex security stage** — a runtime-boundary
   enforcement that would have been structurally stronger than anything Claude Code has for this
   today, now that PL-03a loop 3 established Claude Code's own hook was declared but never actually
   fired here. This is consistent with a standing principle of this design: cross-runtime guarantees
   are verification-based, not enforcement-based, because not every runtime has hooks — and, as it
   turned out, the one that nominally does didn't get one working for this property either. Nothing
   about the red-hash, spec-trace, or bounds checks planned for later tickets depends on this. Real
   enforcement for the Claude Code side is tracked as `PL-03g`.
2. **Loses per-stage context isolation in Codex.** A Codex run executes `.sdd/stages/*.md`
   sequentially in one continuous context, so its `review` stage shares context with whatever
   `dev` was just thinking, and is weaker for it. This is the real loss — see
   `.sdd/pipeline.md`'s "Running stages in a single context" section for what a coordinator without
   subagent isolation has to do by discipline instead. Re-adding a `.codex/agents/` directory later
   restores real isolation without changing anything in `.sdd/`.

Whether losing per-stage isolation degrades review quality enough to justify re-adding it is an
open question, worth watching on the first several real runs rather than deciding up front.

## What's here and what's deliberately not (yet)

This directory currently covers the five existing stages and nothing past them. Specifically **not**
in scope here, even though `docs/sdd-tdad-design.md` describes them as later steps of the same
design:

- **No `red` stage.** The stage sequence is still `planner → dev → tester → review → security`,
  not `planner → red → dev → tester → review → security`.
- **No `pr-review` agent**, and nothing in this repository enforces `.sdd/bounds.md`'s lane
  vocabulary yet — that file defines names and path globs only.
- **No impact resolver** (`get_affected_tests` / `affected_tests.py`).
- **No ledger population.** `.sdd/ledger/README.md` defines the entry format a future ticket will
  write; nothing writes an entry today.

These land in follow-on tickets (tracked as PL-03b/c/d in the design doc). Building this foundation
first is what unblocks them without requiring another rewrite of the stage files.

## For more context

`docs/sdd-tdad-design.md` is the full design document this directory implements the first section
of (Section 1, "Cross-runtime foundation"). Read it if you want the reasoning behind a decision
that isn't repeated here — this README stays intentionally shorter than that document.
