import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import {
  attachConnectionLifecycle,
  ConnectionRegistry,
  createPendingConnection,
  handleAuthFrame,
  handleChatSubscribe,
  handleChatUnsubscribe,
  handleSubscribe,
  handleUnsubscribe,
  releaseChatSubscriptions,
  UNAUTHENTICATED_CLOSE_CODE,
  type GatewayConnection,
} from './connection';
import type { ConnectionIdentity } from './auth';

class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readonly CLOSED = 3;
  readyState = 1;
  sent: unknown[] = [];
  closedWith: { code?: number; reason?: string } | undefined;

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(code?: number, reason?: string): void {
    this.readyState = this.CLOSED;
    this.closedWith = { code, reason };
    this.emit('close');
  }
}

function fakeReq(headers: Record<string, string> = {}): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

const IDENTITY: ConnectionIdentity = {
  orgId: 'org-1',
  roles: ['member'],
  userId: 'user-1',
  token: 'tok-1',
};

describe('ConnectionRegistry', () => {
  it('add/get/remove round-trip', () => {
    const registry = new ConnectionRegistry();
    const conn = createPendingConnection('c1', new FakeSocket() as unknown as WebSocket);
    registry.add(conn);
    expect(registry.get('c1')).toBe(conn);
    registry.remove('c1');
    expect(registry.get('c1')).toBeUndefined();
  });

  it('matching() requires authenticated && orgId match && repoId subscribed', () => {
    const registry = new ConnectionRegistry();
    const authedMatching = createPendingConnection('a', new FakeSocket() as unknown as WebSocket);
    Object.assign(authedMatching, { orgId: 'org-a', authenticated: true });
    authedMatching.repoSubscriptions.add('repo-1');

    const authedWrongOrg = createPendingConnection('b', new FakeSocket() as unknown as WebSocket);
    Object.assign(authedWrongOrg, { orgId: 'org-b', authenticated: true });
    authedWrongOrg.repoSubscriptions.add('repo-1');

    const authedWrongRepo = createPendingConnection('c', new FakeSocket() as unknown as WebSocket);
    Object.assign(authedWrongRepo, { orgId: 'org-a', authenticated: true });
    authedWrongRepo.repoSubscriptions.add('repo-2');

    const unauthenticated = createPendingConnection('d', new FakeSocket() as unknown as WebSocket);
    Object.assign(unauthenticated, { orgId: 'org-a', authenticated: false });
    unauthenticated.repoSubscriptions.add('repo-1');

    registry.add(authedMatching);
    registry.add(authedWrongOrg);
    registry.add(authedWrongRepo);
    registry.add(unauthenticated);

    expect(registry.matching('org-a', 'repo-1')).toEqual([authedMatching]);
  });

  it('all() returns every registered connection', () => {
    const registry = new ConnectionRegistry();
    const a = createPendingConnection('a', new FakeSocket() as unknown as WebSocket);
    const b = createPendingConnection('b', new FakeSocket() as unknown as WebSocket);
    registry.add(a);
    registry.add(b);
    expect(registry.all()).toHaveLength(2);
  });
});

describe('handleAuthFrame', () => {
  it('on success, mutates the connection and returns a ready reply', async () => {
    const conn = createPendingConnection('c1', new FakeSocket() as unknown as WebSocket);
    const authenticate = vi.fn(async () => IDENTITY);

    const reply = await handleAuthFrame(conn, 'tok-1', { authenticate });

    expect(reply).toEqual({ type: 'ready' });
    expect(conn.authenticated).toBe(true);
    expect(conn.orgId).toBe('org-1');
    expect(conn.roles).toEqual(['member']);
    expect(conn.userId).toBe('user-1');
    expect(conn.token).toBe('tok-1');
    expect(authenticate).toHaveBeenCalledWith('tok-1');
  });

  it('on failure, returns null and never marks the connection authenticated (never leaks which check failed)', async () => {
    const conn = createPendingConnection('c1', new FakeSocket() as unknown as WebSocket);
    const authenticate = vi.fn(async () => {
      throw new Error('some internal verification detail');
    });

    const reply = await handleAuthFrame(conn, 'bad-token', { authenticate });

    expect(reply).toBeNull();
    expect(conn.authenticated).toBe(false);
  });
});

