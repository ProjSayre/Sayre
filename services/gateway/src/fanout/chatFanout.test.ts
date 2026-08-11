// CH-05 — relayChatEvent: the per-connection, PER-PUSH RBAC re-filter and send.
// Authored by `red` from .pipeline/spec.md before any implementation exists.
//
// Every assertion below is about what the RELAY owes: it re-asks Core on every
// single delivery over that connection's own token, sends the pinned frame
// shape field-for-field, and delivers ZERO frames whenever the authorization
// call fails in any way (never the unfiltered event, never a cached scope).

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import type { DecodedChatEvent } from '../ws/chatEvents';
import { relayChatEvent } from './chatFanout';
import { ConnectionRegistry, createPendingConnection, type GatewayConnection } from '../ws/connection';
import { CoreForbiddenError, CoreUnauthorizedError, CoreUnavailableError } from '../coreClient';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG_ID = '99999999-9999-4999-8999-999999999999';
const CONVERSATION_ID = '44444444-4444-4444-8444-444444444444';
const TURN_ID = '66666666-6666-4666-8666-666666666666';
const TS = '2026-08-11T00:00:00.000000Z';

class FakeSocket {
  readonly OPEN = 1;
  readyState = 1;
  sent: unknown[] = [];
  sendThrows = false;

  send(data: string): void {
    if (this.sendThrows) throw new Error('socket is half-open');
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    this.readyState = 3;
  }
}

type ChatConnection = GatewayConnection & { chatSubscriptions: Set<string> };

function chatConnection(
  id: string,
  orgId = ORG_ID,
  conversationId: string | null = CONVERSATION_ID,
  token = `tok-${id}`,
): ChatConnection {
  const conn = createPendingConnection(id, new FakeSocket() as unknown as WebSocket) as ChatConnection;
  conn.authenticated = true;
  conn.orgId = orgId;
  conn.userId = `user-${id}`;
  conn.token = token;
  // `chatSubscriptions` is CH-05's own addition to GatewayConnection; the
  // fallback keeps THIS file measuring the relay rather than the connection
  // factory (createPendingConnection's initialization is pinned in
  // ../ws/connection.test.ts).
  conn.chatSubscriptions = conn.chatSubscriptions ?? new Set<string>();
  if (conversationId) conn.chatSubscriptions.add(conversationId);
  return conn;
}

function sentOf(conn: GatewayConnection): unknown[] {
  return (conn.socket as unknown as FakeSocket).sent;
}

function citation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    nodeId: 'file-login',
    label: 'src/auth/login.ts',
    kind: 'file',
    resolvedNodeId: 'canvas-login',
    ...overrides,
  };
}

const METRICS = { contextNodes: 7, tokensUsed: 1234, baselineTokens: 9876, ratio: 0.125 };

function progressEvent(seq = 1, orgId = ORG_ID): DecodedChatEvent {
  return {
    orgId,
    conversationId: CONVERSATION_ID,
    turnId: TURN_ID,
    push: {
      type: 'chat.turn.progress',
      conversationId: CONVERSATION_ID,
      turnId: TURN_ID,
      seq,
      kind: 'status',
      tool: null,
      detail: 'Preparing…',
      ts: TS,
    },
  } as unknown as DecodedChatEvent;
}

function completedEvent(citations: Array<Record<string, unknown>> = [citation()]): DecodedChatEvent {
  return {
    orgId: ORG_ID,
    conversationId: CONVERSATION_ID,
    turnId: TURN_ID,
    push: {
      type: 'chat.turn.completed',
      conversationId: CONVERSATION_ID,
      turnId: TURN_ID,
      answer: 'Login is handled in `src/auth/login.ts`.',
      citations,
      metrics: { ...METRICS },
      ts: TS,
    },
  } as unknown as DecodedChatEvent;
}

