# Audit 02 — Authentication, session handling, MCP API key lifecycle

Scope: `services/core/src/auth/`, `services/core/src/mcp/**`, `services/core/src/security/` (key/credential side),
`MCP_TOOL_CONTRACT.md`, `SECRETS.md`. Adjacent files pulled in because the auth/session/key path runs through
them: `services/core/src/services/{authService,loginService,mcpKeyService}.ts`,
`services/core/src/db/{mcpKeyStore,authUsers}.ts`, `services/core/src/graph-query/permissions.ts`,
`services/core/src/http/{authenticate,authorize}.ts`, `apps/web/app/api/**`, `packages/config/src/*`.

Counts: 0 CRITICAL, 3 HIGH, 8 MEDIUM, 4 LOW.

---

### [SEVERITY: HIGH] Login CSRF — the OAuth `state` token is never bound to the browser that started the flow

- **File:** `services/core/src/auth/loginState.ts:77-87`, `services/core/src/services/loginService.ts:57-72`, `services/core/src/routes/login.ts:17-25`
- **Code:**
```ts
// loginState.ts:77-87
export async function signLoginState(input?: { redirectTo?: string }): Promise<string> {
  const key = await getSecret('env://JWT_SIGNING_KEY');
  const payload: LoginState = { nonce: randomUUID(), purpose: PURPOSE };
  ...
  return jwt.sign(payload, key, { algorithm: 'HS256', expiresIn: EXPIRY });
}
```
```ts
// routes/login.ts:17-25 — start emits the state only in the redirect URL; no cookie, no server-side nonce store
const result = await startGithubLogin({ redirectTo: req.query.redirect_to as string | undefined });
res.redirect(302, result.redirectTo);
```
  And the module header explicitly acknowledges the statelessness:
  `loginState.ts:16-18` — *"Stateless (no nonce store) ... a replayed, still-valid, unexpired login-state passes verification here"*.
- **Why it's wrong:** The whole point of the OAuth `state` parameter is to prove the callback belongs to the *same
  user agent* that started the flow. Here `state` is a self-signed JWT that anyone can obtain by simply requesting
  `GET /auth/github/login`, and nothing (cookie, `__Host-` nonce, or server-side store) ties it to a browser.
  Attack: attacker hits `/auth/github/login`, completes the GitHub authorize step with their *own* GitHub account,
  captures the unused `code` + `state`, and gets a victim to load
  `https://sayre/auth/github/callback?code=<attacker_code>&state=<attacker_state>`. Core mints a session for the
  **attacker's** identity and redirects the victim's browser to `/auth/complete#token=…`, where
  `apps/web/app/auth/complete/page.tsx:40` writes it to the victim's `localStorage` and
  `persistSessionCookie()` mirrors it into the `sayre_session` cookie. The victim now silently operates inside the
  attacker's org — any repo they connect, Jira account they link, or Agent/Skill MD they author lands in the
  attacker's tenant. The comment's mitigation ("the code is single-use, so replay is bounded") does not apply: the
  attacker supplies a *fresh, unused* code. `services/core/src/github/installState.ts` has the same shape.
- **Fix:** At login start, set a short-lived `__Host-sayre_login_state` HttpOnly/SameSite=Lax cookie containing the
  state token (or its nonce) and require the callback to `timingSafeEqual` the cookie nonce against the `state`
  JWT's `nonce` claim before exchanging the code; clear the cookie on completion.

---

### [SEVERITY: HIGH] Returning-user login is structurally broken in production — pre-tenant user lookup is RLS-filtered

- **File:** `services/core/src/db/authUsers.ts:48-63`; policy at `services/core/drizzle/0001_rls_and_role.sql:35-39`
- **Code:**
```ts
// authUsers.ts:52-60 — runs on the runtime pool with NO withOrgContext, so `app.org_id` is unset
const rows = await db
  .select({ userId: users.id, orgId: users.orgId, orgRole: users.orgRole })
  .from(users)
  .where(eq(users.externalAuthId, externalAuthId))
  .limit(1);
```
```sql
-- drizzle/0001_rls_and_role.sql:35-39
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON users
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
```
  The file's own header (`authUsers.ts:8-19`) labels this a *"PRODUCTION GAP (documented, not fixed)"*.
