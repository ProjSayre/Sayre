# Tenant Isolation — Invariant & Threat Model

> Ticket: **W2-06 — Tenant isolation enforcement**. This is the single referenceable
> contract for tenant (`org_id`) isolation across every store Sayre touches. Every
> future data-touching ticket, and the adversarial attacker-agent evaluation that
> follows W2-06, should read this file first. It documents *what* provides the
> isolation guarantee at each layer, *why* that mechanism is trusted, and — for the
> one store where the guarantee is structurally weaker — the explicit residual risk.

## The invariant

`org_id` is:
1. **Server-resolved, never client-supplied.** The only two legitimate sources are
   `requireOrgId(req)` (Node REST — `services/core/src/auth/context.ts:72`, itself
   backed by `AuthContext.orgId`, populated by `authenticate()` from a verified
   bearer token) and `GraphScope.org_id` (Python worker jobs — derived from the
   server-controlled message envelope, never from a message `payload`). No code path
   may read `org_id` from `req.query`, `req.body`, a request header (`X-Org-Id`,
   `X-Tenant`, etc.), or a message `payload`.
2. **Stamped on every graph write and injected server-side on every graph read**
   (`.claude/rules/graph-schema.md`, `.claude/rules/security-multitenancy.md`).
3. **Enforced with defense in depth**: an explicit app-layer filter (a `WHERE org_id`
   clause, a Cypher `$org_id` predicate, W2-02's RBAC allow/deny rules) is kept *in
   addition to*, never *instead of*, an engine- or guard-level backstop that still
   holds if that app-layer filter is bypassed, forgotten, or removed at a lower layer.

The rest of this document is the per-store realization of that invariant, followed by
the one place (Neo4j, Community edition) where the backstop is weaker than Postgres's,
and exactly what W2-06 does to floor that gap.

## Per-store matrix

| Store | How `org_id` is server-resolved | Primary control | Defense-in-depth backstop | Residual risk |
|---|---|---|---|---|
| **Postgres (Node)** | `requireOrgId(req)` → passed into `withOrgContext(db, orgId, fn)` (`services/core/src/db/client.ts:73`) | Explicit `WHERE`/`org_id` column on every query | **Row-Level Security**, `ENABLE`+`FORCE`, policy `USING/WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid)` on all 13 tenant tables (`drizzle/0001,0004,0007_*.sql`); engaged only because `withOrgContext` first runs `SET LOCAL ROLE sayre_app` (`NOLOGIN NOBYPASSRLS`, non-owner) before setting `app.org_id` — RLS is a real engine-level backstop that holds even if the app-layer filter is dropped, **as long as the session is running as `sayre_app`** | None once `SET LOCAL ROLE sayre_app` executes; residual risk is entirely in DSN provisioning (see below) |
| **Postgres (Python workers)** | `GraphScope.org_id` (ingestion) / job-scoped `org_id` (embeddings) → passed into `org_scoped_connection(dsn, org_id)` (`services/workers/sayre_workers/db/session.py`) | Explicit `WHERE org_id = %s` clause kept on every statement in `chunks.py`/`state.py` (belt *and* suspenders — not replaced) | Same RLS policies as above, engaged by `org_scoped_connection`'s own `SET LOCAL ROLE sayre_app` — **this was a live gap before W2-06** (see "Finding 1" below); now mirrors `withOrgContext` exactly | Same DSN-provisioning risk as the Node path, mitigated by `assert_runtime_role_rls_safe` (Resolved decision Q2) |
| **pgvector (`code_chunks`/`code_embeddings`)** | Same as the Python-worker Postgres path above — these are ordinary RLS-protected tables, not a separate store | Explicit `org_id`/`ref_id`/`chunk_id` predicates on every read/write | Same RLS backstop as any other tenant table | **Logical namespace only** (Resolved decision Q1): `org_id` column + RLS + org-scoped connection *is* the per-tenant namespace for launch; physical per-tenant indices/tables/schemas are deferred to the OpenSearch-era migration (`docs/migration-triggers.md`). No cross-org `graph_node_id` collision risk: `org_id` is part of every composite key, so the same `graph_node_id` string in two orgs is never merged. |
| **Neo4j (write path)** | `orgId` argument to `GraphWriteExecutor.run` (`services/core/src/graph-write/neo4j.ts:14`), sourced from `ctx.orgId` / `input.orgId` by every caller | Every write Cypher literal filters/merges on `{org_id: $org_id}` (`ingestion/graph.py`, `graphOwnershipStore.ts`, `graphTicketStore.ts`) | **No engine-level RLS on Neo4j.** The backstop is `assertOrgScopedCypher` (`services/core/src/security/graphOrgGuard.ts`), called as the first statement inside `InstrumentedNeo4jWriteExecutor.run`, fail-closed if the Cypher omits `$org_id` or `params.org_id` doesn't strictly equal the server-resolved `orgId` | See "Neo4j has no engine backstop" below |
| **Neo4j (read path)** | `orgId` argument to `GraphReadExecutor.run` (`services/core/src/graph-query/neo4j.ts:16`, W2-02), sourced from `ctx.orgId` by all three `RbacGraphQueryService` methods | Every read query filters on `node.org_id = $org_id` / `edge.org_id = $org_id` (`GET_NODES_IN_VIEWPORT_CYPHER`, `GET_STRUCTURAL_EDGES_CYPHER`, `GET_AFFECTED_NODES_CYPHER`) | Same `assertOrgScopedCypher` guard, called as the first statement inside `InstrumentedNeo4jReadExecutor.run` — **new in W2-06**; W2-02 shipped this executor with the identical structural gap the write executor had (guard call-site is a firm requirement, Resolved decision Q4) | See "Neo4j has no engine backstop" below |

## Neo4j has no engine backstop — the documented residual risk

Postgres has a real, engine-enforced backstop (RLS) that holds even when the
application forgets a `WHERE` clause, *as long as the session is running under the
correct role*. **Neo4j Community has no equivalent.** It has exactly one user
(`neo4j`), no roles, no RBAC, and a single database — there is no per-tenant
row-level filter the engine itself can enforce. Everything that protects tenant
isolation on the graph store lives in application code sitting *above* the driver.

W2-06 delivers the strongest **Community-achievable floor**, in layers:

1. **`assertOrgScopedCypher`** (`services/core/src/security/graphOrgGuard.ts`) —
   fail-closed on both executors: throws `GraphOrgScopeError` unless the Cypher
   references `$org_id` as part of an actual property-match/filter predicate
   (`org_id: $org_id` / `x.org_id = $org_id`), **outside of any Cypher comment
   and outside of any quoted string literal**, *and* `params.org_id` is a UUID
   that **strictly equals** the server-resolved `orgId` (Resolved decision Q5:
   assert-only, never auto-inject or rewrite — auto-injection can mask a query
   that forgot to reference `$org_id` while still binding the parameter, which
   is exactly the failure the guard exists to catch). A raw substring check
   (`cypher.includes('$org_id')`) was proven bypassable across three
   consecutive adversarial rounds: a `//`/`/* */` comment-only mention
   (FND-5da52fce61f4), a decoy string literal containing the predicate text
   with no real filter (Gap 1, remediation-verification pass #2), and —
   because Gap 1's own fix composed two *independent* global regex passes
   (one for double-quoted literals, one for single-quoted) with no shared
   "which quote type is open" state — a cross-quote-type desync where a
   single-quoted literal containing an embedded, unescaped double-quote
   character (ordinary content, not contrived) positioned before a genuine
   double-quoted decoy caused the decoy to survive unstripped (Gap 3, third
   remediation round). After three rounds of the same function producing a
   structurally-similar escape, the fix is now a **single linear left-to-right
   state-machine scan** (`stripCypherNoise`) that tracks exactly one active
   lexical mode at a time — double-quoted string / single-quoted string / line
   comment / block comment / code — instead of composable independent regex
   passes that can desync against each other. This closes the *class* of bug
   (two passes losing track of what the other pass already consumed), not
   just the three specific reported instances.
2. **Mandatory `org_id` parameter, checked per call** — not a one-time schema
   constraint, because Neo4j has no schema-level way to require it.
3. **A static Cypher scan** (`services/core/src/security/cypherOrgIdScan.test.ts`) —
   every Neo4j-targeting Cypher literal across Node write-side
   (`graph-write/**`, `integrations/**`), the read-side query constants exported
   from `graph-query/index.ts`, and the Python ingestion writer
   (`sayre_workers/**`) is asserted to reference `org_id`, so a future query that
   forgets it fails the build before it ships, not at runtime.
4. **Driver/session chokepoint fitness test** (Resolved decision Q3, option 1;
   `services/core/src/security/neo4jChokepoint.test.ts`) — the PRIMARY gate is an
   import-based check (`importsNeo4jDriverPackage`): any non-allowlisted file that
   imports/requires the `neo4j-driver` package at all — under any local alias,
   namespace import, `require()`, or a *literal* dynamic `import()` — fails the
   build. A SECONDARY, defense-in-depth substring scan additionally confines the
   `neo4j.driver(`, `neo4j.auth`, and `.session(` call-site markers to
   `graph-write/neo4j.ts` and `graph-query/neo4j.ts`. A THIRD, fail-closed check
   (Gap 2a, remediation-verification pass #2) flags any dynamic `import(...)` call
   in a non-allowlisted file whose specifier is *not* a single literal string (e.g.
   a specifier built via string concatenation and stored in a variable before being
   passed to `import()`) — a static scanner cannot prove what a computed specifier
   resolves to, so "cannot prove it's safe" is treated as a violation. Together,
   the only two places in the Node codebase that can construct a driver or open a
   session are the two guarded executors — a new bypass path (a third module
   talking to Neo4j directly, including via a computed dynamic-import specifier) is
   a failing build.

   **Third remediation round — structural rewrite (Gap 4a/4b/4c, 2026-07-23):**
   the PRIMARY and THIRD checks above were originally regexes
   (`NEO4J_DRIVER_IMPORT_RE`, `STATIC_LITERAL_DYNAMIC_IMPORT_RE`/
   `ANY_DYNAMIC_IMPORT_RE`) that only tolerated `\s*` — or, in the
   dynamic-import/`require` branches, no whitespace at all — between the
   `import`/`require` keyword and its `(`. A single space
   (`import ('neo4j-driver')`, `require ('neo4j-driver')`) or a `/* ... */`
   comment in that position (`import/* webpackIgnore: true */(modName)`)
   defeated one or both checks, on a real, unobfuscated import of the actual
   package. Fixed by replacing both checks with an AST walk using the
   `typescript` package's own parser (already a `services/core`
   devDependency — no new dependency added): `ts.createSourceFile` tokenizes
   exactly like the real compiler, so whitespace and comments are trivia
   attached to tokens, never part of the token stream, and cannot be used to
   dodge an `ImportDeclaration`/dynamic-`import()`-call/`require()`-call
   check. This closes the whitespace/comment-placement escape dimension as a
   *category*, not just the three reported shapes.

   **Documented residual (Gap 2b, precondition-dependent, NOT currently
   exploitable, accepted rather than fixed):** the chokepoint's guarantee partially
   depends on `graph-write/neo4j.ts` and `graph-query/neo4j.ts` never re-exporting a
   raw driver/session-capable value (a constructed `Driver` instance, or
   `export { default as ... } from 'neo4j-driver'`). If either file were ever
   changed to do so, a third file could import that re-export instead of
   `'neo4j-driver'` directly (defeats the PRIMARY import check, which only matches
   a direct `'neo4j-driver'` specifier) and reach the session via a computed/bracket
   property key (defeats the SECONDARY marker scan and the Gap 2a dynamic-import
   check, since the import itself would be an ordinary static ES import, not a
   dynamic one). This is true today but is enforced only by a single, non-generic
   regex assertion in `neo4jChokepoint.test.ts`
   (`[Gap 2b, TESTER-FOUND, sanity]`) confirming neither allowlisted file currently
   re-exports the raw driver — not by a generic structural check. Recorded here so
   the dependency is explicit rather than implicit; not fixed this pass because the
   precondition it depends on does not exist in the codebase today.
5. **W2-02's app-layer RBAC filter** (`RbacGraphQueryService`/`permissions.ts`,
   `canReadResource`, the `$allow_rules`/`$deny_rules` predicates) sits as an
   *additional* net above the tenant guard. It answers a different question — "does
   this org see exactly the nodes it's permitted to" — and is **not** a substitute
   for the tenant-isolation backstop; W2-06 does not re-verify or modify that logic
   (see `.pipeline/spec.md` Scope — explicitly out of scope).

**What this floor does *not* achieve — options considered and deferred (Resolved
decision Q3):**

- **Per-org Neo4j user/role/database** — not available on Community (multi-user,
  RBAC, and multi-database are Enterprise-only features). This is the real engine
  analog of Postgres RLS and is an edition limitation, not an implementation gap.
  It lands with an Enterprise upgrade or the Neptune migration
  (`docs/migration-triggers.md`).
- **One Neo4j instance per org** — genuine engine isolation on Community, but
  operationally heavy (N orgs = N processes/ports/backups); contradicts the
  single-graph launch topology. Recorded as the escape hatch for a customer that
  contractually requires engine-enforced graph isolation before Neptune: a
  dedicated single-tenant deployment.
- **Automatic `org_id` query rewriting** — rejected (Resolved decision Q5): brittle
  openCypher parsing, and it can mask a query that forgot to reference `$org_id`
  while still binding the parameter. Strictly weaker than assert-only.

**Bound the adversarial reviewer should know:** for Neo4j, "isolation holds even if
the middleware is bypassed" is bounded by "the driver chokepoint / guard is not
itself bypassed." W2-06 makes that bound a build-enforced invariant (the fitness
test), but it is not equivalent to Postgres's engine-level guarantee. True
engine-level Neo4j isolation is explicitly deferred to Enterprise, Neptune, or a
dedicated single-tenant instance — not delivered by this ticket.

