# Audit 01 — Tenant Isolation & RBAC Enforcement

**Scope:** `services/core/src/services/` (64 files), `services/core/src/graph-query/`, `services/core/src/security/`, plus the call sites they depend on (`db/`, `http/`, `auth/`, `mcp/`, `routes/`, `integrations/`, `graph-write/`).

**Headline:** the core enforcement machinery is genuinely well built and I could not find a request-reachable cross-tenant leak or auth bypass. `assertOrgScopedCypher` (a single-pass lexer, not a stack of regexes) gates both Neo4j executors; every Cypher constant embeds an `org_id` predicate *and* the TypeScript mappers re-check org/repo/ref/revision and re-run `canReadResource` as defense in depth; `withOrgContext` does `SET LOCAL ROLE sayre_app` before `set_config`, so RLS actually engages. That is not the norm for an unreviewed MVP.

What I did find are **5 real defects**, all of them structural/consistency gaps rather than live exploits — plus one out-of-scope functional bug I tripped over. Ordered most severe first.

---

### [SEVERITY: HIGH] Unscoped, non-chokepointed read of the tenant `users` table in the authentication path

- **File:** `services/core/src/db/authUsers.ts:52-60`
- **Code:**
```ts
const rows = await db
  .select({
    userId: users.id,
    orgId: users.orgId,
    orgRole: users.orgRole,
  })
  .from(users)
  .where(eq(users.externalAuthId, externalAuthId))
  .limit(1);
```
- **Why it's wrong:** This is the only place in application code that reads a tenant-scoped table with **no `withOrgContext`, no `org_id` predicate, and no SECURITY DEFINER chokepoint**. Every other pre-tenant lookup in this codebase goes through a migration-owned, column-constrained resolver: `db/installations.ts:36-43` (`resolve_github_installation_org`), `db/jiraPollDiscovery.ts:28-34` (`list_active_jira_connection_org_ids`), `db/mcpKeyStore.ts:114-121` (`resolve_mcp_client_key`), `db/githubInitialParseOutbox.ts:119-129`. This one just queries `users` globally on a pooled connection outside any transaction.

  The file's own header (lines 8-19) labels this a "PRODUCTION GAP", but the consequence is understated. Two concrete failure scenarios:

  1. **Correctly-provisioned production** (login role is NOBYPASSRLS, as `security/assertRuntimeRoleRlsSafe.ts` demands): `app.org_id` is unset on this connection, so the RLS policy matches nothing and the query returns zero rows for *every* returning user. `loginService.ts:180` then treats a returning user as brand-new, tries to insert, hits the global `users_external_auth_id_unique` constraint, re-resolves (null again), and rethrows at `loginService.ts:216`. **Every returning user's login 500s.** Fails closed, but the production login path is broken.
  2. **Mis-provisioned production** (DSN accidentally points at a superuser/BYPASSRLS role — precisely the risk `assertRuntimeRoleRlsSafe` exists to catch, and which it *skips* outside `NODE_ENV=production`/`CI=true`): this becomes an unaudited, unrestricted read of the `users` table with no structural boundary limiting it to the three columns it needs.
- **Fix:** Add a `resolve_user_by_external_auth_id` SECURITY DEFINER function mirroring migration 0011's `resolve_github_installation_org` (NOLOGIN/NOBYPASSRLS owner, returns only `user_id`/`org_id`/`org_role`), and call it through the same `set local role sayre_app` + `set_config('app.org_id','',true)` transaction shape the other three resolvers use.

---

### [SEVERITY: MEDIUM] One env var (`NODE_ENV`) simultaneously enables unauthenticated owner access and disables the RLS-role startup guard

- **File:** `services/core/src/http/authenticate.ts:57-61`, `services/core/src/services/authService.ts:40-51`, `services/core/src/security/assertRuntimeRoleRlsSafe.ts:39`
- **Code:**
```ts
// http/authenticate.ts:57 — no bearer token required
if (isDevOrTestEnvironment()) {
  req.context = devSessionContext();
  next();
  return;
}

// services/authService.ts:45-50 — synthesized context is a full org owner
return {
  subjectType: 'user',
  userId: getConfig('DEV_USER_ID'),
  orgId: getConfig('DEV_ORG_ID'),
  roles: ['owner'],
};

// security/assertRuntimeRoleRlsSafe.ts:39 — same var, opposite direction
return getOptionalConfig('NODE_ENV') === 'production' || getConfig('CI') === 'true';
```
- **Why it's wrong:** `NODE_ENV=development` on a deployed instance does two things at once, and nothing in the codebase notes the coupling: (a) **every unauthenticated request** to any `authenticate()`-gated route gets `roles: ['owner']` for `DEV_ORG_ID`, and `PostgresPermissionStore.getReadScope` (`graph-query/permissions.ts:303`) short-circuits owners to `OWNER_SCOPE` — full read of that org's graph with no credential; and (b) the startup assertion that the runtime DSN's login role cannot bypass RLS silently no-ops, so the *other* backstop is gone at the same moment.

  Today this is contained because `DEV_ORG_ID` defaults to the non-UUID `'org_dev_local'` (`packages/config/src/config.ts:67`), which `withOrgContext` (`db/client.ts:78`) and `assertOrgScopedCypher` (`security/graphOrgGuard.ts:246`) both reject. **That containment is accidental, not designed** — the moment anyone sets `DEV_ORG_ID` to a real org UUID (the natural thing to do when developing against a seeded database) and that `.env` reaches a deployed host, this is an unauthenticated full-org-owner bypass reachable from a plain HTTP request.
