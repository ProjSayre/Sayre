# Sayre — agent entry point

This file is the entry point for any AGENTS.md-reading tool (Codex, Cursor, or anything else). It
is tracked and committed — every clone of this repository gets the same instructions, the same way
a Claude Code checkout gets `.claude/`. There is no machine-local setup step to reach this content
anymore.

## Read first, in this order

1. `README.md` and the relevant `package.json` before choosing any command — see "Repo shape"
   below before assuming which one applies.
2. `CLAUDE.md` for product architecture, stack, structure, and invariants.
3. `.sdd/README.md`, then `.sdd/pipeline.md` — the runtime-neutral pipeline methodology. This is
   the actual procedure for every stage described below; it is not repeated in this file.
4. The matching `.claude/rules/*.md` file before changing a covered component:
   - `service-layer.md` for core API or gateway TypeScript.
   - `graph-schema.md` for graph schema, Cypher, or core service changes.
   - `async-messaging.md` for Python workers and queue behavior.
   - `security-multitenancy.md` for auth, tenant data, secrets, webhooks, ingestion, or
     persistence.

When documentation and the checked-out implementation disagree about an executable command or
path, verify against the files on disk and report the mismatch; do not invent missing scripts or
directories.

## Secret paths — `.agentignore`

`.agentignore` lists the paths no agent may read or write. It is runtime-neutral, uses gitignore
pattern syntax, and is the **only** source for the `Read()`/`Edit()` entries in
`.claude/settings.json`'s `permissions.deny` — `npm run generate:agent-ignore` regenerates them and
CI's `npm run check:agent-ignore` fails if the two have drifted. Add a secret path there, never to
the settings file directly.

Be precise about what this does and does not buy you, because the difference is the whole point:

- **Claude Code enforces it.** The generated deny rules are applied by Claude Code itself, not by
  the model, so no prompt or instruction can talk its way past them. They cover the built-in file
  tools and the file commands Claude Code recognizes in Bash (`cat`, `head`, `tail`, `sed`).
- **They do not cover arbitrary subprocesses.** A Node or Python script that opens the file itself
  is outside this mechanism. For an OS-level boundary, that needs sandboxing, which this repo does
  not currently enable.
- **No other runtime reads `.agentignore` today.** There is no `.claudeignore`, and Codex/Cursor
  have no equivalent this file plugs into. For every runtime except Claude Code, treat it as a
  declaration of intent, not a control — and act accordingly when working in one.
- **Deny rules cannot carry exceptions.** A leading `!` enforces nothing (verified, not assumed),
  which is why the patterns are written narrowly enough to never match a tracked, placeholder-only
  `.env.example`. Those templates stay readable on purpose; onboarding depends on them. The
  consequence is that a secret-bearing `.env.<name>` outside the listed forms is not covered —
  `.gitignore` still stops it being committed, but an agent could read it.

Secret *values* are governed separately and more strictly: see `SECRETS.md` for the closed catalog
of secret names, and `.claude/rules/security-multitenancy.md` for the never-log/never-commit rules.

## Repo shape

The repository root is a monorepo workspace root: `package.json`'s `workspaces` array covers
`apps/*` (the marketing site at `apps/site`, and the product client at `apps/web`),
`services/core`, `services/gateway`, and `packages/*`. The marketing site's own source, static
assets, and scripts live entirely under `apps/site/` (PL-15) — the root no longer carries any of
them directly. Root `dev`/`build`/`preview` remain thin delegating aliases to the marketing site's
own scripts (unchanged names, for the Cloudflare Pages deploy contract and muscle memory), not a
turbo command across every workspace — see `CLAUDE.md`'s Commands section for the exact split. See
`docs/repo-structure.md` for the full directory map.

CLAUDE.md's own "Commands" section (`npm run dev` / `build` / `test` / `lint`) describes the
platform-wide target shape; the root `package.json` does not yet define bare `test` or `lint`
scripts — only `test:workspaces` / `lint:workspaces` (via turbo, scoped to the workspace packages)
and a set of narrower root scripts (`check:secret-access`, `check:security-audit-agents`,
`check:agent-shims`, and others — see `package.json` for the current list). Run the narrowest
relevant one for what you're actually changing rather than guessing at a `test`/`lint` script that
doesn't exist at the root today.

