// CH-05 — in-process end-to-end: a real `ws` client talks to a real `ws` server
// wired through the exact building blocks server.ts composes (ConnectionRegistry
// + attachConnectionLifecycle + createChatEventBus + relayChatEvent), with a
// fake Core (`authorizePush` / `authorizeChatSubscription`) and the FakeRedis
// fixture standing in for the real connections. Authored by `red` from
// .pipeline/spec.md before any implementation exists.
//
// Deliberate strengthening of spec.md's "in-memory fake chat bus" note: this
// file drives the REAL createChatEventBus over an injected FakeRedis rather
// than a hand-written in-memory bus, because AC-1's ordering guarantee lives
// in the bus's per-channel dispatch. A hand-written fake would supply its own
// ordering and make AC-1's assertion vacuous. No live Redis is started either
// way — the factory is injected, exactly as ./redis/pubsub.test.ts does.

import http from 'node:http';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, WebSocket as WsClient } from 'ws';
import { resetConfigForTests, setConfigOverrideForTests } from '@sayre/config';
import {
  attachConnectionLifecycle,
  ConnectionRegistry,
  createPendingConnection,
  UNAUTHENTICATED_CLOSE_CODE,
  type GatewayConnection,
} from './ws/connection';
import type { ConnectionIdentity } from './ws/auth';
import { chatEventChannel } from './ws/chatEvents';
import { createChatEventBus, type ChatEventBus } from './redis/chatPubsub';
import type { RedisConnectionFactory } from './redis/pubsub';
import { relayChatEvent } from './fanout/chatFanout';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '99999999-9999-4999-8999-999999999999';
const CONVERSATION_ID = '44444444-4444-4444-8444-444444444444';
const TURN_ID = '66666666-6666-4666-8666-666666666666';
const TS = '2026-08-11T00:00:00.000000Z';

const CHANNEL_A = `sayre:chat.events:${ORG_A}:${CONVERSATION_ID}`;

const IDENTITIES: Record<string, ConnectionIdentity> = {
  'tok-owner': { orgId: ORG_A, roles: ['member'], userId: 'user-owner', token: 'tok-owner' },
  'tok-owner-tab2': { orgId: ORG_A, roles: ['member'], userId: 'user-owner', token: 'tok-owner-tab2' },
  'tok-teammate': { orgId: ORG_A, roles: ['member'], userId: 'user-teammate', token: 'tok-teammate' },
  'tok-other-org': { orgId: ORG_B, roles: ['member'], userId: 'user-elsewhere', token: 'tok-other-org' },
};

async function fakeAuthenticate(token: string): Promise<ConnectionIdentity> {
  const identity = IDENTITIES[token];
  if (!identity) throw new Error('unknown test token');
  return identity;
}

class FakeRedis extends EventEmitter {
  subscribeCalls: string[] = [];
  unsubscribeCalls: string[] = [];
  quit = vi.fn(async () => 'OK');

  async subscribe(channel: string): Promise<number> {
    this.subscribeCalls.push(channel);
    return this.subscribeCalls.length;
  }

  async unsubscribe(channel: string): Promise<number> {
    this.unsubscribeCalls.push(channel);
    return 0;
  }

  async publish(): Promise<number> {
    return 1;
  }
}

function progressJson(seq: number, orgId = ORG_A): string {
  return JSON.stringify({
    message_id: `m-progress-${seq}`,
    idempotency_key: `chat.turn.progress:${TURN_ID}:${seq}`,
    org_id: orgId,
    type: 'chat.turn.progress',
    schema_version: 1,
    occurred_at: TS,
    source: 'sayre-chat-worker',
    payload: {
      conversationId: CONVERSATION_ID,
      turnId: TURN_ID,
      seq,
      kind: 'status',
      tool: null,
      detail: `step ${seq}`,
      ts: TS,
    },
  });
}

