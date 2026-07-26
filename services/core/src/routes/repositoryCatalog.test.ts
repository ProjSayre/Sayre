import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resetConfigForTests,
  resetSecretsForTests,
  setConfigOverrideForTests,
  setSecretBackendForTests,
} from '@sayre/config';
import { signSessionToken } from '../auth/sessionToken';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const SIGNING_KEY = 'repository-catalog-route-signing-key';

const getRepositoryCatalog = vi.fn(async () => ({
  authorization: 'server-filtered' as const,
  repositories: [],
}));

vi.mock('../services/repositoryCatalogService', () => ({
  getRepositoryCatalog: (...args: unknown[]) =>
    (getRepositoryCatalog as unknown as (...values: unknown[]) => unknown)(
      ...args,
    ),
}));

import { createApp } from '../app';

let activeServer: Server | undefined;

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

beforeEach(() => {
  setConfigOverrideForTests('NODE_ENV', 'production');
  setSecretBackendForTests(async (ref) => {
    if (ref === 'env://JWT_SIGNING_KEY') return SIGNING_KEY;
    throw new Error('unexpected secret reference');
  });
  getRepositoryCatalog.mockClear();
});

afterEach(async () => {
  resetSecretsForTests();
  resetConfigForTests();
  if (activeServer) {
    await closeServer(activeServer);
    activeServer = undefined;
  }
});

describe('repository catalog HTTP route', () => {
  it('requires authentication before calling the service', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;

    const response = await fetch(`${baseUrl}/repositories`);

    expect(response.status).toBe(401);
    expect(getRepositoryCatalog).not.toHaveBeenCalled();
  });

  it('passes only signed context and ignores forged tenant inputs', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const token = await signSessionToken({
      userId: 'member-a',
      orgId: ORG_A,
      roles: ['member'],
    });

    const response = await fetch(
      `${baseUrl}/repositories?orgId=${ORG_B}`,
      {
        headers: {
          authorization: `Bearer ${token}`,
          'x-org-id': ORG_B,
        },
      },
    );

    expect(response.status).toBe(200);
    expect(getRepositoryCatalog).toHaveBeenCalledWith({
      subjectType: 'user',
      userId: 'member-a',
      orgId: ORG_A,
      roles: ['member'],
    });
  });
});
