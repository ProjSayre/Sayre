# Bounds — named lane vocabulary

> **Scope note (PL-03a):** this file defines vocabulary only. Nothing in the repository reads or
> enforces it yet — there is no bounds-checking script, no `pr-review` agent, and no wiring into
> `.sdd/pipeline.md`'s routing. Enforcement is PL-03d's scope. This file exists now so the vocabulary
> is fixed before anything is built against it, not because anything currently depends on it.

## Why lanes

A future gate (`pr-review`, PL-03d) will need to check whether a change stayed inside the area a
ticket or contributor was authorized to touch. Named lanes, checked once and reused, beat a fresh
per-ticket path list: less to get wrong per run, and a lane's definition only needs updating in one
place when the repo's layout changes.

## Lane vocabulary

A lane is a name plus a set of path globs. A ticket or contributor is assigned exactly one lane.

| Lane | Path globs | Intended use |
|---|---|---|
| `frontend` | `apps/web/**`, `docs/**`, and tests within those paths | A contributor or ticket scoped to the visualization client and its docs, with no access implied to `services/`, `packages/`, or `infra/`. |
| `full` | everything | No lane restriction — the default for contributors and tickets not explicitly fenced. |

This list is expected to grow (e.g. a narrower lane for integration-worker or Graph Query Service
work) as soon as a second fenced contributor exists. Adding a lane means adding a row here; it does
not require touching any enforcement code, because none exists yet.

## What "in bounds" will mean, once enforced

Reserved for PL-03d, stated here only so the vocabulary and its eventual contract are defined
together: a change is in-bounds if every path in `git diff --name-only base...head` matches at
least one glob in the assigned lane. Out-of-bounds paths are a violation unless explicitly justified
in `changes.md`. The verdict is computed by a deterministic script, not judged by an agent — see
`docs/sdd-tdad-design.md` Section 4 for the full design. None of that script exists yet.