**What the third remediation round does and does not prove.** The chokepoint
check (`importsNeo4jDriverPackage`/`hasNonLiteralDynamicImport`) is now a real
AST walk over the actual TypeScript grammar via the `typescript` compiler
package — for the specific question "does this file import/require
`neo4j-driver`, or contain a dynamic `import()` call with a non-literal
argument," it is structurally sound, not a textual heuristic, and closes
whitespace/comment placement as an escape dimension by construction. The
Cypher predicate check (`referencesOrgIdPredicate`/`stripCypherNoise`) is
*not* a full openCypher parser — it is a single linear lexical scan (quote/
comment-aware, unlike its predecessor) followed by a regex over the result.
It closes the specific bug class three rounds of adversarial testing
converged on (independent passes desyncing against each other), but it is
still a heuristic over Cypher's lexical grammar, not a semantic parse of
Cypher's expression grammar. The honest residual is: "an as-yet-undiscovered
lexical or semantic variant" remains a possible category for the Cypher
check specifically, even though the three concretely-demonstrated bypass
shapes (comment-only, decoy string literal, cross-quote-type desync) are now
closed as a *class*, not merely as three individual patches.

## Forged-`org_id` rejection guarantee

A client can supply `org_id` in a query string, JSON body, header, or (for workers) a
message `payload`, at any tenant-facing surface. It is never used:

