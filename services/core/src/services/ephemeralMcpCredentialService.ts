// CH-01. Mint / audit-read / sweep for the `chat_ephemeral` MCP credential
// family: a short-lived, conversation-bound, digest-only bearer credential
// whose effective RBAC scope is the mint-time snapshot of the issuing user's
// effective scope, intersected with that user's CURRENT effective scope on
// every resolve (`graph-query/permissions.ts`'s existing `agent_key` branch —
// unmodified by this ticket).
//
// `org_id` is never accepted from caller input: every write below runs
// through `ctx.orgId`, passed to the store's `orgId` parameter, which the
// store threads through `withOrgContext` (RLS) — see
// .claude/rules/security-multitenancy.md.

import { randomBytes } from 'node:crypto';
import { getConfig, getSecret } from '@sayre/config';
import type { AuthContext } from '../auth/context';
import type {
  EphemeralMcpCredentialStore,
  EphemeralScopeSnapshot,
} from '../db/ephemeralMcpCredentialStore';
import { ephemeralMcpCredentialStore } from '../db/ephemeralMcpCredentialStore';
import {
  PostgresPermissionStore,
  type PermissionStore,
} from '../graph-query/permissions';
import { mcpSecretHmac } from './mcpKeyService';

export const DEFAULT_EPHEMERAL_TTL_SECONDS = 300;
export const MAX_EPHEMERAL_TTL_SECONDS = 600;
export const MAX_EPHEMERAL_CEILING_ROWS = 512;
export const EPHEMERAL_SWEEP_BATCH = 1_000;
export const EPHEMERAL_CREDENTIAL_NAME = 'Ask Sayre chat session';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  issuedAt: string; // ISO-8601
  expiresAt: string; // ISO-8601
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
  randomSecret: () => Buffer; // 32 bytes
  randomPrefixBytes: () => Buffer; // 8 bytes
}

function parseBoundedInteger(
  value: string,
  minimum: number,
  maximum: number,
): number {
  if (!/^\d+$/.test(value)) throw new EphemeralMcpCredentialValidationError();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new EphemeralMcpCredentialValidationError();
  }
  return parsed;
}

const defaultDeps: EphemeralMcpCredentialServiceDeps = {
  store: ephemeralMcpCredentialStore,
  permissions: new PostgresPermissionStore(),
  getPepper: () => getSecret('env://MCP_TOKEN_PEPPER'),
  getPepperVersion: () =>
    parseBoundedInteger(getConfig('MCP_TOKEN_PEPPER_VERSION'), 1, 2_147_483_647),
  now: () => new Date(),
  randomSecret: () => randomBytes(32),
  randomPrefixBytes: () => randomBytes(8),
};

function depsWith(
  overrides: Partial<EphemeralMcpCredentialServiceDeps>,
): EphemeralMcpCredentialServiceDeps {
  return { ...defaultDeps, ...overrides };
}

function requireUser(
  ctx: AuthContext,
): asserts ctx is Extract<AuthContext, { subjectType: 'user' }> {
  if (ctx.subjectType !== 'user') {
    throw new EphemeralMcpCredentialForbiddenError();
  }
}

function requireEphemeralAdmin(
  ctx: AuthContext,
): asserts ctx is Extract<AuthContext, { subjectType: 'user' }> {
  if (
    ctx.subjectType !== 'user' ||
    (!ctx.roles.includes('owner') && !ctx.roles.includes('admin'))
  ) {
    throw new EphemeralMcpCredentialForbiddenError();
  }
}

interface ParsedMintInput {
  conversationId: string;
  ttlSeconds: number;
}

function parseMintInput(body: unknown): ParsedMintInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new EphemeralMcpCredentialValidationError();
  }
  const record = body as Record<string, unknown>;
  const hasTtl = 'ttlSeconds' in record;
  const expected = hasTtl ? ['conversationId', 'ttlSeconds'] : ['conversationId'];
  const keys = Object.keys(record);
  if (
    keys.length !== expected.length ||
    !('conversationId' in record) ||
    keys.some((key) => !expected.includes(key))
  ) {
    throw new EphemeralMcpCredentialValidationError();
  }

  const conversationId = record.conversationId;
  if (typeof conversationId !== 'string' || !UUID_RE.test(conversationId)) {
    throw new EphemeralMcpCredentialValidationError();
  }

  let ttlSeconds = DEFAULT_EPHEMERAL_TTL_SECONDS;
  if (hasTtl) {
    const value = record.ttlSeconds;
    if (
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value > MAX_EPHEMERAL_TTL_SECONDS
    ) {
      throw new EphemeralMcpCredentialValidationError();
    }
    ttlSeconds = value;
  }

  return { conversationId, ttlSeconds };
}

