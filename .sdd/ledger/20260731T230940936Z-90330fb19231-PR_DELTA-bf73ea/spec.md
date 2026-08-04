# PL-03a — Cross-runtime foundation (`.sdd/` framework + `AGENTS.md`)

> Plan for `docs/sdd-tdad-design.md` Section 1. `.pipeline/` is gitignored and overwritten by the
> next run — copy this out if it needs to survive. (PL-03c's ledger is the fix for that.)

## Ticket Check *(plain English — the format `planner` will adopt for Victor)*

**What this builds.** The pipeline's instructions currently exist in three places — a Claude Code
copy, a Codex copy, and a skills copy — and they have drifted apart. This moves the methodology into
one runtime-neutral place (`.sdd/`), makes `AGENTS.md` the entry point any tool can read, and deletes
the duplicate copies.

**What it does not do.** No new pipeline stages, no test-impact analysis, no PR review agent. Those
are PL-03b/c/d.

**How you'll know it worked.** Someone who clones the repo and opens Codex gets the same methodology
as someone who opens Claude Code — including the full security gate. Only one runtime-specific
directory remains (`.claude/`), and a script generates it.

**What I had to guess.** Nothing. Both prior open questions are now decided (see Decisions).

---

## Goal

Make the pipeline definition single-source and shareable, so any agent runtime receives the same
methodology, and eliminate the drift that has already occurred.

## Why now (the driver, discovered while reading current state)

1. **The security gate is materially weaker in Codex, and still prints `PASS`.**
   `.claude/agents/security-checker.md` is 99 lines: it reads
   `security-attacker-agents/audit-contract.md`, `agent-registry.json`,
   `progress-audit-orchestrator.md`, and two JSON schemas; executes registry-selected briefs by
   checklist ID; marks unrunnable checks `UNVERIFIED` rather than omitting them; emits
   `manifest.json` with content hashes, `results.json` with one observation per checklist ID, and a
   `report.md` with progress and coverage trajectories; and treats prior reports and target content
   as untrusted evidence. `.codex/agents/security-checker.toml` is 13 lines of prose paraphrase with
   none of it. This is the silent-skip failure mode D-006 credits Sayre for avoiding, reproduced
   inside our own runtime mirror — landing on the contributor least able to notice.
2. **Nobody who clones the repo receives the Codex setup at all** — `AGENTS.md`, `.agents/`, and
   `.codex/` are excluded in `.git/info/exclude` lines 8–11, which is machine-local by design.
3. **The two `pipeline` skills disagree on who persists the review verdict** — `.claude/` has the
   `review` agent writing `.pipeline/review.md`; `.agents/` has the coordinator saving the returned
   markdown verbatim.

## Decisions

**D1 — The Bash guard fails closed.** Any command it cannot classify as read-only is blocked. This
matches `validate-pipeline-only-write.sh`'s existing design (it fails closed on an unresolvable
path). `review` legitimately runs tests via `Bash`, so the guard ships with an explicit allowlist of
test-execution and read-only commands, and a documented escape: the operator adds a command to the
allowlist in a reviewed commit, never by disabling the guard.

**D2 — Pare down to `AGENTS.md` + the `.sdd/` framework.** `.codex/` and `.agents/` are deleted.
Remaining surfaces: `.sdd/` (neutral methodology, the source of truth), `AGENTS.md` (entry point for
any AGENTS.md-reading tool — Codex, Cursor, others), and `.claude/` (generated shims, the only
runtime with subagent and hook machinery worth wiring).

*Accepted costs, recorded so they are recoverable rather than forgotten:*
- **Loses `sandbox_mode = "read-only"`** on the Codex security stage — runtime-boundary enforcement
  that was structurally stronger than Claude's hook. Consistent with the design's standing principle
  that cross-runtime guarantees are verification-based (Codex has no hooks), and the red-hash,
  spec-trace, and bounds checks are unaffected.
- **Loses per-stage context isolation in Codex.** A Codex run executes `.sdd/stages/*.md`
  sequentially in one context, so the reviewer shares context with the implementer and is weaker for
  it. This is the real loss. Re-adding `.codex/agents/` later restores it without changing `.sdd/`.

## Scope

**In:** the `.sdd/` tree; `runtimes.yml`; the shim generator (one target: `.claude/`); regenerating
the five `.claude/agents/` files; folding the four `.claude/skills/` into thin wrappers over `.sdd/`;
rewriting `AGENTS.md`; deleting `.codex/` and `.agents/`; removing the `.git/info/exclude` entries;
closing D-005's `Bash` hole; a CI staleness gate.

**Out:** the `red` stage (PL-03c) · `pr-review` and bounds enforcement (PL-03d) · the impact resolver
(PL-03b) · ledger *population* (directory + README only) · any change to the *content* of the
security methodology — this ticket makes it universally reachable, it does not alter what it does.

