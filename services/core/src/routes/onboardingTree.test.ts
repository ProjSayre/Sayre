import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OnboardingGraphQueryService } from '../graph-query/types';
import { errorHandler } from '../http/express';
import type { OnboardingSandboxRunner } from '../services/onboardingSandboxService';
import { createOnboardingTreeRouter } from './onboardingTree';

const getOnboardingProjection = vi.fn(async () => ({
  revisionSha: 'a'.repeat(40),
  nodes: [{
    id: 'root',
    label: 'Folder' as const,
    name: 'fixture',
    path: '',
    parentId: null,
  }],
  steps: [{
    id: 'step-1',
    sequence: 0,
    command: 'printf graph-command',
    requires: [],
  }],
}));
const graph = { getOnboardingProjection } satisfies OnboardingGraphQueryService;
const run = vi.fn(async () => ({
  sandbox: 'container' as const,
  status: 'succeeded' as const,
  exitCode: 0,
  stdout: 'ok',
  stderr: '',
  durationMs: 3,
}));
const sandbox = { run } satisfies OnboardingSandboxRunner;

async function startServer() {
  const app = express();
  app.use(express.json());
  app.use(createOnboardingTreeRouter({ graph, sandbox }));
  app.use(errorHandler);
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
  getOnboardingProjection.mockClear();
  run.mockClear();
  if (activeServer) {
    await closeServer(activeServer);
    activeServer = undefined;
  }
});

describe('Onboarding Tree routes', () => {
  it('serves the default main-ref tree through the shared auth context', async () => {
    const started = await startServer();
    activeServer = started.server;

    const response = await fetch(`${started.baseUrl}/repos/repo-1/onboarding-tree`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      authorization: 'server-filtered',
      refName: 'refs/heads/main',
      visibleNodeCount: 1,
    });
    expect(getOnboardingProjection).toHaveBeenCalledWith(
      'repo-1',
      'refs/heads/main',
      expect.objectContaining({ subjectType: 'user' }),
    );
  });

  it('ignores request-body commands and runs the graph-resolved command', async () => {
    const started = await startServer();
    activeServer = started.server;

    const response = await fetch(
      `${started.baseUrl}/repos/repo-1/onboarding-steps/step-1/execute`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command: 'touch C:\\host-owned' }),
      },
    );

    expect(response.status).toBe(200);
    expect(run).toHaveBeenCalledWith('printf graph-command');
    expect(run).not.toHaveBeenCalledWith('touch C:\\host-owned');
  });
});
