// CH-06 fix-round-1 regression coverage — apps/web/app/workspace/chat/ChatProvider.tsx's degraded
// polling effect (review.md Critical 1 and Critical 2, both traced to spec.md EC-9 / EC-24).
//
// This is a NEW file, written for this fix round only: `.pipeline/red.json`'s 8 listed test files are
// left untouched (see changes.md's "Red-test changes" section — none of them were edited). It covers
// exactly the paths review.md identified as both broken and untested:
//   - EC-9's two untested degraded-mode triggers (WebSocket construction throws; the socket closes
//     before it ever opens), proving each still lands in degraded mode AND still polls;
//   - C1: a second question asked in degraded mode is polled and completes on its own (no "Check
//     again" click), the poll-attempt budget is scoped per turn rather than per session, and the
//     first poll survives a `postTurn` slower than the poll interval;
//   - EC-24's untested trigger (a gateway `{ type: 'error', code: 'unauthenticated' }` frame), and
//     C2: session expiry actually stops the degraded poller instead of starting it, and a 401 from a
//     degraded `GET` stops the poller immediately rather than retrying in a loop.
//
// Harness notes: same approach as AskSayrePanel.test.tsx (vitest `environment: 'node'`, no DOM, drives
// the provider through react-test-renderer). Its `installBackend`/`FakeSocket`/`flush` helpers are not
// exported, so this file re-implements minimal equivalents locally rather than editing that red-listed
// file to share them. This file talks to `WorkspaceChatProvider` directly through `useWorkspaceChat()`
// (no `AskSayreDock` mount, no DOM contract assertions) — the bugs and the fix both live entirely in
// the provider's effects, so a hook-level probe is the most direct behavioral proof of them.

import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtureWorkspaceDataSource, type WorkspaceDataSource } from '../dataSource';
import { WorkspaceStateStoreProvider } from '../state/store';
import { WorkspaceSessionProvider, useWorkspaceSession } from '../state/session';
import { WorkspaceSelectionProvider } from '../state/selection';
import { WorkspaceQueryProvider } from '../state/queries';
import { WorkspaceChatProvider, useWorkspaceChat, type WorkspaceChatContextValue } from './ChatProvider';
import { CHAT_DEGRADED_POLL_INTERVAL_MS, CHAT_DEGRADED_POLL_MAX_ATTEMPTS } from './chatContract';

(globalThis as unknown as { React: typeof React }).React = React;

const GATEWAY_URL = 'ws://localhost:4100/';

// ---------------------------------------------------------------- fake socket

/**
 * Unlike AskSayrePanel.test.tsx's FakeSocket, `close()` here genuinely emits a
 * 'close' event (asynchronously, via a microtask — real WebSocket close is
 * never synchronous either). That is deliberate: C2 depends on
 * `handleSessionExpired`'s own `socket.close()` reaching the provider's
 * `close` listener, which is exactly the path AskSayrePanel.test.tsx's fake
 * (whose `close()` is a silent no-op) never exercised.
 */
class RecoverySocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState: number = RecoverySocket.CONNECTING;
  readonly sent: string[] = [];

  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(readonly url: string) {
    sockets.push(this);
  }

  addEventListener(type: string, handler: (event: unknown) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(handler);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, handler: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(handler);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  /** Mirrors a real WebSocket: a programmatic close() still fires 'close'. */
  close(code?: number): void {
    if (this.readyState === RecoverySocket.CLOSED || this.readyState === RecoverySocket.CLOSING) return;
    this.readyState = RecoverySocket.CLOSING;
    queueMicrotask(() => {
      this.readyState = RecoverySocket.CLOSED;
      this.emit('close', { code, wasClean: code === undefined || code === 1000, reason: '' });
    });
  }

  frames(): Array<Record<string, unknown>> {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }

  private emit(type: string, event: unknown): void {
    this.listeners.get(type)?.forEach((handler) => handler(event));
  }

  simulateOpen(): void {
    this.readyState = RecoverySocket.OPEN;
    this.emit('open', {});
  }

  simulateMessage(payload: unknown): void {
    this.emit('message', { data: typeof payload === 'string' ? payload : JSON.stringify(payload) });
  }

  /** A network-initiated close arriving with no prior simulateOpen() (EC-9 trigger 3). */
  simulateClose(code = 1006): void {
    if (this.readyState === RecoverySocket.CLOSED) return;
    this.readyState = RecoverySocket.CLOSED;
    this.emit('close', { code, wasClean: false, reason: '' });
  }
}

