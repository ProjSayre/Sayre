// CH-06 red suite — the pinned `chat.turn.*` wire contract and the pure
// parsers/formatters that guard it. Authored from .pipeline/spec.md before any
// implementation exists; every assertion traces to an AC-*/EC-* id in
// .pipeline/spec.json.
//
// Node harness (vitest `environment: 'node'`): no DOM is touched here.

import { describe, expect, it } from 'vitest';
import {
  CHAT_DEGRADED_POLL_INTERVAL_MS,
  CHAT_DEGRADED_POLL_MAX_ATTEMPTS,
  CHAT_DRAWABLE_CITATION_KINDS,
  CHAT_INPUT_ELEMENT_ID,
  CHAT_PANEL_ELEMENT_ID,
  CHAT_QUESTION_MAX_CHARACTERS,
  formatChatMetrics,
  parseChatCitations,
  parseChatGatewayMessage,
  parseChatMetrics,
} from './chatContract';

const CONVERSATION_ID = 'conv_1';
const TURN_ID = 'turn_a';

function progressFrame(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'chat.turn.progress',
    conversationId: CONVERSATION_ID,
    turnId: TURN_ID,
    seq: 1,
    kind: 'status',
    tool: null,
    detail: 'Selecting context nodes',
    ts: '2026-08-10T12:00:00.000Z',
    ...overrides,
  });
}

function completedFrame(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'chat.turn.completed',
    conversationId: CONVERSATION_ID,
    turnId: TURN_ID,
    answer: 'The checkout folder owns the cart-to-confirmation flow.',
    citations: [
      { nodeId: 'n_payment_form', label: 'PaymentForm.tsx', kind: 'file', resolvedNodeId: 'n_payment_form' },
    ],
    metrics: { contextNodes: 12, tokensUsed: 900, baselineTokens: 34_200, ratio: 38 },
    ts: '2026-08-10T12:00:04.000Z',
    ...overrides,
  });
}

function errorFrame(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'chat.turn.error',
    conversationId: CONVERSATION_ID,
    turnId: TURN_ID,
    code: 'chat.mcp_unauthorized',
    message: 'Sayre could not read the repository index for this question.',
    ts: '2026-08-10T12:00:04.000Z',
    ...overrides,
  });
}

describe('chat gateway frame contract', () => {
  // @spec AC-3 AC-4
  it('parses the three pinned chat.turn.* frames with their payload fields flattened', () => {
    const progress = parseChatGatewayMessage(progressFrame({ seq: 3, kind: 'tool_call', tool: 'graph.search', detail: 'apps/web/checkout' }));
    expect(progress).toEqual({
      type: 'chat.turn.progress',
      conversationId: CONVERSATION_ID,
      turnId: TURN_ID,
      seq: 3,
      kind: 'tool_call',
      tool: 'graph.search',
      detail: 'apps/web/checkout',
      ts: '2026-08-10T12:00:00.000Z',
    });

    const completed = parseChatGatewayMessage(completedFrame());
    expect(completed).toMatchObject({
      type: 'chat.turn.completed',
      conversationId: CONVERSATION_ID,
      turnId: TURN_ID,
      answer: 'The checkout folder owns the cart-to-confirmation flow.',
      metrics: { contextNodes: 12, tokensUsed: 900, baselineTokens: 34_200, ratio: 38 },
    });
    expect(completed && 'citations' in completed ? completed.citations : null).toEqual([
      { nodeId: 'n_payment_form', label: 'PaymentForm.tsx', kind: 'file', resolvedNodeId: 'n_payment_form' },
    ]);

    expect(parseChatGatewayMessage(errorFrame())).toMatchObject({
      type: 'chat.turn.error',
      conversationId: CONVERSATION_ID,
      turnId: TURN_ID,
      code: 'chat.mcp_unauthorized',
      message: 'Sayre could not read the repository index for this question.',
    });
  });

  // @spec EC-7
  it('accepts a terminal frame that carries a stray seq without surfacing it as progress ordering', () => {
    const completed = parseChatGatewayMessage(completedFrame({ seq: 99 }));
    expect(completed).not.toBeNull();
    expect(completed?.type).toBe('chat.turn.completed');
    const failed = parseChatGatewayMessage(errorFrame({ seq: 99 }));
    expect(failed).not.toBeNull();
    expect(failed?.type).toBe('chat.turn.error');
  });

  // @spec EC-20
  it('returns null for every malformed frame and never throws', () => {
    const malformed: unknown[] = [
      'not json at all',
      '42',
      '"a string"',
      'null',
      '[1,2,3]',
      42,
      null,
      undefined,
      JSON.stringify({ type: 'chat.turn.started', conversationId: CONVERSATION_ID, turnId: TURN_ID }),
      progressFrame({ conversationId: undefined }),
      progressFrame({ conversationId: 7 }),
      progressFrame({ turnId: null }),
      progressFrame({ seq: '3' }),
      progressFrame({ seq: 1.5 }),
      progressFrame({ kind: 'thinking' }),
      progressFrame({ ts: 12 }),
      completedFrame({ answer: 42 }),
      completedFrame({ answer: undefined }),
      completedFrame({ ts: null }),
      errorFrame({ code: undefined }),
      errorFrame({ message: null }),
      errorFrame({ ts: undefined }),
    ];
    for (const frame of malformed) {
      expect(() => parseChatGatewayMessage(frame)).not.toThrow();
      expect(parseChatGatewayMessage(frame)).toBeNull();
    }
  });
});

