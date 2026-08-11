// CH-06 red suite — the Ask Sayre dock, its chat provider, and the DOM contract
// spec.md pins for it. Authored from .pipeline/spec.md before any
// implementation exists.
//
// Harness notes (vitest `environment: 'node'`, see apps/web/vitest.config.ts):
// there is no DOM and no jsdom, so this file uses react-test-renderer the same
// way WorkspaceLayout.test.tsx / SystemRecoveryMenu.test.tsx already do, stubs
// `window` the way coreFetch.test.ts already does, and drives CH-05's pinned
// gateway frames through a fake WebSocket. Nothing here needs a running
// gateway, a real socket, a network call, or a database.

import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtureWorkspaceDataSource, type WorkspaceDataSource } from '../dataSource';
import { MockProvider } from '../state';
import { WorkspaceStateStoreProvider } from '../state/store';
import { WorkspaceSessionProvider, useWorkspaceSession } from '../state/session';
import { WorkspaceNavigationProvider, useWorkspaceNavigation } from '../state/navigation';
import { WorkspaceSelectionProvider, useWorkspaceSelection } from '../state/selection';
import { WorkspaceQueryProvider } from '../state/queries';
import type { ViewId } from '../types';
import { AskSayreDock } from '../components/AskSayrePanel';
import { WorkspaceChatProvider, useWorkspaceChat, type WorkspaceChatContextValue } from './ChatProvider';
import {
  CHAT_DEGRADED_POLL_INTERVAL_MS,
  CHAT_DEGRADED_POLL_MAX_ATTEMPTS,
  CHAT_QUESTION_MAX_CHARACTERS,
} from './chatContract';

(globalThis as unknown as { React: typeof React }).React = React;

const GATEWAY_URL = 'ws://localhost:4100/';

// ---------------------------------------------------------------- fake socket

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = FakeSocket.CONNECTING;
  readonly sent: string[] = [];
  readonly closeCodes: Array<number | undefined> = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

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

  close(code?: number): void {
    this.readyState = FakeSocket.CLOSED;
    this.closeCodes.push(code);
  }

  frames(): Array<Record<string, unknown>> {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }

  private emit(type: string, event: unknown): void {
    this.listeners.get(type)?.forEach((handler) => handler(event));
    const inline = (this as unknown as Record<string, unknown>)[`on${type}`];
    if (typeof inline === 'function') (inline as (value: unknown) => void)(event);
  }

  simulateOpen(): void {
    this.readyState = FakeSocket.OPEN;
    this.emit('open', {});
  }

  simulateMessage(payload: unknown): void {
    this.emit('message', { data: typeof payload === 'string' ? payload : JSON.stringify(payload) });
  }

  simulateClose(code = 1006): void {
    this.readyState = FakeSocket.CLOSED;
    this.emit('close', { code, wasClean: false, reason: '' });
  }
}

let sockets: FakeSocket[] = [];

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
  createStatus?: number;
  postStatus?: number;
  getStatus?: number;
}

interface Backend {
  creates: number;
  gets: string[];
  posts: Array<{ conversationId: string; body: Record<string, unknown> }>;
  turns: TurnRow[];
  lastAssistantTurnId: string | null;
  lastUserTurnId: string | null;
  conversationId: string;
  otherCalls: string[];
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function installBackend(options: BackendOptions = {}): Backend {
  const backend: Backend = {
    creates: 0,
    gets: [],
    posts: [],
    turns: [],
    lastAssistantTurnId: null,
    lastUserTurnId: null,
    conversationId: 'conv_1',
    otherCalls: [],
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
      if (options.createStatus !== undefined) return json({ error: { message: 'nope' } }, options.createStatus);
      return json({ conversation }, 201);
    }

    const turnsMatch = /\/api\/core\/chat\/conversations\/([^/?]+)\/turns$/.exec(url);
    if (turnsMatch !== null && method === 'POST') {
      const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as Record<string, unknown>;
      backend.posts.push({ conversationId: decodeURIComponent(turnsMatch[1]!), body });
      if (options.postStatus !== undefined) return json({ error: { message: 'nope' } }, options.postStatus);
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
      backend.lastUserTurnId = userTurn.id;
      backend.lastAssistantTurnId = assistantTurn.id;
      return json({ conversationId: backend.conversationId, userTurn, assistantTurn }, 202);
    }

    const detailMatch = /\/api\/core\/chat\/conversations\/([^/?]+)$/.exec(url);
    if (detailMatch !== null && method === 'GET') {
      backend.gets.push(decodeURIComponent(detailMatch[1]!));
      if (options.getStatus !== undefined) return json({ error: { message: 'nope' } }, options.getStatus);
      return json({ conversation, turns: backend.turns }, 200);
    }

    backend.otherCalls.push(`${method} ${url}`);
    return json({ error: { message: 'not found' } }, 404);
  }));

  return backend;
}

// ------------------------------------------------------------------- mounting

interface ProbeSink {
  chat: WorkspaceChatContextValue;
  navigation: ReturnType<typeof useWorkspaceNavigation>;
  selection: ReturnType<typeof useWorkspaceSelection>;
  session: ReturnType<typeof useWorkspaceSession>;
}