/** EC-9 trigger 1: the WebSocket constructor itself throws. */
class ThrowingSocket {
  constructor(_url: string) {
    throw new Error('socket construction failed');
  }
}

let sockets: RecoverySocket[] = [];

// --------------------------------------------------------------- fake backend

interface TurnRow {
  id: string;
  conversationId: string;
  seq: number;
  role: 'user' | 'assistant';
  content: string;
  status: 'pending' | 'running' | 'completed' | 'error';
  citations: unknown[] | null;
  metrics: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  createdAt: string;
}

interface BackendOptions {
  postStatus?: number;
  getStatus?: number;
  postDelayMs?: number;
}

interface Backend {
  options: BackendOptions;
  creates: number;
  gets: string[];
  posts: Array<{ conversationId: string; body: Record<string, unknown> }>;
  turns: TurnRow[];
  lastAssistantTurnId: string | null;
  conversationId: string;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Options object is intentionally mutated mid-test (e.g. flipping on a 401) rather than fixed at install time. */
function installBackend(options: BackendOptions = {}): Backend {
  const backend: Backend = {
    options,
    creates: 0,
    gets: [],
    posts: [],
    turns: [],
    lastAssistantTurnId: null,
    conversationId: 'conv_1',
  };

  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : String(input);
    const method = (init.method ?? 'GET').toUpperCase();
    const conversation = {
      id: backend.conversationId,
      title: null,
      createdAt: '2026-08-10T12:00:00.000Z',
      updatedAt: '2026-08-10T12:00:00.000Z',
    };

    if (/\/api\/core\/chat\/conversations$/.test(url) && method === 'POST') {
      backend.creates += 1;
      return json({ conversation }, 201);
    }

    const turnsMatch = /\/api\/core\/chat\/conversations\/([^/?]+)\/turns$/.exec(url);
    if (turnsMatch !== null && method === 'POST') {
      if (backend.options.postDelayMs !== undefined) await delay(backend.options.postDelayMs);
      const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as Record<string, unknown>;
      backend.posts.push({ conversationId: decodeURIComponent(turnsMatch[1]!), body });
      if (backend.options.postStatus !== undefined) return json({ error: { message: 'nope' } }, backend.options.postStatus);
      const ordinal = backend.posts.length;
      const userTurn: TurnRow = {
        id: `turn_${ordinal}_user`,
        conversationId: backend.conversationId,
        seq: ordinal * 2 - 1,
        role: 'user',
        content: String(body.question ?? ''),
        status: 'completed',
        citations: null,
        metrics: null,
        error: null,
        createdAt: `2026-08-10T12:0${ordinal}:01.000Z`,
      };
      const assistantTurn: TurnRow = {
        ...userTurn,
        id: `turn_${ordinal}_assistant`,
        seq: ordinal * 2,
        role: 'assistant',
        content: '',
        status: 'pending',
        createdAt: `2026-08-10T12:0${ordinal}:02.000Z`,
      };
      backend.turns.push(userTurn, assistantTurn);
      backend.lastAssistantTurnId = assistantTurn.id;
      return json({ conversationId: backend.conversationId, userTurn, assistantTurn }, 202);
    }

    const detailMatch = /\/api\/core\/chat\/conversations\/([^/?]+)$/.exec(url);
    if (detailMatch !== null && method === 'GET') {
      backend.gets.push(decodeURIComponent(detailMatch[1]!));
      if (backend.options.getStatus !== undefined) return json({ error: { message: 'nope' } }, backend.options.getStatus);
      return json({ conversation, turns: backend.turns }, 200);
    }

    return json({ error: { message: 'not found' } }, 404);
  }));

  return backend;
}

// ------------------------------------------------------------------- mounting

interface ProbeSink {
  chat: WorkspaceChatContextValue;
  session: ReturnType<typeof useWorkspaceSession>;
}

function Probe({ sink }: { sink: Partial<ProbeSink> }) {
  sink.chat = useWorkspaceChat();
  sink.session = useWorkspaceSession();
  return null;
}