- **HTTP:** `requireOrgId(req)` reads only `req.context.orgId`, itself set by
  `authenticate()` from a verified, signed bearer token — never from
  `req.query`/`req.body`/headers. Routes never read `org_id` from anywhere else
  (e.g. `parseViewport`/`http/viewport.ts` deliberately never reads org at all).
- **Worker jobs:** `GraphScope.org_id` is derived from the server-controlled message
  envelope. A forged `org_id` in a job's `payload` is never read for this purpose
  (mirrors the W2-05 enrichment path's forged-payload-org_id case).
- **Neo4j reads specifically:** even if a caller managed to construct a
  `params.org_id` that diverges from `ctx.orgId` (e.g. `run("A", …, { org_id: "B" })`),
  `assertOrgScopedCypher` throws rather than executing — `ctx.orgId` is authoritative
  and a divergent `params.org_id` cannot win.

If two different forged values are supplied simultaneously (query says B, body says
C, token says A), the resolved value is always A — B and C never reach a query,
because there is exactly one code path (`requireOrgId`/`GraphScope`) that produces
the value every downstream read/write uses.

## DSN-role provisioning risk (Resolved decision Q2)

Both `withOrgContext` (Node) and `org_scoped_connection` (Python) unconditionally run
`SET LOCAL ROLE sayre_app` before setting `app.org_id`, so RLS engages regardless of
which role the DSN's connection logs in as — this is the in-code guarantee and it is
unconditional. As an **early-warning, defense-in-depth** measure on top of that
guarantee, `assert_runtime_role_rls_safe(dsn)` (Python:
`services/workers/sayre_workers/db/session.py`; Node:
`services/core/src/security/assertRuntimeRoleRlsSafe.ts`) queries `pg_roles` for the
resolved `DATABASE_RUNTIME_URL` login role and fails closed if that role can bypass
RLS (`rolsuper`/`rolbypassrls`) or lacks the PostgreSQL `SET` privilege for
`sayre_app` (i.e. `SET LOCAL ROLE sayre_app` would fail at every call).
Generic role membership is insufficient because PostgreSQL 16 memberships can
be granted with `SET FALSE`. This assertion is invoked once at service startup
(`sayre_workers/ingestion/runtime.py`'s `build_ingestion_service`/
`build_embedding_consumer`; `services/core/src/index.ts`) and is deliberately a
**CI/production gate, not a local-dev block**: local dev's login role (`sayre_dev`,
per `infra/.env.example`) is intentionally a superuser, so the assertion is a no-op
unless `SAYRE_ENV`/`NODE_ENV` indicates `ci` or `production`.