- **Fix:** Make `devSessionContext()` refuse to return a context whose `orgId` is a UUID belonging to a real organization, or gate the `authenticate()` dev branch on a second, explicitly-named opt-in (e.g. `ALLOW_UNAUTHENTICATED_DEV_SESSION=true`) so `NODE_ENV` alone can never open it; and decouple `assertRuntimeRoleRlsSafe`'s gate from `NODE_ENV` so it runs by default and is opt-*out*.

---

### [SEVERITY: LOW] `mcpKeyStore.resolve` is the only pre-tenant resolver that does not clear `app.org_id`

- **File:** `services/core/src/db/mcpKeyStore.ts:114-121`
- **Code:**
```ts
const result = await db.transaction(async (tx) => {
  // The migration grants only this SECURITY DEFINER function to the runtime
  // role. It returns one sanitized row before org_id is known.
  await tx.execute(sql`set local role sayre_app`);
  return tx.execute(
    sql`select * from resolve_mcp_client_key(${keyPrefix})`,
  );
});
```
- **Why it's wrong:** The three sibling pre-tenant resolvers all issue `set_config('app.org_id', '', true)` immediately after `set local role sayre_app` — `db/installations.ts:37-38`, `db/jiraPollDiscovery.ts:29-30`, `db/githubInitialParseOutbox.ts:120-121` / `:166-167` / `:199-200`. This one omits it. `withOrgContext` only ever sets the GUC transaction-locally, so there is no known path that leaves a stale value on a pooled connection; the impact today is a fail-*closed* one (a residual `app.org_id` would make an MCP key silently fail to resolve → spurious 401). But this is the single MCP-authentication chokepoint, and it is the one place the established hardening pattern was not applied — a future change to how `app.org_id` is set turns a consistent invariant into a one-off exception nobody remembers.
- **Fix:** Add `await tx.execute(sql\`select set_config('app.org_id', '', true)\`);` after line 117 so all four pre-tenant resolvers are byte-identical in shape.

---

### [SEVERITY: LOW] Explicit `deny` permission rows are silently ignored for any user holding the `owner` role

- **File:** `services/core/src/graph-query/permissions.ts:303`
- **Code:**
```ts
// The owner role is the tenant root and is intentionally omniscient within
// its server-derived org. ...
if (ctx.subjectType === 'user' && ctx.roles.includes('owner')) return OWNER_SCOPE;
```
- **Why it's wrong:** The early return happens before any `permissions` row is read, so `OWNER_SCOPE`'s `denies: []` (line 38-41) is unconditional. An administrator who writes a `deny` row scoped to, say, `repoId=X, pathPrefix='infra/secrets'` for a user who also carries `owner` gets **no error and no effect** — the row is simply never loaded. There is no mechanism to fence an owner out of a path, and nothing surfaces that the deny is inert. The `owner`-is-omniscient decision is defensible; silently accepting and discarding a contradicting deny row is not.
- **Fix:** Either load and apply `denies` even on the owner path (keep `allows: [{null,null,null}]`, drop the `denies: []`), or reject `deny` rows at write time for subjects that resolve to `owner` so the contradiction fails loudly instead of silently.

---

### [SEVERITY: LOW] `CLEAR_TICKET_REFERENCES_CYPHER` deletes relationships without an `org_id` predicate on the edge

