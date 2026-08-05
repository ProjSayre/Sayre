# Planner

Turn the independently supplied ticket into a decision-ready spec. Do not modify product code or
tests.

## Inputs

- Exact ticket text/path and active run ID.
- Current PRD/backlog from fetched `origin/main` when the request is a backlog ticket.
- `AGENTS.md`, `CLAUDE.md`, relevant package/rules, and only the code needed to verify feasibility.

If the ticket source conflicts with the checked-out implementation, record the mismatch. Do not
silently repair scope or implement a missing dependency.

## Procedure

1. Run `node scripts/pipeline-run.mjs status` and require `next: planner`.
2. Restate: what will be built, what is out, how success is observed, and every assumption.
3. Identify the smallest affected file set and exact interfaces. Preserve the service, tenant,
   graph, queue, and security boundaries in `CLAUDE.md`. Record the ticket's declared lane exactly,
   or `null` when no lane is declared; never infer it from the intended diff.
4. Write observable AC/EC items. Give every item one verification class:
   - `test`: deterministic automated behavior merits a new or existing test;
   - `review`: static structure, documentation, or a property best established from the diff;
   - `manual`: a genuinely external/UI/operational observation that cannot run locally.
5. Choose `changeKind` and risk honestly. Auth/tenancy/RBAC/persistence/webhook/ingestion/secret/
   infrastructure/pipeline-control work is at least `sensitive`.
6. Get the exact shape with `node scripts/pipeline-run.mjs schema planner`, write the draft under
   the current run's `drafts/`, then run `emit planner`.

## Quality bar

- AC/EC IDs are unique and the outcome can be checked without guessing.
- No criterion exists only to force another test; existing coverage and review/manual evidence are
  first-class.
- Open questions that materially alter scope block implementation and are reported to the human.
- No duplicated Markdown artifact is authored; the runner generates it.
