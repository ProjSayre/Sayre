// CH-03 — service-layer behaviour for "Ask Sayre" conversation persistence and
// the chat-turns.fifo hand-off. Authored by `red` from .pipeline/spec.md before
// any implementation exists.
//
// Boundary note: this file measures what the SERVICE owes — validation, the
// ctx-only tenant scope it hands the store, the pinned payload/envelope it
// builds, and exactly-once publishing around `dispatched_at`. The SQL half of
// the same acceptance criteria (RLS filtering, seq allocation, advisory-lock
// serialization, history windowing) is measured against a live Postgres in
// src/db/chatStore.rls.test.ts.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../auth/context';
import type {
  AppendTurnPairInput,
  AppendTurnPairResult,
  ChatStore,
  ChatTurnScope,
  StoredChatConversation,
  StoredChatTurn,
} from '../db/chatStore';
import type { MessageEnvelope } from '../queue/envelope';
import type { ChatTurnRequestPayload } from '../queue/sqs';
import {
  CHAT_ANCHOR_NODE_ID_MAX_CHARACTERS,
  CHAT_CONVERSATION_LIST_DEFAULT_LIMIT,
  CHAT_CONVERSATION_LIST_MAX_LIMIT,
  CHAT_CONVERSATION_TURNS_LIMIT,
  CHAT_HISTORY_MAX_TURNS,
  CHAT_QUESTION_MAX_CHARACTERS,
  CHAT_TITLE_MAX_CHARACTERS,
  ChatEnqueueError,
  ChatForbiddenError,
  ChatNotFoundError,
  ChatValidationError,
  createConversation,
  getConversation,
  listConversations,
  postTurn,
  type ChatTurnPublisher,
} from './chatService';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const USER_A = '22222222-2222-4222-8222-222222222222';
const USER_B = '33333333-3333-4333-8333-333333333333';
const CONVERSATION_ID = '44444444-4444-4444-8444-444444444444';
const USER_TURN_ID = '55555555-5555-4555-8555-555555555555';
const ASSISTANT_TURN_ID = '66666666-6666-4666-8666-666666666666';

const userCtx: AuthContext = {
  subjectType: 'user',
  userId: USER_A,
  orgId: ORG_A,
  roles: ['member'],
};

const otherUserCtx: AuthContext = {
  subjectType: 'user',
  userId: USER_B,
  orgId: ORG_A,
  roles: ['member'],
};

const agentKeyCtx: AuthContext = {
  subjectType: 'agent_key',
  agentKeyId: 'mcp_live_abc',
  orgId: ORG_A,
  roles: ['member'],
};

function conversation(overrides: Partial<StoredChatConversation> = {}): StoredChatConversation {
  return {
    id: CONVERSATION_ID,
    title: 'Why does auth fail?',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:05:00.000Z',
    ...overrides,
  };
}

function turn(overrides: Partial<StoredChatTurn> = {}): StoredChatTurn {
  return {
    id: USER_TURN_ID,
    conversationId: CONVERSATION_ID,
    seq: 1,
    role: 'user',
    content: 'How does login work?',
    status: 'completed',
    citations: null,
    metrics: null,
    error: null,
    scope: { view: null, anchorNodeId: null },
    requestTurnId: null,
    dispatchedAt: null,
    createdAt: '2026-08-01T00:05:00.000Z',
    ...overrides,
  };
}

function appendResult(overrides: Partial<AppendTurnPairResult> = {}): AppendTurnPairResult {
  return {
    created: true,
    userTurn: turn(),
    assistantTurn: turn({
      id: ASSISTANT_TURN_ID,
      seq: 2,
      role: 'assistant',
      content: '',
      status: 'pending',
      requestTurnId: USER_TURN_ID,
    }),
    history: [],
    ...overrides,
  };
}

interface StubbedStore extends ChatStore {
  createConversation: ReturnType<typeof vi.fn>;
  listConversations: ReturnType<typeof vi.fn>;
  getConversation: ReturnType<typeof vi.fn>;
  appendTurnPair: ReturnType<typeof vi.fn>;
  markTurnDispatched: ReturnType<typeof vi.fn>;
}

