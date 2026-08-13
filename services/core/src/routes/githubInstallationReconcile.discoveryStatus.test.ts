// Leading-red HTTP-level tests (W7-01) for spec.md AC-10 (the endpoint answers 202, not 200,
// once reconcile becomes async/row-write-only) and EC-17 (unauthenticated/member callers are
// rejected before the service is ever reached, so no manual_reconcile row can exist for them).
// Mirrors routes/githubInstallationReconcile.test.ts's real-HTTP-server + mocked-service
// convention.

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resetConfigForTests,
  resetSecretsForTests,
  setConfigOverrideForTests,
  setSecretBackendForTests,
} from '@sayre/config';
import { signSessionToken } from '../auth/sessionToken';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const SIGNING_KEY = 'reconcile-discovery-route-test-signing-key';

const discoveryResultFixture = { status: 'queued' as const, installations: 1, queued: 1 };
const reconcileInstallationRepositories = vi.fn(async () => discoveryResultFixture);

vi.mock('../services/githubInstallationReconcileService', async () => {
  const actual = await vi.importActual<
    typeof import('../services/githubInstallationReconcileService')
  >('../services/githubInstallationReconcileService');
  return {
    ...actual,
    reconcileInstallationRepositories: (...args: unknown[]) =>
      (reconcileInstallationRepositories as unknown as (...values: unknown[]) => unknown)(...args),
  };
});

import { createApp } from '../app';

async function startServer() {
  const app = createApp();
  const server: Server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function tokenFor(roles: Array<'admin' | 'owner' | 'member'>, orgId = ORG_A): Promise<string> {
  return signSessionToken({ userId: 'admin-a', orgId, roles });
}

let activeServer: Server | undefined;

beforeEach(() => {
  setConfigOverrideForTests('NODE_ENV', 'production');
  setSecretBackendForTests(async (ref) => {
    if (ref === 'env://JWT_SIGNING_KEY') return SIGNING_KEY;
    throw new Error('unexpected secret reference');
  });
  reconcileInstallationRepositories.mockClear();
  reconcileInstallationRepositories.mockResolvedValue(discoveryResultFixture);
});

afterEach(async () => {
  resetSecretsForTests();
  resetConfigForTests();
  if (activeServer) {
    await closeServer(activeServer);
    activeServer = undefined;
  }
});

describe('POST /integrations/github/reconcile — AC-10 (202, async row-write-only result)', () => {
  // @spec AC-10 EC-17
  it('responds 202 (not 200) with the queued/installations/queued result for an admin, while an unauthenticated/member caller never reaches the service at all', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const token = await tokenFor(['admin']);

    const response = await fetch(`${baseUrl}/integrations/github/reconcile`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });

    // AC-10: the new async result shape and 202 status.
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual(discoveryResultFixture);

    // EC-17: reusing the SAME service spy, an unauthenticated/member caller must leave its call
    // count unchanged — i.e. once AC-10's dispatch exists at all, the auth gate must still run
    // before it (a standalone "401/403, service never called" assertion would trivially pass
    // today regardless of whether AC-10 ships, since the gate itself is unmodified by this
    // ticket — this combined test only resolves once the AC-10 assertions above are satisfied).
    const unauthenticated = await fetch(`${baseUrl}/integrations/github/reconcile`, { method: 'POST' });
    const member = await fetch(`${baseUrl}/integrations/github/reconcile`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await tokenFor(['member'])}` },
    });
    expect(unauthenticated.status).toBe(401);
    expect(member.status).toBe(403);
    expect(reconcileInstallationRepositories).toHaveBeenCalledTimes(1); // unchanged since the admin call above
  });
});
