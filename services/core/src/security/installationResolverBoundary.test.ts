import { readFileSync } from 'node:fs';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../db/client';
import {
  InstallationResolutionInputError,
  resolveInstallationOrg,
} from '../db/installations';

const migration = readFileSync(
  new URL('../../drizzle/0011_github_installation_resolver.sql', import.meta.url),
  'utf8',
);

function fakeDb(rows: Array<{ org_id: string; active: boolean }>) {
  const execute = vi
    .fn()
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows });
  const transaction = vi.fn(async (fn: (tx: { execute: typeof execute }) => unknown) =>
    fn({ execute }),
  );
  return { db: { transaction } as unknown as Db, execute, transaction };
}

function renderedSql(value: unknown): string {
  return new PgDialect().sqlToQuery(value as Parameters<PgDialect['sqlToQuery']>[0]).sql;
}

describe('GitHub installation resolution migration', () => {
  it('uses a no-login, no-bypass role with no memberships and column-only read access', () => {
    expect(migration).toMatch(
      /CREATE ROLE sayre_installation_resolver[\s\S]*NOLOGIN[\s\S]*NOINHERIT[\s\S]*NOBYPASSRLS/u,
    );
    expect(migration).toMatch(
      /WHERE roleid = resolver_role\.oid[\s\S]*OR member = resolver_role\.oid/u,
    );
    expect(migration).toMatch(
      /GRANT SELECT \(installation_id, org_id, suspended_at, revoked_at\)[\s\S]*TO sayre_installation_resolver/u,
    );
    expect(migration).not.toMatch(
      /GRANT (?:ALL|SELECT, INSERT|SELECT ON github_app_installations)[\s\S]*TO sayre_installation_resolver/u,
    );
  });

  it('adds one SELECT-only RLS policy and one locked-down function surface', () => {
    expect(migration).toMatch(
      /CREATE POLICY github_installation_resolver_lookup[\s\S]*FOR SELECT[\s\S]*TO sayre_installation_resolver[\s\S]*USING \(true\)/u,
    );
    expect(migration).toMatch(
      /RETURNS TABLE \(org_id uuid, active boolean\)[\s\S]*SECURITY DEFINER[\s\S]*SET search_path = pg_catalog, public/u,
    );
    expect(migration).toContain(
      'OWNER TO sayre_installation_resolver',
    );
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.resolve_github_installation_org\(bigint\) FROM PUBLIC/u,
    );
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.resolve_github_installation_org\(bigint\)[\s\S]*TO sayre_app/u,
    );
  });

  it('accepts only installation id and never accepts client org input', () => {
    const signature = migration.match(
      /FUNCTION public\.resolve_github_installation_org\(([\s\S]*?)\)\s*RETURNS TABLE/u,
    )?.[1];
    expect(signature).toMatch(/requested_installation_id bigint/u);
    expect(signature).not.toMatch(/org_id|organization/u);
  });
});

describe('resolveInstallationOrg', () => {
  it('drops to sayre_app, clears ambient org context, and calls only the narrow function', async () => {
    const { db, execute, transaction } = fakeDb([
      {
        org_id: '11111111-1111-4111-8111-111111111111',
        active: true,
      },
    ]);

    await expect(resolveInstallationOrg(db, 555)).resolves.toEqual({
      orgId: '11111111-1111-4111-8111-111111111111',
      active: true,
    });

    expect(transaction).toHaveBeenCalledOnce();
    expect(renderedSql(execute.mock.calls[0][0])).toBe('set local role sayre_app');
    expect(renderedSql(execute.mock.calls[1][0])).toContain(
      "select set_config('app.org_id', '', true)",
    );
    const lookup = renderedSql(execute.mock.calls[2][0]);
    expect(lookup).toContain('public.resolve_github_installation_org($1::bigint)');
    expect(lookup).not.toContain('github_app_installations');
  });

  it('returns null for an unknown installation and preserves revoked/suspended active=false', async () => {
    await expect(resolveInstallationOrg(fakeDb([]).db, 555)).resolves.toBeNull();
    await expect(
      resolveInstallationOrg(
        fakeDb([
          {
            org_id: '11111111-1111-4111-8111-111111111111',
            active: false,
          },
        ]).db,
        555,
      ),
    ).resolves.toEqual({
      orgId: '11111111-1111-4111-8111-111111111111',
      active: false,
    });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid installation id %s before opening a transaction',
    async (installationId) => {
      const { db, transaction } = fakeDb([]);
      await expect(resolveInstallationOrg(db, installationId)).rejects.toBeInstanceOf(
        InstallationResolutionInputError,
      );
      expect(transaction).not.toHaveBeenCalled();
    },
  );
});