function storeStub(overrides: Partial<Record<keyof ChatStore, unknown>> = {}): StubbedStore {
  return {
    createConversation: vi.fn(async () => conversation()),
    listConversations: vi.fn(async () => [conversation()]),
    getConversation: vi.fn(async () => ({ conversation: conversation(), turns: [turn()] })),
    appendTurnPair: vi.fn(async () => appendResult()),
    markTurnDispatched: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as StubbedStore;
}

function publisherStub(): ChatTurnPublisher & { calls: Array<MessageEnvelope<ChatTurnRequestPayload>> } {
  const calls: Array<MessageEnvelope<ChatTurnRequestPayload>> = [];
  const publish = vi.fn(async (envelope: MessageEnvelope<ChatTurnRequestPayload>) => {
    calls.push(envelope);
    return 'sqs-message-id';
  });
  return Object.assign(publish as unknown as ChatTurnPublisher, { calls });
}

function validTurnBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    idempotencyKey: 'client-turn-0001',
    question: 'How does login work?',
    ...overrides,
  };
}

let store: StubbedStore;
let publish: ReturnType<typeof publisherStub>;

beforeEach(() => {
  store = storeStub();
  publish = publisherStub();
});

describe('postTurn — the first attempt', () => {
  // @spec AC-1
  it('records the user turn plus its pending assistant turn and publishes exactly one message', async () => {
    const result = await postTurn(CONVERSATION_ID, validTurnBody(), userCtx, store, publish);

    expect(store.appendTurnPair).toHaveBeenCalledTimes(1);
    const input = store.appendTurnPair.mock.calls[0]![0] as AppendTurnPairInput;
    expect(input.conversationId).toBe(CONVERSATION_ID);
    expect(input.idempotencyKey).toBe('client-turn-0001');
    expect(input.question).toBe('How does login work?');

    expect(result.conversationId).toBe(CONVERSATION_ID);
    expect(result.userTurn).toMatchObject({
      id: USER_TURN_ID,
      role: 'user',
      status: 'completed',
      content: 'How does login work?',
      seq: 1,
    });
    expect(result.assistantTurn).toMatchObject({
      id: ASSISTANT_TURN_ID,
      role: 'assistant',
      status: 'pending',
      content: '',
      seq: 2,
    });

    expect(publish).toHaveBeenCalledTimes(1);
    expect(store.markTurnDispatched).toHaveBeenCalledTimes(1);
    expect(store.markTurnDispatched).toHaveBeenCalledWith(
      { orgId: ORG_A, userId: USER_A },
      ASSISTANT_TURN_ID,
    );
  });

  // @spec AC-1
  it('stores the trimmed question, not the raw one the client sent', async () => {
    await postTurn(
      CONVERSATION_ID,
      validTurnBody({ question: '   How does login work?  \n' }),
      userCtx,
      store,
      publish,
    );

    const input = store.appendTurnPair.mock.calls[0]![0] as AppendTurnPairInput;
    expect(input.question).toBe('How does login work?');
    expect(publish.calls[0]!.payload.question).toBe('How does login work?');
  });
});