- **File:** `services/core/src/integrations/tickets/graphTicketStore.ts:34-39`
- **Code:**
```cypher
MATCH (ticket:Ticket {org_id: $org_id, uid: $ticket_uid})
MATCH (ticket)-[old:REFERENCES]->()
DELETE old
RETURN count(old) AS removed_references
```
- **Why it's wrong:** This is the only edge-mutating Cypher in the repo that does not constrain the edge itself. Compare its own sibling `LINK_TICKET_REFERENCES_CYPHER:49` (`SET link.org_id = $org_id`) and `integrations/git/graphOwnershipStore.ts:56-58`, which explicitly guards the delete: `WHERE old_owns.org_id = $org_id AND previous.uid <> person.uid`. Here the anchor node is org-scoped and `ticketUid()` folds `orgId` into the uid, so today no cross-tenant edge is reachable — but the invariant "every graph mutation names `$org_id` on the thing it touches" is broken exactly once, and the untargeted `()` endpoint means any REFERENCES edge ever written to this ticket by another path is deleted unconditionally. It also passes `assertOrgScopedCypher` on the strength of the `MATCH` line alone, so the guard cannot catch a future regression here.
- **Fix:** Add the edge predicate: `MATCH (ticket)-[old:REFERENCES]->(target) WHERE old.org_id = $org_id AND target.org_id = $org_id`.

---

## Categories checked and found clean

- **Cypher injection:** clean. Every query is a module-level template constant; the only interpolations are the numeric constant `MAX_GRAPH_PATH_LENGTH` and `canonicalGraphPathPredicate(variable)`, whose argument is a hardcoded literal at every one of its ~20 call sites. All user-controlled values are bound parameters.
- **`org_id` from client input:** clean. No route, service, or parser reads org identity from a body/query/header. `http/realtimeDeltaRequest.ts` explicitly ignores an `org_id` field if present; `mcpKeyService.parseCreateRequest` (`:176-183`) and `providerSettingsService.parseUpdate` (`:126-140`) use exact-key allowlists that *reject* the request outright if an `orgId` key appears.
- **Caller-supplied `permissions`/`scope`/`role`:** clean. No service method accepts a scope, rule set, or role argument. Every `ReadScope` originates inside `PostgresPermissionStore.getReadScope(ctx)`; every `AuthContext` originates from `verifySessionToken` (HS256 pinned, `purpose` claim checked, `org_id` UUID-validated — `auth/sessionToken.ts:70-105`) or `resolveMcpCredential` (HMAC + pepper-version + revoke/expiry + conditional `markUsed` race-closer).
- **Fail-open / advisory RBAC:** clean, and notably good. `getReadScope` returns `EMPTY_SCOPE` on every failure branch (bad repo UUID, revoked key, expired key, missing issuer, no subject clause); `scopeFromRows:119` treats any effect other than the exact string `'allow'` as a deny; malformed allow paths are dropped while malformed deny paths widen to repo-root; every consuming service returns `[]`/`null` when `scope.allows.length === 0`.
- **Route handlers touching the graph/DB directly:** clean. All 14 routers are thin; every one uses `requireAuthContext(req)`/`requireOrgId(req)` and delegates. The three unauthenticated routes (GitHub webhook, GitHub install callback, Jira callback, login) each derive org from a signature/signed-state anchor, never from the request.
- **TOCTOU on permission checks:** clean. `agentSkillMdService.saveAgentSkillMd` re-authorizes via `graph.getNodeOverlay(nodeId, ctx)` and then writes under `pg_advisory_xact_lock` + `expectedVersion` CAS (`db/agentSkillMdStore.ts:137-150`). Agent-key scope is re-intersected with the issuer's *current* scope on every query (`intersectReadScopes`), so narrowing the issuer narrows the key immediately.
- **Bypass flags / `skipAuth` / dev escape hatches:** none beyond the `NODE_ENV` path in finding #2.
- **Cross-tenant fetch-by-id:** clean. Every id-taking service method (`getNodeOverlay`, `getCoveringTests`, `getStyleRules`, `traverseFrom`, `getAgentSkillMd`, `getProviderJobState`) scopes on `ctx.orgId` in the query *and* re-verifies the returned `org_id` in the mapper.

---

## Out of scope but worth flagging (functional, not security)

**`services/core/src/integrations/tickets/jiraPoller.ts:108`**
```ts
scope: { orgId, repositoryId: repo.id, refName: repo.defaultBranch ?? 'main' },
```
`repositories.defaultBranch` holds a short name (`main`), but graph nodes store canonical refs (`refs/heads/main`) — see `refName.ts::canonicalRefName` and `repositoryCatalogService.ts:56-58`, which both normalize. `LINK_TICKET_REFERENCES_CYPHER` matches `target {ref_name: $ref_name}`, so **every poller-driven ticket link silently resolves to 0 nodes**. Fails silently (`linkedNodes: 0`), so it would not show up as an error anywhere. Relatedly, `ticketCache`'s conflict target is `(orgId, provider, externalTicketId)` while the poller fans the same ticket out to every repo in the org (`:105-113`), so each fan-out job overwrites `repoId` — last writer wins.
