# Post-MVP Backlog

A running log of work deliberately deferred past MVP — scope cut for speed, open questions
resolved with an MVP-only default, or gaps flagged during a ticket's pipeline run that don't block
that ticket but shouldn't be forgotten. This is not the ticket backlog (`docs/PRD_Tickets.md`
remains authoritative for planned scope); it's where *unplanned, discovered* follow-ups go so they
don't get lost between a PR merging and someone remembering to file a ticket for them.

**How to add an entry:** one row per item, in the table for its area. Include the ticket that
surfaced it and a one-line "why this is safe to defer" — that's what lets someone triage this list
later without re-deriving the context. Move a row to a real ticket (link it) once it's scheduled,
don't delete it.

**Status:** review of this list is intentionally deferred to post-MVP. When that review happens,
add findings as a `**Review notes (YYYY-MM-DD):**` line under the relevant row (or under this
section if the note is about the list as a whole) rather than only as PR/GitHub comments — this
file should stay the durable record, not the PR thread.

## Auth & tenancy

| Item | Surfaced by | Why deferred |
|---|---|---|
| Real session-gating on `GET /integrations/github/install` (currently behind the dev-placeholder `tenantContext`, hard-fails outside dev/test) | W1-06 | W1-03 (AuthN/AuthZ middleware) not yet built; install route intentionally MVP-only until it lands |
| GitHub OAuth `code` exchange to record the acting user for install audit trail | W1-06 (O-3) | Org binding already comes from signed `state`, not GitHub identity — code exchange only adds audit attribution, not correctness |
| Production-sanctioned pre-tenant read path for `github_app_installations` (currently a privileged lookup that bypasses RLS via the dev superuser role) | W1-02 (O-4), reconfirmed by W1-06 (second consumer of the same gap) | Local/test dev role is a superuser so the plain query works; needs a scoped read role or dedicated service connection before this ships to a real tenant |

## Integrations

| Item | Surfaced by | Why deferred |
|---|---|---|
| Hard cap of 25 repos per GitHub App installation callback (repos beyond the cap are silently not enqueued, no error/warning) | W1-06 (O-5) | Simplest bound on ingestion cost/callback latency for MVP; revisit as a per-org configurable limit (e.g. tied to a future billing tier) or an async fan-out job if real installs approach the cap |
| `installation_repositories` webhook event is subscribed in the App manifest but not explicitly handled (falls through to the normalizer's ignored path) | W1-06 security-checker | Doesn't affect `installation` (add/remove) handling already built; matters once repo-level add/remove-without-reinstall needs its own sync behavior |
| FIFO group-id scheme (`org_id, provider_repo_id, ref`) must stay consistent between W1-02's push-delta path and any future initial-parse producer | W1-02 (O-3) | No correctness issue today (W1-06 already matches the scheme); flagging so a future ticket touching either producer doesn't drift them apart |

## Secrets & infra

| Item | Surfaced by | Why deferred |
|---|---|---|
| KMS-backed secrets manager (replacing gitignored `.env` files) | PRD §4.5 / `.claude/rules/security-multitenancy.md` | Explicit phase gate — required before the first external customer, not before |