describe('postTurn — idempotent retries', () => {
  // @spec AC-2
  it('returns the same turn ids and publishes nothing when the first attempt already dispatched', async () => {
    const alreadyDispatched = appendResult({
      created: false,
      assistantTurn: turn({
        id: ASSISTANT_TURN_ID,
        seq: 2,
        role: 'assistant',
        content: '',
        status: 'pending',
        requestTurnId: USER_TURN_ID,
        dispatchedAt: '2026-08-01T00:05:01.000Z',
      }),
    });
    store = storeStub({ appendTurnPair: vi.fn(async () => alreadyDispatched) });

    const result = await postTurn(CONVERSATION_ID, validTurnBody(), userCtx, store, publish);

    expect(result.userTurn.id).toBe(USER_TURN_ID);
    expect(result.assistantTurn.id).toBe(ASSISTANT_TURN_ID);
    expect(publish).not.toHaveBeenCalled();
    expect(store.markTurnDispatched).not.toHaveBeenCalled();
  });

  // @spec AC-3 AC-8
  it('re-publishes with the byte-identical deduplication key when the first publish failed', async () => {
    await postTurn(CONVERSATION_ID, validTurnBody(), userCtx, store, publish);
    const firstKey = publish.calls[0]!.idempotency_key;

    const undispatchedRetry = storeStub({
      appendTurnPair: vi.fn(async () => appendResult({ created: false })),
    });
    await postTurn(CONVERSATION_ID, validTurnBody(), userCtx, undispatchedRetry, publish);

    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.calls[1]!.idempotency_key).toBe(firstKey);
    expect(firstKey).toBe(`chat.turn:${ASSISTANT_TURN_ID}`);
    expect(undispatchedRetry.markTurnDispatched).toHaveBeenCalledWith(
      { orgId: ORG_A, userId: USER_A },
      ASSISTANT_TURN_ID,
    );
  });
});

describe('owner-only access and tenant scope', () => {
  // @spec AC-4 EC-7 EC-8
  it('reports a conversation it cannot see as not found, never as forbidden', async () => {
    const empty = storeStub({
      getConversation: vi.fn(async () => null),
      appendTurnPair: vi.fn(async () => null),
    });

    await expect(getConversation(CONVERSATION_ID, otherUserCtx, empty)).rejects.toBeInstanceOf(
      ChatNotFoundError,
    );
    await expect(
      postTurn(CONVERSATION_ID, validTurnBody(), otherUserCtx, empty, publish),
    ).rejects.toBeInstanceOf(ChatNotFoundError);
    expect(publish).not.toHaveBeenCalled();
  });

  // @spec AC-4 AC-5
  it('scopes every store call to the org and user on the auth context', async () => {
    await createConversation({ title: 'A' }, userCtx, store);
    await listConversations(undefined, userCtx, store);
    await getConversation(CONVERSATION_ID, userCtx, store);
    await postTurn(CONVERSATION_ID, validTurnBody(), userCtx, store, publish);

    const owner = { orgId: ORG_A, userId: USER_A };
    expect(store.createConversation.mock.calls[0]![0]).toEqual(owner);
    expect(store.listConversations.mock.calls[0]![0]).toEqual(owner);
    expect(store.getConversation.mock.calls[0]![0]).toEqual(owner);
    expect((store.appendTurnPair.mock.calls[0]![0] as AppendTurnPairInput).owner).toEqual(owner);
  });

  // @spec AC-5
  it('ignores an orgId/userId/org_id smuggled through the request body', async () => {
    await createConversation(
      { title: 'A', orgId: 'attacker-org', userId: 'attacker-user', org_id: 'attacker-org' },
      userCtx,
      store,
    );
    await postTurn(
      CONVERSATION_ID,
      validTurnBody({ orgId: 'attacker-org', userId: 'attacker-user', org_id: 'attacker-org' }),
      userCtx,
      store,
      publish,
    );

    expect(store.createConversation.mock.calls[0]![0]).toEqual({ orgId: ORG_A, userId: USER_A });
    const input = store.appendTurnPair.mock.calls[0]![0] as AppendTurnPairInput;
    expect(input.owner).toEqual({ orgId: ORG_A, userId: USER_A });
    expect(publish.calls[0]!.payload.orgId).toBe(ORG_A);
    expect(publish.calls[0]!.payload.userId).toBe(USER_A);
    expect(publish.calls[0]!.org_id).toBe(ORG_A);
    expect(JSON.stringify(publish.calls[0])).not.toContain('attacker');
  });

  // @spec EC-23
  it('refuses every entry point for a non-user subject', async () => {
    await expect(createConversation({ title: 'A' }, agentKeyCtx, store)).rejects.toBeInstanceOf(
      ChatForbiddenError,
    );
    await expect(listConversations(undefined, agentKeyCtx, store)).rejects.toBeInstanceOf(
      ChatForbiddenError,
    );
    await expect(getConversation(CONVERSATION_ID, agentKeyCtx, store)).rejects.toBeInstanceOf(
      ChatForbiddenError,
    );
    await expect(
      postTurn(CONVERSATION_ID, validTurnBody(), agentKeyCtx, store, publish),
    ).rejects.toBeInstanceOf(ChatForbiddenError);

    expect(store.createConversation).not.toHaveBeenCalled();
    expect(store.listConversations).not.toHaveBeenCalled();
    expect(store.getConversation).not.toHaveBeenCalled();
    expect(store.appendTurnPair).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });
});

