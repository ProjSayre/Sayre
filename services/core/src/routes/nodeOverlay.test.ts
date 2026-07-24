import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getConfig } from '@sayre/config';
import type { NodeOverlayGraphSnapshot } from '../graph-query/types';

const snapshot: NodeOverlayGraphSnapshot = {
  node: {
    id: 'file-1',
    label: 'File',
    name: 'index.ts',
    path: '/src/index.ts',
    repositoryId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    refName: 'refs/heads/main',
    revisionSha: 'a'.repeat(40),
  },
  dependencies: [],
  recentChanges: [],
  features: [],
  description: 'Entrypoint.',
  tickets: [],
};

const graphMocks = vi.hoisted(() => ({
  getNodeOverlay: vi.fn(),
}));
const storeMocks = vi.hoisted(() => ({
  latest: vi.fn(async () => null),
  history: vi.fn(async () => []),
  append: vi.fn(async (input: { content: string; editorUserId: string }) => ({
    version: 1,
    content: input.content,
    editorUserId: input.editorUserId,
    editorLabel: 'Dev Owner',
    createdAt: '2026-07-24T00:00:00Z',
  })),
}));

graphMocks.getNodeOverlay.mockResolvedValue(snapshot);

vi.mock('../graph-query', () => ({
  graphQueryService: {
    getNodesInViewport: vi.fn(async () => []),
    getStructuralEdges: vi.fn(async () => []),
    getAffectedNodes: vi.fn(async () => ({ visible: [], removed: [] })),
    getFeatureClusters: vi.fn(async () => []),
    resolveStyleRules: vi.fn(async () => null),
    resolveRetrievalAnchors: vi.fn(async () => []),
    traverseRetrievalContext: vi.fn(async () => null),
    getNodeOverlay: (...args: unknown[]) =>
      (graphMocks.getNodeOverlay as unknown as (...values: unknown[]) => unknown)(...args),
  },
}));

vi.mock('../db/agentSkillMdStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/agentSkillMdStore')>();
  return {
    ...actual,
    agentSkillMdStore: storeMocks,
  };
});

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
  graphMocks.getNodeOverlay.mockClear();
  storeMocks.latest.mockClear();
  storeMocks.history.mockClear();
  storeMocks.append.mockClear();
  if (activeServer) {
    await closeServer(activeServer);
    activeServer = undefined;
  }
});

describe('node overlay routes', () => {
  it('returns all six layers using only the server-derived tenant context', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;

    const response = await fetch(
      `${baseUrl}/nodes/file-1/overlay?orgId=attacker`,
    );
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      authorization: 'server-filtered',
      dependencies: [],
      recentChanges: [],
      specificFeatures: [],
      agentSkillMd: null,
      description: 'Entrypoint.',
      specificTickets: [],
    });
    expect(graphMocks.getNodeOverlay).toHaveBeenCalledWith(
      'file-1',
      expect.objectContaining({
        orgId: getConfig('DEV_ORG_ID'),
        subjectType: 'user',
      }),
    );
    expect(graphMocks.getNodeOverlay.mock.calls[0]?.[1]).not.toMatchObject({
      orgId: 'attacker',
    });
  });

  it('validates and appends a new Agent/Skill MD version through the service', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const content = [
      '## Allowed Tools',
      'Read',
      '## Required Context',
      'Repository rules',
      '## Guardrails',
      'Stay within the tenant.',
    ].join('\n\n');

    const response = await fetch(
      `${baseUrl}/nodes/file-1/agent-skill-md`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content, expectedVersion: 0, orgId: 'attacker' }),
      },
    );
    const body = await response.json() as { document: { version: number } };

    expect(response.status).toBe(200);
    expect(body.document.version).toBe(1);
    expect(storeMocks.append).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedVersion: 0,
        editorUserId: getConfig('DEV_USER_ID'),
        scope: expect.objectContaining({ orgId: getConfig('DEV_ORG_ID') }),
      }),
    );
  });

  it('returns useful safe validation issues for malformed Markdown', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;

    const response = await fetch(
      `${baseUrl}/nodes/file-1/agent-skill-md`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: '# unstructured', expectedVersion: 0 }),
      },
    );
    const body = await response.json() as { error: string; issues: string[] };

    expect(response.status).toBe(400);
    expect(body.error).toBe('invalid Agent/Skill MD');
    expect(body.issues.join(' ')).toContain('Allowed Tools');
    expect(storeMocks.append).not.toHaveBeenCalled();
  });
});
