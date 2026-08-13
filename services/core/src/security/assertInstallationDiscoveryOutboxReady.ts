// W7-01 (AC-22): startup validation for migration 0020's cross-tenant discovery-dispatcher
// boundary. Ports `assertInitialParseOutboxReady`'s single metadata query to the new
// role/functions/ACLs. Any widened ACL or missing function fails closed before HTTP traffic can
// create a discovery run that cannot be recovered.

import { Client } from 'pg';

export class InstallationDiscoveryOutboxUnsafeError extends Error {
  constructor() {
    super(
      'GitHub installation-discovery dispatch is unavailable or unsafely provisioned. ' +
        'Apply the current Core migrations before starting the service.',
    );
    this.name = 'InstallationDiscoveryOutboxUnsafeError';
  }
}

interface DiscoveryOutboxBoundaryMetadata {
  rls_enabled: boolean;
  rls_forced: boolean;
  owner_name: string;
  owner_no_login: boolean;
  owner_no_superuser: boolean;
  owner_no_bypassrls: boolean;
  owner_has_no_memberships: boolean;
  functions_safe: boolean;
  public_cannot_execute: boolean;
  app_can_execute: boolean;
  app_cannot_read_or_mutate_lease_columns: boolean;
  owner_cannot_insert_or_delete: boolean;
  owner_cannot_read_counters_cursor_or_subject: boolean;
}

function metadataIsSafe(row: DiscoveryOutboxBoundaryMetadata | undefined): boolean {
  return Boolean(
    row?.rls_enabled &&
      row.rls_forced &&
      row.owner_name === 'sayre_installation_discovery_dispatcher' &&
      row.owner_no_login &&
      row.owner_no_superuser &&
      row.owner_no_bypassrls &&
      row.owner_has_no_memberships &&
      row.functions_safe &&
      row.public_cannot_execute &&
      row.app_can_execute &&
      row.app_cannot_read_or_mutate_lease_columns &&
      row.owner_cannot_insert_or_delete &&
      row.owner_cannot_read_counters_cursor_or_subject,
  );
}

