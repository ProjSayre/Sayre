// Full HTTP-through-app assertions for the AUTH-01 "Sign in with GitHub"
// routes (routes/login.ts + its errorHandler.ts mapping + app.ts mounting).
// Mirrors routes/auth.integration.test.ts's pattern: real createApp() + real
// HTTP server (no supertest), only infra-touching collaborators mocked.
//
// This file's value-add over loginService.test.ts (which is fully
// DI-mocked and never touches routes/login.ts, app.ts, or errorHandler.ts):
// it proves the wiring itself — that the router is actually mounted, that
// each of the four new error classes really does map to its documented HTTP
// status code end-to-end (not just "the errorHandler function returns X when
// called directly", which http/express.test.ts covers), and that a forged
// org_id/X-Org-Id never reaches the service layer even at the HTTP boundary
// (req.query/req.headers), not just within the already-mocked service.

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetConfigForTests, resetSecretsForTests, setSecretBackendForTests } from '@sayre/config';
import type { GraphEdge, GraphNode } from '../graph-query/types';

const getNodesInViewport = vi.fn(async (): Promise<GraphNode[]> => []);
const getStructuralEdges = vi.fn(async (): Promise<GraphEdge[]> => []);
vi.mock('../graph-query', () => ({
  graphQueryService: {
    getNodesInViewport: (...args: unknown[]) =>
      (getNodesInViewport as unknown as (...a: unknown[]) => unknown)(...args),
    getStructuralEdges: (...args: unknown[]) =>
      (getStructuralEdges as unknown as (...a: unknown[]) => unknown)(...args),
  },
}));

const startGithubAppInstall = vi.fn(async () => ({
  redirectTo: 'https://github.com/apps/sayre/installations/new?state=signed',
}));
const handleGithubAppCallback = vi.fn(async () => ({
  redirectTo: '/settings/integrations',
  enqueuedRepos: 1,
}));
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

const resolveInstallationOrg = vi.fn(async () => ({ orgId: 'org-webhook-1', active: true }));
const getRuntimeDb = vi.fn(async () => ({}) as never);
vi.mock('../db/installations', () => ({
  resolveInstallationOrg: (...args: unknown[]) =>
    (resolveInstallationOrg as unknown as (...a: unknown[]) => unknown)(...args),
  getRuntimeDb: (...args: unknown[]) => (getRuntimeDb as unknown as (...a: unknown[]) => unknown)(...args),
}));

const publishIngestionEvent = vi.fn(async () => 'sqs-message-id');
vi.mock('../queue/sqs', () => ({
  INGESTION_QUEUE: 'ingestion.fifo',
  publishIngestionEvent: (...args: unknown[]) =>
    (publishIngestionEvent as unknown as (...a: unknown[]) => unknown)(...args),
}));

const enqueue = vi.fn(async () => 'bullmq-job-id');
vi.mock('../queue/bullmq', () => ({
  QUEUE_NAMES: ['github-sync', 'jira-sync', 'linear-sync'],
  enqueue: (...args: unknown[]) => (enqueue as unknown as (...a: unknown[]) => unknown)(...args),
}));

// The router under test (routes/login.ts) imports startGithubLogin /
// handleGithubLoginCallback directly from services/loginService — mock the
// whole module so this file never touches real GitHub/Postgres, while still
// re-exporting the real error classes (needed so `instanceof` checks in
// errorHandler.ts keep working against errors these mocks throw).
const startGithubLogin = vi.fn(async () => ({
  redirectTo: 'https://github.test/login/oauth/authorize?client_id=x&state=y&scope=user%3Aemail',
}));
const handleGithubLoginCallback = vi.fn(async () => ({
  redirectTo: '/auth/complete#token=fake.jwt.token',
}));
vi.mock('../services/loginService', async () => {
  const actual = await vi.importActual<typeof import('../services/loginService')>(
    '../services/loginService',
  );
  return {
    ...actual,
    startGithubLogin: (...args: unknown[]) =>
      (startGithubLogin as unknown as (...a: unknown[]) => unknown)(...args),
    handleGithubLoginCallback: (...args: unknown[]) =>
      (handleGithubLoginCallback as unknown as (...a: unknown[]) => unknown)(...args),
  };
});

import { createApp } from '../app';
import { LoginCallbackBadRequestError } from '../services/loginService';
import { GithubOAuthApiError, GithubOAuthCodeError, NoVerifiedEmailError } from '../github/oauthClient';

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

