// HTTP-level tests for the GitHub App install routes via a real createApp() +
// real HTTP server (no supertest — matches routes/technicalTree.test.ts and
// routes/githubWebhook.test.ts). Only the service layer is mocked.

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getConfig } from '@sayre/config';

const startGithubAppInstall = vi.fn(async () => ({ redirectTo: 'https://github.com/apps/sayre/installations/new?state=signed' }));
const handleGithubAppCallback = vi.fn(async () => ({ redirectTo: '/settings/integrations', enqueuedRepos: 1 }));

vi.mock('../services/githubAppInstallService', async () => {
  const actual = await vi.importActual<typeof import('../services/githubAppInstallService')>(
    '../services/githubAppInstallService',
  );
  return {
    ...actual,
    startGithubAppInstall: (...args: unknown[]) =>
      (startGithubAppInstall as unknown as (...a: unknown[]) => unknown)(...args),
    handleGithubAppCallback: (...args: unknown[]) =>
      (handleGithubAppCallback as unknown as (...a: unknown[]) => unknown)(...args),
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

let activeServer: Server | undefined;

afterEach(async () => {
  startGithubAppInstall.mockClear();
  handleGithubAppCallback.mockClear();
  if (activeServer) {
    await closeServer(activeServer);
    activeServer = undefined;
  }
});

describe('GET /integrations/github/install', () => {
  it('redirects 302 to the URL returned by startGithubAppInstall, using the server-side org id', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const expectedOrgId = getConfig('DEV_ORG_ID');

    const res = await fetch(`${baseUrl}/integrations/github/install`, { redirect: 'manual' });

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      'https://github.com/apps/sayre/installations/new?state=signed',
    );
    expect(startGithubAppInstall).toHaveBeenCalledWith({ orgId: expectedOrgId });
  });

  it('a client-supplied ?orgId=attacker has no effect: only the server-side tenant context is used', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const expectedOrgId = getConfig('DEV_ORG_ID');

    await fetch(`${baseUrl}/integrations/github/install?orgId=attacker`, { redirect: 'manual' });

    expect(startGithubAppInstall).toHaveBeenCalledWith({ orgId: expectedOrgId });
    expect(startGithubAppInstall).not.toHaveBeenCalledWith({ orgId: 'attacker' });
  });
});

describe('GET /integrations/github/callback', () => {
  it('redirects 302 to the URL returned by handleGithubAppCallback, forwarding query params', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;

    const res = await fetch(
      `${baseUrl}/integrations/github/callback?installation_id=555&setup_action=install&state=signed-state`,
      { redirect: 'manual' },
    );

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/settings/integrations');
    expect(handleGithubAppCallback).toHaveBeenCalledWith({
      installationId: '555',
      setupAction: 'install',
      state: 'signed-state',
      code: undefined,
    });
  });

  it('propagates a typed service error to the mapped HTTP status (400 for InstallCallbackBadRequestError)', async () => {
    const { InstallCallbackBadRequestError } = await import('../services/githubAppInstallService');
    handleGithubAppCallback.mockRejectedValueOnce(new InstallCallbackBadRequestError());
    const { server, baseUrl } = await startServer();
    activeServer = server;

    const res = await fetch(`${baseUrl}/integrations/github/callback`, { redirect: 'manual' });

    expect(res.status).toBe(400);
  });

  it('propagates InstallationOrgConflictError as 409', async () => {
    const { InstallationOrgConflictError } = await import('../services/githubAppInstallService');
    handleGithubAppCallback.mockRejectedValueOnce(new InstallationOrgConflictError());
    const { server, baseUrl } = await startServer();
    activeServer = server;

    const res = await fetch(`${baseUrl}/integrations/github/callback?installation_id=555&state=x`, {
      redirect: 'manual',
    });

    expect(res.status).toBe(409);
  });

  it('propagates GithubApiError as 502', async () => {
    const { GithubApiError } = await import('../services/githubAppInstallService');
    handleGithubAppCallback.mockRejectedValueOnce(new GithubApiError('boom'));
    const { server, baseUrl } = await startServer();
    activeServer = server;

    const res = await fetch(`${baseUrl}/integrations/github/callback?installation_id=555&state=x`, {
      redirect: 'manual',
    });

    expect(res.status).toBe(502);
  });
});
