// CH-06 red suite — the REST client over the three already-allowlisted core
// proxy chat routes. Authored from .pipeline/spec.md before any implementation
// exists. No live network: `fetch` is stubbed, the way every other apps/web
// client test in this repo does it (see app/lib/coreFetch.test.ts).
//
// The wire shapes the fake server returns are CH-03's landed responses
// (services/core/src/routes/chat.ts: 201 `{ conversation }`, 200
// `{ conversation, turns }`, 202 `{ conversationId, userTurn, assistantTurn }`).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatRequestError, chatClient, newIdempotencyKey } from './chatClient';

interface RecordedCall {
  url: string;
  method: string;
  body: string | null;
}

const CONVERSATION = {
  id: 'conv_1',
  title: null,
  createdAt: '2026-08-10T12:00:00.000Z',
  updatedAt: '2026-08-10T12:00:00.000Z',
};

function turnRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'turn_user',
    conversationId: 'conv_1',
    seq: 1,
    role: 'user',
    content: 'What does this folder do?',
    status: 'completed',
    citations: null,
    metrics: null,
    error: null,
    createdAt: '2026-08-10T12:00:01.000Z',
    ...overrides,
  };
}

function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : String(input);
    calls.push({
      url,
      method: (init.method ?? 'GET').toUpperCase(),
      body: typeof init.body === 'string' ? init.body : null,
    });
    return handler(url, init);
  }));
  return calls;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('chat REST client', () => {
  // @spec AC-2
  it('creates a conversation with an empty body against the allowlisted proxy route', async () => {
    const calls = stubFetch(() => json({ conversation: CONVERSATION }, 201));
    const conversation = await chatClient.createConversation();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('/api/core/chat/conversations');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toBe('{}');
    expect(conversation).toEqual(CONVERSATION);
  });

  // @spec AC-1 AC-8
  it('posts a turn with a body of exactly question, scope, and idempotencyKey', async () => {
    const calls = stubFetch(() => json({
      conversationId: 'conv_1',
      userTurn: turnRow(),
      assistantTurn: turnRow({ id: 'turn_assistant', seq: 2, role: 'assistant', content: '', status: 'pending' }),
    }, 202));

    const result = await chatClient.postTurn('conv_1', {
      question: 'What does this folder do?',
      scope: { view: 'technical', anchorNodeId: 'n_checkout' },
      idempotencyKey: 'idem-0123456789',
    });

    expect(calls[0]!.url).toBe('/api/core/chat/conversations/conv_1/turns');
    expect(calls[0]!.method).toBe('POST');
    const body = JSON.parse(calls[0]!.body ?? '{}') as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['idempotencyKey', 'question', 'scope']);
    expect(Object.keys(body.scope as Record<string, unknown>).sort()).toEqual(['anchorNodeId', 'view']);
    expect(body).toEqual({
      question: 'What does this folder do?',
      scope: { view: 'technical', anchorNodeId: 'n_checkout' },
      idempotencyKey: 'idem-0123456789',
    });
    expect(result.conversationId).toBe('conv_1');
    expect(result.userTurn.id).toBe('turn_user');
    expect(result.assistantTurn.status).toBe('pending');
  });

  // @spec AC-12
  it('reads a conversation detail and parses its citation and metric payloads', async () => {
    const calls = stubFetch(() => json({
      conversation: CONVERSATION,
      turns: [
        turnRow(),
        turnRow({
          id: 'turn_assistant',
          seq: 2,
          role: 'assistant',
          content: 'The checkout folder owns the cart-to-confirmation flow.',
          status: 'completed',
          citations: [
            { nodeId: 'n_use_cart', label: 'useCart.ts', kind: 'file', resolvedNodeId: 'n_use_cart' },
            { nodeId: 'fn_total', label: 'total()', kind: 'function', resolvedNodeId: null },
          ],
          metrics: { contextNodes: 12, tokensUsed: 900, baselineTokens: 34_200, ratio: 38 },
        }),
      ],
    }));

    const detail = await chatClient.getConversation('conv_1');
    expect(calls[0]!.url).toBe('/api/core/chat/conversations/conv_1');
    expect(calls[0]!.method).toBe('GET');
    expect(detail.conversation).toEqual(CONVERSATION);
    expect(detail.turns).toHaveLength(2);
    expect(detail.turns[1]!.citations).toEqual([
      { nodeId: 'n_use_cart', label: 'useCart.ts', kind: 'file', resolvedNodeId: 'n_use_cart' },
      { nodeId: 'fn_total', label: 'total()', kind: 'unknown', resolvedNodeId: null },
    ]);
    expect(detail.turns[1]!.metrics).toEqual({ contextNodes: 12, tokensUsed: 900, baselineTokens: 34_200, ratio: 38 });
    expect(detail.turns[0]!.metrics).toBeNull();
  });

  // @spec EC-19
  it('turns every failure mode into a ChatRequestError instead of leaking a raw body or throwing something else', async () => {
    stubFetch(() => json({ error: { code: 'chat.invalid_question', message: 'Question is required.' } }, 400));
    await expect(chatClient.postTurn('conv_1', {
      question: '',
      scope: { view: 'technical', anchorNodeId: null },
      idempotencyKey: 'idem-0123456789',
    })).rejects.toBeInstanceOf(ChatRequestError);
    vi.unstubAllGlobals();

    stubFetch(() => json({ error: 'bad gateway' }, 502));
    await expect(chatClient.createConversation()).rejects.toMatchObject({ status: 502 });
    vi.unstubAllGlobals();

    stubFetch(() => new Response('<html>not json</html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    await expect(chatClient.getConversation('conv_1')).rejects.toBeInstanceOf(ChatRequestError);
    vi.unstubAllGlobals();

    stubFetch(() => json({ conversation: { id: 42 } }, 201));
    await expect(chatClient.createConversation()).rejects.toBeInstanceOf(ChatRequestError);
    vi.unstubAllGlobals();

    stubFetch(() => json({ conversation: CONVERSATION }, 200));
    await expect(chatClient.getConversation('conv_1')).rejects.toBeInstanceOf(ChatRequestError);
    vi.unstubAllGlobals();

    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const networkFailure = await chatClient.createConversation().catch((error: unknown) => error);
    expect(networkFailure).toBeInstanceOf(ChatRequestError);
    expect((networkFailure as ChatRequestError).status).toBeNull();
    expect((networkFailure as ChatRequestError).unauthenticated).toBe(false);
  });

  // @spec EC-23
  it('surfaces the server rejection of an over-long question as a 400 ChatRequestError', async () => {
    stubFetch(() => json({ error: { code: 'chat.question_too_long', message: 'Question is too long.' } }, 400));
    const failure = await chatClient.postTurn('conv_1', {
      question: 'x'.repeat(8_001),
      scope: { view: 'technical', anchorNodeId: null },
      idempotencyKey: 'idem-0123456789',
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ChatRequestError);
    expect((failure as ChatRequestError).status).toBe(400);
    expect((failure as ChatRequestError).unauthenticated).toBe(false);
  });

  // @spec EC-24
  it('flags a 401 from any chat route as the session-expiry signal', async () => {
    stubFetch(() => json({ error: { code: 'unauthenticated', message: 'Session expired.' } }, 401));
    for (const call of [
      () => chatClient.createConversation(),
      () => chatClient.getConversation('conv_1'),
      () => chatClient.postTurn('conv_1', {
        question: 'q',
        scope: { view: 'technical', anchorNodeId: null },
        idempotencyKey: 'idem-0123456789',
      }),
    ]) {
      const failure = await call().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ChatRequestError);
      expect((failure as ChatRequestError).status).toBe(401);
      expect((failure as ChatRequestError).unauthenticated).toBe(true);
    }
    vi.unstubAllGlobals();

    stubFetch(() => json({ error: { code: 'forbidden', message: 'Not allowed.' } }, 403));
    const forbidden = await chatClient.createConversation().catch((error: unknown) => error);
    expect((forbidden as ChatRequestError).unauthenticated).toBe(false);
  });

  // @spec AC-1 AC-11
  it('mints a fresh idempotency key matching the accepted key grammar on every call', () => {
    const keys = Array.from({ length: 25 }, () => newIdempotencyKey());
    for (const key of keys) {
      expect(key).toMatch(/^[A-Za-z0-9._:-]{8,200}$/);
    }
    expect(new Set(keys).size).toBe(keys.length);
  });
});