function liveSource(): WorkspaceDataSource {
  return { ...fixtureWorkspaceDataSource, id: 'live' } as WorkspaceDataSource;
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(1);
  else await new Promise((resolve) => setTimeout(resolve, 0));
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

interface MountOptions {
  gatewayWsUrl?: string | null;
}

interface Mounted {
  renderer: TestRenderer.ReactTestRenderer;
  sink: Partial<ProbeSink>;
}

async function mountChat(options: MountOptions = {}): Promise<Mounted> {
  const sink: Partial<ProbeSink> = {};
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <WorkspaceStateStoreProvider
        source={liveSource()}
        gatewayWsUrl={options.gatewayWsUrl === undefined ? GATEWAY_URL : options.gatewayWsUrl}
      >
        <WorkspaceSessionProvider>
          <WorkspaceSelectionProvider>
            <WorkspaceQueryProvider>
              <WorkspaceChatProvider>
                <Probe sink={sink} />
              </WorkspaceChatProvider>
            </WorkspaceQueryProvider>
          </WorkspaceSelectionProvider>
        </WorkspaceSessionProvider>
      </WorkspaceStateStoreProvider>,
    );
    await flush();
  });
  return { renderer, sink };
}

async function connectSocket(): Promise<RecoverySocket> {
  const socket = sockets.at(-1);
  expect(socket, 'the chat provider never constructed a WebSocket').toBeDefined();
  await act(async () => {
    socket!.simulateOpen();
    await flush();
  });
  await act(async () => {
    socket!.simulateMessage({ type: 'ready' });
    await flush();
  });
  return socket!;
}

async function push(socket: RecoverySocket, frame: unknown): Promise<void> {
  await act(async () => {
    socket.simulateMessage(frame);
    await flush();
  });
}