## The pipeline

Sayre's delivery pipeline is six stages — `planner` → `red` → `dev` → `tester` → `review` →
`security` — defined once, runtime-neutral, in `.sdd/`, plus a ledger-append step once a run reaches
terminal `PASS`. Five commands compose the stages: four that run some or all of them, and `/hotfix`,
which deliberately runs none of them.

- `/pipeline <ticket>` — the full sequence, planner through security, with routing and loop caps.
- `/spec-only <ticket>` — produce `.pipeline/spec.md` and stop for human review.
- `/pipeline-status` — report the current pipeline state without changing it.
- `/security-recheck` — repeat only the final security assessment.
- `/hotfix <what's broken>` — the sanctioned bypass for a production incident that cannot wait for
  the full sequence; skips every stage above and writes a bypass ledger entry instead — see
  `.sdd/hotfix.md`, the authoritative, runtime-neutral definition of this path.

Each command's exact procedure is defined in `.sdd/pipeline.md`, not here — read it before running
one. Do not skip a missing stage or let a stage invent a replacement for a missing input; if a
required `.pipeline/` artifact doesn't exist, say which stage needs to run first. Pipeline artifacts
live in `.pipeline/`, which stays gitignored (a run's own working files are scratch, not history) —
except the one thing that's durable by design:
`.sdd/ledger/<run-id>/{spec.md,spec.json,entry.md,entry.json,security/}` (plus a copy of
`red.json`/`changes.json`/`review.json`/`security.json` when present for the run — `entry.json` is
the machine-facing, authoritative half; `entry.md` is the human-facing rendering), committed once a
run reaches terminal `PASS`. See `.sdd/ledger/README.md` for the entry format and the file→spec
query path.

Architecture rules, the service-layer boundary, RBAC/tenant-isolation requirements, and the
project's "Don't" list are defined once in `CLAUDE.md` and are not restated here — copying them into
a second file is exactly the kind of drift this file exists to stop causing.

## Long-running and multi-ticket branch policy

- Before planning or implementing tickets, fetch `origin/main` and read the current PRD and backlog
  from that fetched revision. On the current repository, `docs/prd.md` and `docs/PRD_Tickets.md`
  are authoritative; `docs/backlog.md` is an older backlog and must not override them. If the user
  supplies a newer ticket file, read it in full and report any mismatch. Do not rely on a stale
  local `main` or an earlier ticket description.
- Until the tracked companion docs are reconciled, where product scope or tooling in `CLAUDE.md`,
  `docs/architecture.md`, `docs/migration-triggers.md`, `DEPENDENCIES.md`, or `docs/backlog.md`
  conflicts with PRD v5 / `docs/PRD_Tickets.md`, follow the newer PRD/ticket source and call out the
  drift in the ticket spec. Continue to enforce the unchanged security, multi-tenancy,
  service-layer, graph, and queue boundaries.
- Keep the user's active/dirty checkout untouched. Use a separate Git worktree for autonomous
  ticket work.
- Create one branch and one worktree per ticket. Never combine multiple tickets on one
  implementation branch, even when they are requested in one session.
- Start a ticket branch from the latest `origin/main` when all of its dependencies are merged
  there.
- If a ticket has exactly one required predecessor that is implemented but not merged, branch the
  dependent ticket from that predecessor's branch so the Git ancestry records the dependency.
- If a ticket would require two or more unmerged predecessor branches, do not implement it. Report
  that it is not safely branchable and wait for the prerequisites to merge.
- Do not fold dependency implementation into the dependent ticket. Missing prerequisite work
  remains its own ticket, branch, pipeline, and review history.
- For overnight autonomous runs, read the entire current ticket backlog first and classify
  candidates by dependency readiness, security sensitivity, human-decision requirements, external
  credentials/services, testability, and likely merge conflicts. Implement only tickets that are
  explicitly selected after that assessment.
- Leave each completed ticket on its own branch with pipeline artifacts summarized for morning
  human review. Do not merge ticket branches; the human owner performs merges.
