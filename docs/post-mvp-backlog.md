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

## Enrichment

| Item | Surfaced by | Why deferred |
|---|---|---|
| `Neo4jEnrichmentGraphStore.apply()` doesn't independently enforce write.scope-vs-job-scope agreement — only `EnrichmentService.handle` performs that check before calling `apply()` | W2-05 review/security-checker | `apply()`'s spec'd signature (`apply(self, write)`) has no channel for an external job scope to compare against; `handle()` is the only production caller today so there's no bypass path yet — revisit (e.g. thread scope through `apply()`, or add a defense-in-depth check inside it) if `apply()` gains a second caller |

**Review notes (2026-07-22):** W2-05's D6 addendum (integrating with W2-08's dedicated priority-lane
consumer) split `EnrichmentService.handle(envelope)` into a thin envelope-parsing wrapper plus
`async def process(self, job: EnrichmentJob) -> EnrichmentResult`, which now holds the
`write.scope`-vs-`job.scope` guard (and the `apply()` call) that used to live directly in
`handle()`. `process()` remains the single call site for `apply()` — it is invoked from both
`handle()` (default lane, via `parse_enrichment_envelope`) and the new
`onboarding_bridge.build_onboarding_generator` (priority lane, via a directly-constructed
`EnrichmentJob`). So `apply()` still has exactly one production caller (`process()`); the two
lanes now feeding into that one caller doesn't reopen the bypass path described above — this item
stays deferred under the same reasoning, just re-anchored to `process()` instead of `handle()`.

## Tenant isolation (Neo4j guard)

| Item | Surfaced by | Why deferred |
|---|---|---|
| `assertOrgScopedCypher`/`referencesOrgIdPredicate` (`services/core/src/security/graphOrgGuard.ts`) proves `org_id` appears *textually* adjacent to `$org_id` in the query string, not that it functions as a real `MATCH`/`WHERE` filter — a legitimate-looking `{org_id: $org_id}` map literal inside a `RETURN`/`WITH`/`UNWIND` projection satisfies the check with zero real filtering effect | W2-06 adversarial security audit (personalized attacker-agent run, `security-attacker-agents/` framework), round-3 tester re-probe, finding labelled "Gap 7" | Not exploitable via any currently shipped query — every real `graph-write`/`graph-query` Cypher literal stamps `org_id` in an actual `WHERE`/`AND` filter position (verified by grep across `graph-write/*.ts` and `graph-query/index.ts`). Closing it for real needs a structural change bigger than another regex/state-machine patch: either (a) real openCypher grammar parsing to confirm `org_id` sits inside a `WHERE`/pattern-property position within a filtering clause specifically, or (b) replacing "infer org-scoping from query text" with a query-builder API that can't express an org-less query at all. Three remediation rounds (comment-stripping → string-literal/quote-desync fix → full state-machine + AST-based import check) each closed the specifically-demonstrated bypass while a structurally-similar variant kept surfacing — that pattern itself is evidence the textual-analysis approach has a real ceiling, not just an incomplete case list. Neo4j Community has no engine-level backstop (documented in `docs/tenant-isolation.md`), so this guard is the *only* thing standing between an org-less/mis-scoped query and cross-tenant disclosure — treat closing this as high-priority, not routine backlog. |
| Chokepoint fitness test's AST-based import detection (`services/core/src/security/neo4jChokepoint.test.ts`) misses `require` reassigned to a local variable before calling (`const req = require; req('neo4j-driver')`, "Gap 5") and never inspects `export * from 'neo4j-driver'` / named re-export declarations (`ExportDeclaration` nodes, "Gap 6") — the walker only visits Import/Call nodes | Same W2-06 audit, round-3 tester re-probe | Neither pattern exists anywhere in the current codebase (confirmed via the same false-positive sweep as above) and both require a deliberate, unusual authoring choice rather than an accidental omission — lower priority than Gap 7, but should be closed alongside it since it's the same mechanism and the same "textual/structural analysis has edge cases" lesson applies |

## Secrets & infra

| Item | Surfaced by | Why deferred |
|---|---|---|
| KMS-backed secrets manager (replacing gitignored `.env` files) | PRD §4.5 / `.claude/rules/security-multitenancy.md` | Explicit phase gate — required before the first external customer, not before |
