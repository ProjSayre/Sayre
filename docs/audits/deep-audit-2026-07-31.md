# Deep Audit — 31 July 2026

**Method:** 18 independent subagents, each scoped to a disjoint slice of the repo, run without
access to `docs/architecture-assessment-2026-07.md`. Overlap between this audit and that one is
therefore *independent corroboration*, not an echo. Every finding below cites `file:line`.

**Status at time of writing:** 16 of 18 agents reported (Python ingestion/parsing and test-coverage
were still running when the window closed; their reports land in the scratchpad regardless).

Findings are tagged **[NEW]** (not in the July assessment) or **[CONFIRMS]** (independently
reproduces a prior finding, usually with sharper detail).

---

## Part 0 — The one-paragraph version

The security core is in far better shape than "we dumped code for an MVP" implies: no
request-reachable cross-tenant leak was found by any of the three agents that looked for one, zero
of 28 endpoints are missing an authorization check, retrieval isolation is a genuine pre-filter,
and the hardest rule in the codebase — per-push RBAC re-filtering on WebSocket fan-out — is
correctly implemented and tested. What is broken is everything *around* that core: the newest
feature (Jira ticket sync) is independently broken three different ways and fails silently every
time; unauthenticated Redis on `0.0.0.0` is an RCE primitive holding the job bus; one malformed
WebSocket frame kills the gateway for every tenant; AI enrichment costs ~$20 per push on a 10k-file
repo with no quota anywhere; and the pipeline safety guarantee documented in `CLAUDE.md` does not
exist in `.claude/settings.json`.

**The premise of this audit was wrong, in your favour — say so plainly.** "We dumped code and
didn't do proper tests" is not what the evidence shows. Two agents independently measured it:
**192 test files and 2013 passing tests** (1340 TypeScript across 144 files, 625 Python, 48 script
tests), `lint:workspaces` 0 errors / 0 warnings, `typecheck:workspaces` 0 errors across 8/8 tasks.
The suites include negative controls and anti-vacuity checks — `test_tenant_isolation.py:214`
contains a control proving the *pre-fix* pattern still leaks, and CI parses JUnit XML to assert no
broker test silently skipped. That is better discipline than most commercial codebases.

What is broken is the **verification loop documented in CLAUDE.md**, not the tests it was supposed
to run. `npm run test` and `npm run lint` do not exist at root, and `npx tsc --noEmit` passes
**vacuously** — the root tsconfig is `include: ["src"]`, so it checks 48 marketing-site files and
zero product code. The commands you were told to trust have been reporting green without ever
looking at the MVP. That single misconfiguration is the best explanation for why this audit found
what it found: the work was done, but nothing was reporting on it.

Two real coverage gaps remain, both narrower than assumed: the **environment cannot run either
suite as checked out** (no workspace `node_modules`, no turbo; PyJWT missing from all six venvs,
poetry not on PATH, Python 3.11.9 against a `>=3.12` constraint), and **the strongest tenant-
isolation proofs skip on a laptop** — they are database-level "app filter removed" tests that CI
forces on (`ci.yml:87-107`, `206-210`). A local green run is *not* evidence tenant isolation holds.

---

## Part 1 — Fix today (P0)

Ordered by blast radius ÷ effort.

### P0-1 · Unauthenticated Redis bound to `0.0.0.0` **[NEW]**
`infra/docker-compose.yml:32-44` — `redis:7.4-alpine`, `ports: "6379:6379"`, no `requirepass`.
`REDIS_PASSWORD` is commented out at `infra/.env.example:47`, and
`services/core/src/queue/bullmq.ts:85-90` swallows the resulting missing-secret error rather than
failing loudly.

Unauthenticated Redis is a documented RCE primitive (`CONFIG SET dir` + `SAVE` to write an
authorized_keys or cron file). This instance carries BullMQ integration jobs *and* the gateway's
`graph.updated` pub/sub bus. **Verified directly**, not just agent-reported.

*Fix:* set `requirepass`, bind to `127.0.0.1:6379:6379`, and make `bullmq.ts` fail closed on a
missing secret.

### P0-2 · All six datastore ports bind `0.0.0.0` **[NEW]**
`infra/docker-compose.yml:22-92` — Postgres (permissions system-of-record, holds encrypted Jira
tokens) and Neo4j Bolt are reachable from the LAN. A direct Bolt or psql connection bypasses RLS
and every graph guard entirely, because those are enforced at the application role layer.

*Fix:* prefix every port mapping with `127.0.0.1:`.

### P0-3 · One malformed frame kills the gateway for every tenant **[NEW]**
`services/gateway/src/ws/connection.ts:191-227` registers only `message` and `close`. There is **no
`'error'` listener anywhere in `services/gateway/src/`** — verified by direct grep, zero hits. The
`ws` library emits `'error'` on the socket for client-controlled protocol faults, and Node throws
on an unhandled `'error'` event.

Unauthenticated, single-packet, all-tenant DoS. Two-line fix.

