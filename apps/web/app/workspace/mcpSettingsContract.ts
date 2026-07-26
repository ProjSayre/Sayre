import type {
  McpClientKeyIssued,
  McpClientKeyView,
  McpKeySettingsResponse,
  McpReadGrant,
} from '@sayre/shared-types';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const KEY_PREFIX_RE = /^mcp_live_[a-f0-9]{16}$/u;
const TOKEN_RE = /^mcp_live_[a-f0-9]{16}\.[A-Za-z0-9_-]{43}$/u;

export class McpSettingsContractError extends Error {
  constructor() {
    super('The MCP settings response is invalid.');
    this.name = 'McpSettingsContractError';
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new McpSettingsContractError();
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new McpSettingsContractError();
  }
  return value;
}

function nullableString(value: unknown): string | null {
  return value === null ? null : requiredString(value);
}

function timestamp(value: unknown): string {
  const parsed = requiredString(value);
  if (Number.isNaN(Date.parse(parsed))) throw new McpSettingsContractError();
  return parsed;
}

function nullableTimestamp(value: unknown): string | null {
  return value === null ? null : timestamp(value);
}

function grant(value: unknown): McpReadGrant {
  const item = record(value);
  return {
    repoId: nullableString(item.repoId),
    branch: nullableString(item.branch),
    pathPrefix: nullableString(item.pathPrefix),
  };
}

export function parseMcpClientKey(value: unknown): McpClientKeyView {
  const item = record(value);
  const id = requiredString(item.id);
  const keyPrefix = requiredString(item.keyPrefix);
  if (
    !UUID_RE.test(id) ||
    !KEY_PREFIX_RE.test(keyPrefix) ||
    !Array.isArray(item.grants) ||
    item.grants.length === 0
  ) {
    throw new McpSettingsContractError();
  }
  return {
    id,
    name: requiredString(item.name),
    keyPrefix,
    grants: item.grants.map(grant),
    expiresAt: nullableTimestamp(item.expiresAt),
    createdAt: timestamp(item.createdAt),
    createdByLabel: requiredString(item.createdByLabel),
    revokedAt: nullableTimestamp(item.revokedAt),
    revokedByLabel: nullableString(item.revokedByLabel),
    lastUsedAt: nullableTimestamp(item.lastUsedAt),
  };
}

export function parseMcpSettingsResponse(
  value: unknown,
): McpKeySettingsResponse {
  const response = record(value);
  if (
    !Array.isArray(response.keys) ||
    !Number.isSafeInteger(response.rateLimitPerMinute) ||
    (response.rateLimitPerMinute as number) < 1 ||
    (response.rateLimitPerMinute as number) > 10_000
  ) {
    throw new McpSettingsContractError();
  }
  const keys = response.keys.map(parseMcpClientKey);
  if (new Set(keys.map((key) => key.id)).size !== keys.length) {
    throw new McpSettingsContractError();
  }
  return {
    keys,
    rateLimitPerMinute: response.rateLimitPerMinute as number,
  };
}

export function parseMcpIssuedKey(value: unknown): McpClientKeyIssued {
  const item = record(value);
  const token = requiredString(item.token);
  if (!TOKEN_RE.test(token)) throw new McpSettingsContractError();
  return { ...parseMcpClientKey(item), token };
}

export function parseMcpRateLimit(
  value: unknown,
): { rateLimitPerMinute: number } {
  const response = record(value);
  const rateLimitPerMinute = response.rateLimitPerMinute;
  if (
    !Number.isSafeInteger(rateLimitPerMinute) ||
    (rateLimitPerMinute as number) < 1 ||
    (rateLimitPerMinute as number) > 10_000
  ) {
    throw new McpSettingsContractError();
  }
  return { rateLimitPerMinute: rateLimitPerMinute as number };
}
