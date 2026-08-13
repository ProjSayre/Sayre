// Leading-red tests (W7-01, AC-22) for assertInstallationDiscoveryOutboxReady — a structural
// mirror of assertInitialParseOutboxReady.test.ts's mocked-pg-Client convention, since spec.md's
// Approach step 9 says this module ports that startup gate to migration 0020's dispatcher
// boundary. The module does not exist yet, so every test fails today (RED-CORRECT).

import { afterEach, describe, expect, it, vi } from 'vitest';

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

// Metadata shape spec.md's Approach step 9 describes: RLS enabled+forced, owner is
// sayre_installation_discovery_dispatcher (NOLOGIN/NOSUPERUSER/NOBYPASSRLS, no memberships),
// functions SECURITY DEFINER with a pinned search_path, PUBLIC cannot execute, sayre_app can
// execute, sayre_app cannot read/mutate lease/dispatch columns, the dispatcher role cannot
// INSERT/DELETE or read counters/cursor/requesting subject.
const SAFE_METADATA = {
  rls_enabled: true,
  rls_forced: true,
  owner_name: 'sayre_installation_discovery_dispatcher',
  owner_no_login: true,
  owner_no_superuser: true,
  owner_no_bypassrls: true,
  owner_has_no_memberships: true,
  functions_safe: true,
  public_cannot_execute: true,
  app_can_execute: true,
  app_cannot_read_or_mutate_lease_columns: true,
  owner_cannot_insert_or_delete: true,
  owner_cannot_read_counters_cursor_or_subject: true,
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

async function loadModule() {
  return import('./assertInstallationDiscoveryOutboxReady');
}

describe('assertInstallationDiscoveryOutboxReady — AC-22 (fail-closed startup gate)', () => {
  // @spec AC-22
  it('resolves when the boundary metadata is entirely safe', async () => {
    mockSafeBoundary();
    const { assertInstallationDiscoveryOutboxReady } = await loadModule();
    await expect(assertInstallationDiscoveryOutboxReady(FAKE_DSN)).resolves.toBeUndefined();
    expect(endMock).toHaveBeenCalledOnce();
  });

  // @spec AC-22
  it.each([
    ['a missing/unsafe function', 'functions_safe'],
    ['a widened ACL (PUBLIC can execute)', 'public_cannot_execute'],
    ['an unsafe owner role (can log in)', 'owner_no_login'],
    ['sayre_app holding read/write on the lease columns', 'app_cannot_read_or_mutate_lease_columns'],
  ] as const)('fails closed when %s', async (_label, unsafeField) => {
    queryMock.mockResolvedValueOnce({ rows: [{ ...SAFE_METADATA, [unsafeField]: false }] });
    const { assertInstallationDiscoveryOutboxReady, InstallationDiscoveryOutboxUnsafeError } = await loadModule();

    await expect(assertInstallationDiscoveryOutboxReady(FAKE_DSN)).rejects.toBeInstanceOf(
      InstallationDiscoveryOutboxUnsafeError,
    );
  });

  // @spec AC-22
  it('never exposes the DSN or underlying database detail on a probe failure', async () => {
    const marker = 'installation-discovery-secret-marker';
    queryMock.mockRejectedValueOnce(new Error(`driver failed: ${marker}`));
    const { assertInstallationDiscoveryOutboxReady } = await loadModule();

    let message = '';
    try {
      await assertInstallationDiscoveryOutboxReady(`postgresql://user:${marker}@host/db`);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).not.toContain(marker);
    expect(endMock).toHaveBeenCalledOnce();
  });
});