function completedJson(orgId = ORG_A): string {
  return JSON.stringify({
    message_id: 'm-completed',
    idempotency_key: `chat.turn.completed:${TURN_ID}`,
    org_id: orgId,
    type: 'chat.turn.completed',
    schema_version: 1,
    occurred_at: TS,
    source: 'sayre-chat-worker',
    payload: {
      conversationId: CONVERSATION_ID,
      turnId: TURN_ID,
      answer: 'Login is handled in `src/auth/login.ts`.',
      citations: [
        { nodeId: 'file-login', label: 'src/auth/login.ts', kind: 'file', resolvedNodeId: 'canvas-login' },
      ],
      metrics: { contextNodes: 7, tokensUsed: 1234, baselineTokens: 9876, ratio: 0.125 },
      ts: TS,
    },
  });
}

function errorJson(orgId = ORG_A): string {
  return JSON.stringify({
    message_id: 'm-error',
    idempotency_key: `chat.turn.error:${TURN_ID}`,
    org_id: orgId,
    type: 'chat.turn.error',
    schema_version: 1,
    occurred_at: TS,
    source: 'sayre-chat-worker',
    payload: {
      conversationId: CONVERSATION_ID,
      turnId: TURN_ID,
      code: 'retrieval_failed',
      message: 'The question could not be answered.',
      ts: TS,
    },
  });
}

interface AuthorizeArgs {
  baseUrl: string;
  token: string;
  conversationId: string;
  nodeIds: readonly string[];
}

interface TestHarness {
  server: http.Server;
  wss: WebSocketServer;
  registry: ConnectionRegistry;
  bus: ChatEventBus;
  redis: FakeRedis;
  url: string;
  authorizeChatSubscription: ReturnType<typeof vi.fn>;
  authorizePush: ReturnType<typeof vi.fn>;
  onUnauthorized: ReturnType<typeof vi.fn>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startHarness(
  overrides: {
    authorizeChatSubscription?: ReturnType<typeof vi.fn>;
    authorizePush?: ReturnType<typeof vi.fn>;
  } = {},
): Promise<TestHarness> {
  setConfigOverrideForTests('REDIS_HOST', 'localhost');
  setConfigOverrideForTests('REDIS_PORT', '6379');

  const instances: FakeRedis[] = [];
  const factory: RedisConnectionFactory = () => {
    const instance = new FakeRedis();
    instances.push(instance);
    return instance as unknown as ReturnType<RedisConnectionFactory>;
  };

  const bus = await createChatEventBus(factory);
  const registry = new ConnectionRegistry();

  const authorizeChatSubscription = overrides.authorizeChatSubscription ?? vi.fn(async () => true);
  const authorizePush =
    overrides.authorizePush ??
    vi.fn(async (args: AuthorizeArgs) => ({
      conversationId: args.conversationId,
      authorizedNodeIds: [...args.nodeIds],
    }));
  const onUnauthorized = vi.fn((conn: GatewayConnection) =>
    conn.socket.close(UNAUTHENTICATED_CLOSE_CODE, 'core rejected token'),
  );

  const chatDeps = {
    authorizeChatSubscription,
    acquireChatChannel: (orgId: string, conversationId: string) =>
      bus.subscribe(chatEventChannel(orgId, conversationId)),
    releaseChatChannel: (orgId: string, conversationId: string) =>
      bus.unsubscribe(chatEventChannel(orgId, conversationId)),
  };

  bus.onEvent((event) =>
    relayChatEvent(event, registry, {
      authorizePush: authorizePush as never,
      coreBaseUrl: 'http://core.internal:4000',
      onUnauthorized,
      onSubscriptionRevoked: async (conn: GatewayConnection, conversationId: string) => {
        (conn as GatewayConnection & { chatSubscriptions: Set<string> }).chatSubscriptions.delete(
          conversationId,
        );
        await bus.unsubscribe(chatEventChannel(conn.orgId, conversationId));
      },
    } as never),
  );

  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  wss.on('connection', (socket, req) => {
    const conn = createPendingConnection(randomUUID(), socket);
    attachConnectionLifecycle(conn, req, registry, {
      isDevOrTest: () => false,
      authenticate: fakeAuthenticate,
      authTimeoutMs: 10_000,
      ...chatDeps,
    });
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  return {
    server,
    wss,
    registry,
    bus,
    redis: instances[0],
    url: `ws://127.0.0.1:${port}`,
    authorizeChatSubscription,
    authorizePush,
    onUnauthorized,
  };
}

interface TestClient {
  socket: WsClient;
  frames: Array<Record<string, unknown>>;
}

function waitForMessage(client: WsClient): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    client.once('message', (data) => resolve(JSON.parse(data.toString())));
  });
}

