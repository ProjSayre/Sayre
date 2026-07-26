import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertInitialParseOutboxReady,
  InitialParseOutboxUnsafeError,
} from './assertInitialParseOutboxReady';

const queryMock = vi.fn();
const connectMock = vi.fn(async () => undefined);
const endMock = vi.fn(async () => undefined);

vi.mock('pg', () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect: connectMock,
    query: queryMock,
    end: endMock,
  })),
}));

const FAKE_DSN = 'postgresql://fake-user:fake-pass@fake-host/fake-db';
const SAFE_METADATA = {
  rls_enabled: true,
  rls_forced: true,
  owner_name: 'sayre_initial_parse_outbox_dispatcher',
  owner_no_login: true,
  owner_no_superuser: true,
  owner_no_bypassrls: true,
  owner_has_no_memberships: true,
  functions_safe: true,
  public_cannot_execute: true,
  app_can_execute: true,
  owner_can_read_delivery_columns: true,
  owner_can_update_delivery_columns: true,
  owner_cannot_change_event_identity: true,
  owner_cannot_insert_or_delete: true,
  app_can_insert_event: true,
  app_can_read_conflict_identity: true,
  app_cannot_read_or_mutate_delivery_state: true,
};

function mockSafeBoundary(): void {
  queryMock.mockResolvedValueOnce({ rows: [SAFE_METADATA] });
  queryMock.mockResolvedValue({ rows: [] });
}

afterEach(() => {
  queryMock.mockReset();
  connectMock.mockClear();
  endMock.mockClear();
});

describe('assertInitialParseOutboxReady', () => {
  it('validates the boundary and probes all functions without claiming rows', async () => {
    mockSafeBoundary();

    await expect(assertInitialParseOutboxReady(FAKE_DSN)).resolves.toBeUndefined();

    expect(queryMock).toHaveBeenCalledWith(
      'SELECT * FROM public.claim_github_initial_parse_outbox($1::integer, $2::integer)',
      [0, 10],
    );
    expect(queryMock).toHaveBeenLastCalledWith('ROLLBACK');
    expect(endMock).toHaveBeenCalledOnce();
  });

  it.each([
    ['RLS is not forced', 'rls_forced'],
    ['dispatcher can log in', 'owner_no_login'],
    ['dispatcher can bypass RLS', 'owner_no_bypassrls'],
    ['dispatcher has a membership', 'owner_has_no_memberships'],
    ['a function is unsafe', 'functions_safe'],
    ['PUBLIC can execute', 'public_cannot_execute'],
    ['sayre_app cannot execute', 'app_can_execute'],
    ['event identity is mutable', 'owner_cannot_change_event_identity'],
    ['request role can inspect delivery state', 'app_cannot_read_or_mutate_delivery_state'],
  ] as const)('fails closed when %s', async (_label, unsafeField) => {
    queryMock.mockResolvedValueOnce({
      rows: [{ ...SAFE_METADATA, [unsafeField]: false }],
    });

    await expect(assertInitialParseOutboxReady(FAKE_DSN)).rejects.toBeInstanceOf(
      InitialParseOutboxUnsafeError,
    );
  });

  it('rolls back and sanitizes an operational probe failure', async () => {
    queryMock.mockResolvedValueOnce({ rows: [SAFE_METADATA] });
    queryMock.mockResolvedValueOnce({ rows: [] }); // BEGIN
    queryMock.mockResolvedValueOnce({ rows: [] }); // SET ROLE
    queryMock.mockResolvedValueOnce({ rows: [] }); // set_config
    queryMock.mockRejectedValueOnce(new Error('database detail with credentials'));
    queryMock.mockResolvedValueOnce({ rows: [] }); // compensating ROLLBACK

    await expect(assertInitialParseOutboxReady(FAKE_DSN)).rejects.toEqual(
      new InitialParseOutboxUnsafeError(),
    );
    expect(queryMock).toHaveBeenLastCalledWith('ROLLBACK');
  });

  it('never exposes the DSN or underlying database detail', async () => {
    const marker = 'outbox-secret-marker';
    queryMock.mockRejectedValueOnce(new Error(`driver failed: ${marker}`));

    let message = '';
    try {
      await assertInitialParseOutboxReady(`postgresql://user:${marker}@host/db`);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).not.toContain(marker);
    expect(endMock).toHaveBeenCalledOnce();
  });
});