describe('the pinned chat.turn.request.v1 payload', () => {
  // @spec AC-6
  it('carries exactly the pinned keys, in the pinned order, with the pinned values', async () => {
    await postTurn(
      CONVERSATION_ID,
      validTurnBody({ scope: { view: 'technical', anchorNodeId: 'file-42' } }),
      userCtx,
      store,
      publish,
    );

    const payload = publish.calls[0]!.payload;
    expect(Object.keys(payload)).toEqual([
      'schema',
      'turnId',
      'conversationId',
      'orgId',
      'userId',
      'question',
      'scope',
      'history',
      'mcpCredential',
    ]);
    expect(payload.schema).toBe('chat.turn.request.v1');
    expect(payload.turnId).toBe(ASSISTANT_TURN_ID);
    expect(payload.conversationId).toBe(CONVERSATION_ID);
    expect(payload.orgId).toBe(ORG_A);
    expect(payload.userId).toBe(USER_A);
    expect(payload.question).toBe('How does login work?');
    expect(Object.keys(payload.scope)).toEqual(['view', 'anchorNodeId']);
    expect(payload.scope).toEqual({ view: 'technical', anchorNodeId: 'file-42' });
    expect(payload.mcpCredential).toBeNull();
  });

  // @spec AC-8
  it('wraps the payload in the repo-standard envelope the Python consumer parses', async () => {
    await postTurn(CONVERSATION_ID, validTurnBody(), userCtx, store, publish);

    const envelope = publish.calls[0]!;
    expect(envelope.org_id).toBe(ORG_A);
    expect(envelope.type).toBe('chat.turn.request');
    expect(envelope.source).toBe('sayre-core-chat');
    expect(envelope.schema_version).toBe(1);
    expect(envelope.idempotency_key).toBe(`chat.turn:${ASSISTANT_TURN_ID}`);
  });

  // @spec AC-7 EC-11
  it('bounds history to the newest twelve completed turns and copies them verbatim', async () => {
    const history = Array.from({ length: CHAT_HISTORY_MAX_TURNS }, (_, index) => ({
      role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `turn-${index + 1}`,
    }));
    store = storeStub({ appendTurnPair: vi.fn(async () => appendResult({ history })) });

    await postTurn(CONVERSATION_ID, validTurnBody(), userCtx, store, publish);

    const input = store.appendTurnPair.mock.calls[0]![0] as AppendTurnPairInput;
    expect(CHAT_HISTORY_MAX_TURNS).toBe(12);
    expect(input.historyLimit).toBe(CHAT_HISTORY_MAX_TURNS);
    expect(publish.calls[0]!.payload.history).toEqual(history);
    expect(publish.calls[0]!.payload.history).toHaveLength(CHAT_HISTORY_MAX_TURNS);
    for (const entry of publish.calls[0]!.payload.history) {
      expect(Object.keys(entry)).toEqual(['role', 'content']);
    }
  });

  // @spec EC-11
  it('sends an empty history array for the first turn in a new conversation', async () => {
    await postTurn(CONVERSATION_ID, validTurnBody(), userCtx, store, publish);
    expect(publish.calls[0]!.payload.history).toEqual([]);
  });

  // @spec EC-4
  it('always sends a scope object with both keys when the client omitted scope', async () => {
    await postTurn(CONVERSATION_ID, validTurnBody(), userCtx, store, publish);

    const payload = publish.calls[0]!.payload;
    expect(payload.scope).toEqual({ view: null, anchorNodeId: null });
    expect('view' in payload.scope).toBe(true);
    expect('anchorNodeId' in payload.scope).toBe(true);
    const input = store.appendTurnPair.mock.calls[0]![0] as AppendTurnPairInput;
    expect(input.scope).toEqual({ view: null, anchorNodeId: null } satisfies ChatTurnScope);
  });
});