/** `ctx.orgId`/`ctx.userId` are the ONLY sources of tenancy — `input` carries no org_id. */
export async function mintEphemeralMcpCredential(
  input: unknown,
  ctx: AuthContext,
  overrides: Partial<EphemeralMcpCredentialServiceDeps> = {},
): Promise<MintedEphemeralMcpCredential> {
  // Rejected before any key material is generated or any row is written.
  const { conversationId, ttlSeconds } = parseMintInput(input);
  requireUser(ctx);
  const deps = depsWith(overrides);

  const issuedAt = deps.now();
  const expiresAt = new Date(issuedAt.valueOf() + ttlSeconds * 1_000);

  const scope = await deps.permissions.getReadScope(ctx);
  if (scope.allows.length + scope.denies.length > MAX_EPHEMERAL_CEILING_ROWS) {
    throw new EphemeralMcpCredentialValidationError();
  }

  const actorLabel = await deps.store.getActorLabel(ctx.orgId, ctx.userId);
  if (!actorLabel) throw new EphemeralMcpCredentialForbiddenError();

  const secretBytes = deps.randomSecret();
  if (secretBytes.length !== 32) {
    throw new Error('Ephemeral MCP credential RNG returned an invalid secret length.');
  }
  const secret = secretBytes.toString('base64url');
  const prefixBytes = deps.randomPrefixBytes();
  if (prefixBytes.length !== 8) {
    throw new Error('Ephemeral MCP credential RNG returned an invalid prefix length.');
  }
  const keyPrefix = `mcp_chat_${prefixBytes.toString('hex')}`;
  const keyHmac = mcpSecretHmac(secret, await deps.getPepper());
  const pepperVersion = deps.getPepperVersion();

  const ceiling: EphemeralScopeSnapshot = {
    allows: scope.allows,
    denies: scope.denies,
  };
  const row = await deps.store.issue(ctx.orgId, {
    keyPrefix,
    keyHmac,
    pepperVersion,
    conversationId,
    issuedAt,
    expiresAt,
    createdBy: ctx.userId,
    createdByLabel: actorLabel,
    ceiling,
  });

  return {
    token: `${keyPrefix}.${secret}`,
    keyId: row.id,
    keyPrefix,
    kind: 'chat_ephemeral',
    conversationId,
    issuedByUserId: ctx.userId,
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
}

export async function listEphemeralMcpCredentialAudit(
  conversationId: unknown,
  ctx: AuthContext,
  overrides: Partial<EphemeralMcpCredentialServiceDeps> = {},
): Promise<EphemeralMcpCredentialAudit[]> {
  if (typeof conversationId !== 'string' || !UUID_RE.test(conversationId)) {
    throw new EphemeralMcpCredentialValidationError();
  }
  requireUser(ctx);
  const deps = depsWith(overrides);
  const issuedBy =
    ctx.roles.includes('owner') || ctx.roles.includes('admin') ? null : ctx.userId;
  const rows = await deps.store.listByConversation(ctx.orgId, conversationId, issuedBy);
  return rows.map((row) => ({
    keyId: row.id,
    keyPrefix: row.keyPrefix,
    kind: 'chat_ephemeral',
    conversationId: row.conversationId,
    issuedByUserId: row.createdBy,
    issuedByLabel: row.createdByLabel,
    issuedAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  }));
}

/** Hygiene only; lazy rejection on resolve is the enforcement path. Admin/owner gated. */
export async function sweepExpiredEphemeralMcpCredentials(
  ctx: AuthContext,
  overrides: Partial<EphemeralMcpCredentialServiceDeps> = {},
): Promise<number> {
  requireEphemeralAdmin(ctx);
  const deps = depsWith(overrides);
  return deps.store.deleteExpired(ctx.orgId, deps.now(), EPHEMERAL_SWEEP_BATCH);
}
