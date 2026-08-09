# Audit 03 — HTTP request surface (`services/core/src/routes/`, `services/core/src/http/`)

Scope: 31 files in `routes/` (18 non-test), 10 files in `http/` (5 non-test), plus `app.ts` wiring.
Method: every router enumerated, every handler read, every service call followed one level deep to
confirm whether the claimed authorization/validation actually exists.

**Headline:** the architecture rules hold up well. Routes are genuinely thin, the `src/routes/**`
ESLint `no-restricted-imports` gate (`services/core/.eslintrc.json:16-38`) is real and blocks
`pg`/`drizzle-orm`/`neo4j-driver`/`bullmq`/`ioredis`/`**/graph-query`/`**/db` imports, and **no route
reads `org_id` from client input** — every handler derives tenancy from `requireAuthContext(req)`.
**Zero IDORs found:** every id-addressed resource (`:repoId`, `:nodeId`, `:keyId`, `:purpose`) is
re-scoped against `ctx.orgId` plus a `PermissionStore` read scope inside the service/Graph Query
Service layer.

The real defects are in the *edges*: an env-gated auth bypass, zero rate limiting, an unbounded
query window, an inline container spawn, and unvalidated array-typed query params on the
unauthenticated OAuth callbacks.

---

## Endpoint coverage table

Mount order per `services/core/src/app.ts:20-70`.

| # | Method + Path | Handler | AuthN | AuthZ | Input validated |
|---|---|---|---|---|---|
| 1 | `GET /` | app.ts:29 | none (public) | n/a | n/a — static literal |
| 2 | `GET /health` | routes/health.ts:6 | none (public) | n/a | n/a — no client input, liveness only |
| 3 | `POST /webhooks/github` | routes/githubWebhook.ts:14 | HMAC-SHA256 sig | n/a — org from installation id | YES — sig verified before parse (githubWebhookService.ts:111), 5mb raw cap |
| 4 | `GET /repos/:repoId/technical-tree` | routes/technicalTree.ts:23 | `authenticate()` | `authorize('member')` + repo read-scope in GQS | **PARTIAL** — refName canonicalized; viewport unbounded (F-3) |
| 5 | `GET /repos/:repoId/provider-state` | routes/providerJobState.ts:15 | `authenticate()` | `member` + `canReadResource` | YES — `parseProviderJobStateQuery` (UUID/ref/enum) |
| 6 | `GET /repos/:repoId/product-tree` | routes/productTree.ts:21 | `authenticate()` | `member` + scope | YES — `normalizeProductTreeRef` (≤1024, no ctrl chars) |
| 7 | `GET /repos/:repoId/onboarding-tree` | routes/onboardingTree.ts:28 | `authenticate()` | `member` + scope | YES |
| 8 | `POST /repos/:repoId/onboarding-steps/:stepId/execute` | routes/onboardingTree.ts:55 | `authenticate()` | `authorize('admin')` + scope | YES (stepId ≤512, command from graph not body) — but see F-4 |
| 9 | `POST /internal/realtime/graph-delta` | routes/realtimeInternal.ts:31 | `authenticate()` | `member` + scope | **PARTIAL** — `changedPaths` unbounded (F-7) |
| 10 | `GET /integrations/github/install` | routes/githubInstall.ts:16 | `authenticate()` | `authorize('admin')` | n/a — no client input |
| 11 | `GET /integrations/github/callback` | routes/githubInstall.ts:26 | signed `state` JWT | org from `state.org_id` | **NO** — raw `as string` casts (F-5) |
| 12 | `GET /auth/github/login` | routes/login.ts:17 | none (entry point) | n/a | **PARTIAL** — raw cast; `redirect_to` validated downstream by `isSafeRelativePath` |
| 13 | `GET /auth/github/callback` | routes/login.ts:27 | signed `state` JWT | n/a — org resolved/created server-side | **NO** — raw `as string` casts (F-5) |
| 14 | `GET /settings/model-providers` | routes/providerSettings.ts:15 | `authenticate()` | `authorize('admin')` + `requireAdminUser(ctx)` | n/a |
| 15 | `PUT /settings/model-providers/:purpose` | routes/providerSettings.ts:24 | `authenticate()` | `admin` (×2) | YES — `parsePurpose` + `parseUpdate`, org-scoped credential/endpoint allowlist |
| 16 | `GET /nodes/:nodeId/overlay` | routes/nodeOverlay.ts:27 | `authenticate()` | `member` + org+scope filter in GQS | YES |
| 17 | `GET /nodes/:nodeId/agent-skill-md/history` | routes/nodeOverlay.ts:41 | `authenticate()` | `member` + scope | YES — `historyLimit` bounded 1..100 |
| 18 | `PUT /nodes/:nodeId/agent-skill-md` | routes/nodeOverlay.ts:55 | `authenticate()` | `authorize('admin')` + scope | YES — 32 768-char cap, NUL reject, heading schema, optimistic version |
| 19 | `GET /repositories` | routes/repositoryCatalog.ts:11 | `authenticate()` | `member` + per-repo scope filter | n/a — result capped at 250 |
| 20 | `POST /integrations/github/reconcile` | routes/githubInstallationReconcile.ts:16 | `authenticate()` | `authorize('admin')` | n/a — no client input |
| 21 | `GET /integrations/jira/connect` | routes/jiraConnect.ts:48 | `authenticate()` | `admin` + `requireUserId` | n/a |
| 22 | `GET /integrations/jira/callback` | routes/jiraConnect.ts:68 | signed `state` JWT | org from state | YES — `singleQueryValue` rejects arrays |
| 23 | `GET /integrations/jira/status` | routes/jiraConnect.ts:89 | `authenticate()` | `admin` | n/a |
| 24 | `POST /integrations/jira/disconnect` | routes/jiraConnect.ts:98 | `authenticate()` | `admin` + `requireUserId` | n/a |
| 25 | `GET /settings/mcp` | routes/mcpKeys.ts:17 | `authenticate()` | `admin` + `requireAdmin(ctx)` | n/a |
| 26 | `POST /settings/mcp/keys` | routes/mcpKeys.ts:26 | `authenticate()` | `admin` + issuer-scope ceiling check | YES — `parseCreateRequest`, grants ⊆ issuer scope |
| 27 | `DELETE /settings/mcp/keys/:keyId` | routes/mcpKeys.ts:37 | `authenticate()` | `admin`, revoke is `(orgId, keyId)` scoped | YES — UUID regex |
| 28 | `PUT /settings/mcp/rate-limit` | routes/mcpKeys.ts:48 | `authenticate()` | `admin` | YES — exact-key-set check, safe int 1..10 000 |

