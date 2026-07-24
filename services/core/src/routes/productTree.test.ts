import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getConfig } from '@sayre/config';
import type { FeatureCluster } from '../graph-query/types';

const clusters: FeatureCluster[] = [{
  id: 'feature-checkout',
  name: 'Checkout',
  description: 'Completes checkout.',
  team: 'Commerce',
  revisionSha: 'a'.repeat(40),
  members: [{
    id: 'file-route',
    label: 'File',
    name: 'route.ts',
    path: '/src/route.ts',
    parentId: null,
    recentEdit: null,
  }],
}];

const getFeatureClusters = vi.fn(async (): Promise<FeatureCluster[]> => clusters);

vi.mock('../graph-query', () => ({
  graphQueryService: {
    getNodesInViewport: vi.fn(async () => []),
    getStructuralEdges: vi.fn(async () => []),
    getAffectedNodes: vi.fn(async () => ({ visible: [], removed: [] })),
    getFeatureClusters: (...args: unknown[]) =>
      (getFeatureClusters as unknown as (...values: unknown[]) => unknown)(...args),
  },
}));

import { createApp } from '../app';

async function startServer() {
  const server: Server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

let activeServer: Server | undefined;

afterEach(async () => {
  getFeatureClusters.mockClear();
  if (activeServer) {
    await closeServer(activeServer);
    activeServer = undefined;
  }
});

describe('GET /repos/:repoId/product-tree', () => {
  it('returns a server-filtered Product Tree and defaults to main', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;

    const response = await fetch(`${baseUrl}/repos/repo-1/product-tree`);
    const body = await response.json() as {
      authorization: string;
      visibleNodeCount: number;
      features: unknown[];
    };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      authorization: 'server-filtered',
      visibleNodeCount: 1,
    });
    expect(body.features).toHaveLength(1);
    expect(getFeatureClusters).toHaveBeenCalledWith(
      'repo-1',
      'refs/heads/main',
      expect.objectContaining({
        orgId: getConfig('DEV_ORG_ID'),
        subjectType: 'user',
      }),
    );
  });

  it('normalizes a selected branch and ignores client-supplied tenant identity', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;

    const response = await fetch(
      `${baseUrl}/repos/repo-1/product-tree?ref=release&orgId=attacker`,
    );

    expect(response.status).toBe(200);
    expect(getFeatureClusters).toHaveBeenCalledWith(
      'repo-1',
      'refs/heads/release',
      expect.objectContaining({ orgId: getConfig('DEV_ORG_ID') }),
    );
    const context = getFeatureClusters.mock.calls[0]?.[2] as { orgId: string };
    expect(context.orgId).not.toBe('attacker');
  });

  it('rejects blank or repeated ref selectors with a safe 400', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;

    const blank = await fetch(`${baseUrl}/repos/repo-1/product-tree?ref=`);
    expect(blank.status).toBe(400);
    await expect(blank.json()).resolves.toEqual({
      error: 'ref must be a non-blank Git ref',
    });

    const repeated = await fetch(
      `${baseUrl}/repos/repo-1/product-tree?ref=main&ref=release`,
    );
    expect(repeated.status).toBe(400);
    expect(getFeatureClusters).not.toHaveBeenCalled();
  });
});
