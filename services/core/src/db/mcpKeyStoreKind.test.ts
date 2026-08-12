// CH-01 red suite — the `mcp_client_keys` store's half of the two-family
// model: the fail-closed `kind` mapping on the SECURITY DEFINER bootstrap
// lookup, and the `kind = 'agent'` predicate that keeps the W4-06 admin
// surfaces (settings list, revoke) blind to `chat_ephemeral` rows.
//
// No database is needed: `PostgresMcpKeyStore` already injects `getDb`/`withOrg`,
// so the query builder can be handed a recording fake and the predicate it
// actually built rendered back to SQL text through drizzle's own dialect. That
// is a real behavioral assertion about the emitted predicate, not a stub.

import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import { PostgresMcpKeyStore } from './mcpKeyStore';

const ORG = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const KEY_ID = '55555555-5555-4555-8555-555555555555';
const CONVERSATION = '66666666-6666-4666-8666-666666666666';
const NOW = new Date('2026-08-10T12:00:00.000Z');

function rendered(condition: SQL): { sql: string; params: unknown[] } {
  const query = new PgDialect().sqlToQuery(condition);
  return { sql: query.sql, params: query.params as unknown[] };
}

function bootstrapRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key_id: KEY_ID,
    org_id: ORG,
    key_prefix: 'mcp_chat_0123456789abcdef',
    key_hmac: 'a'.repeat(64),
    pepper_version: 7,
    expires_at: NOW,
    revoked_at: null,
    created_by: USER,
    rate_limit_per_minute: 60,
    kind: 'chat_ephemeral',
    conversation_id: CONVERSATION,
    ...overrides,
  };
}

function storeForResolve(row: Record<string, unknown> | undefined) {
  const execute = vi.fn(async () => ({ rows: row ? [row] : [] }));
  const db = {
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ execute }),
  };
  return new PostgresMcpKeyStore({
    getDb: vi.fn(async () => db as never),
    withOrg: vi.fn(async (_db, _orgId, fn) => fn({} as never)) as never,
  });
}

describe('CH-01 mcp_client_keys store kind handling', () => {
  // @spec EC-4
  it('maps a recognized kind and fails closed on anything else', async () => {
    await expect(
      storeForResolve(bootstrapRow()).resolve('mcp_chat_0123456789abcdef'),
    ).resolves.toMatchObject({
      kind: 'chat_ephemeral',
      conversationId: CONVERSATION,
    });

    await expect(
      storeForResolve(
        bootstrapRow({ kind: 'agent', conversation_id: null }),
      ).resolve('mcp_live_0123456789abcdef'),
    ).resolves.toMatchObject({ kind: 'agent', conversationId: null });

    for (const kind of ['root', 'AGENT', '', 'chat', null, undefined, 1]) {
      await expect(
        storeForResolve(bootstrapRow({ kind })).resolve('mcp_live_0123456789abcdef'),
      ).resolves.toMatchObject({ kind: null });
    }

    await expect(
      storeForResolve(undefined).resolve('mcp_live_0123456789abcdef'),
    ).resolves.toBeNull();
  });

  // @spec AC-10 EC-19
  it('lists only agent keys for the settings surface, scoped to the caller org', async () => {
    const captured: SQL[] = [];
    const orderBy = vi.fn(async () => []);
    const where = vi.fn((condition: SQL) => {
      captured.push(condition);
      return { orderBy };
    });
    const tx = {
      select: vi.fn(() => ({ from: vi.fn(() => ({ where })) })),
    };
    const withOrg = vi.fn(async (_db, orgId: string, fn) => {
      expect(orgId).toBe(ORG);
      return fn(tx);
    });
    const store = new PostgresMcpKeyStore({
      getDb: vi.fn(async () => ({}) as never),
      withOrg: withOrg as never,
    });

    await expect(store.list(ORG)).resolves.toEqual([]);
    expect(captured).toHaveLength(1);
    const predicate = rendered(captured[0] as SQL);
    expect(predicate.sql).toMatch(/"org_id" = \$\d+/);
    expect(predicate.sql).toMatch(/"kind" = \$\d+/);
    expect(predicate.params).toContain(ORG);
    expect(predicate.params).toContain('agent');
    expect(predicate.params).not.toContain('chat_ephemeral');
  });

  // @spec AC-10 EC-19
  it('revokes only agent keys, so a chat_ephemeral id is a not-found', async () => {
    const captured: SQL[] = [];
    const returning = vi.fn(async () => []);
    const where = vi.fn((condition: SQL) => {
      captured.push(condition);
      return { returning };
    });
    const tx = {
      update: vi.fn(() => ({ set: vi.fn(() => ({ where })) })),
    };
    const withOrg = vi.fn(async (_db, orgId: string, fn) => {
      expect(orgId).toBe(ORG);
      return fn(tx);
    });
    const store = new PostgresMcpKeyStore({
      getDb: vi.fn(async () => ({}) as never),
      withOrg: withOrg as never,
    });

    await expect(store.revoke(ORG, KEY_ID, USER, 'Ada Lovelace')).resolves.toBeNull();
    expect(captured).toHaveLength(1);
    const predicate = rendered(captured[0] as SQL);
    expect(predicate.sql).toMatch(/"org_id" = \$\d+/);
    expect(predicate.sql).toMatch(/"kind" = \$\d+/);
    expect(predicate.params).toContain(KEY_ID);
    expect(predicate.params).toContain('agent');
  });

  // @spec AC-8
  it('keeps every kind-agnostic write inside the server-supplied org context', async () => {
    const returning = vi.fn(async () => [{ id: KEY_ID }]);
    const where = vi.fn(() => ({ returning }));
    const tx = {
      update: vi.fn(() => ({ set: vi.fn(() => ({ where })) })),
    };
    const withOrg = vi.fn(async (_db, orgId: string, fn) => fn(tx));
    const store = new PostgresMcpKeyStore({
      getDb: vi.fn(async () => ({}) as never),
      withOrg: withOrg as never,
    });

    await expect(
      store.markUsed(ORG, 'mcp_chat_0123456789abcdef', NOW),
    ).resolves.toBe(true);
    expect(withOrg).toHaveBeenCalledTimes(1);
    expect(withOrg.mock.calls[0]?.[1]).toBe(ORG);
  });
});