describe('handleSubscribe / handleUnsubscribe', () => {
  it('rejects subscribe before authentication and records no subscription', () => {
    const conn = createPendingConnection('c1', new FakeSocket() as unknown as WebSocket);
    const reply = handleSubscribe(conn, 'repo-1');

    expect(reply.type).toBe('error');
    expect(conn.repoSubscriptions.size).toBe(0);
  });

  it('subscribes an authenticated connection and is idempotent on duplicate subscribe', () => {
    const conn = createPendingConnection('c1', new FakeSocket() as unknown as WebSocket);
    conn.authenticated = true;

    expect(handleSubscribe(conn, 'repo-1')).toEqual({ type: 'subscribed', repoId: 'repo-1' });
    expect(handleSubscribe(conn, 'repo-1')).toEqual({ type: 'subscribed', repoId: 'repo-1' });
    expect(conn.repoSubscriptions.size).toBe(1);
  });

  it('unsubscribe for a repo never subscribed is a no-op', () => {
    const conn = createPendingConnection('c1', new FakeSocket() as unknown as WebSocket);
    expect(() => handleUnsubscribe(conn, 'repo-never-subscribed')).not.toThrow();
    expect(conn.repoSubscriptions.size).toBe(0);
  });
});

describe('attachConnectionLifecycle', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('header token success: authenticates immediately and sends a ready frame', async () => {
    const socket = new FakeSocket();
    const conn = createPendingConnection('c1', socket as unknown as WebSocket);
    const registry = new ConnectionRegistry();
    const authenticate = vi.fn(async () => IDENTITY);

    attachConnectionLifecycle(conn, fakeReq({ authorization: 'Bearer tok-1' }), registry, { authenticate });
    await new Promise((resolve) => setImmediate(resolve));

    expect(conn.authenticated).toBe(true);
    expect(socket.sent).toContainEqual({ type: 'ready' });
    expect(registry.get('c1')).toBe(conn);
  });

  it('header token failure: closes the socket with the generic unauthenticated code', async () => {
    const socket = new FakeSocket();
    const conn = createPendingConnection('c1', socket as unknown as WebSocket);
    const registry = new ConnectionRegistry();
    const authenticate = vi.fn(async () => {
      throw new Error('invalid');
    });

    attachConnectionLifecycle(conn, fakeReq({ authorization: 'Bearer bad' }), registry, { authenticate });
    await new Promise((resolve) => setImmediate(resolve));

    expect(conn.authenticated).toBe(false);
    expect(socket.closedWith?.code).toBe(UNAUTHENTICATED_CLOSE_CODE);
  });

  it('no token + dev/test: auto-accepts via devIdentity() and sends ready', () => {
    const socket = new FakeSocket();
    const conn = createPendingConnection('c1', socket as unknown as WebSocket);
    const registry = new ConnectionRegistry();

    attachConnectionLifecycle(conn, fakeReq(), registry, {
      isDevOrTest: () => true,
      devIdentity: () => IDENTITY,
    });

    expect(conn.authenticated).toBe(true);
    expect(socket.sent).toContainEqual({ type: 'ready' });
  });

  it('no token + production: closes with the generic code after the auth-timeout window elapses', async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const conn = createPendingConnection('c1', socket as unknown as WebSocket);
    const registry = new ConnectionRegistry();

    attachConnectionLifecycle(conn, fakeReq(), registry, {
      isDevOrTest: () => false,
      authTimeoutMs: 50,
    });

    expect(socket.closedWith).toBeUndefined();
    vi.advanceTimersByTime(51);

    expect(socket.closedWith?.code).toBe(UNAUTHENTICATED_CLOSE_CODE);
  });

  it('a valid auth frame received before the timeout clears it and authenticates', async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const conn = createPendingConnection('c1', socket as unknown as WebSocket);
    const registry = new ConnectionRegistry();
    const authenticate = vi.fn(async () => IDENTITY);

    attachConnectionLifecycle(conn, fakeReq(), registry, {
      isDevOrTest: () => false,
      authTimeoutMs: 50,
      authenticate,
    });

    socket.emit('message', JSON.stringify({ type: 'auth', token: 'tok-1' }));
    await vi.advanceTimersByTimeAsync(0);

    vi.advanceTimersByTime(1000); // well past the original timeout
    expect(socket.closedWith).toBeUndefined();
    expect(conn.authenticated).toBe(true);
  });

  it('subscribe before authenticating gets a generic error frame, no subscription recorded', async () => {
    const socket = new FakeSocket();
    const conn = createPendingConnection('c1', socket as unknown as WebSocket);
    const registry = new ConnectionRegistry();

    attachConnectionLifecycle(conn, fakeReq(), registry, { isDevOrTest: () => false, authTimeoutMs: 10_000 });
    socket.emit('message', JSON.stringify({ type: 'subscribe', repoId: 'repo-1' }));
    await new Promise((resolve) => setImmediate(resolve));

    expect(socket.sent).toContainEqual({
      type: 'error',
      code: 'unauthenticated',
      message: 'Authenticate before subscribing.',
    });
    expect(conn.repoSubscriptions.size).toBe(0);
  });

  it('a malformed frame gets a generic error reply and never crashes the connection', async () => {
    const socket = new FakeSocket();
    const conn = createPendingConnection('c1', socket as unknown as WebSocket);
    const registry = new ConnectionRegistry();

    attachConnectionLifecycle(conn, fakeReq(), registry, { isDevOrTest: () => true, devIdentity: () => IDENTITY });
    socket.emit('message', 'not json');
    await new Promise((resolve) => setImmediate(resolve));

    expect(socket.sent).toContainEqual({
      type: 'error',
      code: 'bad_frame',
      message: 'Malformed or invalid frame.',
    });
  });

  it('deregisters the connection when the socket closes', () => {
    const socket = new FakeSocket();
    const conn = createPendingConnection('c1', socket as unknown as WebSocket);
    const registry = new ConnectionRegistry();

    attachConnectionLifecycle(conn, fakeReq(), registry, { isDevOrTest: () => true, devIdentity: () => IDENTITY });
    expect(registry.get('c1')).toBe(conn);

    socket.emit('close');
    expect(registry.get('c1')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// CH-05 — per-conversation chat subscriptions. Authored by `red` from
// .pipeline/spec.md before any implementation exists. Every case above this
// line predates CH-05 and must keep passing untouched (AC-10).
// ---------------------------------------------------------------------------

const CONVERSATION_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_CONVERSATION_ID = '55555555-5555-4555-8555-555555555555';

type ChatConnection = GatewayConnection & { chatSubscriptions: Set<string> };

function chatDeps(overrides: Record<string, unknown> = {}) {
  return {
    authorizeChatSubscription: vi.fn(async () => true),
    acquireChatChannel: vi.fn(async () => undefined),
    releaseChatChannel: vi.fn(async () => undefined),
    ...overrides,
  } as never;
}

function spyOf(deps: unknown, name: string): ReturnType<typeof vi.fn> {
  return (deps as Record<string, ReturnType<typeof vi.fn>>)[name];
}

function authedChatConnection(id = 'c1', orgId = 'org-1'): ChatConnection {
  const conn = createPendingConnection(id, new FakeSocket() as unknown as WebSocket) as ChatConnection;
  conn.authenticated = true;
  conn.orgId = orgId;
  conn.userId = 'user-1';
  conn.token = `tok-${id}`;
  return conn;
}

describe('ConnectionRegistry.matchingChat', () => {
  // @spec AC-2
  it('AC-2: requires authenticated && orgId match && the conversation is in chatSubscriptions', () => {
    const registry = new ConnectionRegistry();

    const matching = authedChatConnection('a', 'org-a');
    matching.chatSubscriptions.add(CONVERSATION_ID);

    const wrongOrg = authedChatConnection('b', 'org-b');
    wrongOrg.chatSubscriptions.add(CONVERSATION_ID);

    const wrongConversation = authedChatConnection('c', 'org-a');
    wrongConversation.chatSubscriptions.add(OTHER_CONVERSATION_ID);

    const unauthenticated = authedChatConnection('d', 'org-a');
    unauthenticated.authenticated = false;
    unauthenticated.chatSubscriptions.add(CONVERSATION_ID);

    registry.add(matching);
    registry.add(wrongOrg);
    registry.add(wrongConversation);
    registry.add(unauthenticated);

    expect(registry.matchingChat('org-a', CONVERSATION_ID)).toEqual([matching]);
  });

  // @spec AC-2
  it('AC-2: a fresh connection starts with an empty chat-subscription set and a repo subscription is never treated as one', () => {
    const conn = createPendingConnection('c1', new FakeSocket() as unknown as WebSocket) as ChatConnection;

    expect(conn.chatSubscriptions).toBeInstanceOf(Set);
    expect(conn.chatSubscriptions.size).toBe(0);

    conn.authenticated = true;
    conn.orgId = 'org-a';
    conn.repoSubscriptions.add(CONVERSATION_ID);
    const registry = new ConnectionRegistry();
    registry.add(conn);

    expect(registry.matchingChat('org-a', CONVERSATION_ID)).toEqual([]);
  });
});

describe('handleChatSubscribe', () => {
  // @spec EC-19
  it('EC-19: a chat subscribe before authentication gets the generic unauthenticated frame and records nothing', async () => {
    const conn = authedChatConnection();
    conn.authenticated = false;
    const deps = chatDeps();

    const reply = await handleChatSubscribe(conn, CONVERSATION_ID, deps);

    expect(reply).toEqual({
      type: 'error',
      code: 'unauthenticated',
      message: 'Authenticate before subscribing.',
    });
    expect(conn.chatSubscriptions.size).toBe(0);
    expect(spyOf(deps, 'authorizeChatSubscription')).not.toHaveBeenCalled();
    expect(spyOf(deps, 'acquireChatChannel')).not.toHaveBeenCalled();
  });

  // @spec EC-20
  it('EC-20: a gateway constructed WITHOUT chat deps refuses with the generic chat_forbidden frame (fail closed)', async () => {
    const conn = authedChatConnection();

    const reply = await handleChatSubscribe(conn, CONVERSATION_ID, {});

    expect(reply).toEqual({
      type: 'error',
      code: 'chat_forbidden',
      message: 'Conversation not found.',
    });
    expect(conn.chatSubscriptions.size).toBe(0);
  });

  // @spec AC-2 EC-8
  it('AC-2/EC-8: a non-owner and a nonexistent conversation get the IDENTICAL refusal, record nothing and acquire nothing', async () => {
    const nonOwner = authedChatConnection('non-owner');
    const absent = authedChatConnection('absent');
    const deps = chatDeps({ authorizeChatSubscription: vi.fn(async () => false) });

    const nonOwnerReply = await handleChatSubscribe(nonOwner, CONVERSATION_ID, deps);
    const absentReply = await handleChatSubscribe(absent, OTHER_CONVERSATION_ID, deps);

    expect(nonOwnerReply).toEqual({
      type: 'error',
      code: 'chat_forbidden',
      message: 'Conversation not found.',
    });
    // Nothing in the reply distinguishes "not yours" from "does not exist".
    expect({ ...(absentReply as object), conversationId: undefined }).toEqual({
      ...(nonOwnerReply as object),
      conversationId: undefined,
    });
    expect(nonOwner.chatSubscriptions.size).toBe(0);
    expect(absent.chatSubscriptions.size).toBe(0);
    expect(spyOf(deps, 'acquireChatChannel')).not.toHaveBeenCalled();
  });

  // @spec AC-5
  it('AC-5: an owner-verified subscribe records the conversation, acquires the Redis channel once, and replies subscribed', async () => {
    const conn = authedChatConnection('c1', 'org-a');
    const deps = chatDeps();

    const reply = await handleChatSubscribe(conn, CONVERSATION_ID, deps);

    expect(reply).toEqual({ type: 'subscribed', channel: 'chat', conversationId: CONVERSATION_ID });
    expect([...conn.chatSubscriptions]).toEqual([CONVERSATION_ID]);
    expect(spyOf(deps, 'acquireChatChannel')).toHaveBeenCalledTimes(1);
    expect(spyOf(deps, 'acquireChatChannel')).toHaveBeenCalledWith('org-a', CONVERSATION_ID);
    expect(spyOf(deps, 'authorizeChatSubscription')).toHaveBeenCalledWith(conn, CONVERSATION_ID);
  });

  // @spec AC-8
  it('AC-8: the acquired channel org comes from the connection token-derived orgId, never from the frame', async () => {
    const conn = authedChatConnection('c1', 'org-from-token');
    const deps = chatDeps();

    await handleChatSubscribe(conn, CONVERSATION_ID, deps);

    expect(spyOf(deps, 'acquireChatChannel').mock.calls[0][0]).toBe('org-from-token');
  });

  // @spec EC-9
  it('EC-9: a duplicate subscribe replies subscribed again but keeps the set at 1 and acquires exactly once', async () => {
    const conn = authedChatConnection();
    const deps = chatDeps();

    const first = await handleChatSubscribe(conn, CONVERSATION_ID, deps);
    const second = await handleChatSubscribe(conn, CONVERSATION_ID, deps);

    expect(first).toEqual({ type: 'subscribed', channel: 'chat', conversationId: CONVERSATION_ID });
    expect(second).toEqual(first);
    expect(conn.chatSubscriptions.size).toBe(1);
    expect(spyOf(deps, 'acquireChatChannel')).toHaveBeenCalledTimes(1);
  });

  // @spec EC-22
  it('EC-22: two subscribes racing before the first authorization resolves still acquire exactly once', async () => {
    const conn = authedChatConnection();
    let releaseAuthorization: (value: boolean) => void = () => undefined;
    const gate = new Promise<boolean>((resolve) => {
      releaseAuthorization = resolve;
    });
    const deps = chatDeps({ authorizeChatSubscription: vi.fn(() => gate) });

    const both = Promise.all([
      handleChatSubscribe(conn, CONVERSATION_ID, deps),
      handleChatSubscribe(conn, CONVERSATION_ID, deps),
    ]);
    releaseAuthorization(true);
    const replies = await both;

    expect(replies[0]).toEqual({ type: 'subscribed', channel: 'chat', conversationId: CONVERSATION_ID });
    expect(replies[1]).toEqual(replies[0]);
    expect(conn.chatSubscriptions.size).toBe(1);
    expect(spyOf(deps, 'acquireChatChannel')).toHaveBeenCalledTimes(1);
  });
});

describe('handleChatUnsubscribe / releaseChatSubscriptions', () => {
  // @spec EC-10
  it('EC-10: unsubscribing a conversation never subscribed on this connection is a no-op with no Redis release', async () => {
    const conn = authedChatConnection();
    const deps = chatDeps();

    await expect(handleChatUnsubscribe(conn, CONVERSATION_ID, deps)).resolves.toBeUndefined();

    expect(spyOf(deps, 'releaseChatChannel')).not.toHaveBeenCalled();
    expect(conn.chatSubscriptions.size).toBe(0);
  });

  // @spec AC-5
  it('AC-5: unsubscribing a held conversation releases the Redis channel exactly once and forgets it', async () => {
    const conn = authedChatConnection('c1', 'org-a');
    const deps = chatDeps();
    await handleChatSubscribe(conn, CONVERSATION_ID, deps);

    await handleChatUnsubscribe(conn, CONVERSATION_ID, deps);
    await handleChatUnsubscribe(conn, CONVERSATION_ID, deps); // second time: already gone

    expect(spyOf(deps, 'releaseChatChannel')).toHaveBeenCalledTimes(1);
    expect(spyOf(deps, 'releaseChatChannel')).toHaveBeenCalledWith('org-a', CONVERSATION_ID);
    expect(conn.chatSubscriptions.size).toBe(0);
  });

  // @spec AC-5
  it('AC-5: releaseChatSubscriptions releases every held channel, clears the set, and is idempotent', async () => {
    const conn = authedChatConnection('c1', 'org-a');
    const deps = chatDeps();
    await handleChatSubscribe(conn, CONVERSATION_ID, deps);
    await handleChatSubscribe(conn, OTHER_CONVERSATION_ID, deps);

    await releaseChatSubscriptions(conn, deps);
    await releaseChatSubscriptions(conn, deps);

    expect(spyOf(deps, 'releaseChatChannel').mock.calls.map((call) => call[1]).sort()).toEqual(
      [CONVERSATION_ID, OTHER_CONVERSATION_ID].sort(),
    );
    expect(spyOf(deps, 'releaseChatChannel')).toHaveBeenCalledTimes(2);
    expect(conn.chatSubscriptions.size).toBe(0);
  });

  // @spec AC-5
  it('AC-5: one failing release never strands the others', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const conn = authedChatConnection('c1', 'org-a');
    const releaseChatChannel = vi.fn(async (_orgId: string, conversationId: string) => {
      if (conversationId === CONVERSATION_ID) throw new Error('redis is down');
    });
    const deps = chatDeps({ releaseChatChannel });
    await handleChatSubscribe(conn, CONVERSATION_ID, deps);
    await handleChatSubscribe(conn, OTHER_CONVERSATION_ID, deps);

    await expect(releaseChatSubscriptions(conn, deps)).resolves.toBeUndefined();

    expect(releaseChatChannel.mock.calls.map((call) => call[1]).sort()).toEqual(
      [CONVERSATION_ID, OTHER_CONVERSATION_ID].sort(),
    );
    expect(conn.chatSubscriptions.size).toBe(0);
  });
});

describe('attachConnectionLifecycle — CH-05 chat frames', () => {
  // @spec AC-5
  it('AC-5: a chat subscribe frame is dispatched to handleChatSubscribe and replies over the socket', async () => {
    const socket = new FakeSocket();
    const conn = createPendingConnection('c1', socket as unknown as WebSocket);
    const registry = new ConnectionRegistry();
    const deps = chatDeps();

    attachConnectionLifecycle(conn, fakeReq(), registry, {
      isDevOrTest: () => true,
      devIdentity: () => IDENTITY,
      ...(deps as object),
    });
    socket.emit(
      'message',
      JSON.stringify({ type: 'subscribe', channel: 'chat', conversationId: CONVERSATION_ID }),
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(socket.sent).toContainEqual({
      type: 'subscribed',
      channel: 'chat',
      conversationId: CONVERSATION_ID,
    });
    expect(spyOf(deps, 'acquireChatChannel')).toHaveBeenCalledTimes(1);
  });

  // @spec AC-5
  it('AC-5: a chat unsubscribe frame releases the Redis channel and sends no reply frame', async () => {
    const socket = new FakeSocket();
    const conn = createPendingConnection('c1', socket as unknown as WebSocket);
    const registry = new ConnectionRegistry();
    const deps = chatDeps();

    attachConnectionLifecycle(conn, fakeReq(), registry, {
      isDevOrTest: () => true,
      devIdentity: () => IDENTITY,
      ...(deps as object),
    });
    socket.emit(
      'message',
      JSON.stringify({ type: 'subscribe', channel: 'chat', conversationId: CONVERSATION_ID }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    const framesBefore = socket.sent.length;

    socket.emit(
      'message',
      JSON.stringify({ type: 'unsubscribe', channel: 'chat', conversationId: CONVERSATION_ID }),
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(spyOf(deps, 'releaseChatChannel')).toHaveBeenCalledWith(IDENTITY.orgId, CONVERSATION_ID);
    expect(socket.sent).toHaveLength(framesBefore);
  });

  // @spec AC-5 EC-11
  it('AC-5/EC-11: a socket close releases every held chat channel and deregisters the connection', async () => {
    const socket = new FakeSocket();
    const conn = createPendingConnection('c1', socket as unknown as WebSocket);
    const registry = new ConnectionRegistry();
    const deps = chatDeps();

    attachConnectionLifecycle(conn, fakeReq(), registry, {
      isDevOrTest: () => true,
      devIdentity: () => IDENTITY,
      ...(deps as object),
    });
    socket.emit(
      'message',
      JSON.stringify({ type: 'subscribe', channel: 'chat', conversationId: CONVERSATION_ID }),
    );
    socket.emit(
      'message',
      JSON.stringify({ type: 'subscribe', channel: 'chat', conversationId: OTHER_CONVERSATION_ID }),
    );
    await new Promise((resolve) => setImmediate(resolve));

    socket.emit('close');
    await new Promise((resolve) => setImmediate(resolve));

    expect(spyOf(deps, 'releaseChatChannel')).toHaveBeenCalledTimes(2);
    expect((conn as ChatConnection).chatSubscriptions.size).toBe(0);
    expect(registry.get('c1')).toBeUndefined();
  });

  // @spec EC-19
  it('EC-19: a chat subscribe frame before authentication replies unauthenticated and never reaches Core or Redis', async () => {
    const socket = new FakeSocket();
    const conn = createPendingConnection('c1', socket as unknown as WebSocket);
    const registry = new ConnectionRegistry();
    const deps = chatDeps();

    attachConnectionLifecycle(conn, fakeReq(), registry, {
      isDevOrTest: () => false,
      authTimeoutMs: 10_000,
      ...(deps as object),
    });
    socket.emit(
      'message',
      JSON.stringify({ type: 'subscribe', channel: 'chat', conversationId: CONVERSATION_ID }),
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(socket.sent).toContainEqual({
      type: 'error',
      code: 'unauthenticated',
      message: 'Authenticate before subscribing.',
    });
    expect(spyOf(deps, 'authorizeChatSubscription')).not.toHaveBeenCalled();
    expect(spyOf(deps, 'acquireChatChannel')).not.toHaveBeenCalled();
  });

  // @spec EC-26
  it('EC-26: a malformed chat frame gets the generic bad_frame reply, keeps the connection open and records nothing', async () => {
    const socket = new FakeSocket();
    const conn = createPendingConnection('c1', socket as unknown as WebSocket);
    const registry = new ConnectionRegistry();
    const deps = chatDeps();

    attachConnectionLifecycle(conn, fakeReq(), registry, {
      isDevOrTest: () => true,
      devIdentity: () => IDENTITY,
      ...(deps as object),
    });
    socket.emit('message', JSON.stringify({ type: 'subscribe', channel: 'chat' }));
    socket.emit('message', JSON.stringify({ type: 'subscribe', channel: 'chat', conversationId: '' }));
    socket.emit(
      'message',
      JSON.stringify({ type: 'subscribe', channel: 'graph', conversationId: CONVERSATION_ID }),
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(socket.sent).toEqual(
      expect.arrayContaining([
        { type: 'error', code: 'bad_frame', message: 'Malformed or invalid frame.' },
      ]),
    );
    expect(socket.readyState).toBe(socket.OPEN);
    expect((conn as ChatConnection).chatSubscriptions.size).toBe(0);
    expect(spyOf(deps, 'acquireChatChannel')).not.toHaveBeenCalled();
  });

  // @spec AC-10
  it('AC-10: the existing repo subscribe/unsubscribe frames still behave identically alongside the chat branch', async () => {
    const socket = new FakeSocket();
    const conn = createPendingConnection('c1', socket as unknown as WebSocket);
    const registry = new ConnectionRegistry();
    const deps = chatDeps();

    attachConnectionLifecycle(conn, fakeReq(), registry, {
      isDevOrTest: () => true,
      devIdentity: () => IDENTITY,
      ...(deps as object),
    });
    socket.emit('message', JSON.stringify({ type: 'subscribe', repoId: 'repo-1' }));
    await new Promise((resolve) => setImmediate(resolve));

    expect(socket.sent).toContainEqual({ type: 'subscribed', repoId: 'repo-1' });
    expect(conn.repoSubscriptions.has('repo-1')).toBe(true);
    expect((conn as ChatConnection).chatSubscriptions.size).toBe(0);
    expect(spyOf(deps, 'acquireChatChannel')).not.toHaveBeenCalled();

    socket.emit('message', JSON.stringify({ type: 'unsubscribe', repoId: 'repo-1' }));
    await new Promise((resolve) => setImmediate(resolve));

    expect(conn.repoSubscriptions.size).toBe(0);
    expect(spyOf(deps, 'releaseChatChannel')).not.toHaveBeenCalled();
  });
});
