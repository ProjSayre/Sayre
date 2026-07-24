import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import {
  getConfig,
  getSecret,
} from '@sayre/config';
import type {
  McpClientKeyCreateRequest,
  McpClientKeyIssued,
  McpClientKeyView,
  McpKeySettingsResponse,
  McpReadGrant,
} from '@sayre/shared-types';
import type { AgentKeyAuthContext, AuthContext } from '../auth/context';
import {
  mcpKeyStore,
  type McpKeyStore,
  type StoredMcpKey,
} from '../db/mcpKeyStore';
import {
  isRuleWithinScope,
  normalizeAuthorizationRule,
  PostgresPermissionStore,
  type PermissionStore,
} from '../graph-query/permissions';

const KEY_RE = /^(mcp_live_[a-f0-9]{16})\.([A-Za-z0-9_-]{43})$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_GRANTS = 64;
const MAX_EXPIRY_MS = 366 * 24 * 60 * 60 * 1_000;

export class McpKeyAuthenticationError extends Error {
  constructor() {
    super('MCP authentication failed.');
    this.name = 'McpKeyAuthenticationError';
  }
}

export class McpKeyForbiddenError extends Error {
  constructor() {
    super('MCP key administration requires an organization administrator.');
    this.name = 'McpKeyForbiddenError';
  }
}

export class McpKeyValidationError extends Error {
  constructor() {
    super('MCP key settings are invalid.');
    this.name = 'McpKeyValidationError';
  }
}

export class McpKeyNotFoundError extends Error {
  constructor() {
    super('MCP key not found.');
    this.name = 'McpKeyNotFoundError';
  }
}

export interface ResolvedMcpCredential {
  context: AgentKeyAuthContext;
  keyId: string;
  keyPrefix: string;
  rateLimitPerMinute: number;
}

export interface McpKeyServiceDeps {
  store: McpKeyStore;
  permissions: PermissionStore;
  getPepper: () => Promise<string>;
  getPepperVersion: () => number;
  now: () => Date;
  randomSecret: () => Buffer;
}

const defaultDeps: McpKeyServiceDeps = {
  store: mcpKeyStore,
  permissions: new PostgresPermissionStore(),
  getPepper: () => getSecret('env://MCP_TOKEN_PEPPER'),
  getPepperVersion: () =>
    parseBoundedInteger(getConfig('MCP_TOKEN_PEPPER_VERSION'), 1, 2_147_483_647),
  now: () => new Date(),
  randomSecret: () => randomBytes(32),
};

function depsWith(
  overrides: Partial<McpKeyServiceDeps>,
): McpKeyServiceDeps {
  return { ...defaultDeps, ...overrides };
}

function parseBoundedInteger(
  value: string,
  minimum: number,
  maximum: number,
): number {
  if (!/^\d+$/.test(value)) throw new McpKeyValidationError();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new McpKeyValidationError();
  }
  return parsed;
}

function requireAdmin(
  ctx: AuthContext,
): asserts ctx is Extract<AuthContext, { subjectType: 'user' }> {
  if (
    ctx.subjectType !== 'user' ||
    (!ctx.roles.includes('owner') && !ctx.roles.includes('admin'))
  ) {
    throw new McpKeyForbiddenError();
  }
}

function parseNullableString(
  value: unknown,
  maximum: number,
): string | null {
  if (value === null) return null;
  if (
    typeof value !== 'string' ||
    value.trim() !== value ||
    value.length === 0 ||
    value.length > maximum ||
    value.includes('\0')
  ) {
    throw new McpKeyValidationError();
  }
  return value;
}

