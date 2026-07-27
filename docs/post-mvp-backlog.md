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
| Persist the GitHub acting-user identity for an install audit trail | W1-06 (O-3) | The callback now exchanges the one-time OAuth code to authorize the installation account, but deliberately retains neither the user token nor acting-user metadata |
| **[HIGH] Login OAuth callback has no browser-binding — session-injection via login CSRF.** The signed `login_oauth` state JWT (`services/core/src/auth/loginState.ts`) only proves *the server issued it recently*, never *this browser started this flow*. No cookie or other browser-bound value is set at `/auth/github/login` or checked at `/auth/github/callback`. An attacker can sign into their own GitHub account, capture the resulting fresh `code`+`state` before their own browser consumes it, and get a victim's browser to complete that exact callback URL (link or hidden iframe — see frame-protection gap below) — the victim's own frontend then stores a session token for the *attacker's* identity into the victim's `localStorage`, silently authenticating the victim as the attacker. GitHub's single-use-code protection doesn't help: the code is still fresh on its one real use, just consumed by the wrong browser. | AUTH-01 security-checker, PR_DELTA run `20260726T014535000Z-7f22125a81-PR_DELTA-c5c96a`, finding WEB-04 | Explicit product decision: MVP needs a working "Sign in with GitHub" path now; the fix (bind the flow to the initiating browser via an `httpOnly`/`SameSite=Lax` CSRF cookie set at login-start and compared at callback before minting a session) was scoped and ready but deliberately deferred to ship login for MVP. **Must close before any real external user relies on this login path** — the sibling install flow (`routes/githubInstall.ts`) isn't affected, since it already requires an authenticated+authorized admin caller. |
| [MEDIUM] Login start/callback responses have no frame protection (no `X-Frame-Options`/`frame-ancestors`), making the WEB-04 attack above easier to deliver via a hidden iframe | Same AUTH-01 security-checker run, finding WEB-05 | Same MVP-speed call as WEB-04; close alongside it |
| [LOW] Duplicate query params on the callback (e.g. `?code=a&code=b`) parse as an array and crash with a 500 instead of a clean 400 (PoC confirmed) | Same run, finding WEB-07 | Not exploitable for account takeover on its own (just a crash/DoS-adjacent input-validation gap); cheap guard, fine to batch with the WEB-04 fix round |
| [LOW] No rate limiting on `/auth/github/login`/`/auth/github/callback` | Same run, finding WEB-08 | No existing rate-limit middleware pattern to reuse yet in this codebase; accepted for MVP traffic volume |
| [LOW] Login callback redirect / `/auth/complete` responses lack `Cache-Control: no-store` | Same run, finding WEB-10 | Minor caching-hygiene gap on a page that briefly carries a session token in the URL fragment; low value until real traffic through a caching proxy exists |
| `resolveUserByExternalAuthId` (`services/core/src/db/authUsers.ts`) uses a plain pre-tenant-context query that relies on the local/test login role's superuser RLS bypass, rather than a locked-down `SECURITY DEFINER` function | AUTH-01, discovered while rebasing onto `main` after migration `0011` (`resolve_github_installation_org`) had already closed the identical gap for `resolveInstallationOrg` | Written before migration 0011 landed; in production the login role is `NOBYPASSRLS` so this read returns nothing and every login would mint a duplicate org. Should get an equivalent `resolve_user_by_external_auth_id` `SECURITY DEFINER` function + narrowly-scoped `NOLOGIN`/`NOBYPASSRLS` role, mirroring `drizzle/0011_github_installation_resolver.sql` exactly — deferred to ship login for MVP rather than re-derive that migration now |

## Integrations

| Item | Surfaced by | Why deferred |
|---|---|---|
| Replace the 25-repository GitHub callback cap with paginated async reconciliation and visible partial-sync state | W1-06 (O-5) | Today repositories after the first 25 are neither registered nor queued, and no background reconciliation repairs the gap; the bound protects callback latency but installations above it are not fully synchronized |
| Correlate an organization member's `setup_action=request` with a later owner-approved installation | W1-06 security review | The request has no installation to bind and the later `installation.created` webhook has no authenticated Sayre tenant context; requires an expiring, single-use pending intent bound to an authoritative GitHub target account plus replay/conflict/out-of-order tests |
| ~~`installation_repositories` webhook event is subscribed in the App manifest but not explicitly handled (falls through to the normalizer's ignored path)~~ **CLOSED — scheduled and implemented as W2-09** (`ticket/w2-09-github-installation-repos-reconciliation`): added/removed webhook handling plus a manual `POST /integrations/github/reconcile` backstop for missed/out-of-order deliveries. | W1-06 security-checker | N/A — closed, see W2-09 in `docs/PRD_Tickets.md` |
| FIFO group-id scheme (`org_id, provider_repo_id, ref`) must stay consistent between W1-02's push-delta path and any future initial-parse producer | W1-02 (O-3) | No correctness issue today (W1-06 already matches the scheme); flagging so a future ticket touching either producer doesn't drift them apart |
| Reconcile (W2-09) is additive-repair-only by design (OQ-5, human-confirmed): it never revokes a repository based on an inferred absence from a GitHub API diff. A missed `installation_repositories` "removed" webhook therefore leaves that repo un-revoked until a future real removal event fires — no backstop repairs this direction today. | W2-09 (OQ-5) | Inferring revocation from a diff (rather than a real, direct GitHub signal) was judged too risky to ship for MVP; revisit only alongside a concrete missed-webhook incident rate or a stronger signal (e.g. a periodic authoritative full-installation snapshot) that makes destructive reconciliation safe |

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
