// HTTP-level tests for POST /integrations/github/reconcile via a real createApp() + real
// HTTP server (matches routes/providerSettings.test.ts). Only the service layer is mocked.

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resetConfigForTests,
  resetSecretsForTests,
  setConfigOverrideForTests,
  setSecretBackendForTests,
} from '@sayre/config';
import type { OrgRole } from '../auth/context';
import { signSessionToken } from '../auth/sessionToken';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const SIGNING_KEY = 'reconcile-route-test-signing-key';

const reconcileResultFixture = {
  installations: 1,
  registered: 1,
  enqueued: 1,
  revoked: 0,
  truncated: false,
};

const reconcileInstallationRepositories = vi.fn(async () => reconcileResultFixture);

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

async function tokenFor(roles: OrgRole[], orgId = ORG_A): Promise<string> {
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
  reconcileInstallationRepositories.mockResolvedValue(reconcileResultFixture);
});

afterEach(async () => {
  resetSecretsForTests();
  resetConfigForTests();
  if (activeServer) {
    await closeServer(activeServer);
    activeServer = undefined;
  }
});

describe('POST /integrations/github/reconcile', () => {
  it('requires authentication and admin-or-owner role before any service call', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;

    const unauthenticated = await fetch(`${baseUrl}/integrations/github/reconcile`, { method: 'POST' });
    const member = await fetch(`${baseUrl}/integrations/github/reconcile`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await tokenFor(['member'])}` },
    });

    expect(unauthenticated.status).toBe(401);
    expect(member.status).toBe(403);
    expect(reconcileInstallationRepositories).not.toHaveBeenCalled();
  });

  it('an admin can trigger reconcile and receives the service result', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const token = await tokenFor(['admin']);

    const response = await fetch(`${baseUrl}/integrations/github/reconcile`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(reconcileResultFixture);
    expect(reconcileInstallationRepositories).toHaveBeenCalledWith(
      expect.objectContaining({ subjectType: 'user', orgId: ORG_A, roles: ['admin'] }),
    );
  });

  it('an owner (which outranks admin) can also trigger reconcile', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const token = await tokenFor(['owner']);

    const response = await fetch(`${baseUrl}/integrations/github/reconcile`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(200);
  });

  it('org identity comes only from the verified session token; a forged org header/query has no effect', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const token = await tokenFor(['admin']);

    await fetch(`${baseUrl}/integrations/github/reconcile?orgId=${ORG_B}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'x-org-id': ORG_B },
    });

    expect(reconcileInstallationRepositories).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG_A }),
    );
    expect(reconcileInstallationRepositories).not.toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG_B }),
    );
  });

  it('an admin of org A can only reconcile org A (cross-org isolation, symmetric with W2-06/W1-06 style)', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const tokenForOrgB = await tokenFor(['admin'], ORG_B);

    await fetch(`${baseUrl}/integrations/github/reconcile`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenForOrgB}` },
    });

    expect(reconcileInstallationRepositories).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG_B }),
    );
  });
});