Out of table (mounted at `app.ts:67` but outside this audit's directories): `mcpGatewayRouter`
(`src/mcp/gateway.ts`) — carries its own bearer-key auth, `MCP_ALLOWED_ORIGINS` origin gate, zod
schemas, and per-key rate limiting.

**Endpoints with no authorization check appropriate to the resource: 0.**
7 endpoints are unauthenticated (#1, #2, #3, #11, #12, #13, #22); each is either public-by-nature or
anchored to a signed HMAC/JWT, and none returns tenant data without that anchor.
**Rate-limited endpoints: 0 of 28.**

---

## Findings

### [SEVERITY: HIGH] Env-gated auth bypass grants unauthenticated `owner` on all 28 endpoints
- **File:** `services/core/src/http/authenticate.ts:47-63`, with `services/core/src/services/authService.ts:40-51`
- **Code:**
```ts
// http/authenticate.ts:49-63
const token = extractBearerToken(req.headers.authorization);
if (token) { req.context = await resolve(token); next(); return; }

if (isDevOrTestEnvironment()) {   // NODE_ENV === 'development' || 'test'
  req.context = devSessionContext();
  next();
  return;
}
next(new AuthenticationError());
```
```ts
// services/authService.ts:45-50
return { subjectType: 'user', userId: getConfig('DEV_USER_ID'),
         orgId: getConfig('DEV_ORG_ID'), roles: ['owner'] };
```
- **Why it's wrong:** the bypass triggers on *absence* of a credential, so it is not a fallback — it is
  a wide-open door. Any deployment where `NODE_ENV` is `development` (a Docker image built without
  `NODE_ENV=production`, a preview/staging box, a `docker-compose` inheriting `infra/.env`) serves
  every route in the table to an anonymous caller as an `owner` of `DEV_ORG_ID`. `owner` is the top
  of `ROLE_RANK` (`http/authorize.ts:21-25`), so `authorize('admin')` passes too: an anonymous
  request can `POST /settings/mcp/keys` and walk away with a long-lived MCP API token
  (`routes/mcpKeys.ts:26`), `PUT /nodes/:nodeId/agent-skill-md`, `POST /integrations/jira/disconnect`,
  and `POST .../onboarding-steps/:stepId/execute`. The blast radius is bounded only by whatever
  `DEV_ORG_ID` happens to point at — and nothing prevents a real org from being seeded there.
  (Credit where due: `NODE_ENV` has no entry in `packages/config/src/config.ts`'s `DEFAULTS`, so an
  *unset* `NODE_ENV` throws `ConfigError` → 500, i.e. fail-closed. The hole is specifically a
  *wrong* value, which is the common misconfiguration.)
- **Fix:** gate the bypass on an explicit, separately-provisioned opt-in rather than on `NODE_ENV`
  alone — e.g. require `getConfig('ALLOW_DEV_SESSION') === 'true'` **and** `NODE_ENV !== 'production'`,
  and add a startup assertion in `src/index.ts` (alongside the existing
  `assertRuntimeRoleRlsSafe` / `assertInstallationResolverReady` gates) that hard-fails boot if the
  dev-session path is reachable while `CI=true` or a production DSN is configured. At minimum, drop
  `devSessionContext()`'s roles from `['owner']` to `['member']` so the bypass cannot mint API keys.

### [SEVERITY: HIGH] No rate limiting on any HTTP endpoint, including unauthenticated and container-spawning ones
- **File:** `services/core/src/app.ts:20-70` (no limiter middleware); confirmed absent across all of
  `services/core/src/http/` — the only limiter in the repo is `src/mcp/rateLimit.ts`, wired solely into
  `src/mcp/toolExecution.ts:37` for MCP tool calls. No `express-rate-limit` in
  `services/core/package.json` dependencies.
- **Code:**
```ts
// app.ts:27-29 — no limiter anywhere in the chain
app.use('/webhooks/github', express.raw({ type: '*/*', limit: '5mb' }), githubWebhookRouter);
app.use(express.json());
app.get('/', (_req, res) => res.json({ message: 'Sayre core API' }));
```
- **Why it's wrong:** four concrete abuse paths, three of them reachable with no credential at all.
  (a) `GET /auth/github/login` + `GET /auth/github/callback` (`routes/login.ts:17,27`) — unauthenticated;
  each callback attempt drives an outbound GitHub token exchange plus identity/email fetches, and the
  callback path can create an org + user row (`loginService.ts`), so an attacker can burn the GitHub
  App's rate limit and flood `organizations`/`users` with signup churn. No lockout, no backoff.
  (b) `POST /webhooks/github` — unauthenticated, accepts up to 5 MB raw per request and performs a
  secret-store lookup (`githubWebhookService.ts:107`) *before* the signature check; concurrent 5 MB
  bodies are pure memory pressure on a public endpoint.
  (c) `POST /repos/:repoId/onboarding-steps/:stepId/execute` — see F-4; one Docker container per
  request, ~30 s each.
  (d) `POST /integrations/github/reconcile` (`routes/githubInstallationReconcile.ts:16`) — each call
  fans out to the GitHub API and enqueues jobs.
- **Fix:** add an `express-rate-limit` (or Redis-backed, since `ioredis` is already a dependency)
  middleware in `app.ts` with three tiers: a strict per-IP bucket on `/auth/github/*` and
  `/webhooks/github` (e.g. 20/min/IP), a per-org bucket on the expensive admin actions
  (`/onboarding-steps/*/execute`, `/integrations/github/reconcile`, `/settings/mcp/keys`), and a
  default per-context bucket on everything else. Key the authenticated buckets off
  `req.context.orgId`, not the IP.

### [SEVERITY: MEDIUM] Unbounded viewport window returns the entire authorized repo graph (no cap, no LIMIT, no pagination)
- **File:** `services/core/src/http/viewport.ts:19-40` and `services/core/src/routes/technicalTree.ts:23-42`
- **Code:**
```ts
// http/viewport.ts:27-38 — lower bounds only, no upper bound on width/height/zoom
if (width  <= 0) throw new ViewportParseError('viewport.width must be > 0');
if (height <= 0) throw new ViewportParseError('viewport.height must be > 0');
const zoom = q.zoom === undefined ? 1 : Number(q.zoom);
if (!Number.isFinite(zoom) || zoom <= 0) throw new ViewportParseError('viewport.zoom must be > 0');
return { x, y, width, height, zoom };
```
- **Why it's wrong:** `GET /repos/<id>/technical-tree?x=-1e300&y=-1e300&width=1e300&height=1e300`
  passes every check. `getNodesInViewport` (`src/graph-query/index.ts:1950-1973`) turns that into a
  world-space box covering everything, and `GET_NODES_IN_VIEWPORT_CYPHER`
  (`src/graph-query/index.ts:77-155`) has **no `LIMIT`** — I read it end-to-end; it terminates at
  `ORDER BY node.path, node.uid`. Worse, its coordinate predicate is
  `node.layout_x IS NULL OR node.layout_y IS NULL OR (in range)` (lines 88-91), so nodes without
  layout coordinates are returned *unconditionally* regardless of the window. The route adds no
  pagination and no result cap of its own (contrast `repositoryCatalogService.ts`, which caps at
  `MAX_REPOSITORIES = 250`). A single `member` can pull every Folder/File node of a large monorepo in
  one request, serialized into memory as JSON — repeatable, and per F-2 unthrottled.
- **Fix:** bound the window in `parseViewport` (reject `width`/`height` above a sane world-space
  maximum and `zoom` outside e.g. `1e-3..1e3`), and add a hard `LIMIT $limit` to
  `GET_NODES_IN_VIEWPORT_CYPHER` with a server-chosen ceiling, returning a `truncated: true` flag on
  `TechnicalTree` so the client can page rather than silently receiving a partial graph.

### [SEVERITY: MEDIUM] Onboarding step execution awaits a container spawn inline in the request — resource exhaustion and a service-layer rule violation
- **File:** `services/core/src/routes/onboardingTree.ts:55-84` → `services/core/src/services/onboardingTreeService.ts:120-122`
- **Code:**
```ts
// services/onboardingTreeService.ts:120-122
const result = await (
  dependencies.sandbox ?? createOnboardingSandboxRunner()
).run(step.command);
```
- **Why it's wrong:** `.claude/rules/service-layer.md` states async work "is kicked off onto SQS or
  BullMQ from the service layer — never awaited inline in a request handler." This awaits a Docker
  container run with `ONBOARDING_SANDBOX_TIMEOUT_MS` defaulting to `30000`
  (`packages/config/src/config.ts:123`). Concretely: an `admin` (or, under F-1, anyone) issues N
  concurrent `POST /repos/:repoId/onboarding-steps/:stepId/execute` requests and gets N simultaneous
  containers plus N request slots held open for 30 s each, with no queue depth limit, no concurrency
  cap, and no rate limit. That exhausts the container host and the Node process's socket pool at the
  same time. There is also no HTTP server `requestTimeout`/`headersTimeout` configured in
  `src/index.ts:28` to backstop it.
- **Fix:** convert the endpoint to enqueue a BullMQ job and return `202` with an execution id, adding
  a `GET .../executions/:id` poll (or push the result over the existing WebSocket gateway). If the
  synchronous shape must stay for MVP, add a hard global concurrency semaphore around
  `createOnboardingSandboxRunner().run` plus a per-org rate limit, and set
  `server.requestTimeout` in `src/index.ts`.

### [SEVERITY: MEDIUM] Unvalidated array-typed query params on the unauthenticated OAuth callbacks → attacker-triggerable 500s
- **File:** `services/core/src/routes/login.ts:21,31-32` and `services/core/src/routes/githubInstall.ts:29-34`
- **Code:**
```ts
// routes/login.ts:29-33
const result = await handleGithubLoginCallback({
  code:  req.query.code  as string | undefined,
  state: req.query.state as string | undefined,
});
```
```ts
// routes/githubInstall.ts:29-34
const result = await handleGithubAppCallback({
  installationId: req.query.installation_id as string | undefined,
  setupAction:    req.query.setup_action    as string | undefined,
  state:          req.query.state           as string | undefined,
  code:           req.query.code            as string | undefined,
});
```
- **Why it's wrong:** `as string` is a compile-time lie. Express parses a repeated query parameter
  into an array, so `GET /auth/github/callback?state=a&state=b&code=x` delivers `['a','b']` to
  `verifyState`, which does `rawState.trim()` at `services/loginService.ts:144` — `Array.prototype.trim`
  does not exist → `TypeError` → falls through every `instanceof` branch in `errorHandler` to the
  generic `500` (`http/express.ts:233`). Identical path at
  `services/githubAppInstallService.ts:163`. Unauthenticated, one-request, repeatable 500s that
  pollute error budgets/alerting and, combined with F-2, are a cheap noise/DoS primitive. This is a
  *known* bug class in this codebase that was fixed in exactly one place and not the others —
  `routes/jiraConnect.ts:40-46` has the correct guard and its comment even names the failure
  ("reject it as a clean 400 rather than letting an array reach the service and crash (the
  WEB-07-style 500 noted in docs/post-mvp-backlog.md)").
- **Fix:** export `singleQueryValue` from a shared `http/` helper (it is request-shape adaptation, so
  `http/` is the right home) and use it in `routes/login.ts` and `routes/githubInstall.ts`, mapping a
  duplicate param to `LoginCallbackBadRequestError` / `InstallCallbackBadRequestError` so it renders
  as the existing generic 400. Drop the `as string` casts entirely.

### [SEVERITY: LOW] `technicalTree` route does not catch `RangeError`, so bad-but-well-formed input yields a 500 instead of a 400
- **File:** `services/core/src/routes/technicalTree.ts:27-41`
- **Code:**
```ts
asyncHandler(async (req, res) => {
  const viewport = parseViewport(req.query);
  const refName = refNameFromQuery(req.query.refName);
  if (refName === null) { res.status(400).json({ error: 'invalid technical tree refName' }); return; }
  const tree = await getTechnicalTree(req.params.repoId, refName, viewport, requireAuthContext(req));
  res.json(tree);
}),
```
- **Why it's wrong:** `getTechnicalTree` throws `RangeError` for a blank repoId
  (`technicalTreeService.ts:29-31`) and `getNodesInViewport` throws `RangeError` when the derived
  world dimensions are non-finite (`graph-query/index.ts:1954-1962`). Neither is mapped in
  `errorHandler`, so both become `500 Internal server error`. Both are client-reachable:
  `GET /repos/%20/technical-tree?...` (whitespace repoId), and
  `?width=1e308&zoom=1e-10` — `parseViewport` accepts both values individually (each is finite and
  positive) but `width / zoom` overflows to `Infinity`. `productTree.ts:33-39` and
  `onboardingTree.ts:41-51` both catch `RangeError` → 400; `technicalTree.ts` is the odd one out.
- **Fix:** either wrap the call in the same `catch (error) { if (error instanceof RangeError) → 400 }`
  the sibling routes use, or add a `RangeError → 400` branch to `errorHandler` in `http/express.ts`
  so all three routes are consistent.

### [SEVERITY: LOW] `changedPaths` is validated for type but not for size
- **File:** `services/core/src/http/realtimeDeltaRequest.ts:16-32`
- **Code:**
```ts
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}
...
if (!isStringArray(candidate.changedPaths)) {
  throw new RealtimeDeltaParseError('Invalid or missing field: changedPaths (must be an array of strings)');
}
```
- **Why it's wrong:** no cap on array length or per-string length. Every surviving path is forwarded
  verbatim as a Cypher `$paths` parameter in `getAffectedNodes`
  (`graph-query/index.ts:2041-2058`), which also applies no cap — it only de-duplicates and filters
  for canonical form. `express.json()`'s default 100 kb body limit is the only thing bounding this
  today, which still permits a few thousand paths per request against a graph query with no `LIMIT`.
  Every other parser in this layer bounds its input (`historyLimit` 1..100 in `nodeOverlay.ts:15-25`,
  32 768 chars in `agentSkillMdService.ts:15`, ≤1024 in `normalizeProductTreeRef`), so this is an
  inconsistency, not a deliberate choice.
- **Fix:** add an explicit `changedPaths.length <= 1_000` and per-entry `length <= MAX_GRAPH_PATH_LENGTH`
  check in `parseRealtimeDeltaRequest`, matching the bounding style used elsewhere in `http/`.

### [SEVERITY: LOW] `errorHandler` does not guard `res.headersSent`
- **File:** `services/core/src/http/express.ts:60-234`
- **Code:**
```ts
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ViewportParseError) { res.status(400).json({ error: err.message }); return; }
  ...
  res.status(500).json({ error: 'Internal server error' });
}
```
- **Why it's wrong:** if a handler has already written a response (all the redirect routes call
  `res.redirect(302, ...)` and several routes call `res.status(...).json(...)` then continue) and a
  later error reaches this middleware, `res.status()` throws `ERR_HTTP_HEADERS_SENT` *inside the error
  handler*. Express's default handler then destroys the socket, and the original error is lost from
  the response path. This is defensive-only today, but it converts a recoverable error into a hung
  connection when it does fire.
- **Fix:** open with `if (res.headersSent) { _next(err); return; }` — the standard Express contract for
  delegating to the built-in final handler.

### [SEVERITY: LOW] No security headers and no `Cache-Control: no-store` on tenant-scoped JSON
- **File:** `services/core/src/app.ts:20-70`
- **Code:** the full middleware chain is `express.raw` (webhook path only) → `express.json()` →
  routers → `errorHandler`. No `helmet`, no `X-Content-Type-Options`, no `Cache-Control`.
- **Why it's wrong:** responses from `/repos/:repoId/technical-tree`, `/nodes/:nodeId/overlay`,
  `/repositories`, `/settings/mcp`, etc. are per-tenant and per-role but carry no cache directives, so
  any intermediary or the browser cache may retain them; a shared cache keyed only on URL would serve
  one org's graph projection to another. Note the *absence* of CORS middleware is correct here and
  not a finding — `apps/web` reaches core through its own Next.js BFF proxy
  (`apps/web/app/api/core/[...path]/route.ts:339`), so core is same-origin from the browser's view and
  wide-open CORS was correctly never added.
- **Fix:** add `helmet()` and a small middleware setting `Cache-Control: no-store` on any response
  produced downstream of `authenticate()`. Also set `app.set('trust proxy', ...)` before adding the
  IP-keyed limiter from F-2, or the limiter will bucket every request under the load balancer's IP.

---

## Verified non-findings (checked, and clean)

Recording these so the next pass does not re-litigate them:

- **`org_id` from client input** — none. Every handler uses `requireAuthContext(req)` /
  `requireOrgId(req)` (`auth/context.ts:64-77`). `http/realtimeDeltaRequest.ts` explicitly ignores an
  `orgId` field even when present in the body.
- **IDOR on `:nodeId` / `:repoId` / `:keyId` / `:purpose`** — all re-scoped server-side.
  `revokeMcpKey` is `store.revoke(ctx.orgId, keyId, ...)` (`mcpKeyService.ts:358-361`);
  `getNodeOverlay` passes `ctx` into a Cypher query filtered on `node.org_id = $org_id` plus
  allow/deny rules; `getProviderJobState` runs inside `withOrgContext` with an explicit
  `eq(...orgId, orgId)` predicate.
- **Mass assignment** — no `req.body` is ever spread into a write. `issueMcpKey` /
  `updateMcpRateLimit` / `updateProviderSettings` / `saveAgentSkillMd` all take `body: unknown` and
  reconstruct a validated object; `updateMcpRateLimit` even rejects extra keys via
  `Object.keys(body).length !== 1` (`mcpKeyService.ts:376-381`).
- **Business logic / direct DB access in handlers** — none, and it is enforced by the ESLint override
  at `services/core/.eslintrc.json:16-38` (plus `max-statements: 10`), with `routes/lintGate.test.ts`
  asserting the gate stays wired.
- **Unawaited promises / crash-on-reject** — every async handler is wrapped in `asyncHandler`
  (`http/express.ts:54-58`), which routes rejections to `next`.
- **Stack-trace / internal-detail leakage** — `errorHandler` maps ~25 typed errors to fixed generic
  bodies and never emits `err.stack` or a raw message for unknown errors (`http/express.ts:232-233`).
- **Open redirect / token exfiltration via `redirect_to`** — `isSafeRelativePath`
  (`auth/loginState.ts:60-69`) rejects non-string, non-`/`-leading, `//`, `/\`, any `:`, any `\`, and
  whitespace/control chars; it is applied at both sign and verify time.
- **SSRF** — no endpoint accepts a URL or host. Every outbound base URL comes from the closed
  `CONFIG_NAMES` allowlist in `packages/config/src/config.ts`. `MODEL_PROVIDER_ENDPOINT_CATALOG`
  defaults to `'[]'` (fail-closed) and `updateProviderSettings` selects only from the org's catalog
  entries rather than from the request body.
- **Webhook signature ordering** — `handleGithubWebhook` verifies the HMAC before parsing, before any
  DB lookup, and before any publish (`githubWebhookService.ts:105-131`), over the exact raw bytes,
  because `express.raw` is mounted ahead of `express.json()` at `app.ts:27`.
- **`/internal/realtime/graph-delta` exposure** — it *is* mounted on the same public app
  (`app.ts:39`) with only `authorize('member')` between it and the internet, which the file's own
  header comment acknowledges and defers to a network-layer firewall
  (`routes/realtimeInternal.ts:14-24`). Not scored as a separate finding: the endpoint re-runs the
  full RBAC pipeline per call and returns strictly the same server-filtered node set the caller could
  already obtain from `/repos/:repoId/technical-tree`, so a valid session buys no extra data. Worth
  tracking as a deployment requirement, not a code defect.
