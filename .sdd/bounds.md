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
