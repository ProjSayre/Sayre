# CH-01 — Ephemeral scoped MCP credentials for first-party chat

## Ticket Check

**What I'm about to build**
When someone asks Sayre a question in chat, the assistant needs its own short-lived pass to look
things up in the codebase map. This builds that pass: a temporary key that expires in five minutes,
is tied to one conversation and one person, and can only see exactly what that person is already
allowed to see — never more.

**What I'm explicitly not doing**
No chat window, no buttons, no screens of any kind. Nothing that lets an administrator see or cancel
these passes in the product UI. And nothing that actually hands the pass to the chat assistant yet —
wiring it into the conversation flow is a separate, later ticket. This ticket only builds the pass
and the door it opens.

**How you'll know it worked**
Ask an engineer to demonstrate three things: (1) a freshly issued pass lets the assistant look up
exactly the files that person can already open in the app — no more; (2) waiting past the five
minutes makes the same pass stop working, and the refusal looks identical to a completely made-up
pass, so nobody can probe the system to learn which passes once existed; (3) the pass itself is never
written down anywhere — only a scrambled fingerprint of it is kept, plus a record of who asked, for
which conversation, when, and when it expires.

**What I had to guess**
Four things the ticket left open, each resolved one way here:
1. These temporary passes are stored alongside the existing long-lived agent keys in the same
   records table, marked with a type label, rather than in a brand-new table. This was chosen
   because it lets the existing "can never exceed the issuing person's permissions" machinery apply
   with no changes at all to the most security-sensitive code in the repo.
2. A pass keeps matching the person's permissions *as they are now*, not frozen at the moment it was
   issued. If someone's access is taken away, their in-flight pass narrows immediately. It can never
   widen beyond what it was issued with.
3. I added one thing the ticket did not ask for: without it, someone could sidestep the per-minute
   usage limit simply by asking for a fresh pass. These passes now share one usage budget per person.
4. The conversation id recorded on the pass is not yet checked against a real conversation record,
   because conversations do not exist in the database until the next ticket.

## Goal

Give the first-party "Ask Sayre" agent loop a short-lived, conversation-bound, digest-only MCP
bearer credential whose effective RBAC scope is exactly the asking user's own effective scope, so
the existing MCP gateway and every existing tool handler enforce that user's access with zero
handler changes.

## Scope

**In**

- A new credential family (`kind = 'chat_ephemeral'`) persisted in the existing `mcp_client_keys`
  table, discriminated from long-lived agent keys (`kind = 'agent'`), carrying a conversation
  binding and a mandatory, DB-capped expiry.
- A new service module that mints one of these credentials for a signed-in user, returning a
  one-time bearer token and persisting only a pepper-versioned HMAC-SHA-256 digest.
- A mint-time snapshot of the issuing user's effective read scope, written as `permissions` rows
  with `subject_type = 'agent_key'` and `subject_id = <key prefix>` — i.e. the existing agent-key
  ceiling model, reused verbatim.
- Extension of `resolveMcpCredential` so the gateway's existing bearer path resolves both families
  through one code path, with a token-family/stored-kind cross-check.
- A stable metering/rate-limit subject so re-minting cannot reset the per-minute budget or explode
  metric cardinality.
- An org-scoped audit read (issuer, conversation, issued_at, expiry, kind, last_used_at) and an
  org-scoped, admin-gated sweep of expired ephemeral rows.
- Migration `0019`, its journal entry, the Drizzle schema columns, and a migration security-contract
  test.

**Out**

- Any UI, any HTTP route, any GraphQL surface. `mintEphemeralMcpCredential` is called by CH-04's
  chat service; this ticket ships no caller.
- Revocation UI or an admin listing of ephemeral credentials in the MCP settings screen (they are
  deliberately excluded from that list).
- Any change to `services/core/src/graph-query/permissions.ts`. The design is chosen specifically so
  that file is untouched.
- Any change to `services/core/src/mcp/handlers/*`. Handlers must remain byte-identical.
- Scheduling/cron wiring for the sweep. Lazy rejection on resolve is the enforcement path; the sweep
  is hygiene only and is left uninvoked.
- A foreign key from `mcp_client_keys.conversation_id` to a conversations table (that table does not
  exist until CH-03).
- Neo4j / graph-schema changes. There are none — this is entirely a Postgres + service-layer change.

## Affected files

**Created**

- `services/core/src/services/ephemeralMcpCredentialService.ts` — mint / audit-read / sweep.
- `services/core/src/services/ephemeralMcpCredentialService.test.ts` — behavioral suite (red).
- `services/core/src/db/ephemeralMcpCredentialStore.ts` — store interface + Postgres implementation.
- `services/core/drizzle/0019_ch01_ephemeral_mcp_credentials.sql` — hand-authored migration.
- `services/core/src/security/ephemeralMcpCredentialMigration.test.ts` — migration text/security
  contract, mirroring `services/core/src/security/mcpMigration.test.ts`.

**Modified**

- `services/core/src/services/mcpKeyService.ts` — two token-family regexes, `parseToken` returns a
  kind, `resolveMcpCredential` cross-checks kind and populates the two new
  `ResolvedMcpCredential` fields.
- `services/core/src/db/mcpKeyStore.ts` — `McpKeyLookup` gains `kind`/`conversationId`;
  `resolve()` maps the two new columns fail-closed; `list()` and `revoke()` gain a
  `kind = 'agent'` predicate.