- **Why it's wrong:** With the intended production runtime role (`NOBYPASSRLS`, non-owner — enforced by
  `services/core/src/security/assertRuntimeRoleRlsSafe.ts`), `current_setting('app.org_id')` is unset here, so the
  policy filters out every row and `resolveUserByExternalAuthId` always returns `null`. Every returning sign-in is
  therefore treated as a brand-new signup: `resolveOrCreateUser` (`loginService.ts:188-224`) tries to insert a new
  org+user, hits `users_external_auth_id_unique` (`drizzle/0013`), re-resolves (still `null` for the same reason),
  and rethrows → HTTP 500. Production login works exactly once per GitHub account and then hard-fails forever.
  The obvious operator workaround — repointing `DATABASE_RUNTIME_URL` at a superuser/`BYPASSRLS` role — disables
  tenant isolation globally, and `assertRuntimeRoleRlsSafe` only runs when `NODE_ENV=production` or `CI=true`.
- **Fix:** Add a `resolve_user_by_external_auth_id(text)` `SECURITY DEFINER` function returning only
  `{user_id, org_id, org_role}` and `GRANT EXECUTE` to `sayre_app`, exactly as
  `drizzle/0014_w4_06_mcp_gateway.sql` already does for `resolve_mcp_client_key`, and call it from
  `authUsers.ts` instead of the raw Drizzle select.

---

### [SEVERITY: HIGH] Any unauthenticated request becomes an org `owner` when `NODE_ENV=development`

- **File:** `services/core/src/http/authenticate.ts:39-42,57-61`; `services/core/src/services/authService.ts:40-51`; `infra/.env.example:7,22,24`
- **Code:**
```ts
// authenticate.ts:57-61 — no Authorization header at all
if (isDevOrTestEnvironment()) {
  req.context = devSessionContext();
  next();
  return;
}
```
```ts
// authService.ts:45-50
return { subjectType: 'user', userId: getConfig('DEV_USER_ID'),
         orgId: getConfig('DEV_ORG_ID'), roles: ['owner'] };
```
```sh
# infra/.env.example:7,22
NODE_ENV=development
# ... then set DEV_ORG_ID=00000000-0000-4000-8000-000000000001 locally when
```
- **Why it's wrong:** The only gate is the `NODE_ENV` string. The repo's own env template ships
  `NODE_ENV=development` and instructs the operator to override `DEV_ORG_ID` to a **real org UUID** so the GitHub
  install callback works. Any host running the documented dev configuration (`npm run dev`, per CLAUDE.md) with a
  reachable port grants full `owner` on that org to every anonymous HTTP request — `GET /settings/mcp` lists all
  MCP keys, `POST /settings/mcp/keys` mints a new full-scope MCP credential (owner ⇒ `OWNER_SCOPE`, see
  `graph-query/permissions.ts:303`), and the returned token is a permanent read credential over the whole tenant.
  There is no bind-to-loopback guard and no startup banner. (It does fail closed when `NODE_ENV` is *unset* —
  `getConfig('NODE_ENV')` throws because `NODE_ENV` has no entry in `packages/config/src/config.ts` `DEFAULTS` —
  so the risk is specifically the `development` value, not the missing one.)
- **Fix:** Require an explicit opt-in flag in addition to `NODE_ENV` (e.g. `ALLOW_DEV_SESSION=true`) and refuse to
  start the listener on a non-loopback interface while that flag is set.

---

### [SEVERITY: MEDIUM] No rate limiting or lockout on MCP credential verification — unauthenticated DB amplification

