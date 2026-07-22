import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getConfig } from '@sayre/config';
import type { AffectedNodes, GraphNode } from '../graph-query/types';

// Spy on the graph-query singleton so we can assert exactly what auth context reaches
// it through the full HTTP -> route -> service -> graph-query path (mirrors
// ../routes/technicalTree.test.ts's approach — no supertest dependency).
const getAffectedNodes = vi.fn(
  async (): Promise<AffectedNodes> => ({
    visible: [{ id: 'n1', label: 'Folder', name: 'root', path: '/root', parentId: null }],
    removed: [],
  }),
);

vi.mock('../graph-query', () => ({
  graphQueryService: {
    getNodesInViewport: async () => [],
    getStructuralEdges: async () => [],
    getAffectedNodes: (...args: unknown[]) =>
      (getAffectedNodes as unknown as (...a: unknown[]) => unknown)(...args),
  },
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

let activeServer: Server | undefined;

afterEach(async () => {
  getAffectedNodes.mockClear();
  if (activeServer) {
    await closeServer(activeServer);
    activeServer = undefined;
  }
});

describe('POST /internal/realtime/graph-delta (HTTP)', () => {
  it('happy path: valid body returns 200 with a RealtimeGraphDelta', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;

    const res = await fetch(`${baseUrl}/internal/realtime/graph-delta`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repoId: 'repo-1',
        changedPaths: ['/root'],
        fullRebuild: false,
        graphVersion: 2,
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      repoId: string;
      graphVersion: number;
      upserts: GraphNode[];
      removals: string[];
      resyncRequired: boolean;
    };
    expect(body.repoId).toBe('repo-1');
    expect(body.graphVersion).toBe(2);
    expect(body.resyncRequired).toBe(false);
    expect(body.upserts).toHaveLength(1);
  });

  it('full_rebuild=true returns resyncRequired: true with no granular delta (AC6)', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;

    const res = await fetch(`${baseUrl}/internal/realtime/graph-delta`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repoId: 'repo-1',
        changedPaths: ['/root'],
        fullRebuild: true,
        graphVersion: 9,
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { resyncRequired: boolean; upserts: unknown[]; removals: unknown[] };
    expect(body.resyncRequired).toBe(true);
    expect(body.upserts).toEqual([]);
    expect(body.removals).toEqual([]);
    expect(getAffectedNodes).not.toHaveBeenCalled();
  });

  it('malformed body (missing repoId) returns 400 with a safe { error } body', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;

    const res = await fetch(`${baseUrl}/internal/realtime/graph-delta`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ changedPaths: [], fullRebuild: false, graphVersion: 0 }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/repoId/);
    expect(JSON.stringify(body)).not.toMatch(/at .*\(.*:\d+:\d+\)/);
  });

  it('AC5 isolation regression: client-supplied org ids have no effect on the server-derived auth context', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const expectedOrgId = getConfig('DEV_ORG_ID');

    const res = await fetch(`${baseUrl}/internal/realtime/graph-delta`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repoId: 'repo-1',
        changedPaths: ['/root'],
        fullRebuild: false,
        graphVersion: 0,
        org_id: 'attacker-org',
        orgId: 'attacker-org',
      }),
    });

    expect(res.status).toBe(200);
    expect(getAffectedNodes).toHaveBeenCalledWith(
      'repo-1',
      ['/root'],
      expect.objectContaining({ orgId: expectedOrgId, subjectType: 'user' }),
    );
    const context = getAffectedNodes.mock.calls[0]?.[2] as { orgId: string };
    expect(context.orgId).not.toBe('attacker-org');
  });
});