async function connect(url: string, token: string): Promise<TestClient> {
  const socket = new WsClient(url);
  await new Promise<void>((resolve) => socket.once('open', resolve));
  const ready = waitForMessage(socket);
  socket.send(JSON.stringify({ type: 'auth', token }));
  expect(await ready).toEqual({ type: 'ready' });

  const frames: Array<Record<string, unknown>> = [];
  socket.on('message', (data) => frames.push(JSON.parse(data.toString())));
  return { socket, frames };
}

async function subscribeChat(client: TestClient, conversationId = CONVERSATION_ID): Promise<void> {
  client.socket.send(JSON.stringify({ type: 'subscribe', channel: 'chat', conversationId }));
  await waitFor(() => client.frames.length > 0);
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for a condition');
    await delay(5);
  }
}

let harness: TestHarness | undefined;
let clients: WsClient[] = [];

beforeEach(() => {
  clients = [];
});

afterEach(async () => {
  for (const client of clients) client.close();
  clients = [];
  if (harness) {
    await harness.bus.close();
    await new Promise<void>((resolve) => harness!.wss.close(() => resolve()));
    await new Promise<void>((resolve) => harness!.server.close(() => resolve()));
    harness = undefined;
  }
  resetConfigForTests();
  vi.restoreAllMocks();
});