- **File:** `services/core/src/mcp/gateway.ts:262-272`; limiter is only reached in `services/core/src/mcp/toolExecution.ts:33-38`
- **Code:**
```ts
// gateway.ts:262-272 — every POST /mcp resolves a credential with no pre-auth throttle
let credential: ResolvedMcpCredential;
try {
  credential = await deps.resolveCredential(bearerToken(req));
} catch (error) {
  if (error instanceof McpKeyAuthenticationError) { jsonRpcError(res, 401, -32001, 'Unauthorized.'); return; }
```
```ts
// toolExecution.ts:34-38 — the ONLY place the limiter is consumed, and it needs an already-valid credential
deps.limiter.consume(credential.context.orgId, credential.keyPrefix, credential.rateLimitPerMinute);
```
- **Why it's wrong:** The rate limiter is keyed on `(orgId, keyPrefix)` from a *successfully resolved* credential,
  so a request with an invalid or forged bearer token is never counted. Each such request still runs a full
  Postgres transaction (`mcpKeyStore.resolve` → `set local role sayre_app` + `resolve_mcp_client_key`) plus an
  HMAC. An unauthenticated attacker can pin the connection pool and exhaust DB CPU at whatever rate they can open
  sockets. There is also no per-IP throttle and no lockout after N failures on `/auth/github/login`.
- **Fix:** Add an IP/prefix-keyed pre-auth throttle in front of `resolveCredential` (and on the login routes) that
  counts failures regardless of whether the credential resolves.

---

### [SEVERITY: MEDIUM] MCP rate limit does not cover non-tool JSON-RPC methods

- **File:** `services/core/src/mcp/gateway.ts:274-283` vs `services/core/src/mcp/toolExecution.ts:34-38`
- **Code:**
```ts
// gateway.ts:274-283 — initialize / tools/list / notifications go straight into the transport
const server = createServer(credential, deps);
const transport = new StreamableHTTPServerTransport({ ... });
await server.connect(transport);
await transport.handleRequest(req, res, req.body);
```
- **Why it's wrong:** `deps.limiter.consume(...)` is invoked inside `executeMcpTool`, i.e. only for `tools/call`.
  A holder of a key with `rateLimitPerMinute: 1` can still issue unbounded `initialize` and `tools/list` requests,
  and every one of them costs two DB round-trips including a write — `resolveMcpCredential` ends with
  `deps.store.markUsed(...)` (`mcpKeyService.ts:276`), an `UPDATE mcp_client_keys SET last_used_at…` on a single
  row, so parallel requests also serialize on that row lock. `MCP_TOOL_CONTRACT.md:363-365` advertises rate
  limiting as a property of the endpoint, not of the tool-call subset.
- **Fix:** Consume the limiter once per `POST /mcp` in the router (right after `resolveCredential`), and keep the
  per-tool accounting for metrics only.

---

### [SEVERITY: MEDIUM] Rate limiter is per-process in-memory, so the org's configured limit is not the enforced limit

- **File:** `services/core/src/mcp/rateLimit.ts:21-24,38,59`
- **Code:**
```ts
export class InMemoryMcpRateLimiter implements McpRateLimiter {
  private readonly windows = new Map<string, WindowState>();
  ...
  const key = `${orgId}:${keyPrefix}`;
```
- **Why it's wrong:** `MCP_TOOL_CONTRACT.md:363` states *"Rate limiting is per organization and public key prefix,
  using the organization's persisted calls-per-minute setting."* Two things break that contract: (a) state lives in
  a process-local `Map`, so with N core replicas (or after every deploy/restart) the effective ceiling is N× the
  configured value and resets to zero; (b) the counter is keyed per `(org, key)`, so an org holding 50 keys gets
  50× its own "organization" limit. Redis is already a dependency (`REDIS_HOST`/`REDIS_PORT` in
  `packages/config/src/config.ts:8-9`), so this is not an infrastructure blocker.
- **Fix:** Move the window into Redis (INCR + EXPIRE on `mcp:rl:<org>:<prefix>:<minute>`) and add a separate
  org-wide counter if the contract's "per organization" wording is meant literally.

---

