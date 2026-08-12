// CH-03 — the four thin "Ask Sayre" routes over chatService, exercised end to
// end through a real Express app (the routes/nodeOverlay.test.ts idiom: vi.mock
// the store, createApp().listen(0), real fetch). Authored by `red` from
// .pipeline/spec.md before any implementation exists.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getConfig } from '@sayre/config';

const CORE_ROOT = path.resolve(__dirname, '..', '..');
const CHAT_ROUTE_FILE = path.join(__dirname, 'chat.ts');

const CONVERSATION_ID = '44444444-4444-4444-8444-444444444444';
const USER_TURN_ID = '55555555-5555-4555-8555-555555555555';
const ASSISTANT_TURN_ID = '66666666-6666-4666-8666-666666666666';

const storeMocks = vi.hoisted(() => ({
  createConversation: vi.fn(),
  listConversations: vi.fn(),
  getConversation: vi.fn(),
  appendTurnPair: vi.fn(),
  markTurnDispatched: vi.fn(),
}));

const queueMocks = vi.hoisted(() => ({
  publishChatTurnRequest: vi.fn(async () => 'sqs-message-id'),
}));

vi.mock('../db/chatStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/chatStore')>();
  return { ...actual, chatStore: storeMocks };
});

vi.mock('../queue/sqs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../queue/sqs')>();
  return {
    ...actual,
    publishChatTurnRequest: (...args: unknown[]) =>
      (queueMocks.publishChatTurnRequest as unknown as (...values: unknown[]) => unknown)(...args),
  };
});

import { createApp } from '../app';
import { errorHandler } from '../http/express';
import { ChatForbiddenError } from '../services/chatService';

function storedConversation() {
  return {
    id: CONVERSATION_ID,
    title: 'Auth spelunking',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:05:00.000Z',
  };
}

function storedUserTurn() {
  return {
    id: USER_TURN_ID,
    conversationId: CONVERSATION_ID,
    seq: 1,
    role: 'user' as const,
    content: 'How does login work?',
    status: 'completed' as const,
    citations: null,
    metrics: null,
    error: null,
    scope: { view: null, anchorNodeId: null },
    requestTurnId: null,
    dispatchedAt: null,
    createdAt: '2026-08-01T00:05:00.000Z',
  };
}

function storedAssistantTurn() {
  return {
    ...storedUserTurn(),
    id: ASSISTANT_TURN_ID,
    seq: 2,
    role: 'assistant' as const,
    content: '',
    status: 'pending' as const,
    requestTurnId: USER_TURN_ID,
  };
}

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

beforeEach(() => {
  storeMocks.createConversation.mockReset().mockResolvedValue(storedConversation());
  storeMocks.listConversations.mockReset().mockResolvedValue([storedConversation()]);
  storeMocks.getConversation
    .mockReset()
    .mockResolvedValue({ conversation: storedConversation(), turns: [storedUserTurn()] });
  storeMocks.appendTurnPair.mockReset().mockResolvedValue({
    created: true,
    userTurn: storedUserTurn(),
    assistantTurn: storedAssistantTurn(),
    history: [],
  });
  storeMocks.markTurnDispatched.mockReset().mockResolvedValue(undefined);
  queueMocks.publishChatTurnRequest.mockReset().mockResolvedValue('sqs-message-id');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (activeServer) {
    await closeServer(activeServer);
    activeServer = undefined;
  }
});