- `services/core/src/db/schema.ts` — `mcpClientKeys` gains `kind` and `conversationId`, plus the
  doc comment for the hand-authored partial indexes.
- `services/core/src/mcp/toolExecution.ts` — rate-limit and metric bucket key becomes
  `credential.meteringSubject`.
- `services/core/src/mcp/metrics.ts` — doc comment only on `McpToolMeasurement.keyPrefix`
  (the field name and the emitted `key_id` attribute stay as they are).
- `services/core/drizzle/meta/_journal.json` — add entry `idx: 19`,
  `tag: "0019_ch01_ephemeral_mcp_credentials"`, `version: "7"`, `breakpoints: true`,
  `when: 1785384300000`.
- `packages/shared-types/src/index.ts` — add `McpCredentialKind` under the existing
  `--- W4-06: read-only MCP Gateway administration ---` block.
- `services/core/src/services/mcpKeyService.test.ts` — the `McpKeyLookup` fixture and the
  `resolveMcpCredential` `.resolves.toEqual({...})` assertion must gain the new fields. This is a
  required mechanical update, not optional.
- `services/core/src/mcp/gateway.test.ts` — the `CREDENTIAL` fixture must gain `kind` and
  `meteringSubject`; add the ephemeral end-to-end auth case.
- `docs/wave0-foundation-contracts.md` — one paragraph under "Persistence and tenant enforcement"
  recording the second credential kind.

**Deliberately unmodified (Review should verify with `git diff --name-only`)**

- `services/core/src/graph-query/permissions.ts`
- `services/core/src/mcp/handlers/*` (all nine files)
- `services/core/src/mcp/gateway.ts`
- `services/core/src/auth/context.ts`

## Interfaces / signatures

### `packages/shared-types/src/index.ts`

```ts
/** CH-01: which credential family a `mcp_client_keys` row belongs to. */
export type McpCredentialKind = 'agent' | 'chat_ephemeral';
```

### `services/core/src/db/schema.ts` — `mcpClientKeys` additions

```ts
// CH-01: credential family discriminator. 'agent' = the long-lived, org-scoped
// W4-06 agent key; 'chat_ephemeral' = a short-lived, user-scoped,
// conversation-bound first-party chat credential. CHECK lives in drizzle/0019_*.
kind: text("kind").notNull().default("agent"),
// CH-01: the conversation an ephemeral credential is bound to. NULL for
// kind='agent'; NOT NULL for kind='chat_ephemeral' (CHECK in 0019). Deliberately
// NOT a foreign key — the conversations table does not exist until CH-03.
conversationId: uuid("conversation_id"),
```

No new entries in the Drizzle `(table) => [...]` index array: both new indexes are partial and are
hand-authored in `0019` (same convention as `users_external_auth_id_unique` / `jira_connections`).

### `services/core/drizzle/0019_ch01_ephemeral_mcp_credentials.sql`

Statement order, each separated by `--> statement-breakpoint`:

```sql
ALTER TABLE mcp_client_keys ADD COLUMN kind text DEFAULT 'agent' NOT NULL;
ALTER TABLE mcp_client_keys ADD COLUMN conversation_id uuid;

ALTER TABLE mcp_client_keys ADD CONSTRAINT mcp_client_keys_kind_check
  CHECK (kind IN ('agent','chat_ephemeral'));

ALTER TABLE mcp_client_keys ADD CONSTRAINT mcp_client_keys_ephemeral_shape_check
  CHECK (
    (kind = 'chat_ephemeral' AND conversation_id IS NOT NULL AND expires_at IS NOT NULL)
    OR (kind = 'agent' AND conversation_id IS NULL)
  );

ALTER TABLE mcp_client_keys ADD CONSTRAINT mcp_client_keys_ephemeral_ttl_check
  CHECK (
    kind <> 'chat_ephemeral'
    OR (expires_at > created_at AND expires_at <= created_at + interval '600 seconds')
  );

CREATE INDEX mcp_client_keys_ephemeral_conversation_idx
  ON mcp_client_keys (org_id, conversation_id)
  WHERE kind = 'chat_ephemeral';

CREATE INDEX mcp_client_keys_ephemeral_expires_idx
  ON mcp_client_keys (expires_at)
  WHERE kind = 'chat_ephemeral';

DROP FUNCTION IF EXISTS resolve_mcp_client_key(text);
CREATE FUNCTION resolve_mcp_client_key(p_key_prefix text)
RETURNS TABLE (
  key_id uuid,
  org_id uuid,
  key_prefix text,
  key_hmac text,
  pepper_version integer,
  expires_at timestamp with time zone,
  revoked_at timestamp with time zone,
  created_by uuid,
  rate_limit_per_minute integer,
  kind text,
  conversation_id uuid
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT key.id,
         key.org_id,
         key.key_prefix,
         key.key_hmac,
         key.pepper_version,
         key.expires_at,
         key.revoked_at,
         key.created_by,
         org.mcp_rate_limit_per_minute,
         key.kind,
         key.conversation_id
  FROM mcp_client_keys AS key
  JOIN organizations AS org ON org.id = key.org_id
  WHERE key.key_prefix = p_key_prefix
  LIMIT 1
$$;

REVOKE ALL ON FUNCTION resolve_mcp_client_key(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_mcp_client_key(text) TO sayre_app;
```

Three constraints on how this file is written:

1. `DROP FUNCTION` before `CREATE` is mandatory — Postgres rejects `CREATE OR REPLACE` when the
   `RETURNS TABLE` column list changes. `DROP` also drops the grants, which is why `REVOKE`/`GRANT`
   are re-issued.
2. `created_by IS NOT NULL` is deliberately **absent** from `mcp_client_keys_ephemeral_shape_check`.
   `created_by` is `ON DELETE SET NULL`; including it would make deleting a user fail whenever that
   user has an ephemeral row, reproducing exactly the cascade defect documented in
   `drizzle/0007_*`'s `mcp_client_keys_same_org_actor()` header. Attribution is enforced by the
   service (which always sets it), and a NULL `created_by` already fails closed in both
   `resolveMcpCredential` and `PostgresPermissionStore.getReadScope`.
3. The file's comments must avoid the words `raw_key`, `plaintext`, `token`, and `secret` so the new
   migration security test can assert their absence (mirroring
   `services/core/src/security/mcpMigration.test.ts`). Use "digest-only" and "credential material".

The table already has RLS enabled + forced, an `org_isolation` policy, the `same_org_actor` trigger,
the `set_updated_at` trigger, and `GRANT SELECT, INSERT, UPDATE, DELETE ... TO sayre_app`.
`ALTER TABLE ... ADD COLUMN` preserves all of them, so none are re-declared.

### `services/core/src/db/mcpKeyStore.ts`

```ts
import type { McpCredentialKind } from '@sayre/shared-types';

export interface McpKeyLookup {
  id: string;
  orgId: string;
  keyPrefix: string;
  keyHmac: string;
  pepperVersion: number;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdBy: string | null;
  rateLimitPerMinute: number;
  /** CH-01. `null` when the stored value is not a recognized kind — fail closed. */
  kind: McpCredentialKind | null;
  /** CH-01. Non-null only for `kind === 'chat_ephemeral'`. */
  conversationId: string | null;
}
```

`BootstrapRow` gains `kind: string;` and `conversation_id: string | null;`. `resolve()` maps them
through a local, exhaustive guard — never a default-to-`'agent'` fallback:

```ts
function credentialKind(value: unknown): McpCredentialKind | null {
  return value === 'agent' || value === 'chat_ephemeral' ? value : null;
}
```

`PostgresMcpKeyStore.list()` and `PostgresMcpKeyStore.revoke()` each gain
`eq(mcpClientKeys.kind, 'agent')` inside their existing `and(...)`. `resolve()` and `markUsed()`
stay kind-agnostic (both families authenticate through them).

### `services/core/src/db/ephemeralMcpCredentialStore.ts` (new)

```ts
import type { McpReadGrant } from '@sayre/shared-types';

/** Mint-time snapshot of the issuer's effective scope, persisted as `permissions` rows. */
export interface EphemeralScopeSnapshot {
  allows: McpReadGrant[];
  denies: McpReadGrant[];
}

export interface StoreEphemeralMcpCredentialInput {
  keyPrefix: string;
  keyHmac: string;
  pepperVersion: number;
  conversationId: string;
  /** Written to `created_at` explicitly so the DB TTL CHECK compares one clock. */
  issuedAt: Date;
  expiresAt: Date;
  createdBy: string;
  createdByLabel: string;
  ceiling: EphemeralScopeSnapshot;
}

export interface StoredEphemeralMcpCredential {
  id: string;
  keyPrefix: string;
  conversationId: string;
  createdAt: Date;
  createdBy: string | null;
  createdByLabel: string;
  expiresAt: Date;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
}

export interface EphemeralMcpCredentialStore {
  /** Inserts the key row and its ceiling `permissions` rows in ONE transaction. */
  issue(
    orgId: string,
    input: StoreEphemeralMcpCredentialInput,
  ): Promise<StoredEphemeralMcpCredential>;
  /** `issuedBy === null` means "every issuer in this org" (admin/owner read). */
  listByConversation(
    orgId: string,
    conversationId: string,
    issuedBy: string | null,
  ): Promise<StoredEphemeralMcpCredential[]>;
  /** Deletes expired `chat_ephemeral` rows and their `permissions` rows. Returns rows deleted. */
  deleteExpired(orgId: string, before: Date, limit: number): Promise<number>;
  getActorLabel(orgId: string, userId: string): Promise<string | null>;
}

export interface PostgresEphemeralMcpCredentialStoreDeps {
  getDb: () => Promise<Db>;
  withOrg: <T>(db: Db, orgId: string, fn: (tx: Db) => Promise<T>) => Promise<T>;
}

export class PostgresEphemeralMcpCredentialStore
  implements EphemeralMcpCredentialStore { /* ... */ }

export const ephemeralMcpCredentialStore: EphemeralMcpCredentialStore =
  new PostgresEphemeralMcpCredentialStore();
```

`issue()` writes (all inside `withOrgContext(db, orgId, ...)`):

- one `mcp_client_keys` row: `{ orgId, name: EPHEMERAL_CREDENTIAL_NAME, keyPrefix, keyHmac,
  pepperVersion, kind: 'chat_ephemeral', conversationId, createdAt: input.issuedAt,
  updatedAt: input.issuedAt, expiresAt, createdBy, createdByLabel }`;
- then, only if `ceiling.allows.length + ceiling.denies.length > 0`, one `permissions` insert of
  `{ orgId, subjectType: 'agent_key', subjectId: keyPrefix, repoId, branch, pathPrefix,
  action: 'read', effect: 'allow' | 'deny' }` rows.

