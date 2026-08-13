// Leading-red tests (W7-01, AC-11/AC-12/EC-16/EC-18) for getRepositoryCatalog's new `sync`
// summary. RepositoryCatalogServiceDeps does not have `syncRows`/`now` yet and the returned
// RepositoryCatalog has no `sync` field yet, so every assertion on `result.sync` fails today
// (RED-CORRECT). Mirrors repositoryCatalogService.test.ts's DI-mock conventions exactly.

import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../auth/context';
import type { RepositoryCatalogStore, StoredRepositoryCatalogEntry } from '../db/repositoryCatalogStore';
import type { PermissionStore, ReadScope } from '../graph-query/permissions';
import { getRepositoryCatalog } from './repositoryCatalogService';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-08-12T18:00:00.000Z');

const ADMIN: AuthContext = { subjectType: 'user', userId: 'admin-a', orgId: ORG_A, roles: ['admin'] };
const MEMBER: AuthContext = { subjectType: 'user', userId: 'member-a', orgId: ORG_A, roles: ['member'] };

const EMPTY_SCOPE: ReadScope = { allows: [], denies: [] };

function dependencies(overrides: Record<string, unknown> = {}) {
  const store: RepositoryCatalogStore = { list: vi.fn(async (): Promise<StoredRepositoryCatalogEntry[]> => []) };
  const permissions: PermissionStore = { getReadScope: vi.fn(async () => EMPTY_SCOPE) };
  return {
    store,
    permissions,
    syncRows: vi.fn(async () => []),
    now: vi.fn(() => NOW),
    ...overrides,
  };
}

describe('getRepositoryCatalog — AC-11 (sync summary shape + status precedence)', () => {
  // @spec AC-11
  it('returns an idle sync summary when there are no sync rows at all', async () => {
    const deps = dependencies();
    const result = await getRepositoryCatalog(ADMIN, deps as never);
    expect(result.sync).toEqual({
      status: 'idle',
      updatedAt: null,
      discoveredRepositories: 0,
      registeredRepositories: 0,
      revokedRepositories: 0,
      sweepOutcome: null,
    });
  });

  // @spec AC-11
  it('resolves status "importing" for a pending/running row touched within the stall window', async () => {
    const deps = dependencies({
      syncRows: vi.fn(async () => [
        { status: 'running', updatedAt: new Date(NOW.getTime() - 1_000), discoveredCount: 10, registeredCount: 5, enqueuedCount: 5, revokedCount: 0, sweepOutcome: 'not_applicable' },
      ]),
    });
    const result = await getRepositoryCatalog(ADMIN, deps as never);
    expect(result.sync.status).toBe('importing');
  });

  // @spec AC-11
  it('resolves status "stalled" for a pending/running row older than the stall window', async () => {
    const deps = dependencies({
      syncRows: vi.fn(async () => [
        { status: 'running', updatedAt: new Date(NOW.getTime() - 10 * 60_000), discoveredCount: 10, registeredCount: 5, enqueuedCount: 5, revokedCount: 0, sweepOutcome: 'not_applicable' },
      ]),
    });
    const result = await getRepositoryCatalog(ADMIN, deps as never);
    expect(result.sync.status).toBe('stalled');
  });

  // @spec AC-11
  it('resolves status "failed" when no row is importing/stalled but one has status failed', async () => {
    const deps = dependencies({
      syncRows: vi.fn(async () => [
        { status: 'failed', updatedAt: NOW, discoveredCount: 0, registeredCount: 0, enqueuedCount: 0, revokedCount: 0, sweepOutcome: 'not_applicable' },
      ]),
    });
    const result = await getRepositoryCatalog(ADMIN, deps as never);
    expect(result.sync.status).toBe('failed');
  });

  // @spec AC-11
  it('resolves status "idle" when every row is complete/cancelled', async () => {
    const deps = dependencies({
      syncRows: vi.fn(async () => [
        { status: 'complete', updatedAt: NOW, discoveredCount: 5, registeredCount: 5, enqueuedCount: 5, revokedCount: 0, sweepOutcome: 'applied' },
      ]),
    });
    const result = await getRepositoryCatalog(ADMIN, deps as never);
    expect(result.sync.status).toBe('idle');
  });
});

describe('getRepositoryCatalog — AC-12/EC-16 (admin-only counts, null for a member)', () => {
  // @spec AC-12
  it('populates discoveredRepositories/registeredRepositories/revokedRepositories/sweepOutcome for an admin', async () => {
    const deps = dependencies({
      syncRows: vi.fn(async () => [
        { status: 'complete', updatedAt: NOW, discoveredCount: 12, registeredCount: 11, enqueuedCount: 10, revokedCount: 2, sweepOutcome: 'applied' },
      ]),
    });
    const result = await getRepositoryCatalog(ADMIN, deps as never);
    expect(result.sync.discoveredRepositories).toBe(12);
    expect(result.sync.registeredRepositories).toBe(11);
    expect(result.sync.revokedRepositories).toBe(2);
    expect(result.sync.sweepOutcome).toBe('applied');
  });

  // @spec AC-12 EC-16
  it('leaves every admin-gated sync field null for a member, while status/updatedAt remain present', async () => {
    const deps = dependencies({
      syncRows: vi.fn(async () => [
        { status: 'running', updatedAt: NOW, discoveredCount: 12, registeredCount: 11, enqueuedCount: 10, revokedCount: 2, sweepOutcome: 'not_applicable' },
      ]),
    });
    const result = await getRepositoryCatalog(MEMBER, deps as never);
    expect(result.sync.status).toBe('importing');
    expect(result.sync.updatedAt).toBe(NOW.toISOString());
    expect(result.sync.discoveredRepositories).toBeNull();
    expect(result.sync.registeredRepositories).toBeNull();
    expect(result.sync.revokedRepositories).toBeNull();
    expect(result.sync.sweepOutcome).toBeNull();
  });

  // @spec EC-16
  it("an owner also sees the admin-gated fields (role gate is 'admin' or 'owner')", async () => {
    const owner: AuthContext = { subjectType: 'user', userId: 'owner-a', orgId: ORG_A, roles: ['owner'] };
    const deps = dependencies({
      syncRows: vi.fn(async () => [
        { status: 'complete', updatedAt: NOW, discoveredCount: 3, registeredCount: 3, enqueuedCount: 3, revokedCount: 0, sweepOutcome: 'applied' },
      ]),
    });
    const result = await getRepositoryCatalog(owner, deps as never);
    expect(result.sync.discoveredRepositories).toBe(3);
  });
});

describe('getRepositoryCatalog — EC-18 (two-org isolation: syncRows is scoped by caller org only)', () => {
  // @spec EC-18
  it('calls syncRows with ONLY the caller\'s own org, never a hardcoded/foreign org', async () => {
    const deps = dependencies();
    await getRepositoryCatalog({ ...ADMIN, orgId: ORG_B }, deps as never);
    expect(deps.syncRows).toHaveBeenCalledWith(ORG_B);
    expect(deps.syncRows).not.toHaveBeenCalledWith(ORG_A);
  });
});
