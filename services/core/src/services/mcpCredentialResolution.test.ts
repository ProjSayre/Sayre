// CH-01 red suite — the resolve half of the two-family credential model:
// `resolveMcpCredential`'s token-family/stored-kind cross-check, the metering
// subject that keeps a re-mint inside the same per-minute window, and the
// rejection parity that leaves no expired-vs-unknown oracle.
//
// Deliberately a separate file from ephemeralMcpCredentialService.test.ts: this
// one imports only modules that already exist, so its failures are real
// assertion failures against today's behavior rather than a module-load error.
// Every fixture below is an injected fake — no database is involved.

import { describe, expect, it, vi } from 'vitest';
import type { McpKeyLookup, McpKeyStore, StoredMcpKey } from '../db/mcpKeyStore';
import type { McpToolMeasurement } from '../mcp/metrics';
import { InMemoryMcpRateLimiter } from '../mcp/rateLimit';
import { executeMcpTool } from '../mcp/toolExecution';
import type { AuthContext } from '../auth/context';
import {
  McpKeyAuthenticationError,
  McpKeyNotFoundError,
  getMcpKeySettings,
  mcpSecretHmac,
  resolveMcpCredential,
  revokeMcpKey,
} from './mcpKeyService';

const ORG = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const OTHER_USER = '77777777-7777-4777-8777-777777777777';
const KEY_ID = '55555555-5555-4555-8555-555555555555';
const CONVERSATION = '66666666-6666-4666-8666-666666666666';
const NOW = new Date('2026-08-10T12:00:00.000Z');
const EXPIRES_AT = new Date(NOW.valueOf() + 300_000);
const PEPPER = 'pepper-value';
const PEPPER_VERSION = 7;

const CHAT_PREFIX = 'mcp_chat_0123456789abcdef';
const AGENT_PREFIX = 'mcp_live_0123456789abcdef';
const SECRET = Buffer.alloc(32, 3).toString('base64url');
const CHAT_TOKEN = `${CHAT_PREFIX}.${SECRET}`;
const AGENT_TOKEN = `${AGENT_PREFIX}.${SECRET}`;

const ADMIN: AuthContext = {
  subjectType: 'user',
  userId: USER,
  orgId: ORG,
  roles: ['admin'],
};

/** `McpKeyLookup` as CH-01 extends it. Once `dev` lands `kind`/`conversationId`
 *  on the interface itself this intersection is a no-op. */
type LookupFixture = McpKeyLookup & {
  kind: 'agent' | 'chat_ephemeral' | null;
  conversationId: string | null;
};

function lookup(overrides: Partial<LookupFixture> = {}): LookupFixture {
  return {
    id: KEY_ID,
    orgId: ORG,
    keyPrefix: CHAT_PREFIX,
    keyHmac: mcpSecretHmac(SECRET, PEPPER),
    pepperVersion: PEPPER_VERSION,
    expiresAt: EXPIRES_AT,
    revokedAt: null,
    createdBy: USER,
    rateLimitPerMinute: 60,
    kind: 'chat_ephemeral',
    conversationId: CONVERSATION,
    ...overrides,
  };
}

interface StoreHarness {
  store: McpKeyStore;
  getPepper: ReturnType<typeof vi.fn>;
  resolveDeps: (now?: Date) => Record<string, unknown>;
}

function storeFor(
  row: LookupFixture | null,
  options: { listed?: StoredMcpKey[]; revoked?: StoredMcpKey | null } = {},
): StoreHarness {
  const getPepper = vi.fn(async () => PEPPER);
  const store: McpKeyStore = {
    resolve: vi.fn(async () => row as McpKeyLookup | null),
    list: vi.fn(async () => options.listed ?? []),
    issue: vi.fn(async () => {
      throw new Error('not used');
    }),
    revoke: vi.fn(async () => options.revoked ?? null),
    markUsed: vi.fn(async () => true),
    getRateLimit: vi.fn(async () => 60),
    setRateLimit: vi.fn(async (_orgId, value: number) => value),
    getActorLabel: vi.fn(async () => 'Ada Lovelace'),
  };
  return {
    store,
    getPepper,
    resolveDeps: (now = NOW) => ({
      store,
      getPepper,
      getPepperVersion: () => PEPPER_VERSION,
      now: () => now,
    }),
  };
}