function parseGrant(value: unknown): McpReadGrant {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new McpKeyValidationError();
  }
  const record = value as Record<string, unknown>;
  const expected = ['repoId', 'branch', 'pathPrefix'];
  if (
    Object.keys(record).length !== expected.length ||
    expected.some((key) => !(key in record)) ||
    Object.keys(record).some((key) => !expected.includes(key))
  ) {
    throw new McpKeyValidationError();
  }
  const repoId = parseNullableString(record.repoId, 64);
  if (repoId !== null && !UUID_RE.test(repoId)) {
    throw new McpKeyValidationError();
  }
  const branch = parseNullableString(record.branch, 255);
  const pathPrefix = parseNullableString(record.pathPrefix, 2_048);
  if (
    branch?.includes('..') ||
    pathPrefix?.split('/').some((segment) => segment === '..')
  ) {
    throw new McpKeyValidationError();
  }
  return normalizeAuthorizationRule({ repoId, branch, pathPrefix });
}

function parseCreateRequest(
  body: unknown,
  now: Date,
): McpClientKeyCreateRequest {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new McpKeyValidationError();
  }
  const record = body as Record<string, unknown>;
  const expected = ['name', 'expiresAt', 'grants'];
  if (
    Object.keys(record).length !== expected.length ||
    expected.some((key) => !(key in record)) ||
    Object.keys(record).some((key) => !expected.includes(key))
  ) {
    throw new McpKeyValidationError();
  }
  const name = parseNullableString(record.name, 100);
  if (name === null) throw new McpKeyValidationError();
  if (!Array.isArray(record.grants) || record.grants.length < 1) {
    throw new McpKeyValidationError();
  }
  if (record.grants.length > MAX_GRANTS) throw new McpKeyValidationError();
  const grants = record.grants.map(parseGrant);
  const unique = new Map(
    grants.map((grant) => [
      JSON.stringify([grant.repoId, grant.branch, grant.pathPrefix]),
      grant,
    ]),
  );
  if (unique.size !== grants.length) throw new McpKeyValidationError();

  let expiresAt: string | null = null;
  if (record.expiresAt !== null) {
    if (typeof record.expiresAt !== 'string') {
      throw new McpKeyValidationError();
    }
    const parsed = new Date(record.expiresAt);
    if (
      !Number.isFinite(parsed.valueOf()) ||
      parsed <= now ||
      parsed.valueOf() - now.valueOf() > MAX_EXPIRY_MS
    ) {
      throw new McpKeyValidationError();
    }
    expiresAt = parsed.toISOString();
  }
  return { name, expiresAt, grants: [...unique.values()] };
}

function storedView(row: StoredMcpKey): McpClientKeyView {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.keyPrefix,
    grants: row.grants,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    createdByLabel: row.createdByLabel,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    revokedByLabel: row.revokedByLabel,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  };
}

export function mcpSecretHmac(secret: string, pepper: string): string {
  return createHmac('sha256', pepper).update(secret, 'utf8').digest('hex');
}

function hmacMatches(actualHex: string, expectedHex: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(actualHex) || !/^[a-f0-9]{64}$/i.test(expectedHex)) {
    return false;
  }
  return timingSafeEqual(
    Buffer.from(actualHex, 'hex'),
    Buffer.from(expectedHex, 'hex'),
  );
}

function parseToken(token: string): { keyPrefix: string; secret: string } {
  const match = KEY_RE.exec(token);
  if (!match?.[1] || !match[2]) throw new McpKeyAuthenticationError();
  return { keyPrefix: match[1], secret: match[2] };
}

export async function resolveMcpCredential(
  token: string,
  overrides: Partial<McpKeyServiceDeps> = {},
): Promise<ResolvedMcpCredential> {
  const deps = depsWith(overrides);
  const { keyPrefix, secret } = parseToken(token);
  const row = await deps.store.resolve(keyPrefix);
  const now = deps.now();
  if (
    !row ||
    row.keyPrefix !== keyPrefix ||
    row.createdBy === null ||
    row.revokedAt !== null ||
    (row.expiresAt !== null && row.expiresAt <= now) ||
    row.pepperVersion !== deps.getPepperVersion()
  ) {
    throw new McpKeyAuthenticationError();
  }
  const expected = mcpSecretHmac(secret, await deps.getPepper());
  if (!hmacMatches(row.keyHmac, expected)) {
    throw new McpKeyAuthenticationError();
  }
  // This conditional update closes the verify/revoke race and makes a revoked
  // credential fail on the next call even when a process holds no auth cache.
  if (!(await deps.store.markUsed(row.orgId, keyPrefix, now))) {
    throw new McpKeyAuthenticationError();
  }
  return {
    context: {
      subjectType: 'agent_key',
      agentKeyId: keyPrefix,
      orgId: row.orgId,
      roles: ['member'],
    },
    keyId: row.id,
    keyPrefix,
    rateLimitPerMinute: row.rateLimitPerMinute,
  };
}

