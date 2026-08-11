// CH-06 re-gate fix round 2 — review.md's Fix list item 6 (R-2, "should"): CH-05's real gateway
// (packages/shared-types's ClientToGatewayMessage / GatewayToClientMessage) acks a chat subscribe with
// `{ type: 'subscribed', channel: 'chat', conversationId }`. Before this round's C-1 fix, the client's
// outbound frame was rejected outright by CH-05's gateway (see review.md's C-1), so this ack could never
// arrive in real operation. Once the outbound frame is corrected (ChatProvider.tsx, this round), the
// client receives this ack for the first time ever — this file pins that it is received and ignored
// without mutating the transcript, closing the regression-protection gap review flagged.
//
// This is a NEW file, not an edit to any of .pipeline/red.json's 8 listed files (see changes.md's
// "Red-test changes" section for this round's only declared amendments, which are unrelated lines in
// AskSayrePanel.test.tsx). Structurally, the ack is discarded twice over: `parseGatewayMessage`
// (apps/web/app/workspace/realtime.ts) only recognizes a `subscribed` frame carrying `repoId`, so the
// chat variant (`channel`/`conversationId`, no `repoId`) already returns null there; even if it did not,
// `parseChatGatewayMessage` (chatContract.ts) is a closed match over exactly the three `chat.turn.*`
// types and returns null for anything else, the same path EC-20 already exercises for a malformed frame.
// @spec EC-20

import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtureWorkspaceDataSource, type WorkspaceDataSource } from '../dataSource';
import { WorkspaceStateStoreProvider } from '../state/store';
import { WorkspaceSessionProvider } from '../state/session';
import { WorkspaceSelectionProvider } from '../state/selection';
import { WorkspaceQueryProvider } from '../state/queries';
import { WorkspaceChatProvider, useWorkspaceChat, type WorkspaceChatContextValue } from './ChatProvider';

(globalThis as unknown as { React: typeof React }).React = React;

const GATEWAY_URL = 'ws://localhost:4100/';

// ---------------------------------------------------------------- fake socket

class AckSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState: number = AckSocket.CONNECTING;
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

  close(): void {
    if (this.readyState === AckSocket.CLOSED || this.readyState === AckSocket.CLOSING) return;
    this.readyState = AckSocket.CLOSED;
  }

  frames(): Array<Record<string, unknown>> {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }

  private emit(type: string, event: unknown): void {
    this.listeners.get(type)?.forEach((handler) => handler(event));
  }

  simulateOpen(): void {
    this.readyState = AckSocket.OPEN;
    this.emit('open', {});
  }

  simulateMessage(payload: unknown): void {
    this.emit('message', { data: typeof payload === 'string' ? payload : JSON.stringify(payload) });
  }
}

let sockets: AckSocket[] = [];

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

interface Backend {
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

function installBackend(): Backend {
  const backend: Backend = {
    creates: 0,
    gets: [],
    posts: [],
    turns: [],
    lastAssistantTurnId: null,
    conversationId: 'conv_1',
  };

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = typeof input === 'string' ? input : String(input);
      const method = (init.method ?? 'GET').toUpperCase();
      const conversation = {
        id: backend.conversationId,
        title: null,
        createdAt: '2026-08-11T12:00:00.000Z',
        updatedAt: '2026-08-11T12:00:00.000Z',
      };

      if (/\/api\/core\/chat\/conversations$/.test(url) && method === 'POST') {
        backend.creates += 1;
        return json({ conversation }, 201);
      }

      const turnsMatch = /\/api\/core\/chat\/conversations\/([^/?]+)\/turns$/.exec(url);
      if (turnsMatch !== null && method === 'POST') {
        const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as Record<string, unknown>;
        backend.posts.push({ conversationId: decodeURIComponent(turnsMatch[1]!), body });
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
          createdAt: `2026-08-11T12:0${ordinal}:01.000Z`,
        };
        const assistantTurn: TurnRow = {
          ...userTurn,
          id: `turn_${ordinal}_assistant`,
          seq: ordinal * 2,
          role: 'assistant',
          content: '',
          status: 'pending',
          createdAt: `2026-08-11T12:0${ordinal}:02.000Z`,
        };
        backend.turns.push(userTurn, assistantTurn);
        backend.lastAssistantTurnId = assistantTurn.id;
        return json({ conversationId: backend.conversationId, userTurn, assistantTurn }, 202);
      }

      const detailMatch = /\/api\/core\/chat\/conversations\/([^/?]+)$/.exec(url);
      if (detailMatch !== null && method === 'GET') {
        backend.gets.push(decodeURIComponent(detailMatch[1]!));
        return json({ conversation, turns: backend.turns }, 200);
      }

      return json({ error: { message: 'not found' } }, 404);
    }),
  );

  return backend;
}

// ------------------------------------------------------------------- mounting

interface ProbeSink {
  chat: WorkspaceChatContextValue;
}

function Probe({ sink }: { sink: Partial<ProbeSink> }) {
  sink.chat = useWorkspaceChat();
  return null;
}

function liveSource(): WorkspaceDataSource {
  return { ...fixtureWorkspaceDataSource, id: 'live' } as WorkspaceDataSource;
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

interface Mounted {
  renderer: TestRenderer.ReactTestRenderer;
  sink: Partial<ProbeSink>;
}

async function mountChat(): Promise<Mounted> {
  const sink: Partial<ProbeSink> = {};
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <WorkspaceStateStoreProvider source={liveSource()} gatewayWsUrl={GATEWAY_URL}>
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

async function connectSocket(): Promise<AckSocket> {
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
  vi.stubGlobal('WebSocket', AckSocket as unknown as typeof WebSocket);
}

beforeEach(stubBrowserGlobals);

afterEach(async () => {
  if (mounted !== null) {
    const renderer = mounted;
    mounted = null;
    await act(async () => renderer.unmount());
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function open(): Promise<Mounted> {
  const result = await mountChat();
  mounted = result.renderer;
  return result;
}

// ------------------------------------------------------------------ the test

describe('CH-05 chat subscribe ack', () => {
  // @spec EC-20
  it('receives { type: "subscribed", channel: "chat", conversationId } and ignores it without mutating the transcript', async () => {
    const backend = installBackend();
    const { sink } = await open();

    await act(async () => {
      sink.chat!.ask('What does this folder do?');
      await flush();
    });
    expect(backend.posts).toHaveLength(1);

    const socket = await connectSocket();
    // The corrected outbound frame (this round's C-1 fix) is exactly what CH-05's gateway acks.
    expect(
      socket
        .frames()
        .some((frame) => frame.type === 'subscribe' && frame.channel === 'chat' && frame.conversationId === 'conv_1'),
    ).toBe(true);

    const getsBeforeAck = backend.gets.length;
    const turnsBeforeAck = sink.chat!.turns;
    const busyBeforeAck = sink.chat!.busy;
    const liveBeforeAck = sink.chat!.live;

    await act(async () => {
      socket.simulateMessage({ type: 'subscribed', channel: 'chat', conversationId: 'conv_1' });
      await flush();
    });

    // No state mutation at all: the transcript array is the exact same reference, because the handler
    // returns early on a null parse rather than calling setTranscript with an equivalent value.
    expect(sink.chat!.turns).toBe(turnsBeforeAck);
    expect(sink.chat!.busy).toBe(busyBeforeAck);
    expect(sink.chat!.live).toBe(liveBeforeAck);
    // The ack triggers no REST call of its own.
    expect(backend.gets.length).toBe(getsBeforeAck);
  });
});
