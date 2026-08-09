<!-- Sections adapted from the velen MR template (D-020 #3). The Limitations section is the one
     that earns its keep: it forces the author to state what they did NOT do, which is the
     information reviewers most often lack and never think to ask for. -->

## What this changes

<!-- One or two sentences. If this came through /pipeline, this is spec.md's Goal. -->

## Ticket / spec

<!-- Issue link. If this went through the pipeline, also give the ledger entry once it exists:
     .sdd/ledger/<run-id>/spec.md — that spec is the durable record of what the code was
     supposed to do, and it is the first thing to read if this change is later implicated in a bug. -->

## Areas touched

<!-- Tick what applies; delete the rest. -->

- [ ] `apps/web` — visualization client
- [ ] `services/core` — API, service layer, Graph Query Service
- [ ] `services/gateway` — WebSocket / realtime
- [ ] `services/workers` — Python fleet, parsing, ingestion, enrichment
- [ ] `packages/*` — shared schema or types
- [ ] `.sdd/` / pipeline tooling
- [ ] `infra/` / CI
- [ ] Docs only

## Testing

<!-- What you ran, and what it proved. Not "tests pass" — which tests, covering which behaviour.
     If this went through the pipeline, test-results.md's coverage table is the source.
     If any acceptance criterion has no automated coverage, say which and why. -->

## Additional info / limitations

<!-- REQUIRED. What did you NOT do?

     Known gaps, deferred work, assumptions you made, things you couldn't verify, anything a
     reviewer would otherwise have to discover. A deferral recorded honestly is fine; a deferral
     that reads as completeness is not.

     If a check was skipped, say so here rather than letting a green pipeline imply it ran —
     a skipped test looks identical to a passing one. -->

## Security / tenancy

<!-- Delete if genuinely not applicable, but read it first — org_id handling, RBAC filtering,
     secrets, webhook validation, and anything touching the Graph Query Service all belong here.
     See .claude/rules/security-multitenancy.md. -->

- [ ] No change to tenant isolation, RBAC, secrets handling, or webhook validation
- [ ] Changes one of the above, and the security stage verdict is included below

<!-- If this went through the pipeline: security run id and verdict. -->