beforeEach(() => {
  setSecretBackendForTests(async (ref) => {
    throw new Error(`unexpected secret ref in login.integration.test: ${ref}`);
  });
  getNodesInViewport.mockClear();
  getStructuralEdges.mockClear();
  startGithubAppInstall.mockClear();
  handleGithubAppCallback.mockClear();
  resolveInstallationOrg.mockClear();
  publishIngestionEvent.mockClear();
  enqueue.mockClear();
  startGithubLogin.mockClear();
  handleGithubLoginCallback.mockClear();
});

afterEach(async () => {
  resetSecretsForTests();
  resetConfigForTests();
  if (activeServer) {
    await closeServer(activeServer);
    activeServer = undefined;
  }
});

describe('GET /auth/github/login', () => {
  it('is mounted, unauthenticated, and 302s to the service-built GitHub authorize URL', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;

    const res = await fetch(`${baseUrl}/auth/github/login`, { redirect: 'manual' });

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      'https://github.test/login/oauth/authorize?client_id=x&state=y&scope=user%3Aemail',
    );
    expect(startGithubLogin).toHaveBeenCalledWith({ redirectTo: undefined });
  });

  it('passes redirect_to through from the query string', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;

    await fetch(`${baseUrl}/auth/github/login?redirect_to=%2Fdashboard`, { redirect: 'manual' });

    expect(startGithubLogin).toHaveBeenCalledWith({ redirectTo: '/dashboard' });
  });

  it('requires no Authorization header at all (this IS the entry point)', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;

    const res = await fetch(`${baseUrl}/auth/github/login`, { redirect: 'manual' });

    expect(res.status).toBe(302);
  });
});

describe('GET /auth/github/callback', () => {
  it('302s to the service-built completion redirect on success', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;

    const res = await fetch(`${baseUrl}/auth/github/callback?code=abc&state=xyz`, {
      redirect: 'manual',
    });

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/auth/complete#token=fake.jwt.token');
    expect(handleGithubLoginCallback).toHaveBeenCalledWith({ code: 'abc', state: 'xyz' });
  });

  it('never reads a forged org_id from the query string, body-shaped params, or X-Org-Id header', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;

    await fetch(
      `${baseUrl}/auth/github/callback?code=abc&state=xyz&org_id=attacker-org&X-Org-Id=attacker-org`,
      { headers: { 'X-Org-Id': 'attacker-org' }, redirect: 'manual' },
    );

    // routes/login.ts destructures ONLY { code, state } off req.query — an
    // org_id-shaped query param must never reach the service call.
    expect(handleGithubLoginCallback).toHaveBeenCalledWith({ code: 'abc', state: 'xyz' });
    expect(handleGithubLoginCallback).not.toHaveBeenCalledWith(
      expect.objectContaining({ org_id: expect.anything() }),
    );
  });

  it.each([
    ['LoginCallbackBadRequestError', new LoginCallbackBadRequestError('bad state'), 400, { error: 'bad request' }],
    ['GithubOAuthCodeError', new GithubOAuthCodeError(), 400, { error: 'bad request' }],
    [
      'NoVerifiedEmailError',
      new NoVerifiedEmailError(),
      422,
      { error: 'no usable verified email on the GitHub account' },
    ],
    [
      'GithubOAuthApiError',
      new GithubOAuthApiError('transport failure detail: 10.0.0.9 refused'),
      502,
      { error: 'GitHub authentication request failed' },
    ],
  ] as const)('maps a thrown %s to %i end-to-end through errorHandler', async (_name, error, status, body) => {
    handleGithubLoginCallback.mockRejectedValueOnce(error);
    const { server, baseUrl } = await startServer();
    activeServer = server;

    const res = await fetch(`${baseUrl}/auth/github/callback?code=abc&state=xyz`, {
      redirect: 'manual',
    });

    expect(res.status).toBe(status);
    await expect(res.json()).resolves.toEqual(body);
  });

  it('a 502 body never leaks the underlying transport error detail', async () => {
    handleGithubLoginCallback.mockRejectedValueOnce(
      new GithubOAuthApiError('ECONNREFUSED 10.0.0.9:443 (internal)'),
    );
    const { server, baseUrl } = await startServer();
    activeServer = server;

    const res = await fetch(`${baseUrl}/auth/github/callback?code=abc&state=xyz`, {
      redirect: 'manual',
    });
    const text = await res.text();

    expect(text).not.toContain('10.0.0.9');
    expect(text).not.toContain('ECONNREFUSED');
  });
});
