// HTTP-level tests for the Jira OAuth connect routes via a real createApp() +
// real HTTP server (matches routes/githubInstall.test.ts / routes/providerSettings.test.ts).
// Only the service layer is mocked. NODE_ENV is forced to 'production' so
// authenticate()'s dev-session fallback doesn't mask real 401s.

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
const SIGNING_KEY = 'jira-connect-route-test-signing-key';

const startJiraConnect = vi.fn(async () => ({
  redirectTo: 'https://auth.atlassian.test/authorize?state=signed',
}));
const handleJiraCallback = vi.fn(async () => ({ redirectTo: '/settings/integrations' }));
const getJiraConnectionStatus = vi.fn(async () => ({
  authorization: 'server-filtered' as const,
  connection: null,
  updatedAt: '2026-07-24T00:00:00.000Z',
}));
const disconnectJira = vi.fn(async () => ({
  authorization: 'server-filtered' as const,
  connection: null,
  updatedAt: '2026-07-24T00:00:00.000Z',
}));
const resolveConnectingUserLabel = vi.fn(async () => 'Alex Kwon');

vi.mock('../services/jiraConnectService', async () => {
  const actual = await vi.importActual<typeof import('../services/jiraConnectService')>(
    '../services/jiraConnectService',
  );
  return {
    ...actual,
    startJiraConnect: (...args: unknown[]) =>
      (startJiraConnect as unknown as (...a: unknown[]) => unknown)(...args),
    handleJiraCallback: (...args: unknown[]) =>
      (handleJiraCallback as unknown as (...a: unknown[]) => unknown)(...args),
    getJiraConnectionStatus: (...args: unknown[]) =>
      (getJiraConnectionStatus as unknown as (...a: unknown[]) => unknown)(...args),
    disconnectJira: (...args: unknown[]) =>
      (disconnectJira as unknown as (...a: unknown[]) => unknown)(...args),
    resolveConnectingUserLabel: (...args: unknown[]) =>
      (resolveConnectingUserLabel as unknown as (...a: unknown[]) => unknown)(...args),
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

async function tokenFor(orgId: string, roles: OrgRole[], userId = 'admin-a'): Promise<string> {
  return signSessionToken({ userId, orgId, roles });
}

let activeServer: Server | undefined;

beforeEach(() => {
  setConfigOverrideForTests('NODE_ENV', 'production');
  setSecretBackendForTests(async (ref) => {
    if (ref === 'env://JWT_SIGNING_KEY') return SIGNING_KEY;
    throw new Error(`unexpected secret reference: ${ref}`);
  });
  setConfigOverrideForTests('JIRA_POST_CONNECT_REDIRECT_URL', '/settings/integrations');
  startJiraConnect.mockClear();
  handleJiraCallback.mockClear();
  getJiraConnectionStatus.mockClear();
  disconnectJira.mockClear();
  resolveConnectingUserLabel.mockClear();
});

afterEach(async () => {
  resetSecretsForTests();
  resetConfigForTests();
  if (activeServer) {
    await closeServer(activeServer);
    activeServer = undefined;
  }
});

describe('GET /integrations/jira/connect — RBAC', () => {
  it('401s when unauthenticated (production NODE_ENV, no dev-session fallback)', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const res = await fetch(`${baseUrl}/integrations/jira/connect`, { redirect: 'manual' });
    expect(res.status).toBe(401);
    expect(startJiraConnect).not.toHaveBeenCalled();
  });

  it('403s for a member role', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const res = await fetch(`${baseUrl}/integrations/jira/connect`, {
      headers: { authorization: `Bearer ${await tokenFor(ORG_A, ['member'])}` },
      redirect: 'manual',
    });
    expect(res.status).toBe(403);
    expect(startJiraConnect).not.toHaveBeenCalled();
  });

  it('302s to the Atlassian authorize URL for an admin, using only the server-resolved org/user', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const res = await fetch(`${baseUrl}/integrations/jira/connect`, {
      headers: { authorization: `Bearer ${await tokenFor(ORG_A, ['admin'], 'user-42')}` },
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://auth.atlassian.test/authorize?state=signed');
    expect(startJiraConnect).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG_A, userId: 'user-42' }),
    );
  });

  it('302s to the Atlassian authorize URL for an owner role too', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const res = await fetch(`${baseUrl}/integrations/jira/connect`, {
      headers: { authorization: `Bearer ${await tokenFor(ORG_A, ['owner'])}` },
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
  });

  it('a forged ?orgId=attacker query param has no effect: only the verified session org is used', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    await fetch(`${baseUrl}/integrations/jira/connect?orgId=attacker-org`, {
      headers: { authorization: `Bearer ${await tokenFor(ORG_A, ['admin'])}` },
      redirect: 'manual',
    });
    expect(startJiraConnect).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG_A }));
    expect(startJiraConnect).not.toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 'attacker-org' }),
    );
  });
});