function Probe({ sink }: { sink: Partial<ProbeSink> }) {
  sink.chat = useWorkspaceChat();
  sink.navigation = useWorkspaceNavigation();
  sink.selection = useWorkspaceSelection();
  sink.session = useWorkspaceSession();
  return null;
}

function liveSource(overrides: Partial<WorkspaceDataSource> = {}): WorkspaceDataSource {
  return { ...fixtureWorkspaceDataSource, id: 'live', ...overrides } as WorkspaceDataSource;
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(1);
  else await new Promise((resolve) => setTimeout(resolve, 0));
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

interface MountOptions {
  view?: ViewId;
  nodeId?: string | null;
  gatewayWsUrl?: string | null;
  source?: WorkspaceDataSource;
}

interface Mounted {
  renderer: TestRenderer.ReactTestRenderer;
  sink: Partial<ProbeSink>;
}

async function mountDock(options: MountOptions = {}): Promise<Mounted> {
  const sink: Partial<ProbeSink> = {};
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <WorkspaceStateStoreProvider
        source={options.source ?? liveSource()}
        gatewayWsUrl={options.gatewayWsUrl === undefined ? GATEWAY_URL : options.gatewayWsUrl}
        initialView={options.view ?? 'technical'}
        initialNodeId={options.nodeId ?? null}
      >
        <WorkspaceSessionProvider>
          <WorkspaceNavigationProvider>
            <WorkspaceSelectionProvider>
              <WorkspaceQueryProvider>
                <WorkspaceChatProvider>
                  <Probe sink={sink} />
                  <AskSayreDock />
                </WorkspaceChatProvider>
              </WorkspaceQueryProvider>
            </WorkspaceSelectionProvider>
          </WorkspaceNavigationProvider>
        </WorkspaceSessionProvider>
      </WorkspaceStateStoreProvider>,
    );
    await flush();
  });
  return { renderer, sink };
}

// ----------------------------------------------------------------- inspection

