import { describe, expect, it } from 'vitest';
import {
  McpSettingsContractError,
  parseMcpIssuedKey,
  parseMcpSettingsResponse,
} from './mcpSettingsContract';

const KEY = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Local agent',
  keyPrefix: 'mcp_live_0123456789abcdef',
  grants: [
    {
      repoId: '22222222-2222-4222-8222-222222222222',
      branch: 'refs/heads/main',
      pathPrefix: 'services/core',
    },
  ],
  expiresAt: null,
  createdAt: '2026-07-25T12:00:00.000Z',
  createdByLabel: 'Admin',
  revokedAt: null,
  revokedByLabel: null,
  lastUsedAt: null,
};

describe('MCP settings browser contract', () => {
  it('parses settings and the one-time issued token', () => {
    expect(
      parseMcpSettingsResponse({ keys: [KEY], rateLimitPerMinute: 60 }),
    ).toEqual({ keys: [KEY], rateLimitPerMinute: 60 });
    expect(
      parseMcpIssuedKey({
        ...KEY,
        token:
          'mcp_live_0123456789abcdef.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      }).token,
    ).toMatch(/^mcp_live_/u);
  });

  it('fails closed on malformed scope, identifiers, or rate policy', () => {
    expect(() =>
      parseMcpSettingsResponse({
        keys: [{ ...KEY, id: 'client-controlled-id' }],
        rateLimitPerMinute: 60,
      }),
    ).toThrow(McpSettingsContractError);
    expect(() =>
      parseMcpSettingsResponse({
        keys: [{ ...KEY, grants: [] }],
        rateLimitPerMinute: 0,
      }),
    ).toThrow(McpSettingsContractError);
  });
});