`deleteExpired()` selects up to `limit` `key_prefix` values where
`org_id = $1 AND kind = 'chat_ephemeral' AND expires_at <= $2`, deletes the matching `permissions`
rows (`subject_type = 'agent_key' AND subject_id = ANY(prefixes)`), then deletes the key rows —
one transaction, org-scoped, `kind`-scoped.

### `services/core/src/services/mcpKeyService.ts`

```ts
const AGENT_KEY_RE = /^(mcp_live_[a-f0-9]{16})\.([A-Za-z0-9_-]{43})$/;
const CHAT_KEY_RE  = /^(mcp_chat_[a-f0-9]{16})\.([A-Za-z0-9_-]{43})$/;

interface ParsedMcpToken {
  keyPrefix: string;
  secret: string;
  kind: McpCredentialKind;
}

function parseToken(token: string): ParsedMcpToken;   // throws McpKeyAuthenticationError

export interface ResolvedMcpCredential {
  context: AgentKeyAuthContext;
  keyId: string;
  keyPrefix: string;
  rateLimitPerMinute: number;
  /** CH-01: which credential family authenticated. */
  kind: McpCredentialKind;
  /**
   * CH-01: stable rate-limit and metrics bucket key.
   * `'agent'`          -> the key prefix (unchanged behavior).
   * `'chat_ephemeral'` -> `chat:<issuing user id>`, so minting a fresh 300s
   * credential cannot reset the caller's per-minute budget, and metric
   * cardinality stays bounded by users-per-org rather than by mints.
   */
  meteringSubject: string;
}

export async function resolveMcpCredential(
  token: string,
  overrides?: Partial<McpKeyServiceDeps>,
): Promise<ResolvedMcpCredential>;   // signature UNCHANGED
```

`resolveMcpCredential`'s existing rejection disjunction gains exactly one clause,
`row.kind !== parsed.kind` (which also rejects `row.kind === null`). Every other check — `!row`,
prefix mismatch, `createdBy === null`, `revokedAt !== null`, `expiresAt <= now`, pepper version,
`hmacMatches`, `markUsed` — is unchanged and already correct for both families. The returned
`context` stays `{ subjectType: 'agent_key', agentKeyId: keyPrefix, orgId: row.orgId,
roles: ['member'] }` for both families.

### `services/core/src/services/ephemeralMcpCredentialService.ts` (new)

```ts
export const DEFAULT_EPHEMERAL_TTL_SECONDS = 300;
export const MAX_EPHEMERAL_TTL_SECONDS = 600;
export const MAX_EPHEMERAL_CEILING_ROWS = 512;
export const EPHEMERAL_SWEEP_BATCH = 1_000;
export const EPHEMERAL_CREDENTIAL_NAME = 'Ask Sayre chat session';

export class EphemeralMcpCredentialValidationError extends Error {
  constructor() {
    super('Ephemeral MCP credential request is invalid.');
    this.name = 'EphemeralMcpCredentialValidationError';
  }
}

export class EphemeralMcpCredentialForbiddenError extends Error {
  constructor() {
    super('Ephemeral MCP credentials require a signed-in user.');
    this.name = 'EphemeralMcpCredentialForbiddenError';
  }
}

/** `{ conversationId }` or `{ conversationId, ttlSeconds }` — no other keys accepted. */
export interface MintEphemeralMcpCredentialInput {
  conversationId: string;
  ttlSeconds?: number;
}

/**
 * Returned once, in memory, to the caller that minted it. Deliberately NOT in
 * @sayre/shared-types: nothing carrying `token` may become a shared, casually
 * serialized wire type.
 */
export interface MintedEphemeralMcpCredential {
  token: string;
  keyId: string;
  keyPrefix: string;
  kind: 'chat_ephemeral';
  conversationId: string;
  issuedByUserId: string;
  issuedAt: string;   // ISO-8601
  expiresAt: string;  // ISO-8601
}

export interface EphemeralMcpCredentialAudit {
  keyId: string;
  keyPrefix: string;
  kind: 'chat_ephemeral';
  conversationId: string;
  issuedByUserId: string | null;
  issuedByLabel: string;
  issuedAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface EphemeralMcpCredentialServiceDeps {
  store: EphemeralMcpCredentialStore;
  permissions: PermissionStore;
  getPepper: () => Promise<string>;
  getPepperVersion: () => number;
  now: () => Date;
  randomSecret: () => Buffer;      // 32 bytes
  randomPrefixBytes: () => Buffer; // 8 bytes
}

/** `ctx.orgId`/`ctx.userId` are the ONLY sources of tenancy — `input` carries no org_id. */
export async function mintEphemeralMcpCredential(
  input: unknown,
  ctx: AuthContext,
  overrides?: Partial<EphemeralMcpCredentialServiceDeps>,
): Promise<MintedEphemeralMcpCredential>;

export async function listEphemeralMcpCredentialAudit(
  conversationId: unknown,
  ctx: AuthContext,
  overrides?: Partial<EphemeralMcpCredentialServiceDeps>,
): Promise<EphemeralMcpCredentialAudit[]>;

/** Hygiene only; lazy rejection on resolve is the enforcement path. Admin/owner gated. */
export async function sweepExpiredEphemeralMcpCredentials(
  ctx: AuthContext,
  overrides?: Partial<EphemeralMcpCredentialServiceDeps>,
): Promise<number>;
```