## Affected files

**New**

| Path | Purpose |
|---|---|
| `.sdd/README.md` | Entry point; the human-readable methodology doc; Victor's documentation |
| `.sdd/runtimes.yml` | Per-stage tool grants, model tier, hook wiring for `.claude/` |
| `.sdd/stages/{planner,dev,tester,review,security}.md` | Neutral methodology, extracted verbatim |
| `.sdd/pipeline.md` | The stage sequence, routing, and loop caps — currently duplicated across the two `pipeline` SKILL.md files |
| `.sdd/bounds.md` | Named lane vocabulary (defined here; enforced in PL-03d) |
| `.sdd/ledger/README.md` | Directory placeholder + entry format |
| `scripts/generate-agent-shims.mjs` | Emits `.claude/agents/*` from `runtimes.yml` |
| `scripts/validate-pipeline-only-bash.sh` | Fail-closed `PreToolUse` Bash matcher |
| `.gitattributes` | Pin LF on generated files so `--check` is byte-stable on Windows |

**Modified** — `.claude/agents/{planner,dev,tester,review,security-checker}.md` → generated shims ·
`.claude/skills/{pipeline,pipeline-status,spec-only,security-recheck}/SKILL.md` → thin wrappers ·
`AGENTS.md` → entry point · `.git/info/exclude` → remove lines 8–11 · `.gitignore` → `.sdd/` tracked,
`.pipeline/**` unchanged · `.github/workflows/ci.yml` → staleness job.

**Deleted** — `.codex/agents/` (5 TOMLs) · `.agents/` (4 skills + `openai.yaml` files).

> **`.codex/` itself is NOT deleted.** Inspection during planning found it is not a Codex scaffold —
> it is a 1.4 GB design workspace that happens to share the name: `.codex/blender/` (1.4 GB — the
> Blender hero-animation pipeline, `PIPELINE.md`, direction docs, `exports/hero-handoff-v00{3,4}.json`,
> an HTML prototype, reference contact sheets, feeding `scripts/render-anime-hero.mjs`),
> `.codex/design/DIRECTION.md` + `REFERENCE_WORKFLOW.md`, `.codex/references/feature-cards-ui-v1/`
> (UI reference PNGs + README), `.codex/imagegen/` (420 K), `.codex/vendor/` (1.3 MB). **None of it
> has ever been in git**, so deletion is unrecoverable. Only the `agents/` subdirectory is
> pipeline scaffolding and in scope here.

## Interfaces

**The neutral/runtime split — the load-bearing decision.**

| Lives in `.sdd/` (neutral, all runtimes) | Lives in `runtimes.yml` → `.claude/` shims |
|---|---|
| Required inputs and read order | Tool grants |
| Procedure and checks | Model tier |
| Output contract and section names | Hook wiring |
| Verdict vocabulary (`PASS`/`NEEDS_FIXES`/`BLOCKED`/`UNVERIFIED`) | Subagent name |
| Which `.pipeline/` artifact is produced | Whether a subagent writes it directly |

This resolves the review-persistence divergence without either side losing: `.sdd/stages/review.md`
states *"produce a report in this shape; it is persisted to `.pipeline/review.md`"* and leaves the
mechanism to the runtime. In Claude Code the subagent writes it under hook guard; in a runtime
without subagents the coordinator saves the returned markdown. Same contract, different mechanism.

**`.sdd/runtimes.yml`**

```yaml
version: 1
stages:
  planner:
    neutral: stages/planner.md
    claude: { name: planner, tools: [Read, Grep, Glob, Write], model: opus }
  security:
    neutral: stages/security.md
    claude:
      name: security-checker
      tools: [Read, Grep, Glob, Bash, Write]
      disallowedTools: [Edit]
      model: inherit
      hooks:
        PreToolUse:
          - { matcher: Write, command: ./scripts/validate-pipeline-only-write.sh }
          - { matcher: Bash,  command: ./scripts/validate-pipeline-only-bash.sh }
```

**Generator contract**

```
node scripts/generate-agent-shims.mjs            # writes .claude/agents/*
node scripts/generate-agent-shims.mjs --check    # exit 1 + diff if any shim is stale
```

Emitted shim — frontmatter from `runtimes.yml`, body a fixed pointer:

```markdown
---
name: planner
description: <from runtimes.yml>
tools: Read, Grep, Glob, Write
model: opus
---
<!-- GENERATED by scripts/generate-agent-shims.mjs from .sdd/runtimes.yml — do not edit. -->
Follow `.sdd/stages/planner.md` exactly. It is the authoritative definition of this stage.
```

**`scripts/validate-pipeline-only-bash.sh`** — mirrors the existing write guard's fail-closed shape,
reading `.tool_input.command` instead of `.tool_input.file_path`. Allowlists read-only and
test-execution commands; blocks everything else including anything it cannot parse.

