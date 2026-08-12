import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpReadGrant } from '@sayre/shared-types';
import type { AuthContext } from '../auth/context';
import type {
  McpKeyLookup,
  McpKeyStore,
  StoreMcpKeyInput,
  StoredMcpKey,
} from '../db/mcpKeyStore';
import type { PermissionStore } from '../graph-query/permissions';
import {
  McpKeyAuthenticationError,
  McpKeyForbiddenError,
  issueMcpKey,
  resolveMcpCredential,
} from './mcpKeyService';

const ORG = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const REPO = '33333333-3333-4333-8333-333333333333';
const OTHER_REPO = '44444444-4444-4444-8444-444444444444';
const KEY_ID = '55555555-5555-4555-8555-555555555555';
const NOW = new Date('2026-07-23T12:00:00.000Z');
const ADMIN: AuthContext = {
  subjectType: 'user',
  userId: USER,
  orgId: ORG,
  roles: ['admin'],
};

function stored(input: StoreMcpKeyInput): StoredMcpKey {
  return {
    id: KEY_ID,
    name: input.name,
    keyPrefix: input.keyPrefix,
    grants: input.grants,
    expiresAt: input.expiresAt,
    createdAt: NOW,
    createdByLabel: input.createdByLabel,
    revokedAt: null,
    revokedByLabel: null,
    lastUsedAt: null,
  };
}

describe('MCP key lifecycle', () => {
  let captured: StoreMcpKeyInput | null;
  let lookup: McpKeyLookup | null;
  let revoked: boolean;
  let store: McpKeyStore;
  let permissions: PermissionStore;

  beforeEach(() => {
    captured = null;
    lookup = null;
    revoked = false;
    store = {
      resolve: vi.fn(async () =>
        lookup
          ? { ...lookup, revokedAt: revoked ? new Date(NOW) : null }
          : null,
      ),
      list: vi.fn(async () => []),
      issue: vi.fn(async (_orgId, input) => {
        captured = input;
        return stored(input);
      }),
      revoke: vi.fn(async () => null),
      markUsed: vi.fn(async () => !revoked),
      getRateLimit: vi.fn(async () => 60),
      setRateLimit: vi.fn(async (_orgId, value) => value),
      getActorLabel: vi.fn(async () => 'Admin Person'),
    };
    permissions = {
      getReadScope: vi.fn(async () => ({
        allows: [{ repoId: REPO, branch: null, pathPrefix: 'src' }],
        denies: [],
      })),
    };
  });

  it('returns the 256-bit token once and persists only its HMAC and public prefix', async () => {
    const issued = await issueMcpKey(
      {
        name: 'Coding agent',
        expiresAt: '2026-08-01T00:00:00.000Z',
        grants: [
          { repoId: REPO, branch: 'main', pathPrefix: '/src/public' },
        ],
      },
      ADMIN,
      {
        store,
        permissions,
        getPepper: async () => 'pepper-value',
        getPepperVersion: () => 7,
        now: () => NOW,
        randomSecret: () => Buffer.alloc(32, 1),
      },
    );

    expect(issued.token).toMatch(/^mcp_live_[a-f0-9]{16}\.[A-Za-z0-9_-]{43}$/);
    expect(captured).not.toBeNull();
    expect(captured).not.toHaveProperty('token');
    expect(captured).not.toHaveProperty('secret');
    expect(captured?.keyHmac).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(captured)).not.toContain(issued.token);
    expect(captured?.pepperVersion).toBe(7);
    expect(captured?.grants).toEqual([
      {
        repoId: REPO,
        branch: 'refs/heads/main',
        pathPrefix: 'src/public',
      },
    ]);

    lookup = {
      id: KEY_ID,
      orgId: ORG,
      keyPrefix: issued.keyPrefix,
      keyHmac: captured?.keyHmac ?? '',
      pepperVersion: 7,
      expiresAt: new Date('2026-08-01T00:00:00.000Z'),
      revokedAt: null,
      createdBy: USER,
      rateLimitPerMinute: 41,
      kind: 'agent',
      conversationId: null,
    };
    await expect(
      resolveMcpCredential(issued.token, {
        store,
        getPepper: async () => 'pepper-value',
        getPepperVersion: () => 7,
        now: () => NOW,
      }),
    ).resolves.toEqual({
      context: {
        subjectType: 'agent_key',
        agentKeyId: issued.keyPrefix,
        orgId: ORG,
        roles: ['member'],
      },
      keyId: KEY_ID,
      keyPrefix: issued.keyPrefix,
      rateLimitPerMinute: 41,
      kind: 'agent',
      meteringSubject: issued.keyPrefix,
    });
  });

  it('rejects a requested grant outside the issuer scope', async () => {
    await expect(
      issueMcpKey(
        {
          name: 'Too wide',
          expiresAt: null,
          grants: [
            { repoId: OTHER_REPO, branch: null, pathPrefix: null },
          ],
        },
        ADMIN,
        {
          store,
          permissions,
          getPepper: async () => 'pepper',
          getPepperVersion: () => 1,
          now: () => NOW,
        },
      ),
    ).rejects.toBeInstanceOf(McpKeyForbiddenError);
    expect(store.issue).not.toHaveBeenCalled();
  });

  it('fails the very next resolution after revocation without an auth cache', async () => {
    const grant: McpReadGrant = {
      repoId: REPO,
      branch: null,
      pathPrefix: '/src',
    };
    const issued = await issueMcpKey(
      { name: 'Revocable', expiresAt: null, grants: [grant] },
      ADMIN,
      {
        store,
        permissions,
        getPepper: async () => 'pepper',
        getPepperVersion: () => 1,
        now: () => NOW,
        randomSecret: () => Buffer.alloc(32, 2),
      },
    );
    lookup = {
      id: KEY_ID,
      orgId: ORG,
      keyPrefix: issued.keyPrefix,
      keyHmac: captured?.keyHmac ?? '',
      pepperVersion: 1,
      expiresAt: null,
      revokedAt: null,
      createdBy: USER,
      rateLimitPerMinute: 60,
      kind: 'agent',
      conversationId: null,
    };
    revoked = true;
    await expect(
      resolveMcpCredential(issued.token, {
        store,
        getPepper: async () => 'pepper',
        getPepperVersion: () => 1,
        now: () => NOW,
      }),
    ).rejects.toBeInstanceOf(McpKeyAuthenticationError);
    expect(store.markUsed).not.toHaveBeenCalled();
  });
});
