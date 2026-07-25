// Full HTTP-through-app assertions for W1-03's authenticate()/authorize()
// wiring (spec.md Acceptance criteria 1-4, 6, 7). Real createApp() + real HTTP
// server (no supertest — matches routes/technicalTree.test.ts and
// routes/githubWebhook.test.ts). Only infra-touching collaborators (graph
// query, GitHub install service, DB installation lookup, queues) are mocked;
// JWT sign/verify runs for real against a fake secret backend.

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resetConfigForTests,
  resetSecretsForTests,
  setConfigOverrideForTests,
  setSecretBackendForTests,
} from '@sayre/config';
import type { GraphEdge, GraphNode } from '../graph-query/types';
import type { OrgRole } from '../auth/context';
import { signSessionToken } from '../auth/sessionToken';
import { signInstallState } from '../github/installState';

const SIGNING_KEY = 'integration-test-jwt-signing-key';
const WEBHOOK_SECRET = 'integration-test-webhook-secret';
const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

const getNodesInViewport = vi.fn(
  async (): Promise<GraphNode[]> => [
    { id: 'n1', label: 'Folder', name: 'root', path: '/root', parentId: null },
  ],
);
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

function signWebhook(body: Buffer, secret = WEBHOOK_SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

function pushBody(overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(
    JSON.stringify({
      installation: { id: 555 },
      repository: { id: 42, full_name: 'acme/widgets' },
      ref: 'refs/heads/main',
      before: 'a'.repeat(40),
      after: 'b'.repeat(40),
      forced: false,
      deleted: false,
      pusher: { name: 'octocat' },
      commits: [],
      ...overrides,
    }),
  );
}

async function tokenFor(orgId: string, roles: OrgRole[]): Promise<string> {
  return signSessionToken({ userId: 'user-1', orgId, roles });
}

let activeServer: Server | undefined;

beforeEach(() => {
  setSecretBackendForTests(async (ref) => {
    if (ref === 'env://JWT_SIGNING_KEY') return SIGNING_KEY;
    if (ref === 'env://GITHUB_WEBHOOK_SECRET') return WEBHOOK_SECRET;
    throw new Error(`unexpected secret ref in auth.integration.test: ${ref}`);
  });
  getNodesInViewport.mockClear();
  getStructuralEdges.mockClear();
  startGithubAppInstall.mockClear();
  handleGithubAppCallback.mockClear();
  resolveInstallationOrg.mockClear();
  publishIngestionEvent.mockClear();
  enqueue.mockClear();
});

afterEach(async () => {
  resetSecretsForTests();
  resetConfigForTests();
  if (activeServer) {
    await closeServer(activeServer);
    activeServer = undefined;
  }
});

describe('AC1: unauthenticated request rejected before any service runs', () => {
  it('GET /repos/:repoId/technical-tree with no Authorization in production returns 401, service never called', async () => {
    setConfigOverrideForTests('NODE_ENV', 'production');
    const { server, baseUrl } = await startServer();
    activeServer = server;

    const res = await fetch(`${baseUrl}/repos/repo-1/technical-tree?x=0&y=0&width=100&height=100`);

    expect(res.status).toBe(401);
    expect(getNodesInViewport).not.toHaveBeenCalled();
  });
});

describe('AC2: valid session flows the server-resolved org through', () => {
  it('a valid token for org A reaches the service with org A id, from the token only', async () => {
    setConfigOverrideForTests('NODE_ENV', 'production');
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const token = await tokenFor(ORG_A, ['member']);

    const res = await fetch(`${baseUrl}/repos/repo-1/technical-tree?x=0&y=0&width=100&height=100`, {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    expect(getNodesInViewport).toHaveBeenCalledWith(
      'repo-1',
      'refs/heads/main',
      expect.any(Object),
      expect.objectContaining({ orgId: ORG_A, userId: 'user-1' }),
    );
  });
});

describe('AC3: org A cannot reach org B data via client input', () => {
  it('token scoped to org A + ?orgId=B / x-org-id: B has no effect — service still called with org A', async () => {
    setConfigOverrideForTests('NODE_ENV', 'production');
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const token = await tokenFor(ORG_A, ['member']);

    const res = await fetch(
      `${baseUrl}/repos/repo-1/technical-tree?x=0&y=0&width=100&height=100&orgId=${ORG_B}`,
      { headers: { authorization: `Bearer ${token}`, 'x-org-id': ORG_B, 'x-user-id': 'attacker', 'x-roles': 'owner' } },
    );

    expect(res.status).toBe(200);
    expect(getNodesInViewport).toHaveBeenCalledWith(
      'repo-1',
      'refs/heads/main',
      expect.any(Object),
      expect.objectContaining({ orgId: ORG_A, userId: 'user-1', roles: ['member'] }),
    );
    const context = getNodesInViewport.mock.calls[0]?.[3] as { orgId: string };
    expect(context.orgId).not.toBe(ORG_B);
  });

  it('two back-to-back requests for org A and org B each reach the service with their own org, no bleed', async () => {
    setConfigOverrideForTests('NODE_ENV', 'production');
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const tokenA = await tokenFor(ORG_A, ['member']);
    const tokenB = await tokenFor(ORG_B, ['member']);

    await fetch(`${baseUrl}/repos/repo-1/technical-tree?x=0&y=0&width=100&height=100`, {
      headers: { authorization: `Bearer ${tokenA}` },
    });
    await fetch(`${baseUrl}/repos/repo-1/technical-tree?x=0&y=0&width=100&height=100`, {
      headers: { authorization: `Bearer ${tokenB}` },
    });

    expect(getNodesInViewport).toHaveBeenNthCalledWith(
      1,
      'repo-1',
      'refs/heads/main',
      expect.any(Object),
      expect.objectContaining({ orgId: ORG_A }),
    );
    expect(getNodesInViewport).toHaveBeenNthCalledWith(
      2,
      'repo-1',
      'refs/heads/main',
      expect.any(Object),
      expect.objectContaining({ orgId: ORG_B }),
    );
  });
});

describe('AC4: authorize gate works', () => {
  it('a member-role token is 403 on authorize("admin") (install-start) and 200 on authorize("member") (technical-tree)', async () => {
    setConfigOverrideForTests('NODE_ENV', 'production');
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const memberToken = await tokenFor(ORG_A, ['member']);

    const installRes = await fetch(`${baseUrl}/integrations/github/install`, {
      headers: { authorization: `Bearer ${memberToken}` },
      redirect: 'manual',
    });
    expect(installRes.status).toBe(403);
    expect(startGithubAppInstall).not.toHaveBeenCalled();

    const treeRes = await fetch(`${baseUrl}/repos/repo-1/technical-tree?x=0&y=0&width=100&height=100`, {
      headers: { authorization: `Bearer ${memberToken}` },
    });
    expect(treeRes.status).toBe(200);
  });

  it('an owner token passes both authorize("admin") and authorize("member") routes', async () => {
    setConfigOverrideForTests('NODE_ENV', 'production');
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const ownerToken = await tokenFor(ORG_A, ['owner']);

    const installRes = await fetch(`${baseUrl}/integrations/github/install`, {
      headers: { authorization: `Bearer ${ownerToken}` },
      redirect: 'manual',
    });
    expect(installRes.status).toBe(302);
    expect(startGithubAppInstall).toHaveBeenCalledWith({ orgId: ORG_A });

    const treeRes = await fetch(`${baseUrl}/repos/repo-1/technical-tree?x=0&y=0&width=100&height=100`, {
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(treeRes.status).toBe(200);
  });

  it('an admin token passes both routes', async () => {
    setConfigOverrideForTests('NODE_ENV', 'production');
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const adminToken = await tokenFor(ORG_A, ['admin']);

    const installRes = await fetch(`${baseUrl}/integrations/github/install`, {
      headers: { authorization: `Bearer ${adminToken}` },
      redirect: 'manual',
    });
    expect(installRes.status).toBe(302);

    const treeRes = await fetch(`${baseUrl}/repos/repo-1/technical-tree?x=0&y=0&width=100&height=100`, {
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(treeRes.status).toBe(200);
  });

  it('authorize("admin") with no Authorization header at all is 401, not 403', async () => {
    setConfigOverrideForTests('NODE_ENV', 'production');
    const { server, baseUrl } = await startServer();
    activeServer = server;

    const res = await fetch(`${baseUrl}/integrations/github/install`, { redirect: 'manual' });

    expect(res.status).toBe(401);
    expect(startGithubAppInstall).not.toHaveBeenCalled();
  });
});

describe('AC6: exempt surfaces unchanged', () => {
  it('POST /webhooks/github with a valid signature and no Authorization still succeeds (202)', async () => {
    setConfigOverrideForTests('NODE_ENV', 'production');
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const body = pushBody();

    const res = await fetch(`${baseUrl}/webhooks/github`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signWebhook(body),
        'x-github-event': 'push',
        'x-github-delivery': 'delivery-auth-integration-1',
      },
      body,
    });

    expect(res.status).toBe(202);
  });

  it('GET /integrations/github/callback with a valid signed state and no session still redirects (302), org from state', async () => {
    setConfigOverrideForTests('NODE_ENV', 'production');
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const state = await signInstallState(ORG_A);

    const res = await fetch(
      `${baseUrl}/integrations/github/callback?installation_id=555&setup_action=install&state=${state}`,
      { redirect: 'manual' },
    );

    expect(res.status).toBe(302);
    expect(handleGithubAppCallback).toHaveBeenCalledWith(
      expect.objectContaining({ installationId: '555', setupAction: 'install', state }),
    );
  });

  it('GET /health and GET / remain public in production, no Authorization needed', async () => {
    setConfigOverrideForTests('NODE_ENV', 'production');
    const { server, baseUrl } = await startServer();
    activeServer = server;

    const health = await fetch(`${baseUrl}/health`);
    const root = await fetch(`${baseUrl}/`);

    expect(health.status).toBeLessThan(400);
    expect(root.status).toBe(200);
  });
});

describe('AC7: token hygiene — uniform 401 for every malformed/invalid credential', () => {
  it('tampered signature -> 401', async () => {
    setConfigOverrideForTests('NODE_ENV', 'production');
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const token = await tokenFor(ORG_A, ['member']);
    const tampered = `${token.slice(0, -2)}${token.slice(-2) === 'aa' ? 'bb' : 'aa'}`;

    const res = await fetch(`${baseUrl}/repos/repo-1/technical-tree?x=0&y=0&width=100&height=100`, {
      headers: { authorization: `Bearer ${tampered}` },
    });

    expect(res.status).toBe(401);
  });

  it('an install-state token replayed as a session token -> 401', async () => {
    setConfigOverrideForTests('NODE_ENV', 'production');
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const installState = await signInstallState(ORG_A);

    const res = await fetch(`${baseUrl}/repos/repo-1/technical-tree?x=0&y=0&width=100&height=100`, {
      headers: { authorization: `Bearer ${installState}` },
    });

    expect(res.status).toBe(401);
  });

  it('a non-Bearer scheme -> 401', async () => {
    setConfigOverrideForTests('NODE_ENV', 'production');
    const { server, baseUrl } = await startServer();
    activeServer = server;

    const res = await fetch(`${baseUrl}/repos/repo-1/technical-tree?x=0&y=0&width=100&height=100`, {
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
    });

    expect(res.status).toBe(401);
  });

  it('none of the 401 bodies leak which check failed or any stack-trace-shaped content', async () => {
    setConfigOverrideForTests('NODE_ENV', 'production');
    const { server, baseUrl } = await startServer();
    activeServer = server;

    const res = await fetch(`${baseUrl}/repos/repo-1/technical-tree?x=0&y=0&width=100&height=100`);
    const body = (await res.json()) as { error: string };

    expect(res.status).toBe(401);
    expect(body).toEqual({ error: 'unauthorized' });
    expect(JSON.stringify(body)).not.toMatch(/at .*\(.*:\d+:\d+\)/);
  });
});

describe('dev/test fallback (regression: existing route tests keep working)', () => {
  it('no Authorization header, NODE_ENV=test: dev fallback context attached, request succeeds', async () => {
    // NODE_ENV is already "test" under vitest; no override needed here.
    const { server, baseUrl } = await startServer();
    activeServer = server;

    const res = await fetch(`${baseUrl}/repos/repo-1/technical-tree?x=0&y=0&width=100&height=100`);

    expect(res.status).toBe(200);
  });
});