describe('postTurn validation', () => {
  async function expectRejected(body: unknown): Promise<void> {
    await expect(postTurn(CONVERSATION_ID, body, userCtx, store, publish)).rejects.toBeInstanceOf(
      ChatValidationError,
    );
    expect(store.appendTurnPair).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  }

  // @spec EC-1
  it('rejects a blank or whitespace-only question without touching the store or the queue', async () => {
    await expectRejected(validTurnBody({ question: '' }));
    store = storeStub();
    publish = publisherStub();
    await expectRejected(validTurnBody({ question: '   \n\t ' }));
  });

  // @spec EC-2
  it('rejects a question longer than the maximum', async () => {
    await expectRejected(validTurnBody({ question: 'q'.repeat(CHAT_QUESTION_MAX_CHARACTERS + 1) }));
    expect(CHAT_QUESTION_MAX_CHARACTERS).toBe(8_000);
  });

  // @spec EC-3
  it.each([
    ['missing', undefined],
    ['blank', '   '],
    ['too short', 'abc1234'],
    ['too long', 'k'.repeat(201)],
    ['illegal character', 'client turn/0001'],
    ['non-string', 12345],
  ])('rejects an idempotency key that is %s', async (_label, value) => {
    const body = validTurnBody();
    if (value === undefined) delete body.idempotencyKey;
    else body.idempotencyKey = value;
    await expectRejected(body);
  });

  // @spec EC-5
  it.each([
    ['an unknown view', { view: 'financial', anchorNodeId: null }],
    ['a non-string anchor', { view: null, anchorNodeId: 42 }],
    ['a blank anchor', { view: null, anchorNodeId: '   ' }],
    [
      'an over-long anchor',
      { view: null, anchorNodeId: 'n'.repeat(CHAT_ANCHOR_NODE_ID_MAX_CHARACTERS + 1) },
    ],
    ['an anchor containing NUL', { view: null, anchorNodeId: 'file\u0000one' }],
    ['a non-object scope', 'technical'],
  ])('rejects %s', async (_label, scope) => {
    await expectRejected(validTurnBody({ scope }));
  });

  // @spec EC-6
  it('treats a conversation id that is not a UUID as not found, before any store call', async () => {
    await expect(
      postTurn('not-a-uuid', validTurnBody(), userCtx, store, publish),
    ).rejects.toBeInstanceOf(ChatNotFoundError);
    await expect(getConversation('../../etc/passwd', userCtx, store)).rejects.toBeInstanceOf(
      ChatNotFoundError,
    );
    expect(store.appendTurnPair).not.toHaveBeenCalled();
    expect(store.getConversation).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  // @spec EC-19
  it.each([
    ['an array', [] as unknown],
    ['a string', 'question' as unknown],
    ['a number', 42 as unknown],
    ['null', null as unknown],
  ])('rejects a request body that is %s', async (_label, body) => {
    await expect(postTurn(CONVERSATION_ID, body, userCtx, store, publish)).rejects.toBeInstanceOf(
      ChatValidationError,
    );
    await expect(createConversation(body, userCtx, store)).rejects.toBeInstanceOf(
      ChatValidationError,
    );
    expect(store.appendTurnPair).not.toHaveBeenCalled();
    expect(store.createConversation).not.toHaveBeenCalled();
  });
});

describe('publish failure after commit', () => {
  // @spec EC-13 AC-12
  it('raises ChatEnqueueError without leaking SQS detail and without marking the turn dispatched', async () => {
    const failing = vi.fn(async () => {
      throw new Error(
        'AWS.SimpleQueueService.NonExistentQueue: https://sqs.us-east-1.amazonaws.com/123456789012/chat-turns.fifo',
      );
    }) as unknown as ChatTurnPublisher;

    const error = await postTurn(CONVERSATION_ID, validTurnBody(), userCtx, store, failing).catch(
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(ChatEnqueueError);
    const rendered = `${(error as Error).name} ${(error as Error).message}`;
    expect(rendered).not.toMatch(/sqs\.us-east-1|amazonaws|NonExistentQueue|us-east-1|arn:aws/u);
    expect(store.markTurnDispatched).not.toHaveBeenCalled();
  });

  // @spec EC-21
  it('treats a publish that never returned a MessageId as a failure and leaves the turn undispatched', async () => {
    const noMessageId = vi.fn(async () => {
      throw new Error('SQS publish to "chat-turns.fifo" did not return a MessageId.');
    }) as unknown as ChatTurnPublisher;

    await expect(
      postTurn(CONVERSATION_ID, validTurnBody(), userCtx, store, noMessageId),
    ).rejects.toBeInstanceOf(ChatEnqueueError);
    expect(store.markTurnDispatched).not.toHaveBeenCalled();
  });

  // @spec EC-13
  it('raises ChatEnqueueError when the dispatch bookkeeping itself fails', async () => {
    store = storeStub({
      markTurnDispatched: vi.fn(async () => {
        throw new Error('connection terminated');
      }),
    });

    await expect(
      postTurn(CONVERSATION_ID, validTurnBody(), userCtx, store, publish),
    ).rejects.toBeInstanceOf(ChatEnqueueError);
    expect(publish).toHaveBeenCalledTimes(1);
  });
});

describe('concurrent posts to one conversation', () => {
  // @spec EC-9
  it('publishes once when two callers race with the same idempotency key', async () => {
    let attempts = 0;
    const serialized = storeStub({
      appendTurnPair: vi.fn(async () => {
        attempts += 1;
        return attempts === 1
          ? appendResult()
          : appendResult({
              created: false,
              assistantTurn: turn({
                id: ASSISTANT_TURN_ID,
                seq: 2,
                role: 'assistant',
                content: '',
                status: 'pending',
                requestTurnId: USER_TURN_ID,
                dispatchedAt: '2026-08-01T00:05:01.000Z',
              }),
            });
      }),
    });

    const [first, second] = await Promise.all([
      postTurn(CONVERSATION_ID, validTurnBody(), userCtx, serialized, publish),
      postTurn(CONVERSATION_ID, validTurnBody(), userCtx, serialized, publish),
    ]);

    expect(first.assistantTurn.id).toBe(ASSISTANT_TURN_ID);
    expect(second.assistantTurn.id).toBe(ASSISTANT_TURN_ID);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  // @spec EC-10
  it('publishes one distinct message per distinct idempotency key', async () => {
    const secondAssistantId = '77777777-7777-4777-8777-777777777777';
    let attempts = 0;
    const twoPairs = storeStub({
      appendTurnPair: vi.fn(async () => {
        attempts += 1;
        return attempts === 1
          ? appendResult()
          : appendResult({
              userTurn: turn({ id: '88888888-8888-4888-8888-888888888888', seq: 3 }),
              assistantTurn: turn({
                id: secondAssistantId,
                seq: 4,
                role: 'assistant',
                content: '',
                status: 'pending',
                requestTurnId: '88888888-8888-4888-8888-888888888888',
              }),
            });
      }),
    });

    await Promise.all([
      postTurn(CONVERSATION_ID, validTurnBody({ idempotencyKey: 'client-turn-A' }), userCtx, twoPairs, publish),
      postTurn(CONVERSATION_ID, validTurnBody({ idempotencyKey: 'client-turn-B' }), userCtx, twoPairs, publish),
    ]);

    expect(publish).toHaveBeenCalledTimes(2);
    const keys = publish.calls.map((envelope) => envelope.idempotency_key);
    expect(new Set(keys).size).toBe(2);
    expect(new Set(publish.calls.map((envelope) => envelope.payload.turnId)).size).toBe(2);
  });
});

describe('createConversation', () => {
  // @spec EC-17
  it.each([
    ['omitted', {} as Record<string, unknown>],
    ['null', { title: null }],
    ['whitespace-only', { title: '   \t' }],
  ])('stores a %s title as null', async (_label, body) => {
    await createConversation(body, userCtx, store);
    expect(store.createConversation).toHaveBeenCalledWith({ orgId: ORG_A, userId: USER_A }, null);
  });

  // @spec EC-17
  it('trims a usable title and rejects one over the maximum', async () => {
    await createConversation({ title: '  Auth spelunking  ' }, userCtx, store);
    expect(store.createConversation).toHaveBeenCalledWith(
      { orgId: ORG_A, userId: USER_A },
      'Auth spelunking',
    );

    await expect(
      createConversation({ title: 't'.repeat(CHAT_TITLE_MAX_CHARACTERS + 1) }, userCtx, store),
    ).rejects.toBeInstanceOf(ChatValidationError);
    expect(store.createConversation).toHaveBeenCalledTimes(1);
  });
});

describe('listConversations', () => {
  // @spec EC-14
  it('returns an empty list for a user with no conversations', async () => {
    const empty = storeStub({ listConversations: vi.fn(async () => []) });
    await expect(listConversations(undefined, userCtx, empty)).resolves.toEqual([]);
  });

  // @spec EC-15
  it('defaults the limit and accepts the documented range', async () => {
    await listConversations(undefined, userCtx, store);
    expect(store.listConversations).toHaveBeenCalledWith(
      { orgId: ORG_A, userId: USER_A },
      CHAT_CONVERSATION_LIST_DEFAULT_LIMIT,
    );

    await listConversations('25', userCtx, store);
    expect(store.listConversations).toHaveBeenLastCalledWith(
      { orgId: ORG_A, userId: USER_A },
      25,
    );

    await listConversations(String(CHAT_CONVERSATION_LIST_MAX_LIMIT), userCtx, store);
    expect(store.listConversations).toHaveBeenLastCalledWith(
      { orgId: ORG_A, userId: USER_A },
      CHAT_CONVERSATION_LIST_MAX_LIMIT,
    );
  });

  // @spec EC-15
  it.each([
    ['non-numeric', 'ten'],
    ['zero', '0'],
    ['negative', '-5'],
    ['over the maximum', String(CHAT_CONVERSATION_LIST_MAX_LIMIT + 1)],
    ['fractional', '2.5'],
  ])('rejects a %s limit', async (_label, limit) => {
    await expect(listConversations(limit, userCtx, store)).rejects.toBeInstanceOf(
      ChatValidationError,
    );
    expect(store.listConversations).not.toHaveBeenCalled();
  });
});

describe('getConversation', () => {
  // @spec EC-16
  it('asks the store for at most the bounded number of turns and returns them in store order', async () => {
    const turns = [turn({ seq: 1 }), turn({ id: ASSISTANT_TURN_ID, seq: 2, role: 'assistant' })];
    const detailed = storeStub({
      getConversation: vi.fn(async () => ({ conversation: conversation(), turns })),
    });

    const detail = await getConversation(CONVERSATION_ID, userCtx, detailed);

    expect(CHAT_CONVERSATION_TURNS_LIMIT).toBe(200);
    expect(detailed.getConversation).toHaveBeenCalledWith(
      { orgId: ORG_A, userId: USER_A },
      CONVERSATION_ID,
      CHAT_CONVERSATION_TURNS_LIMIT,
    );
    expect(detail.conversation.id).toBe(CONVERSATION_ID);
    expect(detail.turns.map((item) => item.seq)).toEqual([1, 2]);
  });
});