### GitHub installation bootstrap lookup

GitHub webhook routing has one pre-tenant bootstrap problem: the signed provider
payload supplies an installation id, and Sayre must resolve that id to `org_id`
before it can establish ordinary tenant context. A direct query through
`DATABASE_RUNTIME_URL` is intentionally useless under FORCE RLS when
`app.org_id` is unset.

Migration `0011_github_installation_resolver.sql` supplies a narrow database
boundary instead of an admin connection or a general RLS bypass:

- `sayre_installation_resolver` is `NOLOGIN`, `NOINHERIT`, and `NOBYPASSRLS`,
  has no role memberships, and can select only `installation_id`, `org_id`,
  `suspended_at`, and `revoked_at`;
- one SELECT-only RLS policy exposes installation rows to that role;
- one `SECURITY DEFINER` SQL function accepts only a bigint installation id and
  returns only `org_id` and the derived `active` boolean;
- `PUBLIC` cannot execute the function; `sayre_app` can invoke that function but
  still cannot directly read another tenant's installation rows.

`resolveInstallationOrg` explicitly drops to `sayre_app`, clears ambient
transaction-local org context, and calls only that function. Core startup runs
`assertInstallationResolverReady` in every environment and refuses to listen if
the migration, ACLs, owner attributes, column grants, or operational function
call are missing or widened. No additional DSN or secret is required.

