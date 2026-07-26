import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import {
  assertInstallationResolverReady,
  InstallationResolverUnsafeError,
} from './assertInstallationResolverReady';

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
  security_definer: true,
  stable: true,
  safe_search_path: true,
  owner_name: 'sayre_installation_resolver',
  owner_no_login: true,
  owner_no_superuser: true,
  owner_no_bypassrls: true,
  owner_has_no_memberships: true,
  public_cannot_execute: true,
  app_can_execute: true,
  allowed_columns_readable: true,
  forbidden_columns_hidden: true,
  no_table_write_privileges: true,
};

function mockSafeBoundary(): void {
  queryMock.mockResolvedValueOnce({ rows: [SAFE_METADATA] });
  queryMock.mockResolvedValue({ rows: [] });
}

afterEach(() => {
  queryMock.mockReset();
  connectMock.mockClear();
  endMock.mockClear();
  vi.mocked(Client).mockClear();
});

describe('assertInstallationResolverReady', () => {
  it('validates in development too and executes one probe as sayre_app', async () => {
    mockSafeBoundary();

    await expect(assertInstallationResolverReady(FAKE_DSN)).resolves.toBeUndefined();

    expect(Client).toHaveBeenCalledWith({
      connectionString: FAKE_DSN,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 5_000,
      query_timeout: 5_000,
    });
    expect(connectMock).toHaveBeenCalledOnce();
    expect(queryMock).toHaveBeenCalledWith('SET LOCAL ROLE sayre_app');
    expect(queryMock).toHaveBeenCalledWith(
      'SELECT org_id, active FROM public.resolve_github_installation_org($1::bigint)',
      [0],
    );
    expect(queryMock).toHaveBeenLastCalledWith('ROLLBACK');
    expect(endMock).toHaveBeenCalledOnce();
  });

  it('fails closed when the migration function is absent', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });

    await expect(assertInstallationResolverReady(FAKE_DSN)).rejects.toBeInstanceOf(
      InstallationResolverUnsafeError,
    );

    expect(queryMock).not.toHaveBeenCalledWith('BEGIN');
    expect(endMock).toHaveBeenCalledOnce();
  });

  it.each([
    ['SECURITY DEFINER is absent', 'security_definer'],
    ['owner can log in', 'owner_no_login'],
    ['owner can bypass RLS', 'owner_no_bypassrls'],
    ['owner has a role membership', 'owner_has_no_memberships'],
    ['PUBLIC can execute', 'public_cannot_execute'],
    ['sayre_app cannot execute', 'app_can_execute'],
    ['forbidden columns became visible', 'forbidden_columns_hidden'],
    ['write privilege was added', 'no_table_write_privileges'],
  ] as const)('fails closed when %s', async (_label, unsafeField) => {
    queryMock.mockResolvedValueOnce({
      rows: [{ ...SAFE_METADATA, [unsafeField]: false }],
    });

    await expect(assertInstallationResolverReady(FAKE_DSN)).rejects.toBeInstanceOf(
      InstallationResolverUnsafeError,
    );
  });

  it('rolls back and returns a sanitized error when the operational probe fails', async () => {
    queryMock.mockResolvedValueOnce({ rows: [SAFE_METADATA] });
    queryMock.mockResolvedValueOnce({ rows: [] }); // BEGIN
    queryMock.mockResolvedValueOnce({ rows: [] }); // SET ROLE
    queryMock.mockResolvedValueOnce({ rows: [] }); // set_config
    queryMock.mockRejectedValueOnce(new Error('database detail with credentials'));
    queryMock.mockResolvedValueOnce({ rows: [] }); // compensating ROLLBACK

    await expect(assertInstallationResolverReady(FAKE_DSN)).rejects.toEqual(
      new InstallationResolverUnsafeError(),
    );

    expect(queryMock).toHaveBeenLastCalledWith('ROLLBACK');
    expect(endMock).toHaveBeenCalledOnce();
  });

  it('never includes the credential-bearing DSN or underlying database detail', async () => {
    const marker = 'resolver-secret-marker';
    queryMock.mockRejectedValueOnce(new Error(`driver failed: ${marker}`));

    let message = '';
    try {
      await assertInstallationResolverReady(`postgresql://user:${marker}@host/db`);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).not.toContain(marker);
    expect(endMock).toHaveBeenCalledOnce();
  });
});