### [SEVERITY: MEDIUM] The `pepper_version` column cannot do what it claims — rotation silently kills every live key

- **File:** `services/core/src/services/mcpKeyService.ts:84,260-270`; `packages/config/src/secrets.ts:8-37`; `services/core/src/db/schema.ts:437-439`
- **Code:**
```ts
// mcpKeyService.ts:260-270
if ( !row || ... || row.pepperVersion !== deps.getPepperVersion() ) { throw new McpKeyAuthenticationError(); }
const expected = mcpSecretHmac(secret, await deps.getPepper());
```
```ts
// mcpKeyService.ts:84 — one pepper, no version in the reference
getPepper: () => getSecret('env://MCP_TOKEN_PEPPER'),
```
```ts
// schema.ts:437-439 (the claim this contradicts)
// Which pepper version produced `key_hmac` — enables pepper rotation
// without invalidating older rows.
```
- **Why it's wrong:** `getPepper()` always resolves the single `MCP_TOKEN_PEPPER` secret; there is no
  `MCP_TOKEN_PEPPER_V2` in the closed `SECRET_NAMES` catalog (`secrets.ts:8-37`) and no version→value map. So
  `pepperVersion` is used purely as an equality gate: the moment an operator bumps
  `MCP_TOKEN_PEPPER_VERSION`, every existing key is rejected with a generic 401 and every customer's agent breaks
  with no warning, while the schema comment tells the operator the opposite. Worse, an operator who rotates the
  *pepper value* without bumping the version gets silent, un-diagnosable auth failures (version matches, HMAC
  doesn't). Also note `getSecret` memoizes forever (`secrets.ts:110,135-143`), so any pepper change needs a full
  restart of every core process.
- **Fix:** Either resolve the pepper by version (`env://MCP_TOKEN_PEPPER_V${row.pepperVersion}` against an
  allowlisted set of versioned names, accepting the previous version during an overlap window), or delete the
  column and correct the schema comment and `SECRETS.md:36` rotation procedure to say "rotation invalidates all
  keys; reissue required."

---

### [SEVERITY: MEDIUM] Sessions are unrevocable and carry stale roles for up to 12 hours

- **File:** `services/core/src/auth/sessionToken.ts:1-6,34,70-106`; `services/core/src/services/authService.ts:20-32`
- **Code:**
```ts
// sessionToken.ts:4-6
// MVP trusts the signed token's claims for `{ userId, orgId, roles }` with no
// per-request DB confirmation (stateless) — role changes take effect on next
// token re-issue only.
const DEFAULT_EXPIRY = '12h';
```
```ts
// authService.ts:26-31 — claims become the AuthContext verbatim; no users-table read
return { subjectType: 'user', userId: claims.sub, orgId: claims.org_id, roles: claims.roles as OrgRole[] };
```
- **Why it's wrong:** There is no `jti`, no deny-list, and no session table, so there is no way to log a user out
  server-side or to kill a leaked token. Demoting an owner to member, deleting the user, or deleting the org has
  **zero** effect for up to 12 hours: `authorize('admin')` (`http/authorize.ts:38`) reads the roles straight out
  of the JWT, so a demoted owner keeps minting full-scope MCP keys via `POST /settings/mcp/keys` the whole time.
  This is a notable asymmetry with the MCP key path, which re-checks revocation and issuer scope on *every*
  request (`mcpKeyService.ts:260-278`, `graph-query/permissions.ts:309-341`) — the human credential is the weaker
  one. `clearSessionCookie()` in `apps/web/app/lib/coreFetch.ts:56-63` only clears the browser's copy.
- **Fix:** Add a `jti` claim plus a `sessions` (or revoked-jti) table checked in `resolveSessionContext`, or at
  minimum re-read `users.org_role` from Postgres per request and shorten `DEFAULT_EXPIRY` with a refresh token.

---

### [SEVERITY: MEDIUM] No length or entropy validation on `JWT_SIGNING_KEY` / `MCP_TOKEN_PEPPER`

- **File:** `packages/config/src/secrets.ts:99-107,118-128`
- **Code:**
```ts
const environmentBackend: SecretBackend = async (ref) => {
  const { name } = parseReference(ref);
  const value = process.env[name];
  if (value === undefined) throw new SecretNotFoundError(name);
  if (value.trim().length === 0) throw new EmptySecretError(name);
  return value;
};
```
- **Why it's wrong:** The only check on HMAC key material is "not empty". `JWT_SIGNING_KEY=dev` is accepted and
  used for HS256 across all three token families (`sessionToken.ts:52,71`, `loginState.ts:78,99`,
  `github/installState.ts`). A single captured session JWT is then offline-crackable in seconds, after which an
  attacker forges `{sub, org_id, roles:['owner'], purpose:'session'}` for **any** tenant — a complete
  cross-tenant auth bypass that no amount of downstream `org_id` injection can catch, because `org_id` comes from
  the token. `infra/.env.example:128` ships the placeholder `<jwt-signing-material>` with no stated minimum.
- **Fix:** Reject `JWT_SIGNING_KEY` and `MCP_TOKEN_PEPPER` shorter than 32 bytes at startup (add a
  per-secret minimum-length rule in `resolveSecret`), and document the generation command in `SECRETS.md`.

---

### [SEVERITY: MEDIUM] `POST /mcp` handler can reject outside its `try`, producing an unhandled rejection on Express 4

- **File:** `services/core/src/mcp/gateway.ts:255-257,274-283`; `services/core/src/mcp/gateway.ts:55-74`
- **Code:**
```ts
router.post('/mcp', async (req, res) => {
  const allowedOrigins = deps.allowedOrigins();   // parseAllowedOrigins() throws — outside any try
  ...
  const server = createServer(credential, deps);
  const transport = new StreamableHTTPServerTransport({ ... });   // also outside the try
  try { await server.connect(transport); ... } catch { ... }
```
```ts
// gateway.ts:59-61
} catch { throw new Error('MCP_ALLOWED_ORIGINS must be a JSON array.'); }
```
- **Why it's wrong:** `express@4.21.x` (`services/core/package.json:40`) does not catch rejected promises from
  route handlers, and unlike every other route in this codebase this one is **not** wrapped in `asyncHandler`
  (compare `routes/mcpKeys.ts:21,30,41,52`). A malformed `MCP_ALLOWED_ORIGINS` (or an empty string, which makes
  `getConfig` throw `ConfigError`) therefore produces an unhandled promise rejection on the first `/mcp` request:
  the client's request hangs until timeout with no response, and Node ≥15 terminates the process by default.
  Because `parseAllowedOrigins()` is re-parsed per request rather than at boot, this is a runtime crash rather
  than a startup failure.
- **Fix:** Wrap the handler in `asyncHandler` and hoist origin parsing into `createMcpGatewayRouter` so a bad
  value fails at startup instead of on the first request.

---

### [SEVERITY: MEDIUM] BFF proxies authenticate state-changing requests from an ambient cookie with no CSRF defense

- **File:** `apps/web/app/api/mcp-settings/[[...path]]/route.ts:29-40,132-159`; `apps/web/app/api/core/[...path]/route.ts:237-243`; cookie set at `apps/web/app/api/session/route.ts:35-42`
- **Code:**
```ts
// mcp-settings/route.ts:31-37
const explicit = request.headers.get('authorization');
const session = request.cookies.get(SESSION_COOKIE)?.value;
if (explicit !== null && BEARER_RE.test(explicit)) { headers.set('authorization', explicit); }
else if (session && !/\s/u.test(session)) { headers.set('authorization', `Bearer ${session}`); }
```
```ts
// session/route.ts:35-42
response.cookies.set({ name: SESSION_COOKIE, value: token, httpOnly: true,
  sameSite: 'lax', secure: shouldUseSecureCookie(request), path: '/' });
```
- **Why it's wrong:** `POST /api/mcp-settings/keys` (mint a credential), `DELETE /api/mcp-settings/keys/:id`
  (revoke), `PUT /api/mcp-settings/rate-limit`, and `PUT /api/core/nodes/:id/agent-skill-md` all authenticate from
  the ambient `sayre_session` cookie with **no** CSRF token, no `Origin`/`Sec-Fetch-Site` check, and no
  double-submit. The only thing standing between a cross-site request and a minted MCP credential is
  `SameSite=Lax`, which is a browser-version-dependent default rather than an application control and which does
  not stop a same-site (sibling-subdomain or XSS-on-any-subdomain) attacker. The bearer-header path
  (`coreFetch`) does not need the cookie at all, so the cookie fallback widens the attack surface for the benefit
  of full-page navigations only.
- **Fix:** Reject cookie-authenticated requests whose method is not GET/HEAD unless `Origin`/`Sec-Fetch-Site`
  matches the app origin, or restrict the cookie fallback to the specific GET navigation routes
  (`integrations/github/install`, `integrations/jira/connect`) that actually require it.

---

### [SEVERITY: LOW] `verifySessionToken` accepts a token with no `exp` claim and checks no `iss`/`aud`

- **File:** `services/core/src/auth/sessionToken.ts:70-106`
- **Code:**
```ts
decoded = jwt.verify(token, key, { algorithms: ['HS256'] });
...
if (candidate.purpose !== PURPOSE) { throw new SessionTokenError(); }
```
- **Why it's wrong:** `jsonwebtoken` only enforces `exp` when the claim is present; a token minted without it
  never expires. `signSessionToken` always sets one today, but `opts.expiresIn` is caller-controlled
  (`sessionToken.ts:50,59`) and any future issuer that omits it produces a permanent credential with no
  verifier-side guard. There is also no `issuer`/`audience` binding — the `purpose` claim is the sole separator
  between three token families that share `JWT_SIGNING_KEY`.
- **Fix:** Pass `{ algorithms: ['HS256'], maxAge: '12h', issuer: 'sayre', audience: 'sayre-core' }` to
  `jwt.verify` and set the matching claims in all three signers.

---

### [SEVERITY: LOW] MCP keys can be issued with no expiry at all

- **File:** `services/core/src/services/mcpKeyService.ts:199-213`
- **Code:**
```ts
let expiresAt: string | null = null;
if (record.expiresAt !== null) {
  ...
  if (!Number.isFinite(parsed.valueOf()) || parsed <= now ||
      parsed.valueOf() - now.valueOf() > MAX_EXPIRY_MS) { throw new McpKeyValidationError(); }
```
- **Why it's wrong:** `MAX_EXPIRY_MS` caps a *supplied* expiry at 366 days, but `expiresAt: null` skips the branch
  entirely and produces a credential that never expires — the exact case the cap exists to prevent. Long-lived
  read credentials distributed to third-party agent runtimes are the highest-value secret this product issues.
- **Fix:** Reject `null` and require an explicit expiry ≤ `MAX_EXPIRY_MS`, defaulting to 90 days when the field
  is omitted.

---

### [SEVERITY: LOW] GitHub identity is trusted without validating the `id` field

- **File:** `services/core/src/github/oauthClient.ts:152-161`
- **Code:**
```ts
const body = (await response.json()) as GithubUserResponse;
return { id: String(body.id), login: body.login, name: body.name ?? null, email: body.email ?? null };
```
- **Why it's wrong:** `body` is cast, not validated. If `/user` ever returns a payload without `id` (proxy,
  GitHub Enterprise variance, error body served with 200), `String(undefined)` yields the literal string
  `"undefined"`, which becomes `users.external_auth_id`. Because
  `resolveUserByExternalAuthId` keys identity solely on that column
  (`loginService.ts:180`), the first such login creates an account and every subsequent one resolves *into it* —
  unrelated people sharing one org and one owner account. `login` is likewise unchecked before being used to
  derive the org slug.