describe('CH-05 end-to-end (real ws client <-> gateway <-> fake Core, injected FakeRedis)', () => {
  // @spec AC-1
  it('AC-1: the owner receives the progress frames then the completed frame in publish order with seq strictly increasing, even when the FIRST authorization resolves slowest', async () => {
    let call = 0;
    const authorizePush = vi.fn(async (args: AuthorizeArgs) => {
      call += 1;
      // The first push's Core round-trip is deliberately the slowest: under
      // concurrent (fire-and-forget) dispatch the later frames would overtake
      // it and the delivered order would be 3,2,1.
      await delay(call === 1 ? 80 : 1);
      return { conversationId: args.conversationId, authorizedNodeIds: [...args.nodeIds] };
    });
    harness = await startHarness({ authorizePush });

    const owner = await connect(harness.url, 'tok-owner');
    clients.push(owner.socket);
    await subscribeChat(owner);
    owner.frames.length = 0;

    harness.redis.emit('message', CHANNEL_A, progressJson(1));
    harness.redis.emit('message', CHANNEL_A, progressJson(2));
    harness.redis.emit('message', CHANNEL_A, progressJson(3));
    harness.redis.emit('message', CHANNEL_A, completedJson());

    await waitFor(() => owner.frames.length >= 4);
    await delay(50); // let any late/duplicate frame arrive before asserting

    expect(owner.frames.map((frame) => frame.type)).toEqual([
      'chat.turn.progress',
      'chat.turn.progress',
      'chat.turn.progress',
      'chat.turn.completed',
    ]);
    expect(owner.frames.slice(0, 3).map((frame) => frame.seq)).toEqual([1, 2, 3]);
  });

  // @spec AC-6
  it('AC-6: all three push types reach the real wire with exactly the pinned key sets', async () => {
    harness = await startHarness();
    const owner = await connect(harness.url, 'tok-owner');
    clients.push(owner.socket);
    await subscribeChat(owner);
    owner.frames.length = 0;

    harness.redis.emit('message', CHANNEL_A, progressJson(1));
    harness.redis.emit('message', CHANNEL_A, completedJson());
    harness.redis.emit('message', CHANNEL_A, errorJson());
    await waitFor(() => owner.frames.length >= 3);

    const [progress, completed, errored] = owner.frames;
    expect(Object.keys(progress).sort()).toEqual([
      'conversationId',
      'detail',
      'kind',
      'seq',
      'tool',
      'ts',
      'turnId',
      'type',
    ]);
    expect(Object.keys(completed).sort()).toEqual([
      'answer',
      'citations',
      'conversationId',
      'metrics',
      'ts',
      'turnId',
      'type',
    ]);
    expect(Object.keys(errored).sort()).toEqual([
      'code',
      'conversationId',
      'message',
      'ts',
      'turnId',
      'type',
    ]);
    const citations = completed.citations as Array<Record<string, unknown>>;
    expect(Object.keys(citations[0]).sort()).toEqual(['kind', 'label', 'nodeId', 'resolvedNodeId']);
    expect(Object.keys(completed.metrics as object).sort()).toEqual([
      'baselineTokens',
      'contextNodes',
      'ratio',
      'tokensUsed',
    ]);
  });

  // @spec AC-2 EC-8
  it('AC-2/EC-8: a same-org non-owner is refused at subscribe, triggers no Redis SUBSCRIBE, and never sees a single frame of the conversation', async () => {
    const authorizeChatSubscription = vi.fn(async (conn: GatewayConnection) => conn.userId === 'user-owner');
    harness = await startHarness({ authorizeChatSubscription });

    const owner = await connect(harness.url, 'tok-owner');
    const teammate = await connect(harness.url, 'tok-teammate');
    clients.push(owner.socket, teammate.socket);

    await subscribeChat(owner);
    await subscribeChat(teammate);

    expect(teammate.frames).toEqual([
      { type: 'error', code: 'chat_forbidden', message: 'Conversation not found.' },
    ]);
    expect(harness.redis.subscribeCalls).toEqual([CHANNEL_A]); // only the owner's acquire
    expect(harness.bus.subscribedChannels()).toEqual([CHANNEL_A]);

    owner.frames.length = 0;
    teammate.frames.length = 0;
    harness.redis.emit('message', CHANNEL_A, completedJson());
    await waitFor(() => owner.frames.length >= 1);
    await delay(50);

    expect(teammate.frames).toEqual([]);
    expect(JSON.stringify(teammate.frames)).not.toContain('Login is handled');
  });

  // @spec AC-2
  it('AC-2: a connection authenticated under a different org can never match the event org, even for the same conversation id', async () => {
    harness = await startHarness();
    const owner = await connect(harness.url, 'tok-owner');
    const elsewhere = await connect(harness.url, 'tok-other-org');
    clients.push(owner.socket, elsewhere.socket);

    await subscribeChat(owner);
    await subscribeChat(elsewhere);
    owner.frames.length = 0;
    elsewhere.frames.length = 0;

    harness.redis.emit('message', CHANNEL_A, completedJson(ORG_A));
    await waitFor(() => owner.frames.length >= 1);
    await delay(50);

    expect(elsewhere.frames).toEqual([]);
    // The org-B connection acquired its OWN org-scoped channel, never org A's.
    expect(harness.redis.subscribeCalls.sort()).toEqual(
      [CHANNEL_A, `sayre:chat.events:${ORG_B}:${CONVERSATION_ID}`].sort(),
    );
  });

  // @spec AC-4 AC-9
  it('AC-4/AC-9: a scope reduced after subscribe removes the citation from the very NEXT push, and Core is asked once per event (not once at subscribe)', async () => {
    let call = 0;
    const authorizePush = vi.fn(async (args: AuthorizeArgs) => {
      call += 1;
      return {
        conversationId: args.conversationId,
        authorizedNodeIds: call === 1 ? [...args.nodeIds] : [], // access revoked between pushes
      };
    });
    harness = await startHarness({ authorizePush });

    const owner = await connect(harness.url, 'tok-owner');
    clients.push(owner.socket);
    await subscribeChat(owner);
    owner.frames.length = 0;

    harness.redis.emit('message', CHANNEL_A, completedJson());
    await waitFor(() => owner.frames.length >= 1);
    harness.redis.emit('message', CHANNEL_A, completedJson());
    await waitFor(() => owner.frames.length >= 2);

    expect((owner.frames[0].citations as unknown[]).length).toBe(1);
    expect(owner.frames[1].citations).toEqual([]);
    expect(authorizePush).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(owner.frames[1])).not.toContain('canvas-login');
  });

  // @spec AC-5
  it('AC-5: an explicit chat unsubscribe releases the Redis subscription exactly once and stops delivery', async () => {
    harness = await startHarness();
    const owner = await connect(harness.url, 'tok-owner');
    clients.push(owner.socket);
    await subscribeChat(owner);

    owner.socket.send(
      JSON.stringify({ type: 'unsubscribe', channel: 'chat', conversationId: CONVERSATION_ID }),
    );
    await waitFor(() => harness!.bus.subscribedChannels().length === 0);

    expect(harness.redis.unsubscribeCalls).toEqual([CHANNEL_A]);
    expect(harness.bus.subscribedChannels()).toEqual([]);

    owner.frames.length = 0;
    harness.redis.emit('message', CHANNEL_A, completedJson());
    await delay(80);
    expect(owner.frames).toEqual([]);
  });

  // @spec AC-5 EC-11
  it('AC-5/EC-11: a socket close mid-turn releases the channel, leaves nothing behind, and a following event is a silent no-op', async () => {
    harness = await startHarness();
    const owner = await connect(harness.url, 'tok-owner');
    clients.push(owner.socket);
    await subscribeChat(owner);
    owner.frames.length = 0;

    harness.redis.emit('message', CHANNEL_A, progressJson(1));
    await waitFor(() => owner.frames.length >= 1);

    owner.socket.close();
    await waitFor(() => harness!.bus.subscribedChannels().length === 0);

    expect(harness.redis.unsubscribeCalls).toEqual([CHANNEL_A]);
    expect(harness.registry.all()).toHaveLength(0);

    // An event still arriving for the now-closed connection must not crash the bus.
    harness.redis.emit('message', CHANNEL_A, completedJson());
    await delay(80);
    expect(owner.frames).toHaveLength(1);
  });

  // @spec EC-21
  it('EC-21: two tabs for the same user share ONE Redis SUBSCRIBE, both receive every push with their own authorization call, and only the last close unsubscribes', async () => {
    harness = await startHarness();
    const tabOne = await connect(harness.url, 'tok-owner');
    const tabTwo = await connect(harness.url, 'tok-owner-tab2');
    clients.push(tabOne.socket, tabTwo.socket);

    await subscribeChat(tabOne);
    await subscribeChat(tabTwo);

    expect(harness.redis.subscribeCalls).toEqual([CHANNEL_A]); // refcounted to one

    tabOne.frames.length = 0;
    tabTwo.frames.length = 0;
    harness.redis.emit('message', CHANNEL_A, completedJson());
    await waitFor(() => tabOne.frames.length >= 1 && tabTwo.frames.length >= 1);

    expect(harness.authorizePush).toHaveBeenCalledTimes(2); // one per connection per event
    expect(
      (harness.authorizePush.mock.calls as Array<[AuthorizeArgs]>).map((call) => call[0].token).sort(),
    ).toEqual(['tok-owner', 'tok-owner-tab2']);

    tabOne.socket.close();
    await delay(80);
    expect(harness.redis.unsubscribeCalls).toEqual([]); // tab 2 still holds it
    expect(harness.bus.subscribedChannels()).toEqual([CHANNEL_A]);

    tabTwo.socket.close();
    await waitFor(() => harness!.bus.subscribedChannels().length === 0);
    expect(harness.redis.unsubscribeCalls).toEqual([CHANNEL_A]); // exactly one
  });

  // @spec AC-7
  it('AC-7: a malformed / wrong-org / wrong-conversation / wrong-type message on the chat channel is dropped and never reaches the wire', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    harness = await startHarness();
    const owner = await connect(harness.url, 'tok-owner');
    clients.push(owner.socket);
    await subscribeChat(owner);
    owner.frames.length = 0;

    harness.redis.emit('message', CHANNEL_A, 'not json');
    harness.redis.emit('message', CHANNEL_A, completedJson(ORG_B)); // envelope org != channel org
    harness.redis.emit(
      'message',
      CHANNEL_A,
      completedJson().replace(CONVERSATION_ID, '77777777-7777-4777-8777-777777777777'),
    );
    harness.redis.emit(
      'message',
      CHANNEL_A,
      completedJson().replace('"chat.turn.completed"', '"graph.updated"'),
    );
    await delay(120);

    expect(owner.frames).toEqual([]);
    expect(harness.authorizePush).not.toHaveBeenCalled();
  });

  // @spec EC-12 AC-12
  it('AC-12/EC-12: an unavailable Core delivers ZERO frames for that push, keeps the subscription, and the next event is delivered normally', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let call = 0;
    const authorizePush = vi.fn(async (args: AuthorizeArgs) => {
      call += 1;
      if (call === 1) throw new (await import('./coreClient')).CoreUnavailableError();
      return { conversationId: args.conversationId, authorizedNodeIds: [...args.nodeIds] };
    });
    harness = await startHarness({ authorizePush });

    const owner = await connect(harness.url, 'tok-owner');
    clients.push(owner.socket);
    await subscribeChat(owner);
    owner.frames.length = 0;

    harness.redis.emit('message', CHANNEL_A, completedJson());
    await delay(120);
    expect(owner.frames).toEqual([]);
    expect(harness.bus.subscribedChannels()).toEqual([CHANNEL_A]); // retained

    harness.redis.emit('message', CHANNEL_A, completedJson());
    await waitFor(() => owner.frames.length >= 1);
    expect(owner.frames[0].type).toBe('chat.turn.completed');
  });

  // @spec EC-14
  it('EC-14: a mid-turn 403/404 from Core sends exactly one generic chat_forbidden frame, no event data, and releases the Redis subscription', async () => {
    const authorizePush = vi.fn(async () => {
      throw new (await import('./coreClient')).CoreForbiddenError();
    });
    harness = await startHarness({ authorizePush });

    const owner = await connect(harness.url, 'tok-owner');
    clients.push(owner.socket);
    await subscribeChat(owner);
    owner.frames.length = 0;

    harness.redis.emit('message', CHANNEL_A, completedJson());
    await waitFor(() => owner.frames.length >= 1);
    await delay(60);

    expect(owner.frames).toEqual([
      { type: 'error', code: 'chat_forbidden', message: 'Conversation not found.' },
    ]);
    expect(JSON.stringify(owner.frames)).not.toContain('Login is handled');
    expect(harness.bus.subscribedChannels()).toEqual([]);
  });

  // @spec EC-13
  it('EC-13: a mid-turn 401 from Core closes the connection with the generic unauthenticated code and delivers no event frame', async () => {
    const authorizePush = vi.fn(async () => {
      throw new (await import('./coreClient')).CoreUnauthorizedError();
    });
    harness = await startHarness({ authorizePush });

    const owner = await connect(harness.url, 'tok-owner');
    clients.push(owner.socket);
    await subscribeChat(owner);
    owner.frames.length = 0;

    const closed = new Promise<number>((resolve) => owner.socket.once('close', (code) => resolve(code)));
    harness.redis.emit('message', CHANNEL_A, completedJson());

    expect(await closed).toBe(UNAUTHENTICATED_CLOSE_CODE);
    expect(owner.frames).toEqual([]);
  });

  // @spec EC-20
  it('EC-20: a gateway wired WITHOUT chat deps refuses the subscribe with the generic chat_forbidden frame rather than accepting it unverified', async () => {
    const registry = new ConnectionRegistry();
    const server = http.createServer();
    const wss = new WebSocketServer({ server });
    wss.on('connection', (socket, req) => {
      const conn = createPendingConnection(randomUUID(), socket);
      attachConnectionLifecycle(conn, req, registry, {
        isDevOrTest: () => false,
        authenticate: fakeAuthenticate,
        authTimeoutMs: 10_000,
      });
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;

    let owner: TestClient | undefined;
    try {
      owner = await connect(`ws://127.0.0.1:${port}`, 'tok-owner');
      clients.push(owner.socket);
      await subscribeChat(owner);

      expect(owner.frames).toEqual([
        { type: 'error', code: 'chat_forbidden', message: 'Conversation not found.' },
      ]);
      expect(registry.all()[0].chatSubscriptions.size).toBe(0);
    } finally {
      // Close the still-open client connection BEFORE closing wss/server: `ws`'s
      // WebSocketServer.close() (constructed with an externally-owned `server`)
      // only invokes its callback once its tracked client count reaches zero
      // (node_modules/ws/lib/websocket-server.js's close()) — it does not
      // proactively terminate open clients itself. Every other test in this
      // file relies on the shared top-level `afterEach` to close `clients`
      // BEFORE closing its harness's wss/server; this test uniquely closes its
      // own wss/server inside its own `finally`, before that `afterEach` runs,
      // so without this explicit close the two awaits below never resolve.
      owner?.socket.close();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