export async function getMcpKeySettings(
  ctx: AuthContext,
  overrides: Partial<McpKeyServiceDeps> = {},
): Promise<McpKeySettingsResponse> {
  requireAdmin(ctx);
  const deps = depsWith(overrides);
  const [keys, rateLimitPerMinute] = await Promise.all([
    deps.store.list(ctx.orgId),
    deps.store.getRateLimit(ctx.orgId),
  ]);
  return {
    keys: keys.map(storedView),
    rateLimitPerMinute,
  };
}

export async function issueMcpKey(
  body: unknown,
  ctx: AuthContext,
  overrides: Partial<McpKeyServiceDeps> = {},
): Promise<McpClientKeyIssued> {
  requireAdmin(ctx);
  const deps = depsWith(overrides);
  const now = deps.now();
  const request = parseCreateRequest(body, now);
  const issuerScope = await deps.permissions.getReadScope(ctx);
  if (
    request.grants.some(
      (grant) => !isRuleWithinScope(grant, issuerScope),
    )
  ) {
    throw new McpKeyForbiddenError();
  }
  const actorLabel = await deps.store.getActorLabel(ctx.orgId, ctx.userId);
  if (!actorLabel) throw new McpKeyForbiddenError();

  const secretBytes = deps.randomSecret();
  if (secretBytes.length !== 32) throw new Error('MCP key RNG returned an invalid length.');
  const secret = secretBytes.toString('base64url');
  const keyPrefix = `mcp_live_${randomBytes(8).toString('hex')}`;
  const pepperVersion = deps.getPepperVersion();
  const row = await deps.store.issue(ctx.orgId, {
    name: request.name,
    keyPrefix,
    keyHmac: mcpSecretHmac(secret, await deps.getPepper()),
    pepperVersion,
    expiresAt: request.expiresAt ? new Date(request.expiresAt) : null,
    createdBy: ctx.userId,
    createdByLabel: actorLabel,
    grants: request.grants,
  });
  return { ...storedView(row), token: `${keyPrefix}.${secret}` };
}

export async function revokeMcpKey(
  keyId: unknown,
  ctx: AuthContext,
  overrides: Partial<McpKeyServiceDeps> = {},
): Promise<McpClientKeyView> {
  requireAdmin(ctx);
  if (typeof keyId !== 'string' || !UUID_RE.test(keyId)) {
    throw new McpKeyValidationError();
  }
  const deps = depsWith(overrides);
  const actorLabel = await deps.store.getActorLabel(ctx.orgId, ctx.userId);
  if (!actorLabel) throw new McpKeyForbiddenError();
  const row = await deps.store.revoke(
    ctx.orgId,
    keyId,
    ctx.userId,
    actorLabel,
  );
  if (!row) throw new McpKeyNotFoundError();
  return storedView(row);
}

export async function updateMcpRateLimit(
  body: unknown,
  ctx: AuthContext,
  overrides: Partial<McpKeyServiceDeps> = {},
): Promise<{ rateLimitPerMinute: number }> {
  requireAdmin(ctx);
  if (
    typeof body !== 'object' ||
    body === null ||
    Array.isArray(body) ||
    Object.keys(body).length !== 1 ||
    !('rateLimitPerMinute' in body)
  ) {
    throw new McpKeyValidationError();
  }
  const value = (body as { rateLimitPerMinute: unknown }).rateLimitPerMinute;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 10_000) {
    throw new McpKeyValidationError();
  }
  const deps = depsWith(overrides);
  return {
    rateLimitPerMinute: await deps.store.setRateLimit(
      ctx.orgId,
      value as number,
    ),
  };
}