describe('citation parsing', () => {
  // @spec EC-13 AC-6
  it('keeps an undrawable citation kind as evidence under the closed presentational bucket', () => {
    const citations = parseChatCitations([
      { nodeId: 'n_use_cart', label: 'useCart.ts', kind: 'file', resolvedNodeId: 'n_use_cart' },
      { nodeId: 'fn_calculate_total', label: 'calculateTotal()', kind: 'function', resolvedNodeId: null },
      { nodeId: 'cls_cart', label: 'Cart', kind: 'class', resolvedNodeId: 'n_use_cart' },
      { nodeId: 'feat_checkout', label: 'Checkout & payments', kind: 'feature', resolvedNodeId: null },
      { nodeId: 'tick_1', label: 'ATLAS-42', kind: 'ticket', resolvedNodeId: null },
      { nodeId: 'n_checkout', label: 'checkout/', kind: 'folder', resolvedNodeId: 'n_checkout' },
    ]);
    expect(citations.map((citation) => citation.kind)).toEqual([
      'file', 'unknown', 'unknown', 'feature', 'ticket', 'folder',
    ]);
    expect(citations).toHaveLength(6);
    expect(citations[1]).toEqual({ nodeId: 'fn_calculate_total', label: 'calculateTotal()', kind: 'unknown', resolvedNodeId: null });
  });

  // @spec EC-20
  it('drops malformed citation entries and refuses a non-array value', () => {
    expect(parseChatCitations([
      { nodeId: 'n_ok', label: 'ok.ts', kind: 'file', resolvedNodeId: null },
      { label: 'missing node id', kind: 'file', resolvedNodeId: null },
      { nodeId: 'n_bad_label', label: 42, kind: 'file', resolvedNodeId: null },
      { nodeId: 'n_bad_resolved', label: 'bad.ts', kind: 'file', resolvedNodeId: 42 },
      'not an object',
      null,
    ])).toEqual([{ nodeId: 'n_ok', label: 'ok.ts', kind: 'file', resolvedNodeId: null }]);
    expect(parseChatCitations(undefined)).toEqual([]);
    expect(parseChatCitations(null)).toEqual([]);
    expect(parseChatCitations('citations')).toEqual([]);
    expect(parseChatCitations({ nodeId: 'n_ok' })).toEqual([]);
  });

  // @spec AC-6
  it('publishes exactly the four drawable citation kinds, frozen', () => {
    expect([...CHAT_DRAWABLE_CITATION_KINDS]).toEqual(['file', 'folder', 'feature', 'ticket']);
    expect(Object.isFrozen(CHAT_DRAWABLE_CITATION_KINDS)).toBe(true);
  });
});