Default deps mirror `mcpKeyService`'s exactly:
`{ store: ephemeralMcpCredentialStore, permissions: new PostgresPermissionStore(),
getPepper: () => getSecret('env://MCP_TOKEN_PEPPER'),
getPepperVersion: () => parseBoundedInteger(getConfig('MCP_TOKEN_PEPPER_VERSION'), 1, 2_147_483_647),
now: () => new Date(), randomSecret: () => randomBytes(32), randomPrefixBytes: () => randomBytes(8) }`.
The digest is computed with the already-exported `mcpSecretHmac(secret, pepper)` from
`mcpKeyService.ts` — do not re-implement it.

### `services/core/src/mcp/toolExecution.ts`

Two call sites change; nothing else in the file does:

```ts
deps.limiter.consume(
  credential.context.orgId,
  credential.meteringSubject,
  credential.rateLimitPerMinute,
);
...
deps.record({
  orgId: credential.context.orgId,
  keyPrefix: credential.meteringSubject,
  tool,
  outcome,
  responseText,
});
```

`McpToolMeasurement.keyPrefix` keeps its name and still maps to the `key_id` metric attribute; only
its doc comment changes, to say it is the public metering subject (an agent key prefix, or
`chat:<userId>` for an ephemeral credential) and never key material.

## Approach

Build in this order — each step compiles and is independently testable.

1. **`packages/shared-types`** — add `McpCredentialKind`.

2. **`services/core/src/db/schema.ts`** — add `kind` and `conversationId` to `mcpClientKeys` with
   the comments given above.

3. **Migration `0019` + `meta/_journal.json`** — write the SQL exactly as specified. Verify by
   inspection that `DROP FUNCTION` precedes `CREATE FUNCTION`, that `REVOKE`/`GRANT` follow the
   recreate, and that no comment in the file contains `raw_key`/`plaintext`/`token`/`secret`.

4. **`services/core/src/db/mcpKeyStore.ts`** — extend `McpKeyLookup` and `BootstrapRow`, add the
   fail-closed `credentialKind()` mapping in `resolve()`, and add `eq(mcpClientKeys.kind, 'agent')`
   to `list()` and `revoke()`. Nothing else in this file changes.

5. **`services/core/src/db/ephemeralMcpCredentialStore.ts`** — new store, following
   `PostgresMcpKeyStore`'s idioms (injected `getDb`/`withOrg`, everything inside `withOrgContext`).

6. **`services/core/src/services/ephemeralMcpCredentialService.ts`** — `mintEphemeralMcpCredential`
   in this exact order, so no key material is generated for a request that will be rejected:
   1. Validate `input` is a non-null, non-array object whose key set is exactly
      `['conversationId']` or `['conversationId','ttlSeconds']` (same strict-key idiom as
      `parseCreateRequest`). `conversationId` must match the module's UUID regex. `ttlSeconds`, if
      present, must satisfy `Number.isSafeInteger` and be in `[1, MAX_EPHEMERAL_TTL_SECONDS]`;
      otherwise default to `DEFAULT_EPHEMERAL_TTL_SECONDS`. Any failure →
      `EphemeralMcpCredentialValidationError`.
   2. `if (ctx.subjectType !== 'user') throw new EphemeralMcpCredentialForbiddenError()`.
   3. `const issuedAt = deps.now();`
      `const expiresAt = new Date(issuedAt.valueOf() + ttlSeconds * 1_000);`
   4. `const scope = await deps.permissions.getReadScope(ctx);` — the issuer's **current** effective
      scope, with no `repoId` narrowing.
   5. `if (scope.allows.length + scope.denies.length > MAX_EPHEMERAL_CEILING_ROWS) throw new
      EphemeralMcpCredentialValidationError();` — fail loudly rather than silently truncating a
      ceiling.
   6. `const actorLabel = await deps.store.getActorLabel(ctx.orgId, ctx.userId);`
      `if (!actorLabel) throw new EphemeralMcpCredentialForbiddenError();`
   7. Generate: `const secretBytes = deps.randomSecret();` with the same
      `if (secretBytes.length !== 32) throw new Error(...)` guard `issueMcpKey` uses;
      `const secret = secretBytes.toString('base64url');`
      `const keyPrefix = \`mcp_chat_${deps.randomPrefixBytes().toString('hex')}\`;` (an 8-byte
      buffer yields the required 16 hex chars — assert its length the same way).
   8. `const keyHmac = mcpSecretHmac(secret, await deps.getPepper());`
      `const pepperVersion = deps.getPepperVersion();`
   9. `const row = await deps.store.issue(ctx.orgId, { ..., ceiling: { allows: scope.allows,
      denies: scope.denies } });`
   10. Return `{ token: \`${keyPrefix}.${secret}\`, keyId: row.id, keyPrefix, kind:
       'chat_ephemeral', conversationId, issuedByUserId: ctx.userId,
       issuedAt: issuedAt.toISOString(), expiresAt: expiresAt.toISOString() }`. No `console`/logger
       call anywhere in this function.

   `listEphemeralMcpCredentialAudit`: validate `conversationId` as a UUID; require
   `ctx.subjectType === 'user'`; compute
   `const issuedBy = ctx.roles.includes('owner') || ctx.roles.includes('admin') ? null : ctx.userId;`
   and map store rows to `EphemeralMcpCredentialAudit` (ISO strings; no `keyHmac`, no
   `pepperVersion`, no token material in the returned shape).

   `sweepExpiredEphemeralMcpCredentials`: require `ctx.subjectType === 'user'` and an
   `owner`/`admin` role, then
   `return deps.store.deleteExpired(ctx.orgId, deps.now(), EPHEMERAL_SWEEP_BATCH);`

