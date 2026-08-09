# Bounds — named lane vocabulary

> **Status (PL-03d):** enforcement now exists. `scripts/check-bounds.mjs` computes the verdict and
> `.sdd/stages/pr-review.md` adjudicates it.
>
> **The lane definitions live in `.sdd/bounds.yml`, which is authoritative.** This file explains
> them for humans. The split is deliberate: reading lane globs out of the markdown table below
> would mean parsing a natural-language document to reach a control decision, which is the exact
> defect PL-03h spent four rounds removing from the ledger and integrity gates. If this file and
> `bounds.yml` disagree, `bounds.yml` wins and the disagreement is a bug.

## Why lanes

`pr-review` (PL-03d) checks whether a change stayed inside the area a ticket or contributor was
authorized to touch, via `scripts/check-bounds.mjs`. Named lanes, checked once and reused, beat a
fresh per-ticket path list: less to get wrong per run, and a lane's definition only needs updating
in one place when the repo's layout changes.

## Lane vocabulary

A lane is a name plus a set of path globs. A ticket or contributor is assigned exactly one lane.

| Lane | Path globs | Intended use |
|---|---|---|
| `frontend` | `apps/web/**`, `docs/**`, and tests within those paths | A contributor or ticket scoped to the visualization client and its docs, with no access implied to `services/`, `packages/`, or `infra/`. |
| `full` | everything | No lane restriction — the default for contributors and tickets not explicitly fenced. |

This list is expected to grow (e.g. a narrower lane for integration-worker or Graph Query Service
work) as soon as a second fenced contributor exists. Adding a lane means adding a row here (and the
matching row in `bounds.yml`, which is authoritative — see the status note at the top of this file);
`scripts/check-bounds.mjs` reads the lane list generically, so adding one does not require touching
the enforcement script itself.

## What "in bounds" means

A change is in-bounds if every path in `git diff --name-only base...head` matches at least one glob
in the assigned lane. Out-of-bounds paths are a violation unless explicitly justified in
`changes.md`, which `pr-review` adjudicates — a violation is a finding to be judged, never a silent
rejection.

The verdict is computed by `scripts/check-bounds.mjs`, not judged by an agent. Exit `0` = in bounds,
`1` = violation, `2` = the check could not run. That last code is deliberately distinct: collapsing
"the check failed" into "the change is clean" is how a broken gate reads as a passing one.

```bash
node scripts/check-bounds.mjs --lane frontend --base main --json
```

## Files a fenced lane may never touch

`bounds.yml`'s `deny_for_fenced_lanes` list applies to every lane except `full`, regardless of that
lane's own globs. It covers `.sdd/`, `.claude/`, CI workflows, the read-only guard, the bounds-check
script itself, `.gitignore`, `CLAUDE.md`, and `AGENTS.md`.

The reason is narrow and worth stating: these files define the rules. A fenced contributor who can
edit them can widen their own fence, disable the guard constraining the checker stages, or rewrite a
stage definition — as part of an ordinary ticket, with no one specifically looking. Changing any of
them is legitimate work; it just is not *fenced* work, and it wants a human deciding rather than a
glob permitting.

An unfenced author on `full` is unaffected.

## Lite-lane eligibility (PL-11)

**A different axis from `lanes:` above, not a second version of the same idea.** `lanes:` (above) is
a *path fence* — it bounds WHICH PATHS a ticket or contributor may touch, regardless of how large the
change is. `lite_eligibility:` (`.sdd/bounds.yml`) bounds HOW SMALL a change must be before
`/pipeline-lite` may skip `red` and `security` on it, regardless of which lane the ticket is on. A
ticket can be in-lane and still too big for the lite lane; it can be small enough for the lite lane
and still (rightly) barred from it if it touches a governing or security-sensitive path. Both
questions are checked mechanically, by different scripts, against different sections of the same
file:

```yaml
lite_eligibility:
  max_files: 5
  max_changed_lines: 150
  max_line_length: 500
```

`scripts/check-lite-eligible.mjs` computes the verdict — the same "a computer counts, an agent
doesn't judge" discipline `scripts/check-bounds.mjs` already applies to `lanes:`. Tuning any of the
three numbers later is a reviewed diff to this one file, never a code change.

`max_changed_lines` counts LINES, not their size, so a diff shaped as a very few, very long lines
(security round FND-22ef4b5c746e reproduced a ~44KB single-line change measuring `changedLines: 2`)
can slide under it while carrying tens of KB of real content. `max_line_length` is the orthogonal,
second size bound that catches that shape — enforced fail-closed exactly like the other two: a
`lite_eligibility` block missing any of the three keys reads as `null`, never as "no bound."

**There is deliberately no third barred-path list here.** The lite lane's barred set is the
*computed union* of `hotfix_barred_paths` and `deny_for_fenced_lanes` (both above) — org_id/RBAC/
MCP-key/secrets/webhook/ingestion/gateway/Graph-Query-Service paths on one side, the pipeline's own
governing files on the other. A third, lite-specific list would drift from the other two the moment
either changed and this one didn't; the union computes itself instead. Security round
FND-b731f500c5b8 widened `hotfix_barred_paths` itself (the list this union draws from, not a new
list) to close a coverage gap where the service layer, request routes, MCP handlers, the worker
fleet, and the gateway were not barred from either `/hotfix` or the lite lane. See
`scripts/check-lite-eligible.mjs`'s `liteBarredPaths` for exactly how, and `.sdd/pipeline.md`'s
`/pipeline-lite` section for the full eligibility gate this bound feeds.