## Fail-closed posture (all stores)

- Unset or empty-string `app.org_id` → zero rows, every write rejected (Postgres,
  both languages — the `nullif(current_setting('app.org_id', true), '')::uuid` idiom
  means empty-string never raises an invalid-uuid cast error; it just resolves to
  `NULL`, which matches nothing).
- A valid-but-nonexistent org UUID → zero rows (Postgres); the Neo4j guard has no
  equivalent "unknown org" concept since it does not query existence, only equality
  of the bound parameter to the server-resolved id.
- Missing/absent/non-UUID `params.org_id` on either Neo4j executor →
  `GraphOrgScopeError`, nothing executes.
- `SET LOCAL ROLE`/transaction-local `set_config` are both transaction-scoped: after
  the enclosing transaction ends, no stale role or org context survives into a reused
  pooled connection.

## Explicitly not re-litigated by this doc

- **W2-02's node-level RBAC correctness** (`canReadResource`, the `$allow_rules`/
  `$deny_rules` predicate logic) is a distinct, orthogonal concern: "does an
  authorized org see exactly its permitted nodes" vs. this doc's "no query can run
  without being org-scoped at all." W2-06 does not modify or re-verify W2-02's
  authorization logic.
- **Schema-anchor sentinel org** (`00000000-0000-0000-0000-000000000000`,
  `packages/graph-schema/schema.md` "Schema-anchor nodes") is a deliberate,
  migration-time-only exception — it appears exclusively in
  `services/workers/graph-migrations/001_init_node_labels.cypher` and
  `002_init_edge_types.cypher`, and is asserted (by
  `cypherOrgIdScan.test.ts`) to never appear in a runtime query.
- **MCP agent-key auth and its symmetric pen-test** is W4-06, explicitly built after
  W2-06 as "symmetric with W2-06's" per the PRD ticket ordering.

## Findings this ticket closed (for historical/audit reference)

- **Finding 1 (closed):** `PostgresChunkStore._connect` (`chunks.py`) and
  `PostgresRefStateStore.lock` (`state.py`) both called `set_config('app.org_id', ...)`
  but never `SET ROLE sayre_app` — RLS was a silent no-op on that path whenever the
  runtime DSN resolved to a privileged role. Both now route through
  `org_scoped_connection`, which mirrors `withOrgContext` exactly (role drop before
  org context, every time).
- **Finding 2 (unchanged, verified correct):** `withOrgContext` (`client.ts:73`)
  already did this correctly; W2-06 added the adversarial "filter-removed" framing
  and forged-`org_id`-over-HTTP tests around it without modifying the mechanism.
- **Finding 3 (closed):** `chunks.py` used `is_local=false` (session-scoped)
  `set_config`; `state.py` used `is_local=true` (transaction-scoped). The shared
  `org_scoped_connection` helper standardizes on transaction-local, eliminating any
  risk of a pooled connection carrying stale org context into its next checkout.
- **Finding 4 (closed for both executors):** `graph-write/neo4j.ts` took `orgId`
  purely for telemetry, with nothing binding it to the query; W2-02's newly merged
  `graph-query/neo4j.ts` shipped with the identical gap. Both executors now call
  `assertOrgScopedCypher` as the first statement inside their instrumentation
  callback, before the session is opened.