async function askQuestion(sink: Partial<ProbeSink>, question: string): Promise<void> {
  await act(async () => {
    sink.chat!.ask(question);
    await flush();
  });
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

// ---------------------------------------------------------------------- setup

let mounted: TestRenderer.ReactTestRenderer | null = null;

function stubBrowserGlobals(): void {
  sockets = [];
  vi.stubGlobal('window', {
    location: { protocol: 'https:', hostname: 'app.test', search: '' },
    history: { replaceState: () => undefined },
    localStorage: {
      getItem: () => 'session-token',
      setItem: () => undefined,
      removeItem: () => undefined,
    },
  });
  vi.stubGlobal('WebSocket', RecoverySocket as unknown as typeof WebSocket);
}

beforeEach(stubBrowserGlobals);

afterEach(async () => {
  if (mounted !== null) {
    const renderer = mounted;
    mounted = null;
    await act(async () => renderer.unmount());
  }
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function open(options: MountOptions = {}): Promise<Mounted> {
  const result = await mountChat(options);
  mounted = result.renderer;
  return result;
}

// ------------------------------------------------------- EC-9: untested triggers

describe('EC-9 — degraded-mode triggers the red suite never exercised', () => {
  // @spec EC-9
  it('a WebSocket constructor that throws lands in degraded mode and still polls', async () => {
    vi.useFakeTimers();
    const backend = installBackend();
    const { sink } = await open();
    vi.stubGlobal('WebSocket', ThrowingSocket as unknown as typeof WebSocket);

    await askQuestion(sink, 'What does this folder do?');

    expect(sockets).toHaveLength(0);
    expect(sink.chat!.live).toBe('degraded');
    expect(backend.posts).toHaveLength(1);

    const before = backend.gets.length;
    await advance(CHAT_DEGRADED_POLL_INTERVAL_MS + 50);
    expect(backend.gets.length).toBeGreaterThan(before);
  });

  // @spec EC-9
  it('a socket that closes before it ever opens lands in degraded mode and still polls', async () => {
    vi.useFakeTimers();
    const backend = installBackend();
    const { sink } = await open();

    await askQuestion(sink, 'What does this folder do?');
    const socket = sockets.at(-1);
    expect(socket).toBeDefined();
    expect(socket!.readyState).toBe(RecoverySocket.CONNECTING);

    await act(async () => {
      socket!.simulateClose(1006);
      await flush();
    });

    expect(sink.chat!.live).toBe('degraded');
    const before = backend.gets.length;
    await advance(CHAT_DEGRADED_POLL_INTERVAL_MS + 50);
    expect(backend.gets.length).toBeGreaterThan(before);
  });
});

// ------------------------------------------------------------------------- C1

describe('C1 — the degraded poller must not permanently stop after the first idle tick', () => {
  // @spec EC-9
  it('a second question asked in degraded mode is polled and completes on its own, without "Check again"', async () => {
    vi.useFakeTimers();
    const backend = installBackend();
    const { sink } = await open({ gatewayWsUrl: null });

    await askQuestion(sink, 'first question');
    expect(backend.posts).toHaveLength(1);
    expect(sink.chat!.live).toBe('degraded');
    expect(sink.chat!.busy).toBe(true);

    // Let the first turn complete purely through the poller (no refresh() call).
    const firstAssistant = backend.turns.find((turn) => turn.id === backend.lastAssistantTurnId)!;
    firstAssistant.status = 'completed';
    firstAssistant.content = 'First answer.';
    await advance(CHAT_DEGRADED_POLL_INTERVAL_MS + 50);
    expect(sink.chat!.busy).toBe(false);
    expect(sink.chat!.turns.find((turn) => turn.id === firstAssistant.id)?.content).toBe('First answer.');

    // Drain one more interval before asking the next question. The buggy
    // pre-fix `tick` rescheduled itself unconditionally on completion (it only
    // ever checked `hasActiveTurn` at the *start* of the next tick), so the
    // very first idle tick after a turn completes is not actually the one
    // that kills the chain — the *second* one is. Waiting past it here means
    // the assertions below can only pass because a *new* turn re-arms the
    // poller, not because a stale, about-to-die timer happened to still be
    // ticking when the second question was posted.
    await advance(CHAT_DEGRADED_POLL_INTERVAL_MS + 50);
    const getsAfterFirstTurn = backend.gets.length;

    // The regression: under the pre-fix code, no timer was ever re-armed for a
    // turn started after the first idle tick, so this second question would
    // sit pending forever without a manual "Check again".
    await askQuestion(sink, 'second question');
    expect(backend.posts).toHaveLength(2);
    expect(sink.chat!.busy).toBe(true);

    await advance(CHAT_DEGRADED_POLL_INTERVAL_MS + 50);
    expect(backend.gets.length).toBeGreaterThan(getsAfterFirstTurn);

    const secondAssistant = backend.turns.find((turn) => turn.id === backend.lastAssistantTurnId)!;
    secondAssistant.status = 'completed';
    secondAssistant.content = 'Second answer.';
    await advance(CHAT_DEGRADED_POLL_INTERVAL_MS + 50);
    expect(sink.chat!.turns.find((turn) => turn.id === secondAssistant.id)?.content).toBe('Second answer.');
    expect(sink.chat!.busy).toBe(false);
  });

  // @spec EC-9
  it('the poll-attempt budget is scoped per turn, not to the (conversationId, live) session', async () => {
    vi.useFakeTimers();
    const backend = installBackend();
    const { sink } = await open({ gatewayWsUrl: null });

    await askQuestion(sink, 'first question');

    // Consume part of turn 1's budget without letting it complete.
    await advance(CHAT_DEGRADED_POLL_INTERVAL_MS * 5 + 50);
    const consumedByFirstTurn = backend.gets.length;
    expect(consumedByFirstTurn).toBeGreaterThan(0);
    expect(consumedByFirstTurn).toBeLessThan(CHAT_DEGRADED_POLL_MAX_ATTEMPTS);

    // Let it complete on the very next poll.
    const firstAssistant = backend.turns.find((turn) => turn.id === backend.lastAssistantTurnId)!;
    firstAssistant.status = 'completed';
    await advance(CHAT_DEGRADED_POLL_INTERVAL_MS + 50);
    expect(sink.chat!.busy).toBe(false);
    const getsAfterFirstTurn = backend.gets.length;

    // Ask a second question and drive it toward its own full budget. If
    // `attempts` were a session-lifetime counter (the bug) rather than
    // per-turn, turn 2 would starve at `MAX_ATTEMPTS - consumedByFirstTurn`
    // calls instead of getting its own fresh ~MAX_ATTEMPTS.
    await askQuestion(sink, 'second question');
    await advance(CHAT_DEGRADED_POLL_INTERVAL_MS * (CHAT_DEGRADED_POLL_MAX_ATTEMPTS + 6));
    const consumedBySecondTurn = backend.gets.length - getsAfterFirstTurn;
    expect(consumedBySecondTurn).toBeGreaterThanOrEqual(CHAT_DEGRADED_POLL_MAX_ATTEMPTS - 1);
    expect(consumedBySecondTurn).toBeLessThanOrEqual(CHAT_DEGRADED_POLL_MAX_ATTEMPTS + 1);
  });

  // @spec EC-9
  it('the first degraded poll survives a postTurn slower than the poll interval', async () => {
    vi.useFakeTimers();
    const backend = installBackend({ postDelayMs: CHAT_DEGRADED_POLL_INTERVAL_MS + 1_000 });
    const { sink } = await open({ gatewayWsUrl: null });

    act(() => {
      sink.chat!.ask('slow question');
    });
    // Conversation creation and the socket-unavailable degrade both resolve
    // fast; the slow postTurn does not.
    await act(async () => {
      await flush();
    });
    expect(sink.chat!.live).toBe('degraded');
    expect(sink.chat!.busy).toBe(false);
    expect(backend.posts).toHaveLength(0);

    // Advance past a full poll interval while postTurn is still pending. Under
    // the pre-fix code this is exactly where an idle tick fired, found no
    // active turn, and killed the chain before the turn ever existed.
    await advance(CHAT_DEGRADED_POLL_INTERVAL_MS + 50);
    expect(backend.gets).toHaveLength(0);

    // Let the slow POST resolve.
    await advance(1_000);
    expect(backend.posts).toHaveLength(1);
    expect(sink.chat!.busy).toBe(true);

    // The chain must still be alive: the next interval produces a poll.
    const before = backend.gets.length;
    await advance(CHAT_DEGRADED_POLL_INTERVAL_MS + 50);
    expect(backend.gets.length).toBeGreaterThan(before);
  });
});

// ------------------------------------------------------------------------- C2

describe('C2 — session expiry must stop the degraded poller, and must never start it', () => {
  // @spec EC-24
  it('a gateway "unauthenticated" error frame stops the session and never starts the degraded poller', async () => {
    vi.useFakeTimers();
    const backend = installBackend();
    const { sink } = await open();

    await askQuestion(sink, 'What does this folder do?');
    expect(backend.posts).toHaveLength(1);

    const socket = await connectSocket();
    expect(sink.chat!.live).toBe('connected');
    const getsBeforeExpiry = backend.gets.length;

    await push(socket, { type: 'error', code: 'unauthenticated', message: 'Session expired.' });

    expect(sink.session!.session).toBe('session-expired');
    // The regression: handleSessionExpired's own socket.close() used to fire
    // the still-registered close listener, which fell through to
    // setLive('degraded') — session expiry starting the very poller EC-24
    // says it must stop.
    expect(sink.chat!.live).not.toBe('degraded');

    // Give a wrongly-started poller every opportunity to have fired.
    await advance(CHAT_DEGRADED_POLL_INTERVAL_MS * 3);
    expect(backend.gets.length).toBe(getsBeforeExpiry);
    expect(backend.posts).toHaveLength(1);
    expect(sockets).toHaveLength(1);
  });

  // @spec EC-24
  it('a 401 from a degraded GET stops the poller immediately and does not retry in a loop', async () => {
    vi.useFakeTimers();
    const backend = installBackend();
    const { sink } = await open({ gatewayWsUrl: null });

    await askQuestion(sink, 'What does this folder do?');
    expect(sink.chat!.live).toBe('degraded');

    // First poll succeeds (turn still pending server-side).
    const beforeFirstPoll = backend.gets.length;
    await advance(CHAT_DEGRADED_POLL_INTERVAL_MS + 50);
    expect(backend.gets.length).toBeGreaterThan(beforeFirstPoll);
    expect(sink.session!.session).not.toBe('session-expired');

    // The session then expires: the very next poll gets a 401.
    backend.options.getStatus = 401;
    const beforeExpiry = backend.gets.length;
    await advance(CHAT_DEGRADED_POLL_INTERVAL_MS + 50);
    expect(backend.gets.length).toBeGreaterThan(beforeExpiry);
    expect(sink.session!.session).toBe('session-expired');

    // No further polling, however long we wait.
    const afterExpiry = backend.gets.length;
    await advance(CHAT_DEGRADED_POLL_INTERVAL_MS * (CHAT_DEGRADED_POLL_MAX_ATTEMPTS + 5));
    expect(backend.gets.length).toBe(afterExpiry);
  });
});
