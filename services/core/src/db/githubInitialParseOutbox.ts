// Persistence boundary for W1-06's durable GitHub callback -> SQS handoff.
//
// Callback inserts are executed on the caller's existing `withOrgContext`
// transaction. Dispatcher operations call only migration 0012's constrained
// SECURITY DEFINER functions after first dropping to `sayre_app`; there is no
// admin DSN and no general cross-tenant table access in application code.

import { sql } from 'drizzle-orm';
import type { RepoInitialParseEvent } from '@sayre/shared-types';
import { assertValidEnvelope, type MessageEnvelope } from '../queue/envelope';
import type { Db } from './client';

export interface ClaimedInitialParseOutboxEvent {
  id: string;
  leaseToken: string;
  attemptCount: number;
  envelope: MessageEnvelope<RepoInitialParseEvent>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isNonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Validate the event-specific portion that the generic envelope guard cannot
 * express. Error messages name fields only; they never include repository
 * names, revisions, or any other envelope value.
 */
export function assertInitialParseEnvelope(
  value: unknown,
): asserts value is MessageEnvelope<RepoInitialParseEvent> {
  assertValidEnvelope(value);
  if (
    value.type !== 'repo.initial_parse' ||
    value.source !== 'github-app-install' ||
    value.schema_version !== 1
  ) {
    throw new Error('Outbox envelope has an invalid initial-parse header.');
  }

  const payload = value.payload as Partial<RepoInitialParseEvent> | null;
  const repo = payload && typeof payload === 'object' ? payload.repo : null;
  if (
    !payload ||
    payload.provider !== 'github' ||
    payload.type !== 'initial_parse' ||
    payload.reason !== 'app_install' ||
    !isNonBlank(payload.installation_id) ||
    !isNonBlank(payload.ref) ||
    !isNonBlank(payload.revision_sha) ||
    !repo ||
    !isNonBlank(repo.repo_id) ||
    !isNonBlank(repo.provider_repo_id) ||
    !isNonBlank(repo.full_name)
  ) {
    throw new Error('Outbox envelope has an invalid initial-parse payload.');
  }
}

/**
 * Append an immutable event in the installation/repository transaction.
 * Replays are a no-op on the deterministic (org_id, idempotency_key) identity.
 */
export async function enqueueInitialParseOutbox(
  tx: Db,
  envelope: MessageEnvelope<RepoInitialParseEvent>,
): Promise<void> {
  assertInitialParseEnvelope(envelope);
  // Keep the explicit four-column INSERT: the runtime role intentionally has
  // no INSERT privilege on lease/delivery bookkeeping columns. Drizzle's
  // schema-wide INSERT builder emits DEFAULT placeholders for omitted columns,
  // which would unnecessarily require INSERT privilege on those columns.
  await tx.execute(sql`
    insert into public.github_initial_parse_outbox (
      org_id,
      event_type,
      idempotency_key,
      envelope
    )
    values (
      ${envelope.org_id}::uuid,
      'repo.initial_parse',
      ${envelope.idempotency_key},
      ${JSON.stringify(envelope)}::jsonb
    )
    on conflict (org_id, idempotency_key) do nothing
  `);
}

function assertPositiveInteger(value: number, name: string, maximum: number): void {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}.`);
  }
}

function assertUuid(value: string, name: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error(`${name} must be a UUID.`);
  }
}

/**
 * Lease a bounded due batch across tenants through migration 0012's
 * purpose-built boundary. The returned envelope is the exact committed JSON;
 * it is never regenerated during retries.
 */
export async function claimInitialParseOutbox(
  db: Db,
  batchSize: number,
  leaseSeconds: number,
): Promise<ClaimedInitialParseOutboxEvent[]> {
  assertPositiveInteger(batchSize, 'batchSize', 25);
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 10 || leaseSeconds > 300) {
    throw new Error('leaseSeconds must be an integer between 10 and 300.');
  }

  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`set local role sayre_app`);
    await tx.execute(sql`select set_config('app.org_id', '', true)`);
    return tx.execute(sql`
      select id, lease_token, envelope, attempt_count
        from public.claim_github_initial_parse_outbox(
          ${batchSize}::integer,
          ${leaseSeconds}::integer
        )
    `);
  });

  const rows = (
    result as unknown as {
      rows: Array<{
        id: string;
        lease_token: string;
        envelope: unknown;
        attempt_count: number;
      }>;
    }
  ).rows;

  return rows.map((row) => {
    assertUuid(row.id, 'claimed outbox id');
    assertUuid(row.lease_token, 'claimed outbox lease token');
    assertPositiveInteger(row.attempt_count, 'attemptCount', Number.MAX_SAFE_INTEGER);
    assertInitialParseEnvelope(row.envelope);
    return {
      id: row.id,
      leaseToken: row.lease_token,
      attemptCount: row.attempt_count,
      envelope: row.envelope,
    };
  });
}

/** Mark delivered only for the current lease owner. */
export async function completeInitialParseOutbox(
  db: Db,
  id: string,
  leaseToken: string,
): Promise<boolean> {
  assertUuid(id, 'outbox id');
  assertUuid(leaseToken, 'outbox lease token');

  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`set local role sayre_app`);
    await tx.execute(sql`select set_config('app.org_id', '', true)`);
    return tx.execute(sql`
      select public.complete_github_initial_parse_outbox(
        ${id}::uuid,
        ${leaseToken}::uuid
      ) as completed
    `);
  });

  const row = (
    result as unknown as {
      rows: Array<{ completed: boolean }>;
    }
  ).rows[0];
  return row?.completed === true;
}

/**
 * Release the current lease with a bounded delay. If the process dies before
 * this call, lease expiry makes the row claimable again automatically.
 */
export async function retryInitialParseOutbox(
  db: Db,
  id: string,
  leaseToken: string,
  delaySeconds: number,
): Promise<boolean> {
  assertUuid(id, 'outbox id');
  assertUuid(leaseToken, 'outbox lease token');
  assertPositiveInteger(delaySeconds, 'delaySeconds', 300);

  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`set local role sayre_app`);
    await tx.execute(sql`select set_config('app.org_id', '', true)`);
    return tx.execute(sql`
      select public.retry_github_initial_parse_outbox(
        ${id}::uuid,
        ${leaseToken}::uuid,
        ${delaySeconds}::integer
      ) as released
    `);
  });

  const row = (
    result as unknown as {
      rows: Array<{ released: boolean }>;
    }
  ).rows[0];
  return row?.released === true;
}
