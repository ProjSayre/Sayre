// Unit tests for db/authUsers.ts::resolveUserByExternalAuthId, in particular
// the org_role coercion (least-privilege default to 'member' on an
// unexpected stored value — spec.md's "existing user whose stored org_role
// is an unexpected string" edge case).
//
// Placed under src/services/ (NOT src/db/) on purpose: vitest.config.ts
// excludes 'src/db/**' wholesale (that directory's tests run separately,
// against a real Postgres instance, via the node:test-based
// `npm run test:rls`/`test:rls:acceptance` scripts — see db/rls.test.ts's
// header comment) — a vitest test file placed under src/db/ would be
// silently skipped by `npm run test` (confirmed empirically: `npx vitest run
// src/db/__probe.test.ts` reports "No test files found"). This mirrors the
// established precedent of src/services/providerSettingsStore.test.ts, which
// tests db/providerSettingsStore.ts the same way, for the same reason: a
// hand-built fake of drizzle's chained query builder, no real Postgres.
//
// loginService.test.ts's "coerces an unexpected stored org_role to member"
// test does NOT exercise this coercion — its own comment says it simulates a
// value "already coerced upstream by resolveUserByExternalAuthId" and only
// proves the service trusts whatever ResolvedAuthUser it's handed. This file
// is what actually proves the coercion.

import { describe, expect, it, vi } from 'vitest';
import { resolveUserByExternalAuthId } from '../db/authUsers';
import type { Db } from '../db/client';

function makeFakeDb(rows: unknown[]) {
  const limit = vi.fn(async () => rows);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { db: { select } as unknown as Db, select, from, where, limit };
}

describe('resolveUserByExternalAuthId', () => {
  it('returns null when no row has this external_auth_id', async () => {
    const { db } = makeFakeDb([]);
    await expect(resolveUserByExternalAuthId(db, '999999')).resolves.toBeNull();
  });

  it('maps a matching row to userId/orgId/orgRole', async () => {
    const { db, where } = makeFakeDb([
      { userId: 'user-1', orgId: 'org-1', orgRole: 'admin' },
    ]);
    await expect(resolveUserByExternalAuthId(db, '1001')).resolves.toEqual({
      userId: 'user-1',
      orgId: 'org-1',
      orgRole: 'admin',
    });
    expect(where).toHaveBeenCalledTimes(1);
  });

  it.each(['owner', 'admin', 'member'])(
    'passes a valid stored org_role (%s) through unchanged',
    async (validRole) => {
      const { db } = makeFakeDb([{ userId: 'user-1', orgId: 'org-1', orgRole: validRole }]);
      const resolved = await resolveUserByExternalAuthId(db, '1001');
      expect(resolved?.orgRole).toBe(validRole);
    },
  );

  it('coerces an unexpected stored org_role string to "member" (least privilege)', async () => {
    const { db } = makeFakeDb([
      { userId: 'user-1', orgId: 'org-1', orgRole: 'superadmin' },
    ]);
    const resolved = await resolveUserByExternalAuthId(db, '1001');
    expect(resolved?.orgRole).toBe('member');
  });

  it('coerces an empty-string stored org_role to "member"', async () => {
    const { db } = makeFakeDb([{ userId: 'user-1', orgId: 'org-1', orgRole: '' }]);
    const resolved = await resolveUserByExternalAuthId(db, '1001');
    expect(resolved?.orgRole).toBe('member');
  });

  it('only ever returns the first matching row (limit 1 semantics)', async () => {
    const { db, limit } = makeFakeDb([{ userId: 'user-1', orgId: 'org-1', orgRole: 'owner' }]);
    await resolveUserByExternalAuthId(db, '1001');
    expect(limit).toHaveBeenCalledWith(1);
  });
});