function textOf(instance: TestRenderer.ReactTestInstance): string {
  return instance.children
    .map((child) => (typeof child === 'string' ? child : textOf(child)))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function panelText(renderer: TestRenderer.ReactTestRenderer): string {
  return textOf(renderer.root);
}

function buttons(renderer: TestRenderer.ReactTestRenderer): TestRenderer.ReactTestInstance[] {
  return renderer.root.findAll((node) => node.type === 'button');
}

function accessibleName(instance: TestRenderer.ReactTestInstance): string {
  const label = instance.props['aria-label'];
  if (typeof label === 'string' && label.trim().length > 0) return label.trim();
  return textOf(instance);
}

function buttonNamed(renderer: TestRenderer.ReactTestRenderer, pattern: RegExp): TestRenderer.ReactTestInstance {
  const matches = buttons(renderer).filter((button) => pattern.test(accessibleName(button)));
  expect(matches.length, `expected a button matching ${pattern} in: ${panelText(renderer)}`).toBeGreaterThan(0);
  return matches[0]!;
}

function maybeButtonNamed(renderer: TestRenderer.ReactTestRenderer, pattern: RegExp): TestRenderer.ReactTestInstance | null {
  return buttons(renderer).find((button) => pattern.test(accessibleName(button))) ?? null;
}

function toggle(renderer: TestRenderer.ReactTestRenderer): TestRenderer.ReactTestInstance {
  const matches = buttons(renderer).filter((button) => button.props['aria-expanded'] !== undefined);
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

function panel(renderer: TestRenderer.ReactTestRenderer): TestRenderer.ReactTestInstance[] {
  return renderer.root.findAll((node) => node.props?.id === 'ask-sayre-panel');
}

function input(renderer: TestRenderer.ReactTestRenderer): TestRenderer.ReactTestInstance {
  const matches = renderer.root.findAll((node) => node.type === 'input' && node.props.id === 'ask-sayre-input');
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

function submitButton(renderer: TestRenderer.ReactTestRenderer): TestRenderer.ReactTestInstance {
  const matches = buttons(renderer).filter((button) => button.props.type === 'submit');
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

function statusRegions(renderer: TestRenderer.ReactTestRenderer): TestRenderer.ReactTestInstance[] {
  return renderer.root.findAll((node) => node.props?.role === 'status');
}

function hasStatedReason(renderer: TestRenderer.ReactTestRenderer): boolean {
  const described = input(renderer).props['aria-describedby'];
  const title = input(renderer).props.title;
  return (typeof described === 'string' && described.trim().length > 0)
    || (typeof title === 'string' && title.trim().length > 0)
    || statusRegions(renderer).some((region) => textOf(region).length > 0);
}

function jsonTree(renderer: TestRenderer.ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

// -------------------------------------------------------------------- actions

async function typeQuestion(renderer: TestRenderer.ReactTestRenderer, question: string): Promise<void> {
  await act(async () => {
    input(renderer).props.onChange({
      target: { value: question },
      currentTarget: { value: question },
      preventDefault: () => undefined,
    });
    await flush();
  });
}

async function submitComposer(renderer: TestRenderer.ReactTestRenderer): Promise<void> {
  const form = renderer.root.findByType('form');
  await act(async () => {
    form.props.onSubmit({ preventDefault: () => undefined, stopPropagation: () => undefined });
    await flush();
  });
}

async function ask(renderer: TestRenderer.ReactTestRenderer, question: string): Promise<void> {
  await typeQuestion(renderer, question);
  await submitComposer(renderer);
}

async function click(instance: TestRenderer.ReactTestInstance): Promise<void> {
  await act(async () => {
    instance.props.onClick({ preventDefault: () => undefined, stopPropagation: () => undefined });
    await flush();
  });
}

async function connectSocket(): Promise<FakeSocket> {
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

async function push(socket: FakeSocket, frame: unknown): Promise<void> {
  await act(async () => {
    socket.simulateMessage(frame);
    await flush();
  });
}

function progressFrame(turnId: string, seq: number, overrides: Record<string, unknown> = {}) {
  return {
    type: 'chat.turn.progress',
    conversationId: 'conv_1',
    turnId,
    seq,
    kind: 'status',
    tool: null,
    detail: 'Selecting context nodes',
    ts: '2026-08-10T12:00:03.000Z',
    ...overrides,
  };
}

function completedFrame(turnId: string, overrides: Record<string, unknown> = {}) {
  return {
    type: 'chat.turn.completed',
    conversationId: 'conv_1',
    turnId,
    answer: 'The checkout folder owns the cart-to-confirmation flow.',
    citations: [],
    metrics: { contextNodes: 12, tokensUsed: 900, baselineTokens: 34_200, ratio: 38 },
    ts: '2026-08-10T12:00:05.000Z',
    ...overrides,
  };
}

function errorFrame(turnId: string, overrides: Record<string, unknown> = {}) {
  return {
    type: 'chat.turn.error',
    conversationId: 'conv_1',
    turnId,
    code: 'chat.provider_unavailable',
    message: 'Sayre could not finish this answer.',
    ts: '2026-08-10T12:00:05.000Z',
    ...overrides,
  };
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
  vi.stubGlobal('WebSocket', FakeSocket as unknown as typeof WebSocket);
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
  const result = await mountDock(options);
  mounted = result.renderer;
  return result;
}

/** Unmounts the current dock and re-arms the fake browser globals for a second mount. */
async function restartHarness(): Promise<void> {
  if (mounted !== null) {
    const renderer = mounted;
    mounted = null;
    await act(async () => renderer.unmount());
  }
  vi.unstubAllGlobals();
  stubBrowserGlobals();
}

// ----------------------------------------------------------------------- dock

describe('Ask Sayre dock shell', () => {
  // @spec AC-18 AC-13
  it('collapses to a labeled rail and expands back to the panel', async () => {
    installBackend();
    const { renderer } = await open();

    const expandedToggle = toggle(renderer);
    expect(expandedToggle.props.type).toBe('button');
    expect(expandedToggle.props['aria-expanded']).toBe(true);
    expect(expandedToggle.props['aria-controls']).toBe('ask-sayre-panel');
    expect(accessibleName(expandedToggle).length).toBeGreaterThan(0);
    expect(panel(renderer)).toHaveLength(1);

    await click(expandedToggle);
    const collapsedToggle = toggle(renderer);
    expect(collapsedToggle.props['aria-expanded']).toBe(false);
    expect(accessibleName(collapsedToggle).length).toBeGreaterThan(0);
    expect(panel(renderer)).toHaveLength(0);
    expect(renderer.root.findAll((node) => node.type === 'input' && node.props.id === 'ask-sayre-input')).toHaveLength(0);
    expect(buttons(renderer)).toHaveLength(1);

    await click(toggle(renderer));
    expect(toggle(renderer).props['aria-expanded']).toBe(true);
    expect(panel(renderer)).toHaveLength(1);
  });

  // @spec AC-13
  it('exposes a natively submittable, labeled composer and keyboard-reachable buttons', async () => {
    installBackend();
    const { renderer } = await open();

    const form = renderer.root.findByType('form');
    expect(typeof form.props.onSubmit).toBe('function');
    const label = renderer.root.findAll((node) => node.type === 'label' && node.props.htmlFor === 'ask-sayre-input');
    expect(label).toHaveLength(1);
    expect(textOf(label[0]!).length).toBeGreaterThan(0);

    const field = input(renderer);
    expect(field.props.maxLength).toBe(CHAT_QUESTION_MAX_CHARACTERS);
    expect(form.findAll((node) => node.type === 'input' && node.props.id === 'ask-sayre-input')).toHaveLength(1);

    const submits = buttons(renderer).filter((button) => button.props.type === 'submit');
    expect(submits).toHaveLength(1);
    for (const button of buttons(renderer)) {
      expect(['button', 'submit']).toContain(button.props.type);
      expect(accessibleName(button).length, `a button rendered without an accessible name: ${JSON.stringify(button.props)}`).toBeGreaterThan(0);
      expect(button.props.tabIndex === undefined || button.props.tabIndex >= 0).toBe(true);
    }
  });

  // @spec AC-16
  it('renders the view-scoped chip and suggested prompt in all three views', async () => {
    const expected: Array<[ViewId, RegExp, string]> = [
      ['technical', /technical/i, 'Explain this folder'],
      ['product', /product/i, 'What feature does this belong to?'],
      ['onboarding', /onboarding/i, 'What should I start first?'],
    ];
    for (const [view, chipPattern, prompt] of expected) {
      installBackend();
      const { renderer } = await open({ view });
      expect(panelText(renderer)).toMatch(chipPattern);
      const promptButton = buttonNamed(renderer, new RegExp(prompt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
      expect(promptButton.props.type).toBe('button');
      await restartHarness();
    }
  });

  // @spec AC-16
  it('is mounted by the workspace provider tree rather than needing its own wiring', async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<MockProvider><AskSayreDock /></MockProvider>);
      await flush();
    });
    mounted = renderer;
    expect(renderer.root.findAll((node) => node.props?.id === 'ask-sayre-panel')).toHaveLength(1);
    expect(panelText(renderer)).toMatch(/ask sayre/i);
  });
});

// ------------------------------------------------------------------ asking

describe('asking a question', () => {
  // @spec AC-1 AC-8
  it('posts exactly the question, scope, and idempotency key, and appends the pair in ordinal order', async () => {
    const backend = installBackend();
    const { renderer } = await open({ nodeId: 'n_payment_form' });

    await ask(renderer, 'What does this folder do?');

    expect(backend.posts).toHaveLength(1);
    const { conversationId, body } = backend.posts[0]!;
    expect(conversationId).toBe('conv_1');
    expect(Object.keys(body).sort()).toEqual(['idempotencyKey', 'question', 'scope']);
    expect(body.question).toBe('What does this folder do?');
    expect(body.scope).toEqual({ view: 'technical', anchorNodeId: 'n_payment_form' });
    expect(typeof body.idempotencyKey).toBe('string');
    expect(body.idempotencyKey as string).toMatch(/^[A-Za-z0-9._:-]{8,200}$/);
    expect(JSON.stringify(body)).not.toMatch(/org|repositoryId|userId|repoId/i);

    expect(panelText(renderer)).toContain('What does this folder do?');
    expect(input(renderer).props.value).toBe('');
  });

  // @spec AC-2
  it('creates one conversation per workspace session and reuses it, even for a concurrent ask', async () => {
    const backend = installBackend();
    const { renderer, sink } = await open();

    await act(async () => {
      sink.chat!.ask('First question');
      sink.chat!.ask('Second question');
      await flush();
    });
    expect(backend.creates).toBe(1);

    const socket = await connectSocket();
    await push(socket, completedFrame(backend.lastAssistantTurnId!));
    await ask(renderer, 'A later question');

    expect(backend.creates).toBe(1);
    expect(backend.posts.length).toBeGreaterThanOrEqual(2);
    for (const post of backend.posts) expect(post.conversationId).toBe('conv_1');
  });

  // @spec AC-9
  it('submits the per-view suggested prompt from the empty state', async () => {
    const backend = installBackend();
    const { renderer } = await open({ view: 'technical' });

    expect(backend.posts).toHaveLength(0);
    await click(buttonNamed(renderer, /Explain this folder/i));

    expect(backend.posts).toHaveLength(1);
    expect(backend.posts[0]!.body.question).toBe('Explain this folder');
    expect(panelText(renderer)).toContain('Explain this folder');
  });

  // @spec EC-18
  it('refuses a blank or whitespace-only question without a request, a turn, or a cleared field', async () => {
    const backend = installBackend();
    const { renderer } = await open();

    expect(submitButton(renderer).props.disabled).toBe(true);
    await typeQuestion(renderer, '   ');
    expect(submitButton(renderer).props.disabled).toBe(true);
    await submitComposer(renderer);

    expect(backend.posts).toHaveLength(0);
    expect(backend.creates).toBe(0);
    expect(input(renderer).props.value).toBe('   ');
    expect(statusRegions(renderer).some((region) => textOf(region).length > 0)).toBe(true);
  });

  // @spec EC-17
  it('disables the composer with a stated reason while its own turn is running', async () => {
    const backend = installBackend();
    const { renderer, sink } = await open();

    await ask(renderer, 'What does this folder do?');
    expect(input(renderer).props.disabled).toBe(true);
    expect(submitButton(renderer).props.disabled).toBe(true);
    expect(hasStatedReason(renderer)).toBe(true);

    const postsBefore = backend.posts.length;
    await act(async () => {
      sink.chat!.ask('A second question while busy');
      await flush();
    });
    await submitComposer(renderer);
    expect(backend.posts).toHaveLength(postsBefore);
    expect(panelText(renderer)).not.toContain('A second question while busy');
  });

  // @spec EC-23
  it('caps the field at the CH-03 question ceiling', async () => {
    installBackend();
    const { renderer } = await open();
    expect(input(renderer).props.maxLength).toBe(8_000);
    expect(CHAT_QUESTION_MAX_CHARACTERS).toBe(8_000);
  });

  // @spec EC-19
  it('keeps the question editable and the transcript clean when a chat POST fails', async () => {
    const failedTurn = installBackend({ postStatus: 502 });
    const { renderer } = await open();
    await ask(renderer, 'What does this folder do?');

    expect(failedTurn.posts).toHaveLength(1);
    expect(input(renderer).props.value).toBe('What does this folder do?');
    expect(panelText(renderer)).not.toContain('What does this folder do?');
    expect(panelText(renderer)).toMatch(/could not|couldn'?t|failed|didn'?t|unavailable|try again/i);
    expect(maybeButtonNamed(renderer, /try again|retry|send again/i)).not.toBeNull();

    await restartHarness();
    const failedCreate = installBackend({ createStatus: 500 });
    const second = await open();
    await ask(second.renderer, 'What does this folder do?');
    expect(failedCreate.creates).toBe(1);
    expect(failedCreate.posts).toHaveLength(0);
    expect(input(second.renderer).props.value).toBe('What does this folder do?');
    expect(panelText(second.renderer)).not.toContain('What does this folder do?');
    expect(panelText(second.renderer)).toMatch(/could not|couldn'?t|failed|didn'?t|unavailable|try again/i);
  });
});

// ---------------------------------------------------------------- live turn

describe('live turn rendering', () => {
  // @spec AC-3 AC-14
  it('renders an ordered, politely announced progress ticker', async () => {
    const backend = installBackend();
    const { renderer } = await open();
    await ask(renderer, 'What does this folder do?');
    const socket = await connectSocket();
    const turnId = backend.lastAssistantTurnId!;

    await push(socket, progressFrame(turnId, 1, { kind: 'status', tool: 'must.not.render', detail: 'Selecting context nodes' }));
    await push(socket, progressFrame(turnId, 2, { kind: 'tool_call', tool: 'graph.search', detail: 'apps/web/checkout' }));

    const ticker = renderer.root.findAll((node) => node.props?.role === 'status' && node.props?.['aria-live'] === 'polite');
    expect(ticker.length).toBeGreaterThan(0);
    const tickerText = ticker.map((region) => textOf(region)).join(' ');
    expect(tickerText).toContain('Selecting context nodes');
    expect(tickerText).toContain('graph.search');
    expect(tickerText).toContain('apps/web/checkout');
    expect(tickerText.indexOf('Selecting context nodes')).toBeLessThan(tickerText.indexOf('graph.search'));
    expect(panelText(renderer)).not.toContain('must.not.render');

    const monoLines = renderer.root.findAll((node) =>
      typeof node.props?.className === 'string'
      && /mono/i.test(node.props.className as string)
      && textOf(node).includes('graph.search'));
    expect(monoLines.length, 'the tool_call line renders in the quiet mono style').toBeGreaterThan(0);
  });

  // @spec AC-4
  it('collapses the ticker and renders answer, then citations, then the metrics footer', async () => {
    const backend = installBackend();
    const { renderer } = await open();
    await ask(renderer, 'What does this folder do?');
    const socket = await connectSocket();
    const turnId = backend.lastAssistantTurnId!;

    await push(socket, progressFrame(turnId, 1, { detail: 'Selecting context nodes' }));
    await push(socket, completedFrame(turnId, {
      answer: '## Checkout\n\nThe checkout folder owns the cart-to-confirmation flow.',
      citations: [{ nodeId: 'n_use_cart', label: 'useCart.ts', kind: 'file', resolvedNodeId: 'n_use_cart' }],
    }));

    const text = panelText(renderer);
    expect(text).not.toContain('Selecting context nodes');
    expect(text).toContain('Checkout');
    expect(text).toContain('The checkout folder owns the cart-to-confirmation flow.');
    expect(text).toContain('useCart.ts');
    expect(text).toContain('12 context nodes · 900 tokens · 38× less than full repo');
    expect(text.indexOf('The checkout folder owns the cart-to-confirmation flow.'))
      .toBeLessThan(text.indexOf('useCart.ts'));
    expect(text.indexOf('useCart.ts')).toBeLessThan(text.indexOf('12 context nodes'));
    expect(text).not.toContain('##');
  });

  // @spec EC-11
  it('omits the citation row entirely when the completion carries no citations', async () => {
    const backend = installBackend();
    const withCitations = await open();
    await ask(withCitations.renderer, 'What does this folder do?');
    const firstSocket = await connectSocket();
    await push(firstSocket, completedFrame(backend.lastAssistantTurnId!, {
      citations: [
        { nodeId: 'n_use_cart', label: 'useCart.ts', kind: 'file', resolvedNodeId: 'n_use_cart' },
        { nodeId: 'n_checkout', label: 'checkout/', kind: 'folder', resolvedNodeId: 'n_checkout' },
      ],
    }));
    const chipButtons = buttons(withCitations.renderer).length;

    await restartHarness();
    const bare = installBackend();
    const withoutCitations = await open();
    await ask(withoutCitations.renderer, 'What does this folder do?');
    const secondSocket = await connectSocket();
    await push(secondSocket, completedFrame(bare.lastAssistantTurnId!, { citations: [] }));

    const text = panelText(withoutCitations.renderer);
    expect(text).toContain('The checkout folder owns the cart-to-confirmation flow.');
    expect(text).toContain('12 context nodes · 900 tokens · 38× less than full repo');
    expect(text).not.toMatch(/not on canvas/i);
    expect(buttons(withoutCitations.renderer)).toHaveLength(chipButtons - 2);
  });

  // @spec EC-15 EC-14
  it('renders the answer with no footer when the completion carries unusable metrics', async () => {
    const backend = installBackend();
    const { renderer } = await open();
    await ask(renderer, 'What does this folder do?');
    const socket = await connectSocket();
    await push(socket, completedFrame(backend.lastAssistantTurnId!, {
      metrics: { contextNodes: 12, tokensUsed: 'lots', baselineTokens: 34_200, ratio: 38 },
      citations: [{ nodeId: 'n_use_cart', label: 'useCart.ts', kind: 'file', resolvedNodeId: 'n_use_cart' }],
    }));

    const text = panelText(renderer);
    expect(text).toContain('The checkout folder owns the cart-to-confirmation flow.');
    expect(text).toContain('useCart.ts');
    expect(text).not.toMatch(/context nodes/i);
  });

  // @spec EC-21
  it('renders hostile answer markdown as literal text with no injected HTML or anchor', async () => {
    const backend = installBackend();
    const { renderer } = await open();
    await ask(renderer, 'What does this folder do?');
    const socket = await connectSocket();
    await push(socket, completedFrame(backend.lastAssistantTurnId!, {
      answer: '<script>alert("xss")</script>\n\n[click me](javascript:alert(1))\n\n<img src=x onerror="alert(1)">',
      citations: [{ nodeId: 'n_x', label: '<b>bold</b>', kind: 'file', resolvedNodeId: 'n_use_cart' }],
    }));

    const text = panelText(renderer);
    expect(text).toContain('<script>alert("xss")</script>');
    expect(text).toContain('[click me](javascript:alert(1))');
    expect(text).toContain('<img src=x onerror="alert(1)">');
    const tree = jsonTree(renderer);
    expect(tree).not.toContain('dangerouslySetInnerHTML');
    expect(renderer.root.findAll((node) => node.type === 'a')).toHaveLength(0);
    expect(renderer.root.findAll((node) => typeof node.props?.href === 'string')).toHaveLength(0);
  });

  // @spec EC-20
  it('discards a malformed gateway frame without throwing or touching the transcript', async () => {
    const backend = installBackend();
    const { renderer } = await open();
    await ask(renderer, 'What does this folder do?');
    const socket = await connectSocket();
    const before = panelText(renderer);

    for (const frame of [
      'not json at all',
      JSON.stringify({ type: 'chat.turn.progress', conversationId: 'conv_1' }),
      JSON.stringify({ ...progressFrame(backend.lastAssistantTurnId!, 1), seq: 'one' }),
      JSON.stringify({ ...completedFrame(backend.lastAssistantTurnId!), answer: 42 }),
      JSON.stringify([1, 2, 3]),
    ]) {
      await push(socket, frame);
    }
    expect(panelText(renderer)).toBe(before);
  });
});

// ---------------------------------------------------------------- citations

describe('citation chips', () => {
  async function completeWith(citations: unknown[], options: MountOptions = {}) {
    const backend = installBackend();
    const opened = await open(options);
    await ask(opened.renderer, 'What does this folder do?');
    const socket = await connectSocket();
    await push(socket, completedFrame(backend.lastAssistantTurnId!, { citations }));
    return opened;
  }

  // @spec AC-5
  it('selects the cited node on the canvas from the technical view', async () => {
    const { renderer, sink } = await completeWith([
      { nodeId: 'n_use_cart', label: 'useCart.ts', kind: 'file', resolvedNodeId: 'n_payment_form' },
    ]);
    expect(sink.selection!.selectedNodeId).toBeNull();

    await click(buttonNamed(renderer, /useCart\.ts/));
    expect(sink.selection!.selectedNodeId).toBe('n_payment_form');
    expect(sink.navigation!.viewId).toBe('technical');
  });

  // @spec AC-5
  it('selects the feature overlay for a known feature citation in the product view', async () => {
    const { renderer, sink } = await completeWith(
      [{ nodeId: 'feat_checkout', label: 'Checkout & payments', kind: 'feature', resolvedNodeId: null }],
      { view: 'product' },
    );

    await click(buttonNamed(renderer, /Checkout & payments/));
    expect(sink.selection!.selectedFeatureId).toBe('feat_checkout');
    expect(sink.selection!.selectedNodeId).toBeNull();
  });

  // @spec EC-26
  it('opens a cited node in the Technical Tree when the current canvas cannot draw it', async () => {
    const { renderer, sink } = await completeWith(
      [{ nodeId: 'n_use_cart', label: 'useCart.ts', kind: 'file', resolvedNodeId: 'n_use_cart' }],
      { view: 'product' },
    );
    expect(sink.navigation!.viewId).toBe('product');

    await click(buttonNamed(renderer, /useCart\.ts/));
    expect(sink.navigation!.viewId).toBe('technical');
    expect(sink.selection!.selectedNodeId).toBe('n_use_cart');
  });

  // @spec AC-6 EC-12 EC-13
  it('renders an undrawable citation as an inert chip that dispatches nothing', async () => {
    const { renderer, sink } = await completeWith([
      { nodeId: 'fn_calculate_total', label: 'calculateTotal()', kind: 'function', resolvedNodeId: 'n_use_cart' },
      { nodeId: 'cls_cart', label: 'CartClass', kind: 'class', resolvedNodeId: null },
      { nodeId: 'feat_unmapped', label: 'Unmapped feature', kind: 'feature', resolvedNodeId: null },
      { nodeId: 'tick_42', label: 'ATLAS-42', kind: 'ticket', resolvedNodeId: null },
    ]);

    const text = panelText(renderer);
    for (const label of ['calculateTotal()', 'CartClass', 'Unmapped feature', 'ATLAS-42']) {
      expect(text).toContain(label);
      expect(maybeButtonNamed(renderer, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))).toBeNull();
      const spans = renderer.root.findAll((node) => node.type === 'span' && textOf(node).includes(label));
      expect(spans.length, `${label} must render as a non-interactive span chip`).toBeGreaterThan(0);
    }
    expect(text).toMatch(/not on canvas/i);
    expect(sink.selection!.selectedNodeId).toBeNull();
    expect(sink.selection!.selectedFeatureId).toBeNull();
  });

  // @spec AC-15
  it('renders every server-delivered citation without applying a client-side visibility predicate', async () => {
    const { renderer } = await completeWith([
      { nodeId: 'n_not_in_this_view', label: 'ServerOnly.ts', kind: 'file', resolvedNodeId: 'n_not_in_this_view' },
      { nodeId: 'n_use_cart', label: 'useCart.ts', kind: 'file', resolvedNodeId: 'n_use_cart' },
    ]);
    const text = panelText(renderer);
    expect(text).toContain('ServerOnly.ts');
    expect(text).toContain('useCart.ts');
    expect(buttonNamed(renderer, /ServerOnly\.ts/).props.type).toBe('button');
  });
});

// -------------------------------------------------------------------- scope

describe('scope chip', () => {
  // @spec AC-7 AC-8
  it('shows the view and anchor label, dismisses only the anchor, and re-attaches on a new selection', async () => {
    const backend = installBackend();
    const { renderer, sink } = await open({ nodeId: 'n_payment_form' });

    const chip = buttonNamed(renderer, /PaymentForm\.tsx/);
    expect(chip.props.type).toBe('button');
    expect(panelText(renderer)).toMatch(/technical/i);

    await click(chip);
    expect(maybeButtonNamed(renderer, /PaymentForm\.tsx/)).toBeNull();
    expect(panelText(renderer)).toMatch(/technical/i);

    await ask(renderer, 'What does this folder do?');
    expect(backend.posts[0]!.body.scope).toEqual({ view: 'technical', anchorNodeId: null });

    await act(async () => {
      sink.selection!.selectNode('n_use_cart');
      await flush();
    });
    expect(maybeButtonNamed(renderer, /useCart\.ts/)).not.toBeNull();
  });

  // @spec EC-25 AC-11
  it('keeps a pending turn on the scope it was posted with while the chip follows the new view', async () => {
    const backend = installBackend();
    const { renderer, sink } = await open({ view: 'technical', nodeId: 'n_payment_form' });
    await ask(renderer, 'What does this folder do?');
    expect(backend.posts[0]!.body.scope).toEqual({ view: 'technical', anchorNodeId: 'n_payment_form' });
    const socket = await connectSocket();
    const turnId = backend.lastAssistantTurnId!;

    await act(async () => {
      sink.navigation!.selectView('product');
      await flush();
    });
    expect(panelText(renderer)).toMatch(/product/i);

    await push(socket, errorFrame(turnId));
    await click(buttonNamed(renderer, /try again/i));

    expect(backend.posts).toHaveLength(2);
    expect(backend.posts[1]!.body.scope).toEqual({ view: 'technical', anchorNodeId: 'n_payment_form' });
    expect(backend.posts[1]!.body.question).toBe('What does this folder do?');
  });

  // @spec EC-22
  it('clears the transcript and tears the socket down when the repository ref changes', async () => {
    const backend = installBackend();
    const { renderer, sink } = await open();
    await ask(renderer, 'What does this folder do?');
    const socket = await connectSocket();
    await push(socket, completedFrame(backend.lastAssistantTurnId!));
    expect(panelText(renderer)).toContain('The checkout folder owns the cart-to-confirmation flow.');

    await act(async () => {
      sink.navigation!.selectRef('refs/heads/release');
      await flush();
    });

    expect(panelText(renderer)).not.toContain('The checkout folder owns the cart-to-confirmation flow.');
    expect(panelText(renderer)).not.toContain('What does this folder do?');
    expect(socket.frames().some((frame) => frame.type === 'chat.unsubscribe' && frame.conversationId === 'conv_1')).toBe(true);
    expect(socket.closeCodes.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------- provider + errors

describe('provider configuration and turn failures', () => {
  function providerSource(generation: unknown): WorkspaceDataSource {
    return liveSource({
      async providerSettings(signal: AbortSignal) {
        const base = await fixtureWorkspaceDataSource.providerSettings(signal);
        return { ...base, settings: { ...base.settings, generation } } as Awaited<ReturnType<WorkspaceDataSource['providerSettings']>>;
      },
    });
  }

  // @spec AC-10
  it('blocks the composer with a route to provider settings when generation is unconfigured', async () => {
    installBackend();
    const { renderer, sink } = await open({ source: providerSource(null) });

    expect(input(renderer).props.disabled).toBe(true);
    expect(hasStatedReason(renderer)).toBe(true);
    expect(panelText(renderer)).toMatch(/provider/i);

    await click(buttonNamed(renderer, /provider/i));
    expect(sink.navigation!.settingsSection).toBe('providers');
  });

  // @spec AC-10
  it('never blocks the composer when provider settings cannot be read at all', async () => {
    installBackend();
    const forbidden = liveSource({
      providerSettings: async () => {
        throw Object.assign(new Error('Forbidden'), { status: 403 });
      },
    });
    const { renderer } = await open({ source: forbidden });

    expect(input(renderer).props.disabled).toBe(false);
    expect(submitButton(renderer).props.disabled).toBe(true);
    await ask(renderer, 'What does this folder do?');
    expect(panelText(renderer)).toContain('What does this folder do?');
  });

  // @spec AC-11 EC-16
  it('renders an inline error turn and retries it under a fresh idempotency key', async () => {
    const backend = installBackend();
    const { renderer } = await open({ nodeId: 'n_payment_form' });
    await ask(renderer, 'What does this folder do?');
    const socket = await connectSocket();

    await push(socket, errorFrame(backend.lastAssistantTurnId!, {
      code: 'chat.mcp_unauthorized',
      message: 'Sayre could not read the repository index for this question.',
    }));

    const text = panelText(renderer);
    expect(text).toContain('Sayre could not read the repository index for this question.');
    expect(text).not.toMatch(/credential|secret|token|api[_ -]?key|queue|backlog|sqs/i);

    await click(buttonNamed(renderer, /try again/i));

    expect(backend.posts).toHaveLength(2);
    expect(backend.posts[1]!.body.question).toBe('What does this folder do?');
    expect(backend.posts[1]!.body.scope).toEqual({ view: 'technical', anchorNodeId: 'n_payment_form' });
    expect(backend.posts[1]!.body.idempotencyKey).not.toBe(backend.posts[0]!.body.idempotencyKey);
    expect(backend.posts[1]!.body.idempotencyKey as string).toMatch(/^[A-Za-z0-9._:-]{8,200}$/);
    expect(backend.creates).toBe(1);
    // The re-asked question legitimately appears twice: the failed turn and its retry.
    expect(panelText(renderer).match(/What does this folder do\?/g)?.length).toBe(2);
  });

  // @spec EC-24
  it('defers to the workspace session-expiry path instead of retrying in a loop', async () => {
    const expired = installBackend({ postStatus: 401 });
    const { renderer, sink } = await open();
    await ask(renderer, 'What does this folder do?');

    expect(sink.session!.session).toBe('session-expired');
    expect(panelText(renderer)).not.toMatch(/sign in again|session expired/i);
    const socketCount = sockets.length;
    await act(async () => { await flush(); });
    expect(sockets.length).toBe(socketCount);
    expect(expired.posts).toHaveLength(1);

    await restartHarness();
    installBackend();
    const closed = await open();
    await ask(closed.renderer, 'What does this folder do?');
    const socket = await connectSocket();
    await act(async () => {
      socket.simulateClose(4401);
      await flush();
    });
    expect(closed.sink.session!.session).toBe('session-expired');
  });
});

// ------------------------------------------------------------ degraded path

describe('degraded, REST-only path', () => {
  // @spec EC-9
  it('says live progress is unavailable and offers a manual check when no socket can be opened', async () => {
    const backend = installBackend();
    const { renderer } = await open({ gatewayWsUrl: null });
    await ask(renderer, 'What does this folder do?');

    expect(sockets).toHaveLength(0);
    expect(panelText(renderer)).toMatch(/live progress|not connected|unavailable|degraded/i);
    const checkAgain = buttonNamed(renderer, /check again/i);
    expect(checkAgain.props.type).toBe('button');

    const before = backend.gets.length;
    await click(checkAgain);
    expect(backend.gets.length).toBeGreaterThan(before);
  });

  // @spec EC-9
  it('polls the conversation on a bounded budget and still lands the answer', async () => {
    vi.useFakeTimers();
    const backend = installBackend();
    const { renderer } = await open({ gatewayWsUrl: null });
    await ask(renderer, 'What does this folder do?');
    expect(backend.posts).toHaveLength(1);
    expect(sockets).toHaveLength(0);

    const beforePolling = backend.gets.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(CHAT_DEGRADED_POLL_INTERVAL_MS + 50); });
    expect(backend.gets.length).toBeGreaterThan(beforePolling);

    // The turn never terminates server-side: the poller must still stop itself.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CHAT_DEGRADED_POLL_INTERVAL_MS * (CHAT_DEGRADED_POLL_MAX_ATTEMPTS + 6));
    });
    expect(backend.gets.length).toBeLessThanOrEqual(CHAT_DEGRADED_POLL_MAX_ATTEMPTS + 1);

    const assistant = backend.turns.find((turn) => turn.id === backend.lastAssistantTurnId)!;
    assistant.status = 'completed';
    assistant.content = 'Answered without a live socket.';
    assistant.metrics = { contextNodes: 4, tokensUsed: 120, baselineTokens: 4_800, ratio: 40 };
    await click(buttonNamed(renderer, /check again/i));
    expect(panelText(renderer)).toContain('Answered without a live socket.');
    expect(panelText(renderer)).toContain('4 context nodes · 120 tokens · 40× less than full repo');
  });

  // @spec AC-12
  it('reconciles over REST as soon as the chat socket is connected', async () => {
    const backend = installBackend();
    const { renderer } = await open();
    await ask(renderer, 'What does this folder do?');
    const socket = await connectSocket();

    expect(socket.frames().some((frame) => frame.type === 'auth')).toBe(true);
    expect(socket.frames().some((frame) => frame.type === 'chat.subscribe' && frame.conversationId === 'conv_1')).toBe(true);
    expect(backend.gets).toContain('conv_1');
  });
});