### P0-4 · Gateway likely crash-loops on the first browser client **[NEW]**
`services/gateway/src/ws/auth.ts:34-37` calls `getConfig('NODE_ENV')`, which throws when unset
(`packages/config/src/config.ts:64-130` defines no default), synchronously inside
`wss.on('connection')`. Browsers cannot send an `Authorization` header on upgrade, so this path is
hit by the first real client.

### P0-5 · 13 live secrets on disk, protected only by an *uncommitted* gitignore rule **[CONFIRMS A1, expanded]**
`infra/New Text Document.txt` — byte-identical copy of `infra/.env` (same MD5). Per-secret detail
(exact variable names, file/line locations, masked values): `deep-audit-2026-07-31/audit-15-secrets-deps.md`
§C-1 (**PL-15 redaction note applies there** — exact line numbers and liveness confirmation for each
secret are generalized out of that tracked table and remain on file only in the auditor's untracked
working copy).

**Git history and all tracked files are CLEAN** — a 242-commit full-content scan found zero real
secrets, and no `.env`/`.pem`/`.key` was ever committed. But the protection today is the
**uncommitted** `.gitignore` change in your working tree. On `main` as it stands, no committed rule
catches this file: `git add -A` would commit it. It is also in a OneDrive-synced folder, so it has
already left the machine.