describe('POST /chat/conversations/:conversationId/turns', () => {
  // @spec AC-1 AC-12
  it('accepts the question with 202 and returns the user turn plus its pending answer slot', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;

    const response = await fetch(`${baseUrl}/chat/conversations/${CONVERSATION_ID}/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        idempotencyKey: 'client-turn-0001',
        question: 'How does login work?',
      }),
    });
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(202);
    expect(body).toMatchObject({
      conversationId: CONVERSATION_ID,
      userTurn: { id: USER_TURN_ID, role: 'user', status: 'completed' },
      assistantTurn: { id: ASSISTANT_TURN_ID, role: 'assistant', status: 'pending', content: '' },
    });
    expect(storeMocks.appendTurnPair).toHaveBeenCalledTimes(1);
    expect(queueMocks.publishChatTurnRequest).toHaveBeenCalledTimes(1);
  });

  // @spec AC-5
  it('uses only the server-derived tenant context, never orgId from the query or body', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;

    await fetch(`${baseUrl}/chat/conversations/${CONVERSATION_ID}/turns?orgId=attacker`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        idempotencyKey: 'client-turn-0001',
        question: 'How does login work?',
        orgId: 'attacker',
        userId: 'attacker',
      }),
    });

    const input = storeMocks.appendTurnPair.mock.calls[0]![0] as {
      owner: { orgId: string; userId: string };
    };
    expect(input.owner).toEqual({
      orgId: getConfig('DEV_ORG_ID'),
      userId: getConfig('DEV_USER_ID'),
    });
    expect(JSON.stringify(storeMocks.appendTurnPair.mock.calls)).not.toContain('attacker');
  });

  // @spec AC-4 EC-7 EC-8
  it('answers 404 (never 403) for a conversation this user cannot see', async () => {
    storeMocks.appendTurnPair.mockResolvedValue(null);
    const { server, baseUrl } = await startServer();
    activeServer = server;

    const response = await fetch(`${baseUrl}/chat/conversations/${CONVERSATION_ID}/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idempotencyKey: 'client-turn-0001', question: 'Anything?' }),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not found' });
    expect(queueMocks.publishChatTurnRequest).not.toHaveBeenCalled();
  });

  // @spec EC-6
  it('answers 404 for a conversation id that is not a UUID, without reaching the store', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;

    const response = await fetch(`${baseUrl}/chat/conversations/not-a-uuid/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idempotencyKey: 'client-turn-0001', question: 'Anything?' }),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not found' });
    expect(storeMocks.appendTurnPair).not.toHaveBeenCalled();
  });

  // @spec AC-12 EC-19
  it('answers 400 with issue strings for an invalid body', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;

    const blank = await fetch(`${baseUrl}/chat/conversations/${CONVERSATION_ID}/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idempotencyKey: 'client-turn-0001', question: '   ' }),
    });
    const blankBody = (await blank.json()) as { error: string; issues: string[] };

    expect(blank.status).toBe(400);
    expect(blankBody.error).toBe('invalid chat request');
    expect(Array.isArray(blankBody.issues)).toBe(true);
    expect(blankBody.issues.length).toBeGreaterThan(0);

    const arrayBody = await fetch(`${baseUrl}/chat/conversations/${CONVERSATION_ID}/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([]),
    });

    expect(arrayBody.status).toBe(400);
    expect((await arrayBody.json()) as Record<string, unknown>).toMatchObject({
      error: 'invalid chat request',
    });
    expect(storeMocks.appendTurnPair).not.toHaveBeenCalled();
  });

  // @spec AC-12 EC-13
  it('answers 502 with a fixed body — no queue URL, region, ARN or AWS code — when the publish fails', async () => {
    const consoleSpies = [
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
    ];
    queueMocks.publishChatTurnRequest.mockRejectedValue(
      new Error(
        'AWS.SimpleQueueService.NonExistentQueue arn:aws:sqs:us-east-1:123456789012:chat-turns.fifo ' +
          'https://sqs.us-east-1.amazonaws.com/123456789012/chat-turns.fifo',
      ),
    );
    const { server, baseUrl } = await startServer();
    activeServer = server;

    const response = await fetch(`${baseUrl}/chat/conversations/${CONVERSATION_ID}/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idempotencyKey: 'client-turn-0001', question: 'How does login work?' }),
    });
    const raw = await response.text();

    expect(response.status).toBe(502);
    expect(JSON.parse(raw)).toEqual({ error: 'chat turn could not be queued' });
    expect(raw).not.toMatch(/amazonaws|arn:aws|us-east-1|NonExistentQueue|chat-turns\.fifo/u);

    const logged = consoleSpies
      .flatMap((spy) => spy.mock.calls)
      .map((call) => call.map((value) => String(value)).join(' '))
      .join('\n');
    expect(logged).not.toMatch(/amazonaws|arn:aws|us-east-1|NonExistentQueue/u);
    // The committed rows are never rolled back and the turn stays undispatched.
    expect(storeMocks.markTurnDispatched).not.toHaveBeenCalled();
  });
});

