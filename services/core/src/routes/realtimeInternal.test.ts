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

// CH-05: the same singleton now also carries the narrow citation-authorization
// method the new internal chat-authorization route reaches through the service
// layer. Additive — every pre-existing case below is untouched (AC-10).
const getAuthorizedNodeIds = vi.fn(async (): Promise<string[]> => ['file-login']);

vi.mock('../graph-query', () => ({
  graphQueryService: {
    getNodesInViewport: async () => [],
    getStructuralEdges: async () => [],
    getAffectedNodes: (...args: unknown[]) =>
      (getAffectedNodes as unknown as (...a: unknown[]) => unknown)(...args),
    getAuthorizedNodeIds: (...args: unknown[]) =>
      (getAuthorizedNodeIds as unknown as (...a: unknown[]) => unknown)(...args),
  },
}));

// CH-05: the chat-authorization route reaches Postgres through chatService's
// ChatStore for the owner check. Mocked here for the same reason
// routes/chat.test.ts mocks it — no live database in a unit test.
const getConversation = vi.fn(async () => ({
  conversation: {
    id: '44444444-4444-4444-8444-444444444444',
    title: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:05:00.000Z',
  },
  turns: [],
}));

vi.mock('../db/chatStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/chatStore')>();
  return {
    ...actual,
    chatStore: {
      createConversation: vi.fn(),
      listConversations: vi.fn(),
      getConversation: (...args: unknown[]) =>
        (getConversation as unknown as (...a: unknown[]) => unknown)(...args),
      appendTurnPair: vi.fn(),
      markTurnDispatched: vi.fn(),
    },
  };
});

import { createApp } from '../app';

const CONVERSATION_ID = '44444444-4444-4444-8444-444444444444';

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
  getAuthorizedNodeIds.mockClear();
  getConversation.mockClear();
  getConversation.mockImplementation(async () => ({
    conversation: {
      id: CONVERSATION_ID,
      title: null,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:05:00.000Z',
    },
    turns: [],
  }));
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

// ---------------------------------------------------------------------------
// CH-05 — POST /internal/realtime/chat-authorization. Authored by `red` from
// .pipeline/spec.md before any implementation exists. Every case above this
// line predates CH-05 and must keep passing untouched (AC-10).
// ---------------------------------------------------------------------------

async function postChatAuthorization(baseUrl: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/internal/realtime/chat-authorization`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /internal/realtime/chat-authorization (HTTP)', () => {
  // @spec AC-11
  it('AC-11: the conversation owner gets 200 with { conversationId, authorizedNodeIds }', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;

    const res = await postChatAuthorization(baseUrl, {
      conversationId: CONVERSATION_ID,
      nodeIds: ['file-login', 'file-secret'],
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { conversationId: string; authorizedNodeIds: string[] };
    expect(body).toEqual({ conversationId: CONVERSATION_ID, authorizedNodeIds: ['file-login'] });
    expect(getAuthorizedNodeIds).toHaveBeenCalledTimes(1);
  });

  // @spec AC-11 EC-8
  it('AC-11/EC-8: a nonexistent conversation and one owned by another user both return an INDISTINGUISHABLE 404', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    getConversation.mockImplementation(async () => null as never);

    const absent = await postChatAuthorization(baseUrl, {
      conversationId: CONVERSATION_ID,
      nodeIds: ['file-login'],
    });
    const unowned = await postChatAuthorization(baseUrl, {
      conversationId: '77777777-7777-4777-8777-777777777777',
      nodeIds: ['file-login'],
    });

    expect(absent.status).toBe(404);
    expect(unowned.status).toBe(404);
    expect(absent.headers.get('content-type')).toMatch(/application\/json/);
    expect(await absent.json()).toEqual(await unowned.json());
    expect(getAuthorizedNodeIds).not.toHaveBeenCalled();
  });

  // @spec AC-11
  it('AC-11: a malformed body returns 400 with a safe { error } body and no stack trace', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;

    const missingConversation = await postChatAuthorization(baseUrl, { nodeIds: [] });
    expect(missingConversation.status).toBe(400);
    const body = (await missingConversation.json()) as { error: string };
    expect(body.error).toMatch(/conversationId/i);
    expect(JSON.stringify(body)).not.toMatch(/at .*\(.*:\d+:\d+\)/);

    const badNodeIds = await postChatAuthorization(baseUrl, {
      conversationId: CONVERSATION_ID,
      nodeIds: 'file-login',
    });
    expect(badNodeIds.status).toBe(400);

    const tooManyNodeIds = await postChatAuthorization(baseUrl, {
      conversationId: CONVERSATION_ID,
      nodeIds: Array.from({ length: 65 }, (_unused, index) => `n-${index}`),
    });
    expect(tooManyNodeIds.status).toBe(400);
  });

  // @spec AC-8 AC-11
  it('AC-8/AC-11: client-supplied org_id / orgId / userId body fields have NO effect on the server-derived auth context', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const expectedOrgId = getConfig('DEV_ORG_ID');

    const res = await postChatAuthorization(baseUrl, {
      conversationId: CONVERSATION_ID,
      nodeIds: ['file-login'],
      org_id: 'attacker-org',
      orgId: 'attacker-org',
      userId: 'attacker-user',
    });

    expect(res.status).toBe(200);
    expect(getAuthorizedNodeIds).toHaveBeenCalledWith(
      ['file-login'],
      expect.objectContaining({ orgId: expectedOrgId, subjectType: 'user' }),
    );
    const context = getAuthorizedNodeIds.mock.calls[0]?.[1] as { orgId: string };
    expect(context.orgId).not.toBe('attacker-org');

    const owner = getConversation.mock.calls[0]?.[0] as { orgId: string; userId: string };
    expect(owner.orgId).toBe(expectedOrgId);
    expect(owner.userId).not.toBe('attacker-user');
  });

  // @spec EC-28
  it('EC-28: an empty nodeIds list still runs the ownership check and returns [] without a graph query', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;

    const res = await postChatAuthorization(baseUrl, { conversationId: CONVERSATION_ID, nodeIds: [] });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ conversationId: CONVERSATION_ID, authorizedNodeIds: [] });
    expect(getConversation).toHaveBeenCalledTimes(1);
    expect(getAuthorizedNodeIds).not.toHaveBeenCalled();
  });
});