describe('GET /integrations/jira/status — RBAC', () => {
  it('401s when unauthenticated', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const res = await fetch(`${baseUrl}/integrations/jira/status`);
    expect(res.status).toBe(401);
    expect(getJiraConnectionStatus).not.toHaveBeenCalled();
  });

  it('403s for a member role', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const res = await fetch(`${baseUrl}/integrations/jira/status`, {
      headers: { authorization: `Bearer ${await tokenFor(ORG_A, ['member'])}` },
    });
    expect(res.status).toBe(403);
  });

  it('200s for an admin and uses only the server-resolved org, ignoring a query orgId', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const res = await fetch(`${baseUrl}/integrations/jira/status?orgId=${ORG_B}`, {
      headers: { authorization: `Bearer ${await tokenFor(ORG_A, ['admin'])}` },
    });
    expect(res.status).toBe(200);
    expect(getJiraConnectionStatus).toHaveBeenCalledWith({ orgId: ORG_A });
    expect(getJiraConnectionStatus).not.toHaveBeenCalledWith({ orgId: ORG_B });
  });
});

describe('POST /integrations/jira/disconnect — RBAC', () => {
  it('401s when unauthenticated', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const res = await fetch(`${baseUrl}/integrations/jira/disconnect`, { method: 'POST' });
    expect(res.status).toBe(401);
    expect(disconnectJira).not.toHaveBeenCalled();
  });

  it('403s for a member role', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const res = await fetch(`${baseUrl}/integrations/jira/disconnect`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await tokenFor(ORG_A, ['member'])}` },
    });
    expect(res.status).toBe(403);
  });

  it('200s for admin and revokes only the server-resolved org, ignoring a forged body org_id', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const res = await fetch(`${baseUrl}/integrations/jira/disconnect`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await tokenFor(ORG_A, ['admin'], 'user-42')}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ orgId: ORG_B, org_id: ORG_B }),
    });
    expect(res.status).toBe(200);
    expect(disconnectJira).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG_A, actorUserId: 'user-42' }),
    );
    expect(disconnectJira).not.toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG_B }),
    );
  });
});

describe('GET /integrations/jira/callback — unauthenticated by design, state-derived org/user only', () => {
  it('is reachable with NO Authorization header (unauthenticated by design)', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const res = await fetch(
      `${baseUrl}/integrations/jira/callback?code=abc&state=signed-state`,
      { redirect: 'manual' },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/settings/integrations');
    expect(handleJiraCallback).toHaveBeenCalledWith({
      code: 'abc',
      state: 'signed-state',
      error: undefined,
    });
  });

  it('duplicate query params (?code=a&code=b) -> clean 400, not a 500', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const res = await fetch(`${baseUrl}/integrations/jira/callback?code=a&code=b&state=x`, {
      redirect: 'manual',
    });
    expect(res.status).toBe(400);
    expect(handleJiraCallback).not.toHaveBeenCalled();
  });

  it('duplicate state query params (?state=a&state=b) -> clean 400, not a 500', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const res = await fetch(`${baseUrl}/integrations/jira/callback?code=abc&state=a&state=b`, {
      redirect: 'manual',
    });
    expect(res.status).toBe(400);
    expect(handleJiraCallback).not.toHaveBeenCalled();
  });

  it('propagates JiraCallbackBadRequestError as 400', async () => {
    const { JiraCallbackBadRequestError } = await import('../services/jiraConnectService');
    handleJiraCallback.mockRejectedValueOnce(new JiraCallbackBadRequestError());
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const res = await fetch(`${baseUrl}/integrations/jira/callback?code=abc&state=bad`, {
      redirect: 'manual',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'bad request' });
  });

  it('propagates JiraOAuthUpstreamError as 502', async () => {
    const { JiraOAuthUpstreamError } = await import('../services/jiraConnectService');
    handleJiraCallback.mockRejectedValueOnce(new JiraOAuthUpstreamError());
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const res = await fetch(`${baseUrl}/integrations/jira/callback?code=abc&state=x`, {
      redirect: 'manual',
    });
    expect(res.status).toBe(502);
  });

  it('a JiraSingleSiteRequiredError is caught BY THE ROUTE and redirected with ?jira_error=multiple_sites, not surfaced as a JSON 4xx/5xx', async () => {
    const { JiraSingleSiteRequiredError } = await import('../services/jiraConnectService');
    handleJiraCallback.mockRejectedValueOnce(
      new JiraSingleSiteRequiredError('Your Atlassian authorization granted access to multiple Jira sites'),
    );
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const res = await fetch(`${baseUrl}/integrations/jira/callback?code=abc&state=x`, {
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/settings/integrations?jira_error=multiple_sites');
  });

  it('an unexpected infra failure (e.g. JIRA_TOKEN_ENC_KEY missing during store.connect()) surfaces as a generic 500, never leaking internals', async () => {
    handleJiraCallback.mockRejectedValueOnce(new Error('Secret JIRA_TOKEN_ENC_KEY is missing.'));
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const res = await fetch(`${baseUrl}/integrations/jira/callback?code=abc&state=x`, {
      redirect: 'manual',
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: 'Internal server error' });
    expect(JSON.stringify(body)).not.toContain('JIRA_TOKEN_ENC_KEY');
  });

  it('forwards the Atlassian ?error= flag through untouched', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    await fetch(`${baseUrl}/integrations/jira/callback?error=access_denied&state=x`, {
      redirect: 'manual',
    });
    expect(handleJiraCallback).toHaveBeenCalledWith({
      code: undefined,
      state: 'x',
      error: 'access_denied',
    });
  });
});
