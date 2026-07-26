// Startup assertion for migration 0011's deliberately narrow pre-tenant
// GitHub-installation resolver. Unlike the general runtime-role assertion,
// this check runs in every environment: a missing migration or unsafe ACL must
// stop the HTTP service before a signed webhook can be misrouted or silently
// treated as an unknown installation.

import { Client } from 'pg';

const RESOLVER_DB_TIMEOUT_MS = 5_000;

export class InstallationResolverUnsafeError extends Error {
  constructor() {
    super(
      'GitHub installation resolution is unavailable or unsafely provisioned. ' +
        'Apply the current Core migrations before starting the service.',
    );
    this.name = 'InstallationResolverUnsafeError';
  }
}

interface ResolverMetadata {
  security_definer: boolean;
  stable: boolean;
  safe_search_path: boolean;
  owner_name: string;
  owner_no_login: boolean;
  owner_no_superuser: boolean;
  owner_no_bypassrls: boolean;
  owner_has_no_memberships: boolean;
  public_cannot_execute: boolean;
  app_can_execute: boolean;
  allowed_columns_readable: boolean;
  forbidden_columns_hidden: boolean;
  no_table_write_privileges: boolean;
}

function metadataIsSafe(row: ResolverMetadata | undefined): boolean {
  return Boolean(
    row?.security_definer &&
      row.stable &&
      row.safe_search_path &&
      row.owner_name === 'sayre_installation_resolver' &&
      row.owner_no_login &&
      row.owner_no_superuser &&
      row.owner_no_bypassrls &&
      row.owner_has_no_memberships &&
      row.public_cannot_execute &&
      row.app_can_execute &&
      row.allowed_columns_readable &&
      row.forbidden_columns_hidden &&
      row.no_table_write_privileges,
  );
}

/**
 * Verifies both the catalog shape and an operational call through `sayre_app`.
 * The DSN is never included in an error or log. Any missing object, grant,
 * unsafe owner attribute, widened column privilege, or execution failure is a
 * single sanitized startup failure.
 */
export async function assertInstallationResolverReady(dsn: string): Promise<void> {
  const client = new Client({
    connectionString: dsn,
    connectionTimeoutMillis: RESOLVER_DB_TIMEOUT_MS,
    statement_timeout: RESOLVER_DB_TIMEOUT_MS,
    query_timeout: RESOLVER_DB_TIMEOUT_MS,
  });
  await client.connect();
  let transactionOpen = false;

  try {
    const metadata = await client.query<ResolverMetadata>(`
      SELECT
        procedure.prosecdef AS security_definer,
        procedure.provolatile = 's' AS stable,
        coalesce(
          procedure.proconfig @> ARRAY['search_path=pg_catalog, public']::text[],
          false
        ) AS safe_search_path,
        owner.rolname AS owner_name,
        NOT owner.rolcanlogin AS owner_no_login,
        NOT owner.rolsuper AS owner_no_superuser,
        NOT owner.rolbypassrls AS owner_no_bypassrls,
        NOT EXISTS (
          SELECT 1
            FROM pg_auth_members AS membership
           WHERE membership.roleid = owner.oid
              OR membership.member = owner.oid
        ) AS owner_has_no_memberships,
        NOT has_function_privilege(
          'public',
          procedure.oid,
          'EXECUTE'
        ) AS public_cannot_execute,
        has_function_privilege(
          'sayre_app',
          procedure.oid,
          'EXECUTE'
        ) AS app_can_execute,
        has_column_privilege(
          owner.oid,
          'public.github_app_installations',
          'installation_id',
          'SELECT'
        )
        AND has_column_privilege(
          owner.oid,
          'public.github_app_installations',
          'org_id',
          'SELECT'
        )
        AND has_column_privilege(
          owner.oid,
          'public.github_app_installations',
          'suspended_at',
          'SELECT'
        )
        AND has_column_privilege(
          owner.oid,
          'public.github_app_installations',
          'revoked_at',
          'SELECT'
        ) AS allowed_columns_readable,
        NOT has_column_privilege(
          owner.oid,
          'public.github_app_installations',
          'account_login',
          'SELECT'
        )
        AND NOT has_column_privilege(
          owner.oid,
          'public.github_app_installations',
          'account_type',
          'SELECT'
        )
        AND NOT has_column_privilege(
          owner.oid,
          'public.github_app_installations',
          'repository_selection',
          'SELECT'
        ) AS forbidden_columns_hidden,
        NOT has_table_privilege(
          owner.oid,
          'public.github_app_installations',
          'INSERT'
        )
        AND NOT has_table_privilege(
          owner.oid,
          'public.github_app_installations',
          'UPDATE'
        )
        AND NOT has_table_privilege(
          owner.oid,
          'public.github_app_installations',
          'DELETE'
        ) AS no_table_write_privileges
      FROM pg_proc AS procedure
      JOIN pg_roles AS owner
        ON owner.oid = procedure.proowner
      WHERE procedure.oid =
        to_regprocedure('public.resolve_github_installation_org(bigint)')
    `);

    if (!metadataIsSafe(metadata.rows[0])) {
      throw new InstallationResolverUnsafeError();
    }

    await client.query('BEGIN');
    transactionOpen = true;
    await client.query('SET LOCAL ROLE sayre_app');
    await client.query("SELECT set_config('app.org_id', '', true)");
    await client.query(
      'SELECT org_id, active FROM public.resolve_github_installation_org($1::bigint)',
      [0],
    );
    await client.query('ROLLBACK');
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the single sanitized startup error below.
      }
    }
    if (error instanceof InstallationResolverUnsafeError) throw error;
    throw new InstallationResolverUnsafeError();
  } finally {
    await client.end();
  }
}
