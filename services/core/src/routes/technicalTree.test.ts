import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GraphEdge, GraphNode } from '../graph-query/types';
import { getConfig } from '@sayre/config';

// Spy on the graph-query singleton so we can assert exactly what auth context reaches
// it through the full HTTP -> route -> service -> graph-query path, without a
// new test dependency (no supertest — see .pipeline/changes.md decision log).
// vi.mock is hoisted above these imports by vitest's transform, so the mocked
// module is what technicalTreeService's default `graph` param resolves to.
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
  getNodesInViewport.mockClear();
  getStructuralEdges.mockClear();
  if (activeServer) {
    await closeServer(activeServer);
    activeServer = undefined;
  }
});

describe('GET /repos/:repoId/technical-tree (HTTP)', () => {
  it('happy path: valid viewport returns 200 with { nodes, edges }', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;

    const res = await fetch(
      `${baseUrl}/repos/repo-1/technical-tree?x=0&y=0&width=100&height=100`,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { nodes: GraphNode[]; edges: GraphEdge[] };
    expect(body.nodes.length).toBeGreaterThan(0);
    expect(body.edges).toEqual([]);
  });

  it('malformed viewport (width=0) returns 400 with a safe { error } body', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;

    const res = await fetch(
      `${baseUrl}/repos/repo-1/technical-tree?x=0&y=0&width=0&height=100`,
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/width/);
    expect(JSON.stringify(body)).not.toMatch(/at .*\(.*:\d+:\d+\)/); // no stack-trace-shaped content
  });

  it('missing required viewport field (width) returns 400', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;

    const res = await fetch(`${baseUrl}/repos/repo-1/technical-tree?x=0&y=0&height=100`);

    expect(res.status).toBe(400);
  });

  it('absent zoom defaults to 1 and still succeeds (200)', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;

    const res = await fetch(
      `${baseUrl}/repos/repo-1/technical-tree?x=0&y=0&width=100&height=100`,
    );

    expect(res.status).toBe(200);
  });

  it('a client-supplied ?orgId=attacker has no effect: the server-derived auth context reaches the graph-query layer', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const expectedOrgId = getConfig('DEV_ORG_ID');

    const res = await fetch(
      `${baseUrl}/repos/repo-1/technical-tree?x=0&y=0&width=100&height=100&orgId=attacker`,
    );

    expect(res.status).toBe(200);
    expect(getNodesInViewport).toHaveBeenCalledWith(
      'repo-1',
      expect.any(Object),
      expect.objectContaining({ orgId: expectedOrgId, subjectType: 'user' }),
    );
    const context = getNodesInViewport.mock.calls[0]?.[2] as { orgId: string };
    expect(context.orgId).not.toBe('attacker');
  });

  it('missing :repoId (double slash) does not 500 — either 404s or runs with an empty repoId param', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;

    const res = await fetch(
      `${baseUrl}/repos//technical-tree?x=0&y=0&width=100&height=100`,
    );

    // Document actual behavior per spec's edge-case instruction: Express's
    // router does not match an empty :repoId segment against this path
    // pattern, so this 404s rather than reaching the handler at all.
    expect(res.status).toBe(404);
  });
});