7. **`services/core/src/services/mcpKeyService.ts`** — split the regex, widen `parseToken`, add the
   single `row.kind !== parsed.kind` clause, and populate `kind`/`meteringSubject` on the returned
   credential (`kind === 'chat_ephemeral' ? \`chat:${row.createdBy}\` : keyPrefix`; `row.createdBy`
   is provably non-null at that point because the existing disjunction already rejected null).

8. **`services/core/src/mcp/toolExecution.ts`** — swap the two bucket-key arguments.

9. **Fixture updates** — `mcpKeyService.test.ts` (`McpKeyLookup` literal + the `toEqual`
   expectation) and `gateway.test.ts` (`CREDENTIAL` literal).

10. **Docs** — one paragraph in `docs/wave0-foundation-contracts.md`.

**Why the credential lives in `mcp_client_keys` rather than a new table.**
`PostgresPermissionStore.getReadScope`'s `agent_key` branch already implements exactly the semantics
this ticket needs: look the key row up by `key_prefix` under org RLS, reject it if `created_by` is
null / it is revoked / it has expired, load the issuer's live scope, and return
`intersectReadScopes(keyCeiling, issuerScope)`. If the credential row lives in that same table with
`created_by` set to the asking user and its ceiling rows written as the mint-time snapshot of that
same user's scope, then AC-2 and AC-5 fall out with **zero** lines changed in
`graph-query/permissions.ts` — the single most security-sensitive file in the service. A separate
table would have required a new branch in that file. That trade is the whole reason for the `kind`
discriminator.

**Why AC-2 is a coverage claim, not an array-equality claim.**
`intersectReadScopes(S, S)` intersects every rule with every other rule, so the result may contain
*more* rules than `S` (each self-intersection, plus narrower rules for any pair that overlaps).
Every extra rule is a subset of an existing one, so the authorized *set of resources* is identical.
Tests must therefore assert equality of `canReadResource(...)` over a probe set of
`{repoId, refName, path}` resources, never deep-equality of `scope.allows`.

## Acceptance criteria

- **AC-1** `mintEphemeralMcpCredential` returns a one-time bearer token matching
  `/^mcp_chat_[a-f0-9]{16}\.[A-Za-z0-9_-]{43}$/`, and presenting that token as
  `Authorization: Bearer <token>` to the real gateway (`POST /mcp` through
  `createMcpGatewayRouter` with the real `resolveMcpCredential`) inside its TTL authenticates
  successfully and serves a tool call.
- **AC-2** The resolved credential's effective read scope has identical resource coverage to the
  issuing user's current effective scope from `PostgresPermissionStore.getReadScope` — proven by
  `canReadResource` agreeing on every probe resource for the mint-time ceiling intersected with the
  issuer's live scope.
- **AC-3** A token presented after `expiresAt` is rejected with `McpKeyAuthenticationError`, and the
  gateway response for it is byte-identical to the response for a syntactically valid but entirely
  unknown token (HTTP 401, `{"jsonrpc":"2.0","error":{"code":-32001,"message":"Unauthorized."},
  "id":null}`) — no expired-vs-unknown oracle.
- **AC-4** Storage is digest-only: the payload handed to the store contains no substring of the
  returned token's secret, `keyHmac` matches `/^[a-f0-9]{64}$/` and equals
  `mcpSecretHmac(secret, pepper)`, and `pepperVersion` is the configured version. No persisted
  column and no returned audit field carries the raw token.
- **AC-5** The persisted ceiling is exactly the issuing user's mint-time effective scope
  (allows as `effect: 'allow'` rows, denies as `effect: 'deny'` rows, `subject_type = 'agent_key'`,
  `subject_id = <key prefix>`), and a ceiling artificially widened after mint still cannot produce
  coverage beyond the issuer's live scope, because resolution intersects the two.
- **AC-6** Audit fields are persisted and queryable: `listEphemeralMcpCredentialAudit` returns
  `kind`, `conversationId`, `issuedByUserId`, `issuedByLabel`, `issuedAt`, `expiresAt`,
  `lastUsedAt`, `revokedAt` for a conversation, org-scoped, with no digest or key material in the
  result.
- **AC-7** TTL defaults to 300 seconds when `ttlSeconds` is omitted, is accepted up to 600 seconds,
  and is rejected above 600 or when non-integer/non-positive — rejected *before* any key material is
  generated or any row is written. The 600-second ceiling is additionally enforced in the database
  by `mcp_client_keys_ephemeral_ttl_check`.
- **AC-8** `org_id` is never accepted from caller input: `mintEphemeralMcpCredential`'s signature has
  no org parameter, the input object's accepted key set is exactly `conversationId`/`ttlSeconds`,
  and every write runs inside `withOrgContext(db, ctx.orgId, ...)`.
- **AC-9** For an ephemeral credential the rate-limit and metric bucket key is `chat:<issuing user
  id>`, so a second credential minted for the same user continues consuming the same per-minute
  window rather than a fresh one; for an agent key the bucket key is still the key prefix and
  behavior is unchanged.
