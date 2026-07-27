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
const SIGNING_KEY = 'github-integration-status-route-signing-key';

const getGitHubIntegrationStatus = vi.fn(async () => ({
  authorization: 'server-filtered' as const,
  installations: [],
  repositories: [],
  updatedAt: '2026-07-26T16:00:00.000Z',
}));

vi.mock('../services/githubIntegrationStatusService', () => ({
  getGitHubIntegrationStatus: (...args: unknown[]) =>
    (getGitHubIntegrationStatus as unknown as (
      ...values: unknown[]
    ) => unknown)(...args),
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
  getGitHubIntegrationStatus.mockClear();
});

afterEach(async () => {
  resetSecretsForTests();
  resetConfigForTests();
  if (activeServer) {
    await closeServer(activeServer);
    activeServer = undefined;
  }
});

describe('GitHub integration status HTTP authorization', () => {
  it('requires authentication and an administrator role', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const memberToken = await signSessionToken({
      userId: 'member-a',
      orgId: ORG_A,
      roles: ['member'],
    });

    const unauthenticated = await fetch(
      `${baseUrl}/integrations/github/status`,
    );
    const member = await fetch(`${baseUrl}/integrations/github/status`, {
      headers: { authorization: `Bearer ${memberToken}` },
    });

    expect(unauthenticated.status).toBe(401);
    expect(member.status).toBe(403);
    expect(getGitHubIntegrationStatus).not.toHaveBeenCalled();
  });

  it('passes only the signed tenant to the status service', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const ownerToken = await signSessionToken({
      userId: 'owner-a',
      orgId: ORG_A,
      roles: ['owner'],
    });

    const response = await fetch(
      `${baseUrl}/integrations/github/status?orgId=${ORG_B}`,
      {
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-org-id': ORG_B,
        },
      },
    );

    expect(response.status).toBe(200);
    expect(getGitHubIntegrationStatus).toHaveBeenCalledWith(ORG_A);
    expect(getGitHubIntegrationStatus).not.toHaveBeenCalledWith(ORG_B);
  });
});