function errorEvent(): DecodedChatEvent {
  return {
    orgId: ORG_ID,
    conversationId: CONVERSATION_ID,
    turnId: TURN_ID,
    push: {
      type: 'chat.turn.error',
      conversationId: CONVERSATION_ID,
      turnId: TURN_ID,
      code: 'retrieval_failed',
      message: 'The question could not be answered.',
      ts: TS,
    },
  } as unknown as DecodedChatEvent;
}

interface AuthorizeArgs {
  baseUrl: string;
  token: string;
  conversationId: string;
  nodeIds: readonly string[];
}

function relayDeps(overrides: Record<string, unknown> = {}) {
  return {
    authorizePush: vi.fn(async (args: AuthorizeArgs) => ({
      conversationId: args.conversationId,
      authorizedNodeIds: [...args.nodeIds],
    })),
    coreBaseUrl: 'http://core.internal:4000',
    onUnauthorized: vi.fn(),
    onSubscriptionRevoked: vi.fn(async () => undefined),
    ...overrides,
  } as never;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('relayChatEvent — contract conformance', () => {
  // @spec AC-6
  it('AC-6: a progress push reaches the wire with exactly the pinned key set', async () => {
    const registry = new ConnectionRegistry();
    const conn = chatConnection('c1');
    registry.add(conn);

    await relayChatEvent(progressEvent(1), registry, relayDeps());

    expect(sentOf(conn)).toEqual([
      {
        type: 'chat.turn.progress',
        conversationId: CONVERSATION_ID,
        turnId: TURN_ID,
        seq: 1,
        kind: 'status',
        tool: null,
        detail: 'Preparing…',
        ts: TS,
      },
    ]);
    expect(Object.keys(sentOf(conn)[0] as object).sort()).toEqual([
      'conversationId',
      'detail',
      'kind',
      'seq',
      'tool',
      'ts',
      'turnId',
      'type',
    ]);
  });

  // @spec AC-6
  it('AC-6: a completed push reaches the wire with exactly the pinned completed/citation/metrics key sets', async () => {
    const registry = new ConnectionRegistry();
    const conn = chatConnection('c1');
    registry.add(conn);

    await relayChatEvent(completedEvent(), registry, relayDeps());

    const frame = sentOf(conn)[0] as {
      citations: Array<Record<string, unknown>>;
      metrics: Record<string, unknown>;
    };
    expect(Object.keys(frame).sort()).toEqual([
      'answer',
      'citations',
      'conversationId',
      'metrics',
      'ts',
      'turnId',
      'type',
    ]);
    expect(Object.keys(frame.citations[0]).sort()).toEqual([
      'kind',
      'label',
      'nodeId',
      'resolvedNodeId',
    ]);
    expect(Object.keys(frame.metrics).sort()).toEqual([
      'baselineTokens',
      'contextNodes',
      'ratio',
      'tokensUsed',
    ]);
  });

  // @spec AC-6
  it('AC-6: an error push reaches the wire with exactly the pinned key set', async () => {
    const registry = new ConnectionRegistry();
    const conn = chatConnection('c1');
    registry.add(conn);

    await relayChatEvent(errorEvent(), registry, relayDeps());

    expect(sentOf(conn)).toEqual([
      {
        type: 'chat.turn.error',
        conversationId: CONVERSATION_ID,
        turnId: TURN_ID,
        code: 'retrieval_failed',
        message: 'The question could not be answered.',
        ts: TS,
      },
    ]);
  });

  // @spec EC-27
  it('EC-27: progress events with a gap or a repeat in seq are relayed verbatim, in arrival order', async () => {
    const registry = new ConnectionRegistry();
    const conn = chatConnection('c1');
    registry.add(conn);
    const deps = relayDeps();

    await relayChatEvent(progressEvent(1), registry, deps);
    await relayChatEvent(progressEvent(3), registry, deps);
    await relayChatEvent(progressEvent(3), registry, deps);

    expect((sentOf(conn) as Array<{ seq: number }>).map((frame) => frame.seq)).toEqual([1, 3, 3]);
  });
});

describe('relayChatEvent — per-push RBAC re-filter', () => {
  // @spec AC-3 EC-16
  it('AC-3/EC-16: a citation outside the receiver current scope is absent; the rest survive and metrics are byte-identical', async () => {
    const registry = new ConnectionRegistry();
    const conn = chatConnection('c1');
    registry.add(conn);

    const deps = relayDeps({
      authorizePush: vi.fn(async () => ({
        conversationId: CONVERSATION_ID,
        authorizedNodeIds: ['allowed', 'canvas-allowed'],
      })),
    });

    await relayChatEvent(
      completedEvent([
        citation({ nodeId: 'allowed', resolvedNodeId: 'canvas-allowed' }),
        citation({ nodeId: 'forbidden-node', resolvedNodeId: 'canvas-forbidden' }),
      ]),
      registry,
      deps,
    );

    const frame = sentOf(conn)[0] as { citations: unknown[]; metrics: unknown };
    expect(frame.citations).toEqual([
      {
        nodeId: 'allowed',
        label: 'src/auth/login.ts',
        kind: 'file',
        resolvedNodeId: 'canvas-allowed',
      },
    ]);
    expect(frame.metrics).toEqual(METRICS);
    expect(JSON.stringify(sentOf(conn))).not.toContain('forbidden-node');
  });

  // @spec EC-18
  it('EC-18: when every citation is stripped the completed frame is still delivered with citations: []', async () => {
    const registry = new ConnectionRegistry();
    const conn = chatConnection('c1');
    registry.add(conn);

    const deps = relayDeps({
      authorizePush: vi.fn(async () => ({ conversationId: CONVERSATION_ID, authorizedNodeIds: [] })),
    });

    await relayChatEvent(completedEvent(), registry, deps);

    const frame = sentOf(conn)[0] as { type: string; citations: unknown[]; answer: string; metrics: unknown };
    expect(frame.type).toBe('chat.turn.completed');
    expect(frame.citations).toEqual([]);
    expect(frame.answer).toBe('Login is handled in `src/auth/login.ts`.');
    expect(frame.metrics).toEqual(METRICS);
  });

  // @spec AC-4 AC-9
  it('AC-4/AC-9: a scope narrowed AFTER subscribe changes the very next push — Core is asked once per event, not once at subscribe', async () => {
    const registry = new ConnectionRegistry();
    const conn = chatConnection('c1');
    registry.add(conn);

    const authorizePush = vi
      .fn()
      .mockResolvedValueOnce({
        conversationId: CONVERSATION_ID,
        authorizedNodeIds: ['file-login', 'canvas-login'],
      })
      .mockResolvedValueOnce({ conversationId: CONVERSATION_ID, authorizedNodeIds: [] });
    const deps = relayDeps({ authorizePush });

    await relayChatEvent(completedEvent(), registry, deps);
    await relayChatEvent(completedEvent(), registry, deps);

    const frames = sentOf(conn) as Array<{ citations: unknown[] }>;
    expect(frames).toHaveLength(2);
    expect(frames[0].citations).toHaveLength(1);
    expect(frames[1].citations).toEqual([]);
    expect(authorizePush).toHaveBeenCalledTimes(2);
  });

  // @spec AC-9
  it('AC-9: N events to one subscribed connection produce N authorization calls carrying that connection own bearer token', async () => {
    const registry = new ConnectionRegistry();
    const conn = chatConnection('c1', ORG_ID, CONVERSATION_ID, 'tok-secret-c1');
    registry.add(conn);
    const deps = relayDeps();

    await relayChatEvent(progressEvent(1), registry, deps);
    await relayChatEvent(progressEvent(2), registry, deps);
    await relayChatEvent(completedEvent(), registry, deps);

    const authorizePush = (deps as unknown as { authorizePush: ReturnType<typeof vi.fn> }).authorizePush;
    expect(authorizePush).toHaveBeenCalledTimes(3);
    for (const call of authorizePush.mock.calls) {
      expect((call[0] as AuthorizeArgs).token).toBe('tok-secret-c1');
    }
  });

  // @spec AC-9
  it('AC-9: each matching connection gets its OWN authorization call per event, with its own token', async () => {
    const registry = new ConnectionRegistry();
    const first = chatConnection('c1', ORG_ID, CONVERSATION_ID, 'tok-1');
    const second = chatConnection('c2', ORG_ID, CONVERSATION_ID, 'tok-2');
    registry.add(first);
    registry.add(second);
    const deps = relayDeps();

    await relayChatEvent(progressEvent(1), registry, deps);

    const authorizePush = (deps as unknown as { authorizePush: ReturnType<typeof vi.fn> }).authorizePush;
    expect(authorizePush).toHaveBeenCalledTimes(2);
    expect(authorizePush.mock.calls.map((call) => (call[0] as AuthorizeArgs).token).sort()).toEqual([
      'tok-1',
      'tok-2',
    ]);
    expect(sentOf(first)).toHaveLength(1);
    expect(sentOf(second)).toHaveLength(1);
  });

  // @spec AC-8
  it('AC-8: the authorization call carries exactly baseUrl/token/conversationId/nodeIds — no org id, no user id', async () => {
    const registry = new ConnectionRegistry();
    const conn = chatConnection('c1');
    registry.add(conn);
    const deps = relayDeps();

    await relayChatEvent(completedEvent(), registry, deps);

    const authorizePush = (deps as unknown as { authorizePush: ReturnType<typeof vi.fn> }).authorizePush;
    const args = authorizePush.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(args).sort()).toEqual(['baseUrl', 'conversationId', 'nodeIds', 'token']);
    expect(args.conversationId).toBe(CONVERSATION_ID);
    expect(args.baseUrl).toBe('http://core.internal:4000');
    expect(JSON.stringify(args)).not.toContain(ORG_ID);
  });

  // @spec EC-28
  it('EC-28: a progress or error push still calls Core (the ownership half of the re-filter) with nodeIds: []', async () => {
    const registry = new ConnectionRegistry();
    const conn = chatConnection('c1');
    registry.add(conn);
    const deps = relayDeps();

    await relayChatEvent(progressEvent(1), registry, deps);
    await relayChatEvent(errorEvent(), registry, deps);

    const authorizePush = (deps as unknown as { authorizePush: ReturnType<typeof vi.fn> }).authorizePush;
    expect(authorizePush).toHaveBeenCalledTimes(2);
    for (const call of authorizePush.mock.calls) {
      expect((call[0] as AuthorizeArgs).nodeIds).toEqual([]);
    }
    expect(sentOf(conn)).toHaveLength(2);
  });

  // @spec AC-3
  it('AC-3: the gateway performs no scope computation of its own — it delivers exactly the intersection Core returned', async () => {
    const registry = new ConnectionRegistry();
    const conn = chatConnection('c1');
    registry.add(conn);

    // Core authorizes ids the gateway could not have derived from anything in
    // the event: the only possible source of truth is Core's answer.
    const deps = relayDeps({
      authorizePush: vi.fn(async () => ({
        conversationId: CONVERSATION_ID,
        authorizedNodeIds: ['b-node', 'b-canvas'],
      })),
    });

    await relayChatEvent(
      completedEvent([
        citation({ nodeId: 'a-node', resolvedNodeId: 'a-canvas' }),
        citation({ nodeId: 'b-node', resolvedNodeId: 'b-canvas' }),
      ]),
      registry,
      deps,
    );

    const frame = sentOf(conn)[0] as { citations: Array<{ nodeId: string }> };
    expect(frame.citations.map((entry) => entry.nodeId)).toEqual(['b-node']);
  });

  // @spec AC-12
  it('AC-12: a Core response for a DIFFERENT conversation is never trusted — zero frames', async () => {
    const registry = new ConnectionRegistry();
    const conn = chatConnection('c1');
    registry.add(conn);

    const deps = relayDeps({
      authorizePush: vi.fn(async () => ({
        conversationId: 'some-other-conversation',
        authorizedNodeIds: ['file-login', 'canvas-login'],
      })),
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await relayChatEvent(completedEvent(), registry, deps);

    expect(sentOf(conn)).toHaveLength(0);
  });
});

describe('relayChatEvent — selection', () => {
  // @spec AC-2
  it('AC-2: a connection authenticated under a different org never matches, and is never even asked about', async () => {
    const registry = new ConnectionRegistry();
    const sameOrg = chatConnection('a', ORG_ID);
    const otherOrg = chatConnection('b', OTHER_ORG_ID);
    registry.add(sameOrg);
    registry.add(otherOrg);
    const deps = relayDeps();

    await relayChatEvent(progressEvent(1, ORG_ID), registry, deps);

    expect(sentOf(sameOrg)).toHaveLength(1);
    expect(sentOf(otherOrg)).toHaveLength(0);
    expect((deps as unknown as { authorizePush: ReturnType<typeof vi.fn> }).authorizePush).toHaveBeenCalledTimes(1);
  });

  // @spec AC-2
  it('AC-2: a connection with no subscription for this conversation receives nothing', async () => {
    const registry = new ConnectionRegistry();
    const conn = chatConnection('c1', ORG_ID, null); // subscribed to nothing
    registry.add(conn);
    const deps = relayDeps();

    await relayChatEvent(progressEvent(1), registry, deps);

    expect(sentOf(conn)).toHaveLength(0);
    expect((deps as unknown as { authorizePush: ReturnType<typeof vi.fn> }).authorizePush).not.toHaveBeenCalled();
  });

  // @spec EC-25
  it('EC-25: an event with no matching connection short-circuits — zero Core calls, zero frames', async () => {
    const registry = new ConnectionRegistry();
    registry.add(chatConnection('wrong-org', OTHER_ORG_ID));
    const deps = relayDeps();

    await expect(relayChatEvent(progressEvent(1), registry, deps)).resolves.toBeUndefined();

    expect((deps as unknown as { authorizePush: ReturnType<typeof vi.fn> }).authorizePush).not.toHaveBeenCalled();
  });
});

describe('relayChatEvent — fail closed', () => {
  // @spec AC-12 EC-12
  it('AC-12/EC-12: CoreUnavailableError (500 / network) delivers ZERO frames, keeps the subscription, and the next event still works', async () => {
    const registry = new ConnectionRegistry();
    const conn = chatConnection('c1');
    registry.add(conn);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const authorizePush = vi
      .fn()
      .mockRejectedValueOnce(new CoreUnavailableError())
      .mockResolvedValueOnce({
        conversationId: CONVERSATION_ID,
        authorizedNodeIds: ['file-login', 'canvas-login'],
      });
    const deps = relayDeps({ authorizePush });

    await expect(relayChatEvent(completedEvent(), registry, deps)).resolves.toBeUndefined();
    expect(sentOf(conn)).toHaveLength(0);
    expect(conn.chatSubscriptions.has(CONVERSATION_ID)).toBe(true);

    await relayChatEvent(completedEvent(), registry, deps);
    expect(sentOf(conn)).toHaveLength(1);
    expect((sentOf(conn)[0] as { citations: unknown[] }).citations).toHaveLength(1);
  });

  // @spec EC-12
  it('EC-12: the unavailable-Core log never contains the bearer token', async () => {
    const registry = new ConnectionRegistry();
    const conn = chatConnection('c1', ORG_ID, CONVERSATION_ID, 'tok-super-secret-value');
    registry.add(conn);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const deps = relayDeps({
      authorizePush: vi.fn(async () => {
        throw new CoreUnavailableError();
      }),
    });

    await relayChatEvent(completedEvent(), registry, deps);

    expect(JSON.stringify(logged.mock.calls)).not.toContain('tok-super-secret-value');
  });

  // @spec EC-13
  it('EC-13: CoreUnauthorizedError (401 mid-turn) fires onUnauthorized and delivers no event frame', async () => {
    const registry = new ConnectionRegistry();
    const conn = chatConnection('c1');
    registry.add(conn);
    const deps = relayDeps({
      authorizePush: vi.fn(async () => {
        throw new CoreUnauthorizedError();
      }),
    });

    await relayChatEvent(completedEvent(), registry, deps);

    expect((deps as unknown as { onUnauthorized: ReturnType<typeof vi.fn> }).onUnauthorized).toHaveBeenCalledWith(conn);
    expect(sentOf(conn)).toHaveLength(0);
  });

  // @spec EC-14
  it('EC-14: CoreForbiddenError (403/404 mid-turn) sends exactly one generic error frame, no event data, and revokes the subscription', async () => {
    const registry = new ConnectionRegistry();
    const conn = chatConnection('c1');
    registry.add(conn);
    const onSubscriptionRevoked = vi.fn(async (revoked: GatewayConnection, conversationId: string) => {
      (revoked as ChatConnection).chatSubscriptions.delete(conversationId);
    });
    const deps = relayDeps({
      authorizePush: vi.fn(async () => {
        throw new CoreForbiddenError();
      }),
      onSubscriptionRevoked,
    });

    await relayChatEvent(completedEvent(), registry, deps);

    expect(sentOf(conn)).toEqual([
      { type: 'error', code: 'chat_forbidden', message: 'Conversation not found.' },
    ]);
    expect(onSubscriptionRevoked).toHaveBeenCalledWith(conn, CONVERSATION_ID);
    expect(conn.chatSubscriptions.has(CONVERSATION_ID)).toBe(false);
    // No event data at all — not the answer, not a citation, not the metrics.
    expect(JSON.stringify(sentOf(conn))).not.toContain('Login is handled');
    expect(JSON.stringify(sentOf(conn))).not.toContain('file-login');
  });

  // @spec AC-12
  it('AC-12: an unexpected error type is rethrown rather than silently swallowed (mirrors fanout.ts)', async () => {
    const registry = new ConnectionRegistry();
    registry.add(chatConnection('c1'));
    const deps = relayDeps({
      authorizePush: vi.fn(async () => {
        throw new TypeError('programmer error');
      }),
    });

    await expect(relayChatEvent(completedEvent(), registry, deps)).rejects.toBeInstanceOf(TypeError);
  });
});

describe('relayChatEvent — socket robustness', () => {
  // @spec EC-11 EC-23
  it('EC-11/EC-23: a socket closed mid-turn is a silent no-op, not a crash', async () => {
    const registry = new ConnectionRegistry();
    const conn = chatConnection('c1');
    (conn.socket as unknown as FakeSocket).readyState = 3; // CLOSED
    registry.add(conn);

    await expect(relayChatEvent(completedEvent(), registry, relayDeps())).resolves.toBeUndefined();
    expect(sentOf(conn)).toHaveLength(0);
  });

  // @spec EC-23
  it('EC-23: a socket whose send() throws is swallowed and logged; relayChatEvent still resolves', async () => {
    const registry = new ConnectionRegistry();
    const conn = chatConnection('c1');
    (conn.socket as unknown as FakeSocket).sendThrows = true;
    registry.add(conn);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(relayChatEvent(completedEvent(), registry, relayDeps())).resolves.toBeUndefined();
  });

  // @spec EC-11
  it('EC-11: one closed connection never stops a still-open sibling from receiving the push', async () => {
    const registry = new ConnectionRegistry();
    const closed = chatConnection('closed');
    (closed.socket as unknown as FakeSocket).readyState = 3;
    const open = chatConnection('open');
    registry.add(closed);
    registry.add(open);

    await relayChatEvent(progressEvent(1), registry, relayDeps());

    expect(sentOf(closed)).toHaveLength(0);
    expect(sentOf(open)).toHaveLength(1);
  });
});