13 confirmed real secrets, all requiring rotation (exact source-file line locations were removed
before this snapshot was first committed to git — they remain in the auditor's untracked working
copy; see `deep-audit-2026-07-31/audit-15-secrets-deps.md`'s generalized inventory):

| Secret |
|---|
| **`JWT_SIGNING_KEY`** / **`MCP_TOKEN_PEPPER`** |
| **`JIRA_TOKEN_ENC_KEY`** |
| `GITHUB_APP_PRIVATE_KEY` (full RSA PEM), GitHub App client secret, webhook secret |
| `JIRA_OAUTH_CLIENT_SECRET` |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` |
| Postgres password + both DSNs, Neo4j password/auth |

Three of these protect *other* credentials and cannot be rotated with a simple replace:
`JWT_SIGNING_KEY` signs the session tokens carrying `org_id` and roles — anyone holding it mints a
valid session for any tenant, downstream of every RLS policy and RBAC filter in Part 6.
`JIRA_TOKEN_ENC_KEY` decrypts every org's Jira tokens, and `MCP_TOKEN_PEPPER` backs every MCP agent
key digest — both need the re-encrypt/reissue procedure in `SECRETS.md`.

(AWS `test`/`test` and the `LINEAR_*` local placeholder values are not real secrets — no action.)

*Fix, in order:* commit the `.gitignore` change today (verified safe — it ignores nothing currently
tracked), move the file out of the repo tree, then rotate all 13 following `SECRETS.md` for the
three key-material entries.

### P0-6 · The `check:secret-access` CI gate is failing on `main` right now **[NEW]**
It exits 1 today with 4 violations, including
`services/core/src/integrations/tickets/pollWorker.ts:9` — yet merges landed on top of it. Either
branch protection is not enforcing this gate, or it is not wired to the required-checks list. Worth
confirming immediately, because it is one of only two security gates that actually run.

---

## Part 2 — The Jira sync feature has never worked

Three agents with disjoint scopes each found a *different* silent, total break in the ticket-sync
poll loop merged two commits ago (`3aff7a3`, `2059a64`). Any one of them alone reduces the feature
to a no-op. None of them raise an error.

1. **Timezone-shifted JQL window** `[NEW]` —
   `services/core/src/integrations/tickets/jira/jiraOAuthClient.ts:131-138` (used at `:274`)
   formats `since` as a bare UTC literal, but Jira evaluates JQL datetimes in the *token user's*
   timezone. For any Jira site west of UTC the window lands in the future: zero issues, forever, no
   error.
2. **Repo-agnostic clear-Cypher deletes what it just wrote** `[NEW]` —
   `graphTicketStore.ts:34-51` + `jiraPoller.ts:104-113`. The poller fans out per repo;
   `CLEAR_TICKET_REFERENCES_CYPHER` is not repo-scoped, so repo 2's clear step removes repo 1's
   fresh edges. Multi-repo orgs end every cycle with zero references.
3. **Non-canonical ref means every link matches 0 nodes** `[NEW]` —
   `jiraPoller.ts:108` passes `main` where the graph stores `refs/heads/main`. Fails quietly with
   `linkedNodes: 0`.

Plus, from the same cluster:
- **No persisted watermark** — `since = now - 15min` only (`jiraPoller.ts:48-51`). Any downtime
  over 15 minutes drops every ticket updated during it, with no catch-up.
- **No pagination** — `jiraOAuthClient.ts:274-286` ignores `nextPageToken` while pairing
  `maxResults: 100` with `order by updated asc`; bursts over 100 are permanently lost.
- **~15× redundant re-sync** — a random `cycleId` sits inside the idempotency key
  (`ticketSyncIngress.ts:101`, `pollWorker.ts:9`), so each ticket re-syncs once per cycle across
  the 15-minute lookback, each firing a real embedding call. **[CONFIRMS C4, sharper]**
- **No overlap guard** — `setInterval` with no lock and no backoff (`pollWorker.ts:11-25`); cycles
  stack unbounded once one exceeds 60s.
- **Linear still uses one global token for all tenants** — `providers/linear.ts:76`,
  `worker.ts:72-74`. A `linear-sync` job for org B writes another workspace's issue content under
  `org_id = B`. **[CONFIRMS C6]**

**Recommendation:** treat Jira sync as unshipped. Write one integration test that crosses the
poll→graph seam before touching any of the individual bugs — the existing unit tests mock the seam
and encode the wrong assumptions (the same F5 pattern that hid D2).

---

## Part 3 — Cost and correctness in the AI layer

No org-level token or spend quota exists anywhere in the codebase. Combined with the items below, a
single active 10k-file repo costs roughly **$20 per push**.

- **CRITICAL · Onboarding LLM calls 400 on every job** `[NEW]` —
  `enrichment/onboarding_plan.py:108` hardcodes `temperature=0.0`. Sampling parameters are removed
  on Opus 5/4.8/4.7, Fable 5, and Sonnet 5. The 400 is swallowed as a generic `provider_error` and
  latches the circuit breaker open. `tests/test_onboarding_plan.py:107` encodes the bug, so the
  suite stays green while the feature is dead.
- **HIGH · ~$3 per push** — `enrichment/feature_clustering.py:77-93` serializes the entire repo file
  list into every prompt with no cap, and `service.py:123` forces `full_rebuild` true per push:
  ~600K tokens at 10k files, hard 400 past ~50k.
- **HIGH · Billed input doubled** — `feature_clustering.py:149` puts every file path in the schema
  `enum`, exceeding OpenAI strict-mode enum limits; the Anthropic path sends it without
  `strict: true` so it isn't enforced at all.
- **HIGH · ~$17 per push** — `style_classifier.py:236-246` issues one serial call per 8 folders
  (~188 calls at 10k files) with no cap or concurrency, and a mid-run failure restarts all of them.
- **MEDIUM** — retry loop retries non-retryable 4xx with no jitter (`resilience.py:313`); generation
  SDK clients set neither `timeout` nor `max_retries=0`, so one logical "attempt" is up to three
  billed requests (`anthropic_adapter.py:54`).

**What holds up:** vendor SDK imports are statically enforced by
`tests/test_enrichment_vendor_isolation.py`; secrets never log; and LLM output is schema-validated
*and then re-validated against the authoritative graph* before any write — a genuinely good
prompt-injection defense.

---

## Part 4 — Durability and delivery

- **CRITICAL · SNS payload blows the 256 KB limit on large repos** `[NEW]` —
  `ingestion/events.py:79` + `ingestion/service.py:97-99,141-148`. On a full rebuild `changed_paths`
  is the entire tracked tree (~5k files breaks it). It fails *after* the graph commit but *before*
  chunk/embedding publication, and the replay path reproduces it identically until DLQ. Presents as
  "the graph imported fine but AI features silently don't work."
- **HIGH · Documented webhook idempotency does not exist** `[NEW]` — `queue/bullmq.ts:180-184` sets
  `removeOnComplete: true`, which defeats jobId dedup entirely.
- **HIGH · `attempts: 1`, no backoff, nothing reads the failed set** — `queue/bullmq.ts:180-184`.
  Ownership sync loses data permanently and silently after returning 202.
- **HIGH · Durable idempotency breaks across replicas** — `cli.py:196-200` hardcodes a per-container
  `SqliteDeliveryStore` with no injection point. Double-charged embedding calls on any scale-out.
- **HIGH · Two FIFO poison messages, each stalling a group ~25 min** `[NEW]` — branch
  `create`/`delete` publishes a `repo.branch` type the only consumer rejects
  (`normalizeGithubEvent.ts:204` vs `ingestion/models.py:205`); branch-deletion pushes are sent to
  ingestion, which then fetches a ref GitHub already deleted (`normalizeGithubEvent.ts:174-181`).
- **HIGH · SQS deleted before fan-out** `[CONFIRMS D4]` — `gateway/src/server.ts:50-53` +
  `sqs/consumer.ts:143-158` delete after the Redis `PUBLISH`. Redis pub/sub has no persistence, so
  events vanish across restarts. Comments at `server.ts:73-75` and `consumer.ts:22-23` assert the
  opposite guarantee; **both are false**.
- **HIGH · Secrets leak to customer repo code** `[NEW]` —
  `dynamic_coverage/command_runner.py:66-71` omits `env=`, so a subprocess running the
  repo-under-test's own test command inherits `ANTHROPIC_API_KEY`, `GITHUB_APP_PRIVATE_KEY`,
  `DATABASE_RUNTIME_URL`. The correct helper `get_subprocess_environment()`
  (`config/config.py:132`) already exists and is used properly at `ingestion/repository.py:389`.

---

## Part 4b — The verification loop is reporting green on nothing

| CLAUDE.md gate | Exists? | Result |
|---|---|---|
| `npx tsc --noEmit` | yes, **wrong scope** — root tsconfig is `include: ["src"]` = 48 marketing files, zero MVP code | passes vacuously |
| `npm run test` | **no — missing script** | — |
| `npm run lint` | **no — missing script** | — |
| `npm run build` | yes, **wrong scope** — marketing site only | pass |

The commands that actually work are the undocumented ones: `typecheck:workspaces` (0 errors, 8/8),
`lint:workspaces` (0/0), `test:workspaces` (**1340 passed, 7 skipped, 144 files**),
`build:workspaces` (5/5). All exit 0, nothing hangs, no live DB needed. `npm run dev` is also
mis-documented — it is `vite` (marketing site), not the turbo web+core+gateway CLAUDE.md describes.
`AGENTS.md:24` contradicts CLAUDE.md here and is the correct one.

Three consequences worth acting on:

- **The Python fleet is entirely unverified.** 140 `.py` files and 40 test files, and nothing can
  run them here: poetry, pytest, ruff, and mypy are all absent, and installed Python is **3.11.9
  against a `requires-python = ">=3.12,<3.13"` hard constraint**. The tooling *is* configured in
  `pyproject.toml`; it has simply never run on this machine. This is the largest unverified surface
  in the repo — and note that a disproportionate share of this audit's CRITICALs live in it.
- **6 of 17 tenant-isolation penetration tests skip by default**
  (`services/core/src/security/tenantIsolation.penetration.test.ts`), gated on a live Postgres via
  the separate, never-run `test:rls` scripts. The isolation coverage `security-multitenancy.md`
  leans on is partially inert in a normal run.
- **Version pins are all off** — Node v24.14.0 vs `engines: ">=20 <21"` and `.nvmrc: 20`
  (8 `EBADENGINE` warnings). Local green is not evidence that pinned-version CI is green.

Minor: `packages/graph-schema/` contains only `schema.md` with no `package.json`, so it is not a
workspace and is never built, linted, or tested — despite CLAUDE.md describing it as holding "query
builders."

*Cheapest fix: add root `test`/`lint`/`typecheck` scripts delegating to the `:workspaces` variants,
and point the root tsconfig at the workspaces — or correct CLAUDE.md to name the real commands.*

### What the tests actually cover
**Cross-tenant isolation is tested — at four layers.** `fanout.test.ts:91` asserts "org A never
reaches org B" and runs with no infrastructure, as do the `graphOrgGuard` / `cypherOrgIdScan` and
Graph Query Service tests. `test_tenant_isolation.py:214` includes a negative control proving the
pre-fix pattern still leaks — that is the mark of a test suite someone actually thought about.

**8 modules have zero referencing tests.** The three that matter:

1. **`services/core/src/routes/mcpKeys.ts`** — all four endpoints carry `authorize('admin')`, and
   no test references this router. **Deleting that guard from 256-bit key issuance would break no
   test.** The service and the middleware are each well tested; only the wiring between them is
   unasserted. `routes/auth.integration.test.ts:235` already demonstrates the pattern to copy.
2. **`apps/web/app/workspace/state.tsx`** — 1023 lines, no behavioral test (33 of 38 `.tsx` files
   are untested overall).
3. **`apps/web/app/workspace/realtime.ts`** — the client half of the WebSocket path. The server
   half is thorough; the client half is unasserted.

Suite results as checked out, before any environment repair: pytest **7 collection errors**
(`ModuleNotFoundError: jwt`); `npm run test:workspaces` **`'turbo' is not recognized`**;
`node --test scripts/` **fails on Node v24** against an `.nvmrc` pinning Node 20. After repair:
625 passed / 19 skipped (Python), 7/7 turbo tasks, 48/48 script tests.

---

## Part 4c — Auth, data layer, and client

### Auth **[all CONFIRMS — no new auth holes]**
- **Login CSRF, still fully open** `[CONFIRMS C1]` — OAuth `state` is a self-issued JWT with no
  cookie or nonce binding to the browser (`auth/loginState.ts:77-87`, `routes/login.ts:17-25`). An
  attacker can force a victim's browser to complete the attacker's login flow, silently placing the
  victim inside the attacker's tenant.
- **Returning-user login is structurally broken in production** `[CONFIRMS C2]` — the pre-tenant
  `users` lookup runs outside `withOrgContext` against a FORCE-RLS table
  (`db/authUsers.ts:52-60` + `drizzle/0001_rls_and_role.sql:35-39`), so under a correct
  `NOBYPASSRLS` role it always returns null and every repeat sign-in 500s. The
  `SECURITY DEFINER` pre-tenant pattern this needs **already exists** for MCP key lookup.
- MEDIUM: no pre-auth throttle on MCP key verification (`mcp/gateway.ts:262-272`); the rate limiter
  never runs for `initialize`/`tools/list` (`mcp/toolExecution.ts:34-38`) and is process-local, so
  the contract's per-org limit multiplies by replica count (`mcp/rateLimit.ts:21-24`); a single
  `MCP_TOKEN_PEPPER` means rotation kills every key, contradicting `db/schema.ts:437-439`; BFF
  proxies mint/revoke MCP keys from the ambient cookie with no CSRF defense
  (`apps/web/app/api/mcp-settings/[[...path]]/route.ts:31-37`).

**Verified clean:** the MCP key crypto itself — 256-bit `randomBytes`, HMAC-only storage, one-time
return, `timingSafeEqual` — plus the double ceiling check at issuance *and* per request, revocation
and expiry re-checked every call, and all nine handlers genuinely thin.

### Data layer — **no injection anywhere**
Every query is parameterized (Drizzle `sql` templates / psycopg `%s`); Cypher labels interpolate
only from hardcoded tuples; no dynamic ORDER BY/table/column outside tests; both Neo4j executors
close sessions in `finally`.

- **HIGH · Deleting a user or org raises `check_violation`** `[NEW]` —
  `drizzle/0010_w4_02_agent_skill_md_versions.sql:18,79-81`'s `BEFORE UPDATE OR DELETE`
  immutability trigger fires on FK referential actions, so `ON DELETE SET NULL` (user) and
  `ON DELETE CASCADE` (repository, organization) all fail. Migration 0007 explicitly patched this
  same bug class for `mcp_client_keys`.
- **HIGH · Drizzle snapshots are 11 migrations stale** `[NEW]` — `drizzle/meta/` stops at `0007`
  while `_journal.json` has 18 entries. The next `npm run db:generate` re-emits `CREATE TABLE` for
  4 live tables and 7 `ADD COLUMN`s.
- **HIGH · Migrations fail on any non-empty DB** `[NEW]` —
  `drizzle/0006_w0_05_v2_reshape_and_new_tables.sql:44,48,60` does `ADD COLUMN ... NOT NULL` with
  no default. There are no down migrations anywhere in the repo.
- **HIGH · `pg.Pool` has no `'error'` listener** `[NEW]` — `db/client.ts:21-28`; an idle-client
  error becomes an uncaught exception and exits the process. Also no `max` or
  `connectionTimeoutMillis`, so exhaustion queues forever instead of failing fast.
- MEDIUM: no index matching the hot `permissions(org_id, subject_type, subject_id, action)` RBAC
  predicate, while 0002's composite index serves no query; hnsw + `WHERE` in
  `reference_match.py:176-194` post-filters into silent `no_candidates`; three separate `pg.Pool`s
  despite the codebase's own "do not create a second pool" contract.

### Web client — 0 CRITICAL, and **no client-side RBAC filtering** ✅
Every parser hard-requires `authorization: 'server-filtered'` and fails closed;
`onboardingTree.ts:201-206` even rejects responses where the server leaked an edge endpoint outside
the authorized node set. No Function/Class nodes reach canvas — all three parsers reject
non-`Folder`/`File` labels wholesale. No `dangerouslySetInnerHTML`, `innerHTML`, or `eval`
anywhere. Fetch races are handled consistently (AbortController + `active` flag on every effect).

- **HIGH · `javascript:` XSS via ticket/PR URLs** `[NEW]` — `app/lib/nodeOverlay.ts:188,204` puts
  URLs into `href` with no scheme check, rendered at
  `app/workspace/drawer/nodeModuleRenderers.tsx:145,290`. The sibling parser
  `app/lib/productTree.ts:163-174` **does** validate the protocol — same missed-consistency pattern.
- **HIGH · Session bearer token in `localStorage`** `[NEW]` — `app/lib/coreFetch.ts:9,19,30`.
  Redundant with the httpOnly `sayre_session` cookie every proxy already accepts; its only unique
  consumer is WS first-frame auth. Combined with the finding above, this escalates XSS to full
  session takeover.
- **HIGH · WebSocket reconnect + full graph refetch every 2.5s during an entire ingest** `[NEW]` —
  repository object-identity churn across `app/workspace/state.tsx:384-390`, `:726-736`, `:908-915`.
- MEDIUM: **no error boundary anywhere** despite many reachable throw sites; `/mock` ships as an
  unauthenticated production route with a state-manipulation control panel; the Product canvas
  rebuilds an O(features²) connection graph on every keystroke (`WorkspaceShell.tsx:543`).

### Core service-layer correctness — 0 CRITICAL
- **HIGH · A rejected promise is cached forever** `[NEW]` —
  `services/providerJobStateService.ts:63-68` uses `defaultDbPromise ??=`, so one transient
  secret/DSN failure permanently breaks the reader until restart. The identical twin at
  `db/installations.ts:57-65` (`getRuntimeDb`) backs nearly every store, making the blast radius
  *all Postgres access*. `packages/config/src/secrets.ts:138-143` already implements the correct
  eviction idiom.
- **HIGH · Dead-code verdicts are wrong on well-connected files** `[NEW]` —
  `services/livenessService.ts:70-93` derives its verdict from `overlay.dependencies`, which
  `graph-query/index.ts:1648-1650` already truncated to 128 entries sorted by *path*. A file with
  >128 combined edges can report `no_inbound_imports` while actively imported.
- **HIGH · Ticket cache and graph disagree permanently** `[NEW]` —
  `services/ticketSyncService.ts:97-127` runs `cache.upsert(write)` *before* `write.ticket` is
  replaced with the AI-inferred reference, so `ticket_cache` records `references: []` while the
  graph gets the link. Existing tests only assert the graph side.
- MEDIUM: `onboardingSandboxService.ts:87-100` reports a successful step as
  `status: 'timed_out'` on `maxBuffer` overflow; `repositoryCatalogService.ts:158-186` sorts an
  unbounded query then slices to 250, making later repos unreachable with no cursor.

**Verified clean:** zero `any`, `as unknown as`, `@ts-ignore`, or async-`forEach` in the entire
service directory. Note though that `noUncheckedIndexedAccess` is **off** in
`services/core/tsconfig.json` — every array index happens to be guarded, but the compiler isn't
checking.

### Repo hygiene — the `src/` vs `apps/web/` question, answered
**Not drift — a deliberate, documented split.** `src/` is the `trysayre.com` marketing site (Vite,
last touched 2026-07-21); `apps/web/` is the product (Next.js, 2026-07-27). Zero code coupling in
either direction; `apps/web/package.json` self-describes as "Distinct from the root Vite marketing
site"; `src/data/*` is fixture data for a *fictional* e-commerce repo, not drifted product logic.
The real problem is only that the root build/verification scripts belong to the marketing site
(Part 4b).

- **`.codex/` is 1.4 GB** of vendored blender-mcp plus stale logs, ignored only via machine-local
  `.git/info/exclude` — so the protection does not travel to teammates, and it is syncing through
  OneDrive continuously.
- **23 of 53 `src/` files are unreachable** by import-graph trace from `main.tsx`. Mostly a
  documented parked prototype, but `CanvasSandbox.tsx`, `HeroTreeScene.tsx`, and `heroTreeData.ts`
  are undocumented and zero-reference. 17 of the repo's 30 `eslint-disable` lines live in this dead
  tree.
- **`dist/` is clean** — `git ls-files dist` returns 0; never committed on any branch. Not a leak
  vector.
- **The uncommitted `.gitignore` change is safe — commit it.** Verified no tracked `infra/` file
  becomes ignored; it only adds coverage.
- **Debt is genuinely low:** 5 TODO/FIXME total, of which 2 are security *test fixture strings* and
  3 are stale domain TODOs already resolved in code — **zero real unfinished security paths**. One
  justified `@ts-expect-error` (in a test), **zero** `@ts-ignore`/`@ts-nocheck`, one non-test `any`,
  all tsconfigs `strict: true`.

---

## Part 4d — Python ingestion, and dependency risk

### Ingestion — 0 CRITICAL, and the hardened surfaces really are hardened
The areas the brief attacked hardest all held: scratch-clone cleanup is a context manager over
`tempfile.TemporaryDirectory`; path canonicalization rejects `..` and absolute paths; symlink
escape is caught by a `resolve()` + `is_relative_to` check that **also covers intermediate
symlinked directories**; every `subprocess` call is `shell=False` with validated argv and a
sanitized git env; no archive extraction exists; per-file parse failures are isolated; and `org_id`
always comes from the envelope, never the payload. No injection, no exfiltration, no traversal.

The damage is cost and correctness instead:

- **HIGH · Every full rebuild cascade-deletes every embedding for the ref** `[NEW]` —
  `ingestion/chunks.py:111-115`; `code_embeddings.chunk_id` is `onDelete: cascade`
  (`db/schema.ts:662-664`) and re-inserted chunks get new ids, so the `content_hash` dedup at
  `chunks.py:146` is **dead code**. Fires on every force-push, initial parse, and replayed
  delivery — meaning you re-pay for the entire repo's embeddings each time.
- **HIGH · The persistence contract is violated** `[NEW]` — `ingestion/chunks.py:62-64` sets
  `budget = len(text) - 1` for any file ≤12,000 chars, so "bounded" chunks store whole files minus
  one character. The comment's claim that a checkout cannot be reconstructed is false, and
  CLAUDE.md's "repository checkouts and source trees never persist" rule is not actually held. Its
  regression test (`tests/test_ingestion.py:618`) is satisfied by the `-1` alone.
- **HIGH · No cap on file count or aggregate bytes** `[NEW]` — `ingestion/repository.py:519-535`
  enforces only a 1 MB *per-file* limit; the whole repo is held in memory (pydantic-copied) through
  parse and graph write. OOM becomes a permanent poison message.
- **HIGH · Label-less `MATCH` in the CONTAINS edge write** `[NEW]` — `ingestion/graph.py:70-75`;
  every Neo4j index is label-scoped, so this is an `AllNodesScan` **twice per edge**. Every other
  edge query in the file labels both endpoints.
- **HIGH · `scripts/synthetic_graph_load.py:259,336` never awaits `neo4j_driver_from_env()`**
  `[NEW]` — the default real-Neo4j path crashes with
  `AttributeError: 'coroutine' object has no attribute 'session'`. Tests miss it because they only
  exercise `--simulate` and a sync monkeypatch.

### Dependencies
`npm audit` production (`--omit=dev`): **0 critical / 7 high / 8 moderate**. Full tree: 1 critical /
27 high / 15 moderate — the critical is dev-only (`vitest`).

- **Top production issue: `drizzle-orm@0.38.4` SQL injection via unescaped identifiers** — sitting
  directly in front of the RLS-enforced tenant tables. Note this does *not* contradict Part 4c's
  "no injection found": your query code is correctly parameterized; the advisory is in the library
  beneath it.
- **Your own pinning policy blocks the fixes.** The `.x` minor-pinning rule in `DEPENDENCIES.md`
  forbids the **non-major** patches available for `express`, `ws`, `bullmq`, and
  `@modelcontextprotocol/sdk`. Relaxing those four clears 4 production advisories at near-zero risk.
- `next@14.2.x` carries 21 advisories (SSRF, cache poisoning, XSS, middleware bypass) and needs a
  major migration — plan it, don't rush it.
- Checked and cleared: `graphifyy==0.9.16` is **not** a typosquat. The double-`y` is deliberate,
  documented in three places, hash-locked, and guarded by a vendor-isolation test. It does pull ~28
  transitive packages into production for one imported function, which is worth revisiting on cost
  grounds alone.

---

## Part 5 — Governance gaps

- **The pipeline read-only guarantee is fiction** `[NEW]` — `CLAUDE.md` states `review` and
  `security-checker` are read-only "enforced by hook." `.claude/settings.json` is 47 bytes,
  `{"permissions":{"deny":[]}}`, **no hooks**. `scripts/validate-pipeline-only-write.sh` is
  orphaned. **Verified directly.**
- **The security-audit validators never run** `[NEW]` — `check:security-audit-agents`,
  `check:security-audit-run`, `test:security-audit-run` exist in `package.json:19-21` and are absent
  from `ci.yml`. Their only trigger is an LLM subagent choosing to call them. Note the recursion:
  `validate-security-audit-agents.mjs:96-106` is the script that asserts the security pipeline is
  still wired to its registry — so the check that detects broken wiring only runs when the wiring
  works.
- **`security-attacker-agents/` has never run against this surface** — nine well-structured
  adversarial briefs, referenced only by `.claude/agents/security-checker.md`, never by CI. Its
  `supply-chain-infrastructure-attacker.md` (SC-01..SC-14) covers exactly the surface where P0-1
  through P0-4 live. Had it ever run, most of Part 1 would already be known.
- **No `permissions:` block in `ci.yml`** — `GITHUB_TOKEN` inherits the repo default while running
  `npm ci` / `poetry install`. (Trigger is `pull_request`, not `pull_request_target` — that
  particular hole is absent.)
- **`vercel.json` has no `headers` key** — no CSP, HSTS, X-Frame-Options, or nosniff.
- **Zero Dockerfiles, zero `.dockerignore`** `[CONFIRMS B1]` — no defined deployment path for core,
  gateway, or the Python fleet.
- **Dev backdoor is one env var from a full bypass** `[CONFIRMS C6]` — `NODE_ENV=development`
  grants unauthenticated `roles:['owner']` on all 28 endpoints *and* silently no-ops the RLS startup
  guard (`http/authenticate.ts:57-61`, `security/assertRuntimeRoleRlsSafe.ts:39`). Contained today
  only because `DEV_ORG_ID` defaults to a non-UUID that fails closed downstream
  (`packages/config/src/config.ts:67`). Set it to a real org UUID and it is a full unauthenticated
  org bypass.

---

## Part 6 — What is actually solid

Stated explicitly because an audit that only lists defects misrepresents the codebase, and because
these are the invariants worth *not* breaking during cleanup.

- **No request-reachable cross-tenant leak or auth bypass was found**, by three agents that each
  looked for one from a different angle.
- **0 of 28 endpoints are missing an appropriate authorization check. No IDORs.** Seven endpoints
  are unauthenticated, all by design, each anchored to a signed HMAC/JWT or genuinely public.
- **`assertOrgScopedCypher` uses a single-pass lexer**, not composed regexes — a deliberately
  robust choice. Every Cypher constant is org-scoped *and* re-verified in the TS mapper.
- **`withOrgContext` does `SET LOCAL ROLE` before `set_config`**, so RLS genuinely engages. Every
  failure branch in the permission store returns `EMPTY_SCOPE` (fails closed).
- **Retrieval tenant isolation is a true pre-filter** — `org_id` is bound into the SQL WHERE clause
  (`retrieval/store.py:106,156`) and structurally excluded from `RetrievalQuery`
  (`models.py:30-38`) so it cannot be client-supplied. There is no top-k vector search in the
  retrieval path at all; chunks are fetched by node id from an already-authorized traversal, making
  k-slot leakage architecturally impossible.
- **The WebSocket per-push RBAC re-filter is correctly implemented and tested** —
  `fanout.ts:44-60` calls Core per connection per event; `coreClient.ts:41-58` forwards the
  client's own bearer token and never sends `org_id`; `realtimeInternal.ts:31-44` re-authenticates
  and re-derives org server-side; expiry is re-checked so a revoked session 401s on the next push.
  Proof at `e2e.test.ts:199-234`.
- **Webhook signature verification is correct** — present, runs first, constant-time, uses the raw
  body, rejects a missing header. Clone URL is host-pinned; git runs via argv (no shell); cleanup is
  in `finally`.
- **The route layer's architectural discipline is real and mechanically enforced** — the
  `src/routes/**` ESLint import gate blocking `pg`/`drizzle-orm`/`neo4j-driver`/`bullmq`/`ioredis`
  is tested. No `org_id` from client input, no body-spread into a write, no SSRF surface.
- **The permanent BullMQ/SQS fleet split is respected.** All six SQS queues have DLQs with
  `maxReceiveCount=5`. FIFO group hashing is byte-identical across Node and Python.
  `initialParseOutboxDispatcher.ts` is well-built — leases, bounded exponential backoff,
  at-least-once by design.
- **CI runs the two secret-access gates before `npm ci`**, so no package lifecycle code executes
  first. A thoughtful supply-chain detail.
- **Config and telemetry are clean** — no insecure secret defaults, strict `env://` grammar with an
  allowlist, empty values rejected; telemetry captures no prompts, code, embeddings, or secrets.

---

## Part 7 — Cross-cutting patterns

Four patterns explain most of the defect population better than any individual finding.

1. **Silent failure is the default.** The Jira triple-break, `linkedNodes: 0`, the swallowed
   `provider_error`, `attempts: 1` after a 202, the 256 KB SNS failure landing between commit and
   publication — none surface an error to anyone. The codebase has good *enforcement* and almost no
   *alarming*.
2. **Comments assert guarantees the code doesn't provide.** `server.ts:73-75` and
   `consumer.ts:22-23` on SQS redelivery; `ticketSyncService.ts:116-123`'s "never blocks";
   `CLAUDE.md`'s hook enforcement. Each one actively misleads the next reader.
3. **Mock-at-the-seam testing encodes bugs as expected behavior.** `test_onboarding_plan.py:107`
   locks in the temperature bug; the D2 test mocked the enqueue call. Every seam where a real bug
   was found is a seam no test crosses.
4. **The fix usually already exists one directory over.** `get_subprocess_environment()` vs the
   coverage runner; `jiraConnect.ts:40-46`'s array-param validation vs `login.ts`/`githubInstall.ts`;
   `org_scoped_connection` vs `retrieval/store.py`; `appClient.ts`'s timeouts vs `oauthClient.ts`.
   These are consistency gaps, not knowledge gaps — which makes them cheap.

---

## Part 8 — Suggested order of work

1. **First, 2 minutes:** commit the `.gitignore` change. It is verified safe, and until it lands,
   one `git add -A` publishes 13 live secrets including `JWT_SIGNING_KEY`.
2. **Today, ~30 minutes:** P0-1 through P0-4 — unauthenticated Redis, `0.0.0.0` datastore binds, the
   missing WS `'error'` listener, the gateway `NODE_ENV` crash. All config or two-line changes with
   disproportionate blast radius.
3. **Today, separately:** move `infra/New Text Document.txt` out of the synced tree and rotate all
   13 secrets, using the `SECRETS.md` re-encrypt/reissue path for `JWT_SIGNING_KEY`,
   `JIRA_TOKEN_ENC_KEY`, and `MCP_TOKEN_PEPPER`.
4. **Today, one check:** confirm why `check:secret-access` is red on `main` yet merges landed
   (P0-6). A security gate that fails without blocking is worse than no gate.
5. **This week — restore your feedback loop.** Add root `test`/`lint`/`typecheck` scripts delegating
   to the `:workspaces` variants and repoint the root tsconfig. Everything below is easier once
   `npx tsc --noEmit` stops passing vacuously. Then get Python 3.12 + poetry installed so the 140
   unverified worker files can actually run — that is where a disproportionate share of the
   remaining CRITICALs live.
6. **Before any demo:** the SNS 256 KB cap (Part 4), the enrichment spend caps (Part 3), and the
   embedding cascade-delete (Part 4d). All three fire precisely when you point the product at an
   impressively large repo.
7. **Before calling Jira sync shipped:** one integration test crossing the poll→graph seam, *then*
   the three silent breaks. Writing the test first is what stops break #4 from shipping.
8. **Before trusting the pipeline again:** wire the hooks `CLAUDE.md` already claims exist, and add
   the three security-audit validators to CI.
9. **Deliberate, not urgent:** relax the four `.x` pins blocking security patches; fix the
   persistence-contract violation in `chunks.py:62-64`; plan the `next@14` major migration;
   Dockerfiles (B1) remain the gate on everything deployable.

---

*Companion to `docs/architecture-assessment-2026-07.md`. Per-agent reports with full evidence are in
the session scratchpad as `audit-NN-*.md`.*
