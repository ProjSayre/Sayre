// Startup validation for migration 0012's cross-tenant outbox dispatcher
// boundary. Any widened ACL or missing function fails closed before HTTP
// traffic can create an initial-parse event that cannot be recovered.

import { Client } from 'pg';

export class InitialParseOutboxUnsafeError extends Error {
  constructor() {
    super(
      'GitHub initial-parse outbox delivery is unavailable or unsafely provisioned. ' +
        'Apply the current Core migrations before starting the service.',
    );
    this.name = 'InitialParseOutboxUnsafeError';
  }
}

interface OutboxBoundaryMetadata {
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
  owner_can_read_delivery_columns: boolean;
  owner_can_update_delivery_columns: boolean;
  owner_cannot_change_event_identity: boolean;
  owner_cannot_insert_or_delete: boolean;
  app_can_insert_event: boolean;
  app_can_read_conflict_identity: boolean;
  app_cannot_read_or_mutate_delivery_state: boolean;
}

function metadataIsSafe(row: OutboxBoundaryMetadata | undefined): boolean {
  return Boolean(
    row?.rls_enabled &&
      row.rls_forced &&
      row.owner_name === 'sayre_initial_parse_outbox_dispatcher' &&
      row.owner_no_login &&
      row.owner_no_superuser &&
      row.owner_no_bypassrls &&
      row.owner_has_no_memberships &&
      row.functions_safe &&
      row.public_cannot_execute &&
      row.app_can_execute &&
      row.owner_can_read_delivery_columns &&
      row.owner_can_update_delivery_columns &&
      row.owner_cannot_change_event_identity &&
      row.owner_cannot_insert_or_delete &&
      row.app_can_insert_event &&
      row.app_can_read_conflict_identity &&
      row.app_cannot_read_or_mutate_delivery_state,
  );
}

export async function assertInitialParseOutboxReady(dsn: string): Promise<void> {
  const client = new Client({ connectionString: dsn });
  await client.connect();
  let transactionOpen = false;

  try {
    const metadata = await client.query<OutboxBoundaryMetadata>(`
      WITH boundary_functions AS (
        SELECT procedure.*
          FROM pg_proc AS procedure
         WHERE procedure.oid IN (
           to_regprocedure(
             'public.claim_github_initial_parse_outbox(integer,integer)'
           ),
           to_regprocedure(
             'public.complete_github_initial_parse_outbox(uuid,uuid)'
           ),
           to_regprocedure(
             'public.retry_github_initial_parse_outbox(uuid,uuid,integer)'
           )
         )
      ),
      dispatcher AS (
        SELECT *
          FROM pg_roles
         WHERE rolname = 'sayre_initial_parse_outbox_dispatcher'
      ),
      outbox AS (
        SELECT *
          FROM pg_class
         WHERE oid = to_regclass('public.github_initial_parse_outbox')
      )
      SELECT
        outbox.relrowsecurity AS rls_enabled,
        outbox.relforcerowsecurity AS rls_forced,
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
             AND bool_and(
               NOT has_function_privilege('public', oid, 'EXECUTE')
             )
            FROM boundary_functions
        ) AS public_cannot_execute,
        (
          SELECT count(*) = 3
             AND bool_and(
               has_function_privilege('sayre_app', oid, 'EXECUTE')
             )
            FROM boundary_functions
        ) AS app_can_execute,
        has_column_privilege(
          dispatcher.oid,
          outbox.oid,
          'id',
          'SELECT'
        )
        AND has_column_privilege(
          dispatcher.oid,
          outbox.oid,
          'envelope',
          'SELECT'
        )
        AND has_column_privilege(
          dispatcher.oid,
          outbox.oid,
          'attempt_count',
          'SELECT'
        ) AS owner_can_read_delivery_columns,
        has_column_privilege(
          dispatcher.oid,
          outbox.oid,
          'attempt_count',
          'UPDATE'
        )
        AND has_column_privilege(
          dispatcher.oid,
          outbox.oid,
          'next_attempt_at',
          'UPDATE'
        )
        AND has_column_privilege(
          dispatcher.oid,
          outbox.oid,
          'lease_token',
          'UPDATE'
        )
        AND has_column_privilege(
          dispatcher.oid,
          outbox.oid,
          'lease_expires_at',
          'UPDATE'
        )
        AND has_column_privilege(
          dispatcher.oid,
          outbox.oid,
          'delivered_at',
          'UPDATE'
        ) AS owner_can_update_delivery_columns,
        NOT has_column_privilege(
          dispatcher.oid,
          outbox.oid,
          'org_id',
          'UPDATE'
        )
        AND NOT has_column_privilege(
          dispatcher.oid,
          outbox.oid,
          'idempotency_key',
          'UPDATE'
        )
        AND NOT has_column_privilege(
          dispatcher.oid,
          outbox.oid,
          'envelope',
          'UPDATE'
        ) AS owner_cannot_change_event_identity,
        NOT has_table_privilege(dispatcher.oid, outbox.oid, 'INSERT')
        AND NOT has_table_privilege(dispatcher.oid, outbox.oid, 'DELETE')
          AS owner_cannot_insert_or_delete,
        has_column_privilege(
          'sayre_app',
          outbox.oid,
          'org_id',
          'INSERT'
        )
        AND has_column_privilege(
          'sayre_app',
          outbox.oid,
          'event_type',
          'INSERT'
        )
        AND has_column_privilege(
          'sayre_app',
          outbox.oid,
          'idempotency_key',
          'INSERT'
        )
        AND has_column_privilege(
          'sayre_app',
          outbox.oid,
          'envelope',
          'INSERT'
        ) AS app_can_insert_event,
        has_column_privilege(
          'sayre_app',
          outbox.oid,
          'org_id',
          'SELECT'
        )
        AND has_column_privilege(
          'sayre_app',
          outbox.oid,
          'idempotency_key',
          'SELECT'
        ) AS app_can_read_conflict_identity,
        NOT has_column_privilege(
          'sayre_app',
          outbox.oid,
          'envelope',
          'SELECT'
        )
        AND NOT has_column_privilege(
          'sayre_app',
          outbox.oid,
          'lease_token',
          'SELECT'
        )
        AND NOT has_table_privilege('sayre_app', outbox.oid, 'UPDATE')
        AND NOT has_table_privilege('sayre_app', outbox.oid, 'DELETE')
          AS app_cannot_read_or_mutate_delivery_state
      FROM dispatcher
      CROSS JOIN outbox
    `);

    if (!metadataIsSafe(metadata.rows[0])) {
      throw new InitialParseOutboxUnsafeError();
    }

    await client.query('BEGIN');
    transactionOpen = true;
    await client.query('SET LOCAL ROLE sayre_app');
    await client.query("SELECT set_config('app.org_id', '', true)");
    await client.query(
      'SELECT * FROM public.claim_github_initial_parse_outbox($1::integer, $2::integer)',
      [0, 10],
    );
    await client.query(
      'SELECT public.complete_github_initial_parse_outbox($1::uuid, $2::uuid)',
      ['00000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-000000000001'],
    );
    await client.query(
      'SELECT public.retry_github_initial_parse_outbox($1::uuid, $2::uuid, $3::integer)',
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
    if (error instanceof InitialParseOutboxUnsafeError) throw error;
    throw new InitialParseOutboxUnsafeError();
  } finally {
    await client.end();
  }
}
