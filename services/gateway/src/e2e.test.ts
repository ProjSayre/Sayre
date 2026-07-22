// In-process end-to-end test: a real `ws` client talks to a real `ws` server
// wired through the exact building blocks server.ts composes
// (ConnectionRegistry + attachConnectionLifecycle + fanOutGraphUpdated), with
// a fake Core (`fetchDelta`) standing in for the real HTTP call. Redis/SQS are
// intentionally NOT started here — redis/pubsub.ts and sqs/consumer.ts are
// unit-tested on their own (their job is simply to hand an envelope to
// fanOutGraphUpdated, which is exercised directly below, exactly as
// server.ts's `bus.subscribe(...)` callback does).
//
// Proves AC1 (affected-nodes-only delta, well within the 15s target), AC2 (no
// cross-org leak), and AC3 (re-filtered on every push; an unauthorized push
// closes the connection).

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, WebSocket as WsClient } from 'ws';
import type { GraphUpdatedPayload, RealtimeGraphDelta } from '@sayre/shared-types';
import type { MessageEnvelope } from '@sayre/core';
import {
  attachConnectionLifecycle,
  ConnectionRegistry,
  createPendingConnection,
  type AttachConnectionDeps,
  type GatewayConnection,
} from './ws/connection';
import type { ConnectionIdentity } from './ws/auth';
import { fanOutGraphUpdated } from './fanout/fanout';
import { CoreUnauthorizedError } from './coreClient';

const IDENTITIES: Record<string, ConnectionIdentity> = {
  'tok-org-a': { orgId: 'org-a', roles: ['member'], userId: 'user-a', token: 'tok-org-a' },
  'tok-org-b': { orgId: 'org-b', roles: ['member'], userId: 'user-b', token: 'tok-org-b' },
};

async function fakeAuthenticate(token: string): Promise<ConnectionIdentity> {
  const identity = IDENTITIES[token];
  if (!identity) throw new Error('unknown test token');
  return identity;
}

interface TestServer {
  server: http.Server;
  wss: WebSocketServer;
  registry: ConnectionRegistry;
  url: string;
}

