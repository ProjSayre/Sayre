// CH-06 red suite — the pure transcript reducer: progress ordering and
// idempotency, terminal-event precedence, and REST reconciliation.
// Authored from .pipeline/spec.md before any implementation exists.

import { describe, expect, it } from 'vitest';
import type { ChatGatewayMessage, ChatScope } from './chatContract';
import type { ChatConversationDetail, ChatTurnRecord } from './chatClient';
import {
  appendTurnPair,
  applyChatEvent,
  emptyChatTranscript,
  hasActiveTurn,
  reconcileTranscript,
  type ChatTranscriptState,
} from './chatTranscript';

const SCOPE: ChatScope = { view: 'technical', anchorNodeId: 'n_checkout' };
const CONVERSATION_ID = 'conv_1';

function record(overrides: Partial<ChatTurnRecord> = {}): ChatTurnRecord {
  return {
    id: 'turn_user',
    conversationId: CONVERSATION_ID,
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

function assistantRecord(overrides: Partial<ChatTurnRecord> = {}): ChatTurnRecord {
  return record({
    id: 'turn_assistant',
    seq: 2,
    role: 'assistant',
    content: '',
    status: 'pending',
    createdAt: '2026-08-10T12:00:02.000Z',
    ...overrides,
  });
}

function progress(overrides: Partial<Extract<ChatGatewayMessage, { type: 'chat.turn.progress' }>> = {}): ChatGatewayMessage {
  return {
    type: 'chat.turn.progress',
    conversationId: CONVERSATION_ID,
    turnId: 'turn_assistant',
    seq: 1,
    kind: 'status',
    tool: null,
    detail: 'Selecting context nodes',
    ts: '2026-08-10T12:00:03.000Z',
    ...overrides,
  };
}

function completed(overrides: Partial<Extract<ChatGatewayMessage, { type: 'chat.turn.completed' }>> = {}): ChatGatewayMessage {
  return {
    type: 'chat.turn.completed',
    conversationId: CONVERSATION_ID,
    turnId: 'turn_assistant',
    answer: 'The checkout folder owns the cart-to-confirmation flow.',
    citations: [],
    metrics: null,
    ts: '2026-08-10T12:00:05.000Z',
    ...overrides,
  };
}

function failed(overrides: Partial<Extract<ChatGatewayMessage, { type: 'chat.turn.error' }>> = {}): ChatGatewayMessage {
  return {
    type: 'chat.turn.error',
    conversationId: CONVERSATION_ID,
    turnId: 'turn_assistant',
    code: 'chat.mcp_unauthorized',
    message: 'Sayre could not read the repository index for this question.',
    ts: '2026-08-10T12:00:05.000Z',
    ...overrides,
  };
}

function started(): ChatTranscriptState {
  return appendTurnPair(emptyChatTranscript, record(), assistantRecord(), SCOPE);
}

function assistantOf(state: ChatTranscriptState) {
  const turn = state.turns.find((candidate) => candidate.id === 'turn_assistant');
  expect(turn).toBeDefined();
  return turn!;
}

describe('transcript append', () => {
  // @spec AC-1 AC-8
  it('appends the user turn and the pending assistant turn in ordinal order with the posted scope stored', () => {
    const state = started();
    expect(state.conversationId).toBe(CONVERSATION_ID);
    expect(state.turns.map((turn) => turn.id)).toEqual(['turn_user', 'turn_assistant']);
    expect(state.turns.map((turn) => turn.seq)).toEqual([1, 2]);
    expect(state.turns.map((turn) => turn.role)).toEqual(['user', 'assistant']);
    expect(assistantOf(state).status).toBe('pending');
    for (const turn of state.turns) {
      expect(turn.scope).toEqual(SCOPE);
      expect(turn.progress).toEqual([]);
      expect(turn.lastProgressSeq).toBeNull();
    }
    // The stored scope is the retry payload (AC-11): a later pair posted under a
    // different scope must not rewrite an earlier turn's recorded scope.
    const second = appendTurnPair(state, record({ id: 'turn_user_2', seq: 3 }), assistantRecord({ id: 'turn_assistant_2', seq: 4 }), { view: 'product', anchorNodeId: null });
    expect(second.turns.map((turn) => turn.id)).toEqual(['turn_user', 'turn_assistant', 'turn_user_2', 'turn_assistant_2']);
    expect(second.turns[3]!.scope).toEqual({ view: 'product', anchorNodeId: null });
    expect(second.turns[1]!.scope).toEqual(SCOPE);
  });

  // @spec EC-17
  it('reports an active turn only while an assistant turn is pending or running', () => {
    expect(hasActiveTurn(emptyChatTranscript)).toBe(false);
    const state = started();
    expect(hasActiveTurn(state)).toBe(true);
    expect(hasActiveTurn(applyChatEvent(state, progress()))).toBe(true);
    expect(hasActiveTurn(applyChatEvent(state, completed()))).toBe(false);
    expect(hasActiveTurn(applyChatEvent(state, failed()))).toBe(false);
    const userOnly = appendTurnPair(emptyChatTranscript, record({ status: 'pending' }), assistantRecord({ status: 'completed' }), SCOPE);
    expect(hasActiveTurn(userOnly)).toBe(false);
  });
});

describe('progress ordering and idempotency', () => {
  // @spec AC-3
  it('promotes the pending assistant turn to running and accumulates an ordered ticker', () => {
    const state = applyChatEvent(
      applyChatEvent(started(), progress({ seq: 1, kind: 'status', detail: 'Selecting context nodes' })),
      progress({ seq: 2, kind: 'tool_call', tool: 'graph.search', detail: 'apps/web/checkout' }),
    );
    const assistant = assistantOf(state);
    expect(assistant.status).toBe('running');
    expect(assistant.lastProgressSeq).toBe(2);
    expect(assistant.progress.map((line) => line.seq)).toEqual([1, 2]);
    expect(assistant.progress[0]).toMatchObject({ kind: 'status', tool: null, detail: 'Selecting context nodes' });
    expect(assistant.progress[1]).toMatchObject({ kind: 'tool_call', tool: 'graph.search', detail: 'apps/web/checkout' });
  });

  // @spec EC-1
  it('applies a duplicate progress seq exactly once and leaves state identical', () => {
    const first = applyChatEvent(started(), progress({ seq: 1 }));
    const repeated = applyChatEvent(first, progress({ seq: 1, detail: 'Selecting context nodes (redelivered)' }));
    expect(repeated).toBe(first);
    expect(assistantOf(repeated).progress).toHaveLength(1);
    expect(assistantOf(repeated).lastProgressSeq).toBe(1);
  });

  // @spec EC-2
  it('drops a lower seq delivered after a higher one and never rewrites a rendered line', () => {
    const third = applyChatEvent(started(), progress({ seq: 3, detail: 'Third' }));
    const late = applyChatEvent(third, progress({ seq: 2, detail: 'Second, delivered late' }));
    expect(late).toBe(third);
    const lines = assistantOf(late).progress;
    expect(lines.map((line) => line.seq)).toEqual([3]);
    expect(lines.map((line) => line.detail)).toEqual(['Third']);
    expect(assistantOf(late).lastProgressSeq).toBe(3);
  });

  // @spec EC-3
  it('renders a gapped sequence without inventing filler lines or stalling', () => {
    const gapped = applyChatEvent(applyChatEvent(started(), progress({ seq: 1, detail: 'One' })), progress({ seq: 4, detail: 'Four' }));
    const assistant = assistantOf(gapped);
    expect(assistant.progress.map((line) => line.seq)).toEqual([1, 4]);
    expect(assistant.progress.map((line) => line.detail)).toEqual(['One', 'Four']);
    expect(assistant.lastProgressSeq).toBe(4);
    expect(assistant.status).toBe('running');
    // The gap does not buffer: a later completion still lands.
    expect(assistantOf(applyChatEvent(gapped, completed())).status).toBe('completed');
  });
});

describe('terminal-event precedence', () => {
  // @spec AC-4
  it('records the answer, citations, and metrics from a completion', () => {
    const state = applyChatEvent(applyChatEvent(started(), progress({ seq: 1 })), completed({
      citations: [{ nodeId: 'n_use_cart', label: 'useCart.ts', kind: 'file', resolvedNodeId: 'n_use_cart' }],
      metrics: { contextNodes: 12, tokensUsed: 900, baselineTokens: 34_200, ratio: 38 },
    }));
    const assistant = assistantOf(state);
    expect(assistant.status).toBe('completed');
    expect(assistant.content).toBe('The checkout folder owns the cart-to-confirmation flow.');
    expect(assistant.citations).toEqual([{ nodeId: 'n_use_cart', label: 'useCart.ts', kind: 'file', resolvedNodeId: 'n_use_cart' }]);
    expect(assistant.metrics).toEqual({ contextNodes: 12, tokensUsed: 900, baselineTokens: 34_200, ratio: 38 });
    expect(assistant.error).toBeNull();
  });

  // @spec AC-11 EC-16
  it('records the sanitized server message on an error turn', () => {
    const assistant = assistantOf(applyChatEvent(started(), failed()));
    expect(assistant.status).toBe('error');
    expect(assistant.error).toEqual({
      code: 'chat.mcp_unauthorized',
      message: 'Sayre could not read the repository index for this question.',
    });
  });

  // @spec EC-4
  it('ignores progress that arrives after a terminal event for the same turn', () => {
    const done = applyChatEvent(applyChatEvent(started(), progress({ seq: 1 })), completed());
    const afterCompletion = applyChatEvent(done, progress({ seq: 2, detail: 'Late tool call' }));
    expect(afterCompletion).toBe(done);
    expect(assistantOf(afterCompletion).progress).toHaveLength(1);
    expect(assistantOf(afterCompletion).status).toBe('completed');
    expect(assistantOf(afterCompletion).content).toBe('The checkout folder owns the cart-to-confirmation flow.');

    const errored = applyChatEvent(started(), failed());
    const afterError = applyChatEvent(errored, progress({ seq: 1, detail: 'Late tool call' }));
    expect(afterError).toBe(errored);
    expect(assistantOf(afterError).status).toBe('error');
    expect(assistantOf(afterError).progress).toEqual([]);
  });

  // @spec EC-7
  it('never advances lastProgressSeq from a seq smuggled onto a terminal frame', () => {
    const running = applyChatEvent(applyChatEvent(started(), progress({ seq: 1 })), progress({ seq: 2 }));
    const terminal = applyChatEvent(running, { ...completed(), seq: 99 } as unknown as ChatGatewayMessage);
    const assistant = assistantOf(terminal);
    expect(assistant.status).toBe('completed');
    expect(assistant.lastProgressSeq).toBe(2);
    expect(assistant.progress.map((line) => line.seq)).toEqual([1, 2]);
  });

  // @spec EC-8
  it('lets the first terminal event win and ignores every later one', () => {
    const completedFirst = applyChatEvent(started(), completed());
    const thenError = applyChatEvent(completedFirst, failed());
    expect(thenError).toBe(completedFirst);
    expect(assistantOf(thenError).status).toBe('completed');
    expect(assistantOf(thenError).error).toBeNull();

    const twice = applyChatEvent(completedFirst, completed({ answer: 'A different answer' }));
    expect(twice).toBe(completedFirst);
    expect(assistantOf(twice).content).toBe('The checkout folder owns the cart-to-confirmation flow.');

    const erroredFirst = applyChatEvent(started(), failed());
    const thenCompleted = applyChatEvent(erroredFirst, completed());
    expect(thenCompleted).toBe(erroredFirst);
    expect(assistantOf(thenCompleted).status).toBe('error');
    expect(assistantOf(thenCompleted).content).toBe('');
  });
});

describe('push addressing', () => {
  // @spec EC-5
  it('ignores every push addressed to another conversation', () => {
    const state = started();
    for (const message of [
      progress({ conversationId: 'conv_other' }),
      completed({ conversationId: 'conv_other' }),
      failed({ conversationId: 'conv_other' }),
    ]) {
      const next = applyChatEvent(state, message);
      expect(next).toBe(state);
      expect(next.turns).toHaveLength(2);
      expect(assistantOf(next).status).toBe('pending');
    }
  });

  // @spec EC-6
  it('never fabricates a phantom turn from a push for an unknown turn id', () => {
    const state = started();
    for (const message of [
      progress({ turnId: 'turn_ghost' }),
      completed({ turnId: 'turn_ghost' }),
      failed({ turnId: 'turn_ghost' }),
    ]) {
      const next = applyChatEvent(state, message);
      expect(next).toBe(state);
      expect(next.turns.map((turn) => turn.id)).toEqual(['turn_user', 'turn_assistant']);
    }
    expect(applyChatEvent(emptyChatTranscript, completed())).toBe(emptyChatTranscript);
  });
});

describe('REST reconciliation', () => {
  function detail(turns: ChatTurnRecord[]): ChatConversationDetail {
    return {
      conversation: {
        id: CONVERSATION_ID,
        title: null,
        createdAt: '2026-08-10T12:00:00.000Z',
        updatedAt: '2026-08-10T12:00:06.000Z',
      },
      turns,
    };
  }

  // @spec AC-12
  it('lets the server row win per field while keeping every locally known turn and its progress', () => {
    const local = applyChatEvent(applyChatEvent(started(), progress({ seq: 1, detail: 'One' })), progress({ seq: 2, detail: 'Two' }));
    const withLocalOnly = appendTurnPair(local, record({ id: 'turn_user_2', seq: 3 }), assistantRecord({ id: 'turn_assistant_2', seq: 4 }), SCOPE);

    const reconciled = reconcileTranscript(withLocalOnly, detail([
      record({ content: 'What does this folder do? (server copy)' }),
      assistantRecord({
        status: 'completed',
        content: 'The checkout folder owns the cart-to-confirmation flow.',
        citations: [{ nodeId: 'n_use_cart', label: 'useCart.ts', kind: 'file', resolvedNodeId: 'n_use_cart' }],
        metrics: { contextNodes: 12, tokensUsed: 900, baselineTokens: 34_200, ratio: 38 },
      }),
      record({ id: 'turn_user_unknown', seq: 5, content: 'Asked from another tab' }),
    ]));

    const ids = reconciled.turns.map((turn) => turn.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(['turn_user', 'turn_assistant', 'turn_user_2', 'turn_assistant_2', 'turn_user_unknown']);
    expect(reconciled.turns[0]!.content).toBe('What does this folder do? (server copy)');

    const assistant = assistantOf(reconciled);
    expect(assistant.status).toBe('completed');
    expect(assistant.content).toBe('The checkout folder owns the cart-to-confirmation flow.');
    expect(assistant.citations).toEqual([{ nodeId: 'n_use_cart', label: 'useCart.ts', kind: 'file', resolvedNodeId: 'n_use_cart' }]);
    expect(assistant.metrics).toEqual({ contextNodes: 12, tokensUsed: 900, baselineTokens: 34_200, ratio: 38 });
    expect(assistant.progress.map((line) => line.detail)).toEqual(['One', 'Two']);
    expect(assistant.lastProgressSeq).toBe(2);
    expect(assistant.scope).toEqual(SCOPE);
    expect(reconciled.turns[4]!.scope).toBeNull();
    expect(reconciled.turns[4]!.progress).toEqual([]);
  });

  // @spec EC-10
  it('adopts a turn completed while the socket was down without duplicating or re-appending anything', () => {
    const midTurn = applyChatEvent(applyChatEvent(started(), progress({ seq: 1, detail: 'One' })), progress({ seq: 2, detail: 'Two' }));
    expect(assistantOf(midTurn).status).toBe('running');

    const reconnected = reconcileTranscript(midTurn, detail([
      record(),
      assistantRecord({ status: 'completed', content: 'Completed while the socket was down.' }),
    ]));

    expect(reconnected.turns).toHaveLength(2);
    expect(reconnected.turns.map((turn) => turn.id)).toEqual(['turn_user', 'turn_assistant']);
    expect(reconnected.turns.filter((turn) => turn.role === 'user')).toHaveLength(1);
    expect(assistantOf(reconnected).status).toBe('completed');
    expect(assistantOf(reconnected).content).toBe('Completed while the socket was down.');
    expect(assistantOf(reconnected).progress.map((line) => line.detail)).toEqual(['One', 'Two']);
    expect(hasActiveTurn(reconnected)).toBe(false);
  });
});