export async function assertInstallationDiscoveryOutboxReady(dsn: string): Promise<void> {
  const client = new Client({ connectionString: dsn });
  await client.connect();
  let transactionOpen = false;

  try {
    const metadata = await client.query<DiscoveryOutboxBoundaryMetadata>(`
      WITH boundary_functions AS (
        SELECT procedure.*
          FROM pg_proc AS procedure
         WHERE procedure.oid IN (
           to_regprocedure(
             'public.claim_github_installation_discovery(integer,integer)'
           ),
           to_regprocedure(
             'public.complete_github_installation_discovery(uuid,uuid,integer)'
           ),
           to_regprocedure(
             'public.retry_github_installation_discovery(uuid,uuid,integer)'
           )
         )
      ),
      dispatcher AS (
        SELECT *
          FROM pg_roles
         WHERE rolname = 'sayre_installation_discovery_dispatcher'
      ),
      sync_table AS (
        SELECT *
          FROM pg_class
         WHERE oid = to_regclass('public.github_installation_sync')
      )
      SELECT
        sync_table.relrowsecurity AS rls_enabled,
        sync_table.relforcerowsecurity AS rls_forced,
        dispatcher.rolname AS owner_name,
        NOT dispatcher.rolcanlogin AS owner_no_login,
        NOT dispatcher.rolsuper AS owner_no_superuser,
        NOT dispatcher.rolbypassrls AS owner_no_bypassrls,
        NOT EXISTS (
          SELECT 1
            FROM pg_auth_members AS membership
           WHERE membership.roleid = dispatcher.oid
              OR membership.member = dispatcher.oid
        ) AS owner_has_no_memberships,
        (
          SELECT count(*) = 3
             AND bool_and(prosecdef)
             AND bool_and(provolatile = 'v')
             AND bool_and(
               coalesce(
                 proconfig @> ARRAY['search_path=pg_catalog, public']::text[],
                 false
               )
             )
             AND bool_and(proowner = dispatcher.oid)
            FROM boundary_functions
        ) AS functions_safe,
        (
          SELECT count(*) = 3
             AND bool_and(NOT has_function_privilege('public', oid, 'EXECUTE'))
            FROM boundary_functions
        ) AS public_cannot_execute,
        (
          SELECT count(*) = 3
             AND bool_and(has_function_privilege('sayre_app', oid, 'EXECUTE'))
            FROM boundary_functions
        ) AS app_can_execute,
        NOT has_column_privilege('sayre_app', sync_table.oid, 'lease_token', 'SELECT')
        AND NOT has_column_privilege('sayre_app', sync_table.oid, 'lease_token', 'UPDATE')
        AND NOT has_column_privilege('sayre_app', sync_table.oid, 'lease_expires_at', 'SELECT')
        AND NOT has_column_privilege('sayre_app', sync_table.oid, 'lease_expires_at', 'UPDATE')
        AND NOT has_column_privilege('sayre_app', sync_table.oid, 'dispatched_at', 'SELECT')
        AND NOT has_column_privilege('sayre_app', sync_table.oid, 'dispatched_at', 'UPDATE')
        AND NOT has_column_privilege('sayre_app', sync_table.oid, 'dispatch_attempt_count', 'SELECT')
        AND NOT has_column_privilege('sayre_app', sync_table.oid, 'dispatch_attempt_count', 'UPDATE')
          AS app_cannot_read_or_mutate_lease_columns,
        NOT has_table_privilege(dispatcher.oid, sync_table.oid, 'INSERT')
        AND NOT has_table_privilege(dispatcher.oid, sync_table.oid, 'DELETE')
          AS owner_cannot_insert_or_delete,
        NOT has_column_privilege(dispatcher.oid, sync_table.oid, 'next_page', 'SELECT')
        AND NOT has_column_privilege(dispatcher.oid, sync_table.oid, 'discovered_count', 'SELECT')
        AND NOT has_column_privilege(dispatcher.oid, sync_table.oid, 'registered_count', 'SELECT')
        AND NOT has_column_privilege(dispatcher.oid, sync_table.oid, 'enqueued_count', 'SELECT')
        AND NOT has_column_privilege(dispatcher.oid, sync_table.oid, 'revoked_count', 'SELECT')
        AND NOT has_column_privilege(
          dispatcher.oid, sync_table.oid, 'requested_by_subject_id', 'SELECT'
        )
          AS owner_cannot_read_counters_cursor_or_subject
      FROM dispatcher
      CROSS JOIN sync_table
    `);

    if (!metadataIsSafe(metadata.rows[0])) {
      throw new InstallationDiscoveryOutboxUnsafeError();
    }

    await client.query('BEGIN');
    transactionOpen = true;
    await client.query('SET LOCAL ROLE sayre_app');
    await client.query("SELECT set_config('app.org_id', '', true)");
    await client.query(
      'SELECT * FROM public.claim_github_installation_discovery($1::integer, $2::integer)',
      [0, 10],
    );
    await client.query(
      'SELECT public.complete_github_installation_discovery($1::uuid, $2::uuid, $3::integer)',
      [
        '00000000-0000-4000-8000-000000000000',
        '00000000-0000-4000-8000-000000000001',
        30,
      ],
    );
    await client.query(
      'SELECT public.retry_github_installation_discovery($1::uuid, $2::uuid, $3::integer)',
      [
        '00000000-0000-4000-8000-000000000000',
        '00000000-0000-4000-8000-000000000001',
        1,
      ],
    );
    await client.query('ROLLBACK');
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve one sanitized startup failure.
      }
    }
    if (error instanceof InstallationDiscoveryOutboxUnsafeError) throw error;
    throw new InstallationDiscoveryOutboxUnsafeError();
  } finally {
    await client.end();
  }
}
