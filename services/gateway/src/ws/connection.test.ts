import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import {
  attachConnectionLifecycle,
  ConnectionRegistry,
  createPendingConnection,
  handleAuthFrame,
  handleSubscribe,
  handleUnsubscribe,
  UNAUTHENTICATED_CLOSE_CODE,
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