describe('CH-01 credential family resolution', () => {
  // @spec AC-9 AC-10
  it('resolves an agent key exactly as before and buckets it on its own prefix', async () => {
    const h = storeFor(
      lookup({ keyPrefix: AGENT_PREFIX, kind: 'agent', conversationId: null }),
    );

    await expect(
      resolveMcpCredential(AGENT_TOKEN, h.resolveDeps()),
    ).resolves.toEqual({
      context: {
        subjectType: 'agent_key',
        agentKeyId: AGENT_PREFIX,
        orgId: ORG,
        roles: ['member'],
      },
      keyId: KEY_ID,
      keyPrefix: AGENT_PREFIX,
      rateLimitPerMinute: 60,
      kind: 'agent',
      meteringSubject: AGENT_PREFIX,
    });
    expect(h.store.markUsed).toHaveBeenCalledWith(ORG, AGENT_PREFIX, NOW);
  });

  // @spec AC-1 AC-9
  it('resolves a chat credential to an agent_key context bucketed on the issuing user', async () => {
    const h = storeFor(lookup());

    await expect(resolveMcpCredential(CHAT_TOKEN, h.resolveDeps())).resolves.toEqual({
      context: {
        subjectType: 'agent_key',
        agentKeyId: CHAT_PREFIX,
        orgId: ORG,
        roles: ['member'],
      },
      keyId: KEY_ID,
      keyPrefix: CHAT_PREFIX,
      rateLimitPerMinute: 60,
      kind: 'chat_ephemeral',
      meteringSubject: `chat:${USER}`,
    });
  });

  // @spec AC-9 EC-18
  it('keeps one per-minute window per issuing user across re-mints, and per prefix for agent keys', async () => {
    const measurements: McpToolMeasurement[] = [];
    const limiter = new InMemoryMcpRateLimiter(() => NOW.valueOf());
    const deps = { limiter, record: (entry: McpToolMeasurement) => measurements.push(entry) };
    const call = async (credential: Awaited<ReturnType<typeof resolveMcpCredential>>) =>
      executeMcpTool('get_node_context', credential, async () => ({ ok: true }), deps);

    const firstMint = await resolveMcpCredential(
      CHAT_TOKEN,
      storeFor(lookup({ rateLimitPerMinute: 1 })).resolveDeps(),
    );
    const secondMint = await resolveMcpCredential(
      `mcp_chat_fedcba9876543210.${SECRET}`,
      storeFor(
        lookup({ keyPrefix: 'mcp_chat_fedcba9876543210', rateLimitPerMinute: 1 }),
      ).resolveDeps(),
    );
    const otherUser = await resolveMcpCredential(
      `mcp_chat_1111222233334444.${SECRET}`,
      storeFor(
        lookup({
          keyPrefix: 'mcp_chat_1111222233334444',
          createdBy: OTHER_USER,
          rateLimitPerMinute: 1,
        }),
      ).resolveDeps(),
    );

    expect(secondMint.meteringSubject).toBe(firstMint.meteringSubject);
    expect(otherUser.meteringSubject).not.toBe(firstMint.meteringSubject);

    expect((await call(firstMint)).isError).not.toBe(true);
    // A freshly minted credential for the SAME user must not reset the window.
    expect((await call(secondMint)).isError).toBe(true);
    // A different user has their own window.
    expect((await call(otherUser)).isError).not.toBe(true);

    expect(measurements.map((entry) => entry.keyPrefix)).toEqual([
      `chat:${USER}`,
      `chat:${USER}`,
      `chat:${OTHER_USER}`,
    ]);
    expect(measurements.map((entry) => entry.outcome)).toEqual([
      'ok',
      'rate_limited',
      'ok',
    ]);

    // Agent keys keep per-prefix windows, unchanged.
    const agentOne = await resolveMcpCredential(
      AGENT_TOKEN,
      storeFor(
        lookup({
          keyPrefix: AGENT_PREFIX,
          kind: 'agent',
          conversationId: null,
          rateLimitPerMinute: 1,
        }),
      ).resolveDeps(),
    );
    const agentTwo = await resolveMcpCredential(
      `mcp_live_aaaabbbbccccdddd.${SECRET}`,
      storeFor(
        lookup({
          keyPrefix: 'mcp_live_aaaabbbbccccdddd',
          kind: 'agent',
          conversationId: null,
          rateLimitPerMinute: 1,
        }),
      ).resolveDeps(),
    );
    expect((await call(agentOne)).isError).not.toBe(true);
    expect((await call(agentTwo)).isError).not.toBe(true);
    expect(measurements.at(-1)?.keyPrefix).toBe('mcp_live_aaaabbbbccccdddd');
  });

  // @spec AC-3 EC-1 EC-2
  it('rejects an expired chat credential exactly as it rejects an unknown one', async () => {
    const justInTime = storeFor(lookup());
    await expect(
      resolveMcpCredential(
        CHAT_TOKEN,
        justInTime.resolveDeps(new Date(EXPIRES_AT.valueOf() - 1)),
      ),
    ).resolves.toMatchObject({ keyPrefix: CHAT_PREFIX, kind: 'chat_ephemeral' });

    const atBoundary = storeFor(lookup());
    const expired = await resolveMcpCredential(
      CHAT_TOKEN,
      atBoundary.resolveDeps(EXPIRES_AT),
    ).catch((error: unknown) => error as Error);
    expect(expired).toBeInstanceOf(McpKeyAuthenticationError);
    expect(atBoundary.store.resolve).toHaveBeenCalledWith(CHAT_PREFIX);
    expect(atBoundary.store.markUsed).not.toHaveBeenCalled();

    const unknown = storeFor(null);
    const missing = await resolveMcpCredential(
      `mcp_chat_deadbeefdeadbeef.${SECRET}`,
      unknown.resolveDeps(),
    ).catch((error: unknown) => error as Error);
    expect(missing).toBeInstanceOf(McpKeyAuthenticationError);
    expect(missing.message).toBe(expired.message);
    expect(missing.name).toBe(expired.name);
  });

  // @spec EC-3
  it('rejects a token whose family disagrees with the stored kind, before any digest compare', async () => {
    const chatTokenAgentRow = storeFor(
      lookup({ keyPrefix: CHAT_PREFIX, kind: 'agent', conversationId: null }),
    );
    await expect(
      resolveMcpCredential(CHAT_TOKEN, chatTokenAgentRow.resolveDeps()),
    ).rejects.toBeInstanceOf(McpKeyAuthenticationError);
    expect(chatTokenAgentRow.store.resolve).toHaveBeenCalledWith(CHAT_PREFIX);
    expect(chatTokenAgentRow.getPepper).not.toHaveBeenCalled();
    expect(chatTokenAgentRow.store.markUsed).not.toHaveBeenCalled();

    const agentTokenChatRow = storeFor(
      lookup({ keyPrefix: AGENT_PREFIX, kind: 'chat_ephemeral' }),
    );
    await expect(
      resolveMcpCredential(AGENT_TOKEN, agentTokenChatRow.resolveDeps()),
    ).rejects.toBeInstanceOf(McpKeyAuthenticationError);
    expect(agentTokenChatRow.store.resolve).toHaveBeenCalledWith(AGENT_PREFIX);
    expect(agentTokenChatRow.getPepper).not.toHaveBeenCalled();
    expect(agentTokenChatRow.store.markUsed).not.toHaveBeenCalled();
  });

  // @spec EC-4
  it('never degrades an unrecognized stored kind to agent', async () => {
    const h = storeFor(
      lookup({ keyPrefix: AGENT_PREFIX, kind: null, conversationId: null }),
    );
    await expect(
      resolveMcpCredential(AGENT_TOKEN, h.resolveDeps()),
    ).rejects.toBeInstanceOf(McpKeyAuthenticationError);
    expect(h.store.resolve).toHaveBeenCalledWith(AGENT_PREFIX);
    expect(h.store.markUsed).not.toHaveBeenCalled();
  });

  // @spec EC-5
  it('rejects malformed tokens without any store lookup and accepts only the two well-formed families', async () => {
    const malformed = [
      '',
      '   ',
      CHAT_PREFIX,
      `${CHAT_PREFIX}.${SECRET}extra`,
      `mcp_chat_0123456789abcde.${SECRET}`,
      `mcp_chat_0123456789abcdeff.${SECRET}`,
      `mcp_chat_0123456789abcdeg.${SECRET}`,
      `mcp_chat_0123456789ABCDEF.${SECRET}`,
      `${AGENT_PREFIX}.${SECRET.slice(0, 42)}`,
      `mcp_test_0123456789abcdef.${SECRET}`,
      `Bearer ${CHAT_TOKEN}`,
      ` ${CHAT_TOKEN}`,
      `${CHAT_PREFIX}.${'+'.repeat(43)}`,
      `${CHAT_PREFIX}.${'/'.repeat(43)}`,
    ];
    const h = storeFor(lookup());
    for (const token of malformed) {
      await expect(
        resolveMcpCredential(token, h.resolveDeps()),
      ).rejects.toBeInstanceOf(McpKeyAuthenticationError);
    }
    expect(h.store.resolve).not.toHaveBeenCalled();

    // Positive control: both well-formed families parse and reach the store.
    const chat = storeFor(lookup());
    await resolveMcpCredential(CHAT_TOKEN, chat.resolveDeps());
    expect(chat.store.resolve).toHaveBeenCalledWith(CHAT_PREFIX);
    const agent = storeFor(
      lookup({ keyPrefix: AGENT_PREFIX, kind: 'agent', conversationId: null }),
    );
    await resolveMcpCredential(AGENT_TOKEN, agent.resolveDeps());
    expect(agent.store.resolve).toHaveBeenCalledWith(AGENT_PREFIX);
  });

  // @spec EC-6
  it('rejects a chat credential written under a different pepper version', async () => {
    const h = storeFor(lookup({ pepperVersion: PEPPER_VERSION + 1 }));
    await expect(
      resolveMcpCredential(CHAT_TOKEN, h.resolveDeps()),
    ).rejects.toBeInstanceOf(McpKeyAuthenticationError);
    expect(h.store.resolve).toHaveBeenCalledWith(CHAT_PREFIX);
    expect(h.store.markUsed).not.toHaveBeenCalled();
  });

  // @spec EC-7
  it('rejects a revoked chat credential', async () => {
    const h = storeFor(lookup({ revokedAt: NOW }));
    await expect(
      resolveMcpCredential(CHAT_TOKEN, h.resolveDeps()),
    ).rejects.toBeInstanceOf(McpKeyAuthenticationError);
    expect(h.store.resolve).toHaveBeenCalledWith(CHAT_PREFIX);
    expect(h.store.markUsed).not.toHaveBeenCalled();
  });

  // @spec EC-8
  it('rejects a chat credential whose issuing user has been deleted', async () => {
    const h = storeFor(lookup({ createdBy: null }));
    await expect(
      resolveMcpCredential(CHAT_TOKEN, h.resolveDeps()),
    ).rejects.toBeInstanceOf(McpKeyAuthenticationError);
    expect(h.store.resolve).toHaveBeenCalledWith(CHAT_PREFIX);
    expect(h.store.markUsed).not.toHaveBeenCalled();
  });

  // @spec EC-22
  it('uses one fixed rejection message for every path and never echoes key material', async () => {
    const scenarios: Array<[string, LookupFixture | null]> = [
      [CHAT_TOKEN, null],
      [CHAT_TOKEN, lookup({ revokedAt: NOW })],
      [CHAT_TOKEN, lookup({ createdBy: null })],
      [CHAT_TOKEN, lookup({ pepperVersion: 99 })],
      [CHAT_TOKEN, lookup({ kind: 'agent' })],
      [CHAT_TOKEN, lookup({ kind: null })],
      [CHAT_TOKEN, lookup({ keyHmac: 'f'.repeat(64) })],
      [`${CHAT_PREFIX}.${'A'.repeat(43)}`, lookup()],
    ];
    for (const [token, row] of scenarios) {
      const h = storeFor(row);
      const error = await resolveMcpCredential(token, h.resolveDeps()).catch(
        (thrown: unknown) => thrown as Error,
      );
      expect(error).toBeInstanceOf(McpKeyAuthenticationError);
      expect(error.message).toBe('MCP authentication failed.');
      expect(error.message).not.toContain(SECRET);
      expect(error.message).not.toContain(CHAT_PREFIX);
      expect(error.stack ?? '').not.toContain(SECRET);
    }
  });

  // @spec AC-10 EC-19
  it('keeps the admin surfaces on agent keys only', async () => {
    // The store is kind-scoped (see mcpKeyStoreKind.test.ts), so a
    // `chat_ephemeral` row is invisible to both admin surfaces: the settings
    // list never contains one, and revoking one by id is a not-found.
    const h = storeFor(null, { listed: [], revoked: null });
    await expect(getMcpKeySettings(ADMIN, h.resolveDeps())).resolves.toEqual({
      keys: [],
      rateLimitPerMinute: 60,
    });
    await expect(revokeMcpKey(KEY_ID, ADMIN, h.resolveDeps())).rejects.toBeInstanceOf(
      McpKeyNotFoundError,
    );
  });
});