## Approach

1. **Extract, don't rewrite.** Move each `.claude/agents/*.md` body verbatim into
   `.sdd/stages/*.md`, deleting only genuinely runtime-specific sentences. The security stage's 99
   lines transfer intact — D-005 records this stage as ahead of both comparison estates, so a
   refactor is the highest-risk moment for it and content changes are out of scope.
2. Reconcile the two `pipeline` SKILL.md files into `.sdd/pipeline.md`, resolving the persistence
   divergence per the table above. Same for the other three skill pairs.
3. Author `.sdd/runtimes.yml` capturing today's frontmatter exactly, plus the new Bash matcher.
4. Write the generator; regenerate the five shims; diff against originals and confirm every
   difference is either the pointer body or an intentional drift correction. **Enumerate the drift
   corrections in `changes.md`** — that list is the audit trail of what Codex was silently missing.
5. Rewrite `AGENTS.md` as the entry point: read `.sdd/README.md`, then the stage files. **Delete the
   claim that "the current checkout is a Vite/React site"** — the root is Vite *and* the monorepo is
   present, and this is the first orientation a new contributor reads.
6. Delete `.codex/agents/` and `.agents/`. **Leave the rest of `.codex/` in place** (see note above).
7. Rework the ignore rules rather than simply removing them:
   - `AGENTS.md` — drop from `.git/info/exclude`, commit it.
   - `.codex/` — **move the rule from `.git/info/exclude` into `.gitignore`.** It currently only
     protects Phillip's machine; as a shared rule it protects every cofounder from committing 1.4 GB
     of Blender output. D-007 already warns about repo weight and recommends git-lfs before it hurts.
   - `.agents/` — drop from both once the directory is gone.
8. Add the Bash matcher to the `review` and `security-checker` stage config, closing D-005's action
   item.
9. Add `.gitattributes` and the CI `--check` job.

## Acceptance criteria

1. A fresh clone gives a Codex user the full methodology through `AGENTS.md` with no machine-local
   setup and no `.codex/` directory.
2. **The security methodology is reachable identically from every runtime** — registry, checklist
   IDs, `UNVERIFIED` semantics, content-hashed manifest, `results.json`, untrusted-evidence clause.
   A reviewer comparing what a Codex agent and a Claude Code agent are instructed to do finds no
   methodological difference.
3. `node scripts/generate-agent-shims.mjs --check` exits 0 on a clean tree and non-zero after any
   hand-edit to a generated file; CI enforces it; it is byte-stable on Windows and Linux.
4. Every `.sdd/` file is complete and readable without reference to any runtime-specific file.
5. `review` and `security-checker` cannot write outside `.pipeline/` via `Bash` — verified by a test
   attempting `sed -i`, `tee`, and `python -c` against a source file, **and** by a test confirming an
   unrecognized command is blocked rather than allowed.
6. `review` can still run the test suite through the guard — verified by a positive test, so the
   fail-closed default is proven not to have broken the stage.
7. `AGENTS.md` contains no statement contradicted by the repo on disk.
8. `git ls-files AGENTS.md .sdd` returns results; `git ls-files .codex .agents` returns nothing.
9. An end-to-end `/pipeline` run on a trivial ticket completes in Claude Code with behavior unchanged
   from before this ticket.

## Edge cases

- **Fail-closed over-blocking `review`** — the most likely way this ticket breaks something.
  Acceptance criterion 6 exists specifically to catch it.
- **Hand-edited shim** — must fail CI, never be silently regenerated.
- **Line endings** — the repo is on Windows and git warns LF→CRLF on every commit. Without
  `.gitattributes` pinning LF, `--check` produces false failures on one platform or the other.
- **Generator run on a dirty tree** — must not silently overwrite uncommitted hand-edits; warn.
- **Stage declared in `runtimes.yml` with a missing neutral file** — fail loudly, never emit a shim
  pointing at a nonexistent path.
- **Deleting `.codex/` wholesale destroys 1.4 GB of unrecoverable design work.** Scope the delete to
  `.codex/agents/` exactly; a glob like `rm -rf .codex` is the failure mode. Nothing under `.codex/`
  has ever been in git.
- **Moving `.codex/` from `.git/info/exclude` to `.gitignore` must land before the exclude line is
  removed**, or a `git add -A` in the gap stages 1.4 GB.
- **A runtime without subagents runs stages in one context** — `.sdd/pipeline.md` must state the
  stage boundaries explicitly enough that a single agent still honors them (fresh read of the prior
  artifact, no skipping, no improvising a missing input), since the runtime will not enforce it.

## Open questions

None blocking. One to revisit after first use: whether losing per-stage context isolation in
non-Claude runtimes degrades review quality enough to justify re-adding `.codex/agents/`. Worth
watching on Victor's first few runs rather than deciding now.