- **AC-10** Existing agent-key behavior is unchanged end to end (issue, resolve, revoke, rate-limit
  settings), and the admin surfaces exclude the new family: `getMcpKeySettings` never returns a
  `chat_ephemeral` row, and `revokeMcpKey` given a `chat_ephemeral` credential's id throws
  `McpKeyNotFoundError`.
- **AC-11** No file under `services/core/src/mcp/handlers/`, nor
  `services/core/src/graph-query/permissions.ts`, nor `services/core/src/mcp/gateway.ts`, nor
  `services/core/src/auth/context.ts` appears in the diff.
- **AC-12** `sweepExpiredEphemeralMcpCredentials` deletes expired `chat_ephemeral` rows together
  with their `permissions` rows, within one org and one transaction, leaving live ephemeral rows,
  every `agent` row (expired or not), and every other org untouched; it is rejected for a non-user
  or non-admin context; and it is not wired to any scheduler in this ticket.
- **AC-13** Migration `0019` follows repo convention: hand-authored SQL with
  `--> statement-breakpoint` separators, a matching `meta/_journal.json` entry, the three CHECK
  constraints, both partial indexes, and a `DROP`-then-`CREATE` of `resolve_mcp_client_key` that
  remains `SECURITY DEFINER` with `SET search_path = public, pg_temp` and re-applies
  `REVOKE ALL ... FROM PUBLIC` / `GRANT EXECUTE ... TO sayre_app`.

## Edge cases

- **EC-1** A syntactically valid token with an unknown prefix is rejected identically to an expired
  one — same error type, same gateway status and body.
- **EC-2** Expiry boundary: a token used when `now === expiresAt` is rejected (`<=`); one used 1 ms
  earlier is accepted.
- **EC-3** Token-family / stored-kind mismatch in both directions — an `mcp_chat_` token whose row is
  `kind='agent'`, and an `mcp_live_` token whose row is `kind='chat_ephemeral'` — is rejected before
  the HMAC comparison.
- **EC-4** An unrecognized `kind` value in the database maps to `null` and is rejected; it never
  degrades to `'agent'`.
- **EC-5** Malformed tokens (no `.` separator, wrong prefix literal, non-hex prefix body, prefix
  body of wrong length, secret of wrong length or with disallowed characters, empty string,
  whitespace-only, missing `Bearer` scheme) are rejected by `parseToken` with no store lookup at all.
- **EC-6** An ephemeral row whose `pepper_version` differs from the configured version is rejected
  (rotation invalidates in-flight ephemeral credentials — acceptable at a 300s TTL).
- **EC-7** An ephemeral row with `revoked_at` set is rejected, even though this ticket ships no
  revocation surface.
- **EC-8** The issuing user is deleted after mint: the `ON DELETE SET NULL` cascade succeeds (the
  DB CHECK deliberately does not require `created_by`), the credential then fails authentication on
  `createdBy === null`, and `getReadScope` returns the empty scope.
- **EC-9** `ttlSeconds` of `0`, `-1`, `1.5`, `NaN`, `Infinity`, `601`, `'300'`, `null`, or `true` is
  rejected; omitting the key yields 300.
- **EC-10** `conversationId` that is missing, empty, a non-UUID string, a non-string, or accompanied
  by any extra/unknown key on the input object is rejected.
- **EC-11** A non-user caller — including a resolved ephemeral credential's own
  `subjectType: 'agent_key'` context — cannot mint another credential (no self-issuance chain), and
  cannot read audit rows or run the sweep.
- **EC-12** An issuing user with an empty effective scope mints successfully: zero `permissions`
  rows are written, the credential resolves, and every tool returns empty/null rather than an error
  that would leak the caller's scope emptiness.
- **EC-13** An `owner` issuer's ceiling is the single wildcard rule
  `{repoId: null, branch: null, pathPrefix: null}`; the resolved coverage equals the owner scope and
  is not broadened.
- **EC-14** The issuer's permissions are narrowed, or a deny is added, after mint but before use:
  the very next resolve narrows accordingly (live intersection), with no new mint required.
- **EC-15** A ceiling `permissions` row edited directly in the database to something broader than
  the issuer's live scope still yields no additional authorized resource.
- **EC-16** An issuer whose effective scope exceeds `MAX_EPHEMERAL_CEILING_ROWS` rules causes mint to
  fail loudly rather than silently persisting a truncated (narrower) ceiling.
- **EC-17** Two concurrent mints for the same `conversationId` both succeed with distinct prefixes
  and independent expiries — there is no unique constraint on `conversation_id`.
- **EC-18** Minting a second credential for the same user does not reset the per-minute rate-limit
  window; two different users each get their own window; agent keys keep per-prefix windows.
- **EC-19** `getMcpKeySettings` omits `chat_ephemeral` rows entirely, and `revokeMcpKey` given such
  a row's id throws `McpKeyNotFoundError` rather than revoking it.
- **EC-20** Database CHECK constraints reject: a `chat_ephemeral` row with NULL `conversation_id`; a
  `chat_ephemeral` row with NULL `expires_at`; a `chat_ephemeral` row with
  `expires_at > created_at + 600s` or `expires_at <= created_at`; an `agent` row with a non-null
  `conversation_id`; and any row with a `kind` outside the two allowed values.
- **EC-21** `deleteExpired` is org-scoped and kind-scoped: it removes only expired `chat_ephemeral`
  rows plus their `permissions` rows, and leaves live ephemeral rows, expired `agent` keys, and
  other orgs' rows in place.