describe('conversation reads and creation', () => {
  // @spec EC-14
  it('returns an empty conversation list as 200 { conversations: [] }', async () => {
    storeMocks.listConversations.mockResolvedValue([]);
    const { server, baseUrl } = await startServer();
    activeServer = server;

    const response = await fetch(`${baseUrl}/chat/conversations`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ conversations: [] });
  });

  // @spec EC-15
  it('rejects an out-of-range limit with 400', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;

    const zero = await fetch(`${baseUrl}/chat/conversations?limit=0`);
    expect(zero.status).toBe(400);
    expect(((await zero.json()) as { error: string }).error).toBe('invalid chat request');

    const wordy = await fetch(`${baseUrl}/chat/conversations?limit=ten`);
    expect(wordy.status).toBe(400);
    expect(storeMocks.listConversations).not.toHaveBeenCalled();
  });

  // @spec AC-4 EC-8
  it('answers 404 when reading a conversation owned by someone else', async () => {
    storeMocks.getConversation.mockResolvedValue(null);
    const { server, baseUrl } = await startServer();
    activeServer = server;

    const response = await fetch(`${baseUrl}/chat/conversations/${CONVERSATION_ID}`);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not found' });
  });

  // @spec AC-12
  it('returns the conversation and its turns as 200 { conversation, turns }', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;

    const response = await fetch(`${baseUrl}/chat/conversations/${CONVERSATION_ID}`);
    const body = (await response.json()) as { conversation: { id: string }; turns: unknown[] };

    expect(response.status).toBe(200);
    expect(body.conversation.id).toBe(CONVERSATION_ID);
    expect(body.turns).toHaveLength(1);
  });

  // @spec EC-17
  it('creates a conversation with 201 and stores a whitespace-only title as null', async () => {
    storeMocks.createConversation.mockResolvedValue({ ...storedConversation(), title: null });
    const { server, baseUrl } = await startServer();
    activeServer = server;

    const response = await fetch(`${baseUrl}/chat/conversations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '   ' }),
    });
    const body = (await response.json()) as { conversation: { title: string | null } };

    expect(response.status).toBe(201);
    expect(body.conversation.title).toBeNull();
    expect(storeMocks.createConversation.mock.calls[0]![1]).toBeNull();
  });
});

describe('authentication and subject type', () => {
  // @spec EC-18
  it('answers 401 for an unauthenticated request outside dev/test, before any chatService call', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    vi.stubEnv('NODE_ENV', 'production');

    const response = await fetch(`${baseUrl}/chat/conversations`);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthorized' });
    expect(storeMocks.listConversations).not.toHaveBeenCalled();
  });

  // @spec AC-12 EC-23
  it('maps a non-user subject to 403 { error: "forbidden" }', () => {
    const statuses: number[] = [];
    const bodies: unknown[] = [];
    const res = {
      status(code: number) {
        statuses.push(code);
        return this;
      },
      json(payload: unknown) {
        bodies.push(payload);
        return this;
      },
    } as unknown as Response;

    errorHandler(new ChatForbiddenError(), {} as Request, res, (() => undefined) as NextFunction);

    expect(statuses).toEqual([403]);
    expect(bodies).toEqual([{ error: 'forbidden' }]);
  });
});

describe('route thinness (the src/routes/** lint contract)', () => {
  // @spec AC-11
  it('lints clean under the real src/routes/** override', () => {
    expect(existsSync(CHAT_ROUTE_FILE)).toBe(true);

    const eslintExecutable = path.join(
      path.dirname(require.resolve('eslint/package.json')),
      'bin',
      'eslint.js',
    );
    let status = 0;
    let output = '';
    try {
      output = execFileSync(process.execPath, [eslintExecutable, 'src/routes/chat.ts'], {
        cwd: CORE_ROOT,
        encoding: 'utf-8',
      });
    } catch (err) {
      const failure = err as { status?: number; stdout?: string; stderr?: string };
      status = failure.status ?? 1;
      output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`;
    }

    expect(output).not.toMatch(/max-statements|no-restricted-imports/u);
    expect(status).toBe(0);
  });

  // @spec AC-11
  it('contains no business logic: every handler delegates to chatService', () => {
    expect(existsSync(CHAT_ROUTE_FILE)).toBe(true);
    const source = readFileSync(CHAT_ROUTE_FILE, 'utf8');

    expect(source).not.toMatch(/from '(pg|drizzle-orm|bullmq|ioredis|neo4j-driver)'/u);
    expect(source).not.toMatch(/from '\.\.\/(db|graph-query)/u);
    expect(source).toMatch(/from '\.\.\/services\/chatService'/u);
    // Four registered routes, each reached through requireAuthContext(req).
    expect(source.match(/chatRouter\.(get|post)\(/gu) ?? []).toHaveLength(4);
    expect(source.match(/requireAuthContext\(req\)/gu) ?? []).toHaveLength(4);
    expect(source).toMatch(/authenticate\(\)/u);
    expect(source).toMatch(/authorize\('member'\)/u);
  });
});