- **Fix:** Validate the shape (`typeof body.id === 'number' && Number.isInteger(body.id)`,
  non-empty `login`) and throw `GithubOAuthApiError` otherwise.

---

### [SEVERITY: LOW] Session-cookie `Secure` flag is derived from a client-supplied header

- **File:** `apps/web/app/api/session/route.ts:12-19`
- **Code:**
```ts
const forwardedProtocol = request.headers.get('x-forwarded-proto')?.split(',', 1)[0]?.trim().toLowerCase();
return forwardedProtocol === 'https' || request.nextUrl.protocol === 'https:';
```
- **Why it's wrong:** `x-forwarded-proto` is only trustworthy when a proxy is known to overwrite it. If the app is
  ever reached without such a proxy in front (direct container port, misconfigured ingress), a request carrying
  `x-forwarded-proto: http` causes the session cookie to be set **without** `Secure`, making it available over
  plaintext.
- **Fix:** Default to `secure: true` and only downgrade when an explicit `ALLOW_INSECURE_COOKIES` dev flag is set.

---

## Checked and found correct (no finding)

Recorded so these are not re-audited:

- MCP secret handling matches the CLAUDE.md rule. `mcpKeyService.ts:328-343` generates a 32-byte secret via
  `randomBytes(32)` with an explicit length assertion, stores only `createHmac('sha256', pepper)` hex
  (`mcpKeyService.ts:232-234`), returns the cleartext exactly once, and `storedView` (`:217-230`) never includes
  the digest. No `Math.random`, no `Date.now`-seeded material anywhere in the auth/MCP path.