describe('metrics parsing and formatting', () => {
  // @spec EC-15
  it('returns null for missing, non-object, non-numeric, or non-finite metrics', () => {
    for (const value of [
      undefined,
      null,
      'metrics',
      [],
      { contextNodes: 12, tokensUsed: 900, baselineTokens: 34_200 },
      { contextNodes: '12', tokensUsed: 900, baselineTokens: 34_200, ratio: 38 },
      { contextNodes: 12, tokensUsed: Number.NaN, baselineTokens: 34_200, ratio: 38 },
      { contextNodes: 12, tokensUsed: 900, baselineTokens: Number.POSITIVE_INFINITY, ratio: 38 },
      { contextNodes: 12, tokensUsed: 900, baselineTokens: 34_200, ratio: Number.NaN },
    ]) {
      expect(parseChatMetrics(value)).toBeNull();
    }
    expect(parseChatMetrics({ contextNodes: 12, tokensUsed: 900, baselineTokens: 34_200, ratio: 38 }))
      .toEqual({ contextNodes: 12, tokensUsed: 900, baselineTokens: 34_200, ratio: 38 });
  });

  // @spec AC-4
  it('formats the footer as the context/token/ratio sentence', () => {
    expect(formatChatMetrics({ contextNodes: 12, tokensUsed: 900, baselineTokens: 34_200, ratio: 38 }))
      .toBe('12 context nodes · 900 tokens · 38× less than full repo');
    expect(formatChatMetrics({ contextNodes: 12, tokensUsed: 4_300, baselineTokens: 163_400, ratio: 38 }))
      .toMatch(/^12 context nodes · 4,?300 tokens · 38× less than full repo$/);
  });

  // @spec EC-14
  it('omits the ratio clause without ever dividing when the baseline or ratio is unusable', () => {
    expect(formatChatMetrics({ contextNodes: 12, tokensUsed: 900, baselineTokens: 0, ratio: 0 }))
      .toBe('12 context nodes · 900 tokens');
    expect(formatChatMetrics({ contextNodes: 12, tokensUsed: 900, baselineTokens: 0, ratio: 38 }))
      .toBe('12 context nodes · 900 tokens');
    expect(formatChatMetrics({ contextNodes: 12, tokensUsed: 900, baselineTokens: 34_200, ratio: 0 }))
      .toBe('12 context nodes · 900 tokens');
    expect(formatChatMetrics({ contextNodes: 12, tokensUsed: 900, baselineTokens: 34_200, ratio: -4 }))
      .toBe('12 context nodes · 900 tokens');
    expect(formatChatMetrics({ contextNodes: 12, tokensUsed: 900, baselineTokens: 34_200, ratio: Number.POSITIVE_INFINITY }))
      .toBe('12 context nodes · 900 tokens');
    expect(formatChatMetrics({ contextNodes: 0, tokensUsed: 0, baselineTokens: 0, ratio: 0 }))
      .toBe('0 context nodes · 0 tokens');
  });
});

describe('chat panel constants', () => {
  // @spec EC-23 EC-9
  it("mirrors CH-03's question ceiling and pins the degraded-poll budget and element ids", () => {
    expect(CHAT_QUESTION_MAX_CHARACTERS).toBe(8_000);
    expect(CHAT_DEGRADED_POLL_INTERVAL_MS).toBe(3_000);
    expect(CHAT_DEGRADED_POLL_MAX_ATTEMPTS).toBe(20);
    expect(CHAT_PANEL_ELEMENT_ID).toBe('ask-sayre-panel');
    expect(CHAT_INPUT_ELEMENT_ID).toBe('ask-sayre-input');
  });
});
