import { afterEach, describe, expect, it, vi } from 'vitest';
import { RuntimeRoleUnsafeError, assertRuntimeRoleRlsSafe } from './assertRuntimeRoleRlsSafe';

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

afterEach(() => {
  vi.unstubAllEnvs();
  queryMock.mockReset();
  connectMock.mockClear();
  endMock.mockClear();
});

describe('assertRuntimeRoleRlsSafe', () => {
  it('no-ops outside NODE_ENV=production and CI!=true (never even connects)', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('CI', '');
    await assertRuntimeRoleRlsSafe(FAKE_DSN);
    expect(connectMock).not.toHaveBeenCalled();
  });

  it('no-ops for NODE_ENV=test', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('CI', '');
    await assertRuntimeRoleRlsSafe(FAKE_DSN);
    expect(connectMock).not.toHaveBeenCalled();
  });

  it('enforces when NODE_ENV=production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    queryMock.mockResolvedValue({ rows: [{ rolsuper: true, rolbypassrls: false, in_sayre_app: true }] });
    await expect(assertRuntimeRoleRlsSafe(FAKE_DSN)).rejects.toBeInstanceOf(RuntimeRoleUnsafeError);
    expect(connectMock).toHaveBeenCalled();
  });

  it('enforces when CI=true even if NODE_ENV is unset', async () => {
    vi.stubEnv('CI', 'true');
    queryMock.mockResolvedValue({ rows: [{ rolsuper: false, rolbypassrls: true, in_sayre_app: true }] });
    await expect(assertRuntimeRoleRlsSafe(FAKE_DSN)).rejects.toThrow(/bypass row-level security/);
  });

  it('raises when the role is not a member of sayre_app', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    queryMock.mockResolvedValue({ rows: [{ rolsuper: false, rolbypassrls: false, in_sayre_app: false }] });
    await expect(assertRuntimeRoleRlsSafe(FAKE_DSN)).rejects.toThrow(/not a member of sayre_app/);
  });

  it('raises when the role cannot be resolved', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    queryMock.mockResolvedValue({ rows: [] });
    await expect(assertRuntimeRoleRlsSafe(FAKE_DSN)).rejects.toThrow(/could not resolve/);
  });

  it('passes and closes the connection when the role is safe', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    queryMock.mockResolvedValue({ rows: [{ rolsuper: false, rolbypassrls: false, in_sayre_app: true }] });
    await expect(assertRuntimeRoleRlsSafe(FAKE_DSN)).resolves.toBeUndefined();
    expect(endMock).toHaveBeenCalled();
  });

  it('always closes the connection, even when it throws', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    queryMock.mockResolvedValue({ rows: [{ rolsuper: true, rolbypassrls: false, in_sayre_app: true }] });
    await expect(assertRuntimeRoleRlsSafe(FAKE_DSN)).rejects.toThrow();
    expect(endMock).toHaveBeenCalled();
  });

  it('never leaks the DSN in the thrown error message', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    queryMock.mockResolvedValue({ rows: [{ rolsuper: true, rolbypassrls: false, in_sayre_app: true }] });
    const secretMarker = 's3cr3t-credential-marker';
    await expect(
      assertRuntimeRoleRlsSafe(`postgresql://user:${secretMarker}@host/db`),
    ).rejects.not.toThrow(new RegExp(secretMarker));
  });
});