- Digest comparison is constant-time — `hmacMatches` (`mcpKeyService.ts:236-244`) length-validates both hex
  strings then uses `crypto.timingSafeEqual`.
- Revocation and expiry are re-checked on every request, not cached: `mcpKeyService.ts:260-278` (including the
  conditional `markUsed` that closes the verify/revoke race) and again in
  `graph-query/permissions.ts:309-341`.
- The agent-key ceiling is enforced twice and correctly: at issuance via `isRuleWithinScope` against the issuer's
  current scope (`mcpKeyService.ts:317-324`), and per-request via `intersectReadScopes(keyGrants, issuerScope)`
  (`permissions.ts:363-398`), with `EMPTY_SCOPE` returned when the issuer row is gone. `permissionSubjects`
  (`permissions.ts:56-65`) deliberately does not let an agent key inherit role rows. Agent keys cannot mint keys —
  `requireAdmin` (`mcpKeyService.ts:110-119`) rejects `subjectType !== 'user'`, and `resolveMcpCredential`
  hard-codes `roles: ['member']`.
- All nine MCP handlers are genuinely thin — each is a 1-line delegation to `McpToolServices` with zero DB access
  and zero branching (`services/core/src/mcp/handlers/*.ts`). No architecture violation.
- Error paths fail closed: `gateway.ts:265-271` maps non-auth errors to 500 rather than proceeding;
  `executeMcpTool` (`toolExecution.ts:43-52`) collapses every error to a fixed string;
  `authenticate.ts:64-73` propagates non-`SessionTokenError` to a 500 instead of a permissive default;
  `scopeFromRows` (`permissions.ts:119-130`) treats any unknown `effect` as a deny and a malformed deny as a
  root deny.
- JWT algorithm confusion is not possible — both verifiers pin `{ algorithms: ['HS256'] }`
  (`sessionToken.ts:74`, `loginState.ts:102`), and the `purpose` claim blocks cross-family replay.
- The pre-tenant MCP key lookup is done correctly, via a narrow `SECURITY DEFINER` function with
  `SET search_path` and `REVOKE ALL … FROM PUBLIC` (`drizzle/0014_w4_06_mcp_gateway.sql:14-47`) — this is the
  pattern the login resolver in finding #2 is missing.
- No secret material is logged anywhere in `auth/`, `mcp/`, `mcpKeyService.ts`, `mcpKeyStore.ts`, or
  `loginService.ts` (zero `console.*`/logger calls), and `infra/.env.example` contains placeholders only.