async function startTestServer(deps: AttachConnectionDeps = {}): Promise<TestServer> {
  const registry = new ConnectionRegistry();
  const server = http.createServer();
  const wss = new WebSocketServer({ server });

  wss.on('connection', (socket, req) => {
    const conn = createPendingConnection(randomUUID(), socket);
    attachConnectionLifecycle(conn, req, registry, {
      isDevOrTest: () => false, // force the explicit auth-frame path for per-connection identities
      authenticate: fakeAuthenticate,
      authTimeoutMs: 10_000,
      ...deps,
    });
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return { server, wss, registry, url: `ws://127.0.0.1:${port}` };
}

async function closeTestServer(t: TestServer): Promise<void> {
  await new Promise<void>((resolve) => t.wss.close(() => resolve()));
  await new Promise<void>((resolve) => t.server.close(() => resolve()));
}

function waitForMessage(client: WsClient): Promise<unknown> {
  return new Promise((resolve) => {
    client.once('message', (data) => resolve(JSON.parse(data.toString())));
  });
}

async function connectAndAuth(url: string, token: string, repoId: string): Promise<WsClient> {
  const client = new WsClient(url);
  await new Promise<void>((resolve) => client.once('open', resolve));
  const ready = waitForMessage(client);
  client.send(JSON.stringify({ type: 'auth', token }));
  expect(await ready).toEqual({ type: 'ready' });

  const subscribed = waitForMessage(client);
  client.send(JSON.stringify({ type: 'subscribe', repoId }));
  expect(await subscribed).toEqual({ type: 'subscribed', repoId });

  return client;
}

function envelope(orgId = 'org-a'): MessageEnvelope<GraphUpdatedPayload> {
  return {
    message_id: 'm1',
    idempotency_key: 'm1',
    org_id: orgId,
    type: 'graph.updated',
    schema_version: 1,
    occurred_at: new Date().toISOString(),
    source: 'ingestion-worker',
    graph_scope_key: 'repo-1:main',
    graph_version: 9,
    payload: {
      repository_id: 'repo-1',
      ref_name: 'refs/heads/main',
      revision_sha: 'abc123',
      full_rebuild: false,
      changed_paths: ['/src/index.ts'],
      structural_duration_ms: 900,
    },
  };
}

let activeServer: TestServer | undefined;
let activeClients: WsClient[] = [];

afterEach(async () => {
  for (const client of activeClients) client.close();
  activeClients = [];
  if (activeServer) {
    await closeTestServer(activeServer);
    activeServer = undefined;
  }
});

describe('gateway end-to-end (real ws client <-> gateway <-> fake Core)', () => {
  it('AC1: a subscribed client receives exactly one graph.delta with only the changed-path node(s), well within the 15s target', async () => {
    activeServer = await startTestServer();
    const client = await connectAndAuth(activeServer.url, 'tok-org-a', 'repo-1');
    activeClients.push(client);

    const fetchDelta = vi.fn(async (): Promise<RealtimeGraphDelta> => ({
      repoId: 'repo-1',
      graphVersion: 9,
      upserts: [{ id: 'file-index', label: 'File', name: 'index.ts', path: '/src/index.ts', parentId: 'folder-root' }],
      removals: [],
      resyncRequired: false,
    }));

    const started = Date.now();
    const received = waitForMessage(client);

    await fanOutGraphUpdated(envelope(), activeServer.registry, {
      fetchDelta,
      coreBaseUrl: 'http://core.internal:4000',
      onUnauthorized: vi.fn(),
    });

    const message = await received;
    const elapsedMs = Date.now() - started;

    expect(message).toEqual({
      type: 'graph.delta',
      repoId: 'repo-1',
      graphVersion: 9,
      upserts: [{ id: 'file-index', label: 'File', name: 'index.ts', path: '/src/index.ts', parentId: 'folder-root' }],
      removals: [],
    });
    expect(elapsedMs).toBeLessThan(2_000); // generous local headroom under the 15s structural target
  });

  it('AC2: an event for org A never reaches a client authenticated under org B, even subscribed to the same repo', async () => {
    activeServer = await startTestServer();
    const clientA = await connectAndAuth(activeServer.url, 'tok-org-a', 'repo-1');
    const clientB = await connectAndAuth(activeServer.url, 'tok-org-b', 'repo-1');
    activeClients.push(clientA, clientB);

    const fetchDelta = vi.fn(async (repoId: string): Promise<RealtimeGraphDelta> => {
      void repoId;
      return {
        repoId: 'repo-1',
        graphVersion: 9,
        upserts: [{ id: 'file-index', label: 'File', name: 'index.ts', path: '/src/index.ts', parentId: null }],
        removals: [],
        resyncRequired: false,
      };
    });

    const bReceivedNothing = vi.fn();
    clientB.once('message', bReceivedNothing);
    const aReceived = waitForMessage(clientA);

    await fanOutGraphUpdated(envelope('org-a'), activeServer.registry, {
      fetchDelta,
      coreBaseUrl: 'http://core.internal:4000',
      onUnauthorized: vi.fn(),
    });

    await aReceived;
    await new Promise((resolve) => setTimeout(resolve, 50)); // give clientB a chance to (wrongly) receive a frame

    expect(fetchDelta).toHaveBeenCalledTimes(1); // only org A's connection was even asked
    expect(bReceivedNothing).not.toHaveBeenCalled();
  });

  it('AC3: the Core authority is called once per event per matching connection, and a mid-stream CoreUnauthorizedError closes the socket without delivering a patch', async () => {
    activeServer = await startTestServer();
    const client = await connectAndAuth(activeServer.url, 'tok-org-a', 'repo-1');
    activeClients.push(client);

    const goodDelta: RealtimeGraphDelta = {
      repoId: 'repo-1',
      graphVersion: 1,
      upserts: [{ id: 'file-index', label: 'File', name: 'index.ts', path: '/src/index.ts', parentId: null }],
      removals: [],
      resyncRequired: false,
    };
    const fetchDelta = vi
      .fn()
      .mockResolvedValueOnce(goodDelta)
      .mockResolvedValueOnce(goodDelta)
      .mockRejectedValueOnce(new CoreUnauthorizedError());

    const onUnauthorized = vi.fn((conn: GatewayConnection) => conn.socket.close(4401, 'core rejected token'));
    const deps = { fetchDelta, coreBaseUrl: 'http://core.internal:4000', onUnauthorized };

    const first = waitForMessage(client);
    await fanOutGraphUpdated(envelope(), activeServer.registry, deps);
    await first;

    const second = waitForMessage(client);
    await fanOutGraphUpdated(envelope(), activeServer.registry, deps);
    await second;

    const closed = new Promise<void>((resolve) => client.once('close', () => resolve()));
    await fanOutGraphUpdated(envelope(), activeServer.registry, deps);
    await closed;

    expect(fetchDelta).toHaveBeenCalledTimes(3); // N events -> N authority calls for this connection
    expect(deps.onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('O-3 (existence-leak boundary): a delta with removals alongside upserts never reaches the real client as itemized data — only a generic graph.resync, over the actual wire', async () => {
    activeServer = await startTestServer();
    const client = await connectAndAuth(activeServer.url, 'tok-org-a', 'repo-1');
    activeClients.push(client);

    // Simulates what Core's stub returns today: a co-occurring upsert AND a
    // removal (the removed node's identifier is deliberately a value that
    // must NEVER appear anywhere on the wire the real client receives).
    const fetchDelta = vi.fn(async (): Promise<RealtimeGraphDelta> => ({
      repoId: 'repo-1',
      graphVersion: 9,
      upserts: [{ id: 'file-index', label: 'File', name: 'index.ts', path: '/src/index.ts', parentId: 'folder-root' }],
      removals: ['secret-hidden-node-id-the-client-was-never-authorized-to-see'],
      resyncRequired: false,
    }));

    const rawFrames: string[] = [];
    client.on('message', (data) => rawFrames.push(data.toString()));
    const received = waitForMessage(client);

    await fanOutGraphUpdated(envelope(), activeServer.registry, {
      fetchDelta,
      coreBaseUrl: 'http://core.internal:4000',
      onUnauthorized: vi.fn(),
    });

    const message = await received;
    // Give any additional (wrongly sent) frames a moment to arrive before asserting.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(message).toEqual({ type: 'graph.resync', repoId: 'repo-1', graphVersion: 9 });
    expect(rawFrames).toHaveLength(1); // exactly one frame -- no separate graph.delta with the upsert either
    for (const raw of rawFrames) {
      expect(raw).not.toContain('secret-hidden-node-id-the-client-was-never-authorized-to-see');
      expect(raw).not.toContain('removals');
      expect(raw).not.toContain('file-index'); // the co-occurring upsert is also withheld, not leaked
    }
  });

  it('a client subscribed to a different repo receives nothing for an event on another repo (same org)', async () => {
    activeServer = await startTestServer();
    const client = await connectAndAuth(activeServer.url, 'tok-org-a', 'repo-OTHER');
    activeClients.push(client);

    const fetchDelta = vi.fn(async (): Promise<RealtimeGraphDelta> => ({
      repoId: 'repo-1',
      graphVersion: 1,
      upserts: [],
      removals: [],
      resyncRequired: false,
    }));
    const gotMessage = vi.fn();
    client.once('message', gotMessage);

    await fanOutGraphUpdated(envelope(), activeServer.registry, {
      fetchDelta,
      coreBaseUrl: 'x',
      onUnauthorized: vi.fn(),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(fetchDelta).not.toHaveBeenCalled();
    expect(gotMessage).not.toHaveBeenCalled();
  });
});