- **EC-22** No raw token reaches any persisted column, metric attribute, error message, thrown
  stack, or log line; error messages for every rejection path are the fixed constant strings defined
  on the error classes.
- **EC-23** After `0019`, `resolve_mcp_client_key(text)` is not executable by `PUBLIC`, is executable
  by `sayre_app`, and retains `SECURITY DEFINER` plus `SET search_path = public, pg_temp`.
- **EC-24** Audit read scoping: a `member` sees only credentials they themselves issued for that
  conversation; an `owner`/`admin` sees all of that conversation's credentials within their org; a
  conversation id belonging to another org returns an empty array (RLS + explicit `org_id`
  predicate), never another tenant's rows.

### Testing notes for `red` / `tester`

- Everything except EC-20, EC-21 (the SQL half), EC-23, and the DB half of AC-2 is provable with
  injected fakes (`store`, `permissions`, `now`, `randomSecret`, `randomPrefixBytes`, `getPepper`,
  `getPepperVersion`) exactly as `mcpKeyService.test.ts` already does — those belong in
  `ephemeralMcpCredentialService.test.ts` and run under plain `vitest`.
- AC-2 decomposes into three provable parts without a database: (a) the ceiling captured by a fake
  store deep-equals the scope the fake `PermissionStore` returned; (b)
  `intersectReadScopes(snapshot, issuerScope)` has coverage identical to `issuerScope` over a probe
  set, via the real exported `canReadResource`; (c) an end-to-end gateway round trip with a fake
  `PermissionStore` proving the tool handler receives the `agent_key` context for that prefix.
- Genuinely DB-dependent assertions (EC-20, EC-21's SQL behavior, EC-23) belong in a Node
  `--test` file alongside `services/core/src/db/rls.test.ts`, run via the existing
  `npm --prefix services/core run test:rls`-style script and gated on `DATABASE_ADMIN_URL`. If no
  database is available in this run, `red` should classify those as `RED-DEFERRED` with that reason
  rather than weakening them into text assertions.
- AC-13 and the migration half of EC-23 are provable as a text contract in
  `services/core/src/security/ephemeralMcpCredentialMigration.test.ts`, mirroring the existing
  `mcpMigration.test.ts` (including its
  `expect(migration).not.toMatch(/\b(?:raw_key|plaintext|token|secret)\b/i)` assertion).
- AC-11 is provable with `git diff --name-only` against the merge base, or by hashing the handler
  files; `review` should check it directly.

## Open questions

1. **Ceiling snapshot vs. pure live-user scope (resolved, but worth a human confirming).** The
   ticket says both "equal to the asking user's *current* effective scope" and "reuse the existing
   `permissions` model and ceiling semantics," and AC4 says "at mint time." Those pull slightly apart
   if the user *gains* access during the credential's 300 seconds. This spec resolves it as
   `mint-time ceiling ∩ live issuer scope`: the credential can only ever narrow after mint, never
   widen. The rejected alternative was to resolve the token to a `UserAuthContext` and let scope
   track the user live in both directions — simpler, no snapshot rows at all, but it drops the
   mint-time ceiling that AC4 names, and it would change `ResolvedMcpCredential.context`'s type. If
   you prefer the simpler live-tracking model, say so before `red` runs; it changes AC-5 and EC-15.
2. **Rate-limit and metric bucketing is beyond the ticket's literal scope.** AC-9 was added by this
   spec, not requested. Without it, a user can reset their MCP per-minute budget by minting a new
   ephemeral credential, and each mint adds a new `key_id` value to the OpenTelemetry counters
   (unbounded cardinality over a day of chat). Both are direct consequences of introducing a
   short-lived credential family, so they are treated as in-scope here. Confirm, or split AC-9 out
   into its own ticket.
3. **No foreign key on `conversation_id`.** The conversations table arrives in CH-03, so this column
   is an unvalidated UUID for now: a caller could bind a credential to a conversation id that does
   not exist, or to another user's conversation id. It grants nothing (scope comes from the issuer,
   not the conversation) but it does mean the audit trail can record a meaningless binding. Should
   CH-03 add the FK and a backfill/cleanup, or should CH-01 already validate the id against
   something? This spec assumes CH-03 adds the FK.
4. **Pepper rotation invalidates in-flight ephemeral credentials** (EC-6), because
   `resolveMcpCredential` requires `row.pepperVersion === getPepperVersion()`. At a 300s TTL the
   blast radius is one chat turn, so this spec accepts it rather than adding multi-version pepper
   support. Flagging it because it is a behavioral difference an operator would notice during a
   rotation.
5. **Sweep invocation.** `sweepExpiredEphemeralMcpCredentials` is admin-gated and takes an
   `AuthContext`, because there is no system/service auth context in this codebase to hang a
   scheduled job off. That means nothing calls it today, and expired rows accumulate until someone
   does. Acceptable per the ticket ("a cleanup sweep is optional"), but if you want it actually
   running, that needs a scheduler and a system context — a separate ticket.
6. **Lane.** This ticket was not filed through `.github/ISSUE_TEMPLATE/pipeline-ticket.yml` and
   declares no lane, so `spec.json` records `lane: null`. The work touches `services/core/**`,
   `packages/shared-types/**`, and `docs/**`, which is outside the `frontend` lane; if a lane is
   assigned retroactively it must be `full`.
