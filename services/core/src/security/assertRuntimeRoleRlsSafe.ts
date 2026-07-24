// CI/production startup gate (W2-06, Resolved decision Q2 -- see
// docs/tenant-isolation.md "DSN-role provisioning risk"). Mirrors
// sayre_workers/db/session.py::assert_runtime_role_rls_safe exactly.
//
// Lives under src/security/ (not src/db/) so its unit test runs under plain
// `npm run test` (vitest) -- src/db/** is deliberately excluded from vitest
// (see vitest.config.ts) because rls.test.ts/rls_acceptance.tester.test.ts
// use node:test instead.
//
// `withOrgContext` (../db/client.ts) already unconditionally runs `SET LOCAL
// ROLE sayre_app` before setting `app.org_id` -- that in-code guarantee is
// what actually engages RLS, regardless of which role the DSN's connection
// logs in as, and it is NOT modified by this file (read-only reference, per
// .pipeline/spec.md). This module is a *defense-in-depth early warning* on
// top of that guarantee: it queries pg_roles for the resolved
// DATABASE_RUNTIME_URL login role and fails closed at startup if that role
// can bypass RLS (a misprovisioned DSN, e.g. accidentally pointed at the
// admin/owner role) or is not even granted membership in sayre_app (which
// would mean withOrgContext's SET LOCAL ROLE fails at every call at runtime
// -- better to catch that at boot).
//
// Deliberately a CI/production gate, not a local-dev block: local dev's login
// role (sayre_dev, infra/.env.example) is intentionally a superuser (see
// client.ts's own header comment), so this function no-ops unless NODE_ENV is
// "production" or CI=true.

import { Client } from 'pg';

export class RuntimeRoleUnsafeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeRoleUnsafeError';
  }
}

function isGatedEnvironment(): boolean {
  return process.env.NODE_ENV === 'production' || process.env.CI === 'true';
}

/**
 * Queries `pg_roles` for the DSN's login role (before any `SET LOCAL ROLE`)
 * and throws `RuntimeRoleUnsafeError` if that role can bypass RLS
 * (`rolsuper`/`rolbypassrls`) or is not a member of `sayre_app`. No-ops
 * outside `NODE_ENV=production` / `CI=true`. Never logs `dsn` (it carries
 * credentials).
 */
export async function assertRuntimeRoleRlsSafe(dsn: string): Promise<void> {
  if (!isGatedEnvironment()) return;

  const client = new Client({ connectionString: dsn });
  await client.connect();
  try {
    const result = await client.query<{
      rolsuper: boolean;
      rolbypassrls: boolean;
      in_sayre_app: boolean;
    }>(
      `SELECT rolsuper, rolbypassrls,
              pg_has_role(current_user, 'sayre_app', 'member') AS in_sayre_app
         FROM pg_roles WHERE rolname = current_user`,
    );
    const row = result.rows[0];
    if (!row) {
      throw new RuntimeRoleUnsafeError(
        'assertRuntimeRoleRlsSafe: could not resolve the runtime login role.',
      );
    }
    if (row.rolsuper || row.rolbypassrls) {
      throw new RuntimeRoleUnsafeError(
        "assertRuntimeRoleRlsSafe: DATABASE_RUNTIME_URL's login role can bypass row-level " +
          'security (superuser or BYPASSRLS). Provision a NOBYPASSRLS, non-superuser login ' +
          'role granted membership in sayre_app before this deploys to CI/production.',
      );
    }
    if (!row.in_sayre_app) {
      throw new RuntimeRoleUnsafeError(
        "assertRuntimeRoleRlsSafe: DATABASE_RUNTIME_URL's login role is not a member of " +
          'sayre_app; withOrgContext\'s SET LOCAL ROLE sayre_app will fail closed on every ' +
          'call. Fix the grant before this deploys to CI/production.',
      );
    }
  } finally {
    await client.end();
  }
}
