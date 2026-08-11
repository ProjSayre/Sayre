// CH-05 — the pure (no I/O) chat-event validation gate: channel naming, envelope
// decoding, citation id extraction and citation filtering. Authored by `red`
// from .pipeline/spec.md before any implementation exists.
//
// Boundary note: this file measures what the DECODER owes. The Redis dispatch
// half (refcounting, ordering) is measured in ../redis/chatPubsub.test.ts, the
// per-push RBAC re-filter in ../fanout/chatFanout.test.ts, and the whole path
// over a real `ws` socket in ../chatE2e.test.ts.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CHAT_EVENT_CHANNEL_PREFIX,
  CHAT_EVENT_SOURCE,
  CHAT_MAX_CITATIONS,
  chatEventChannel,
  citationNodeIds,
  decodeChatEvent,
  filterCitations,
  parseChatEventChannel,
} from './chatEvents';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG_ID = '99999999-9999-4999-8999-999999999999';
const CONVERSATION_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_CONVERSATION_ID = '55555555-5555-4555-8555-555555555555';
const TURN_ID = '66666666-6666-4666-8666-666666666666';
const TS = '2026-08-11T00:00:00.000000Z';

const CHANNEL = `sayre:chat.events:${ORG_ID}:${CONVERSATION_ID}`;

function envelopeJson(
  type: string,
  payload: unknown,
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    message_id: 'm-1',
    idempotency_key: `${type}:${TURN_ID}`,
    org_id: ORG_ID,
    type,
    schema_version: 1,
    occurred_at: TS,
    source: 'sayre-chat-worker',
    payload,
    ...overrides,
  });
}

function progressPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    conversationId: CONVERSATION_ID,
    turnId: TURN_ID,
    seq: 1,
    kind: 'status',
    tool: null,
    detail: 'Preparing…',
    ts: TS,
    ...overrides,
  };
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

function metrics(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contextNodes: 7,
    tokensUsed: 1234,
    baselineTokens: 9876,
    ratio: 0.125,
    ...overrides,
  };
}

function completedPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    conversationId: CONVERSATION_ID,
    turnId: TURN_ID,
    answer: 'Login is handled in `src/auth/login.ts`.',
    citations: [citation()],
    metrics: metrics(),
    ts: TS,
    ...overrides,
  };
}

function errorPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    conversationId: CONVERSATION_ID,
    turnId: TURN_ID,
    code: 'retrieval_failed',
    message: 'The question could not be answered.',
    ts: TS,
    ...overrides,
  };
}

/** A completed push shaped exactly as `decodeChatEvent` must produce it. */
function completedPush(citations: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    type: 'chat.turn.completed',
    conversationId: CONVERSATION_ID,
    turnId: TURN_ID,
    answer: 'Login is handled in `src/auth/login.ts`.',
    citations,
    metrics: metrics(),
    ts: TS,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('chatEventChannel / parseChatEventChannel', () => {
  // @spec AC-13
  it('AC-13: produces exactly the string CH-04 sayre_workers.chat.events.chat_event_channel produces', () => {
    // Pinned against the Python side literally, not against the TS constant, so
    // the two implementations cannot drift together:
    //   f"{CHAT_EVENT_CHANNEL_PREFIX}:{org_id}:{conversation_id}"
    //   CHAT_EVENT_CHANNEL_PREFIX = "sayre:chat.events"
    expect(CHAT_EVENT_CHANNEL_PREFIX).toBe('sayre:chat.events');
    expect(chatEventChannel(ORG_ID, CONVERSATION_ID)).toBe(
      `sayre:chat.events:${ORG_ID}:${CONVERSATION_ID}`,
    );
    expect(chatEventChannel('org-a', 'conv-b')).toBe('sayre:chat.events:org-a:conv-b');
  });

  // @spec AC-13
  it('AC-13: pins the mirrored worker constants (source, max citations)', () => {
    expect(CHAT_EVENT_SOURCE).toBe('sayre-chat-worker');
    expect(CHAT_MAX_CITATIONS).toBe(24);
  });

  // @spec AC-13
  it('AC-13: parseChatEventChannel round-trips chatEventChannel', () => {
    expect(parseChatEventChannel(chatEventChannel(ORG_ID, CONVERSATION_ID))).toEqual({
      orgId: ORG_ID,
      conversationId: CONVERSATION_ID,
    });
  });

  // @spec EC-6
  it('EC-6: returns null for a wrong prefix, too few/many colon segments, or a blank segment', () => {
    expect(parseChatEventChannel(`sayre:graph.updated:${ORG_ID}:${CONVERSATION_ID}`)).toBeNull();
    expect(parseChatEventChannel(`sayre:chat.events:${ORG_ID}`)).toBeNull();
    expect(parseChatEventChannel(`sayre:chat.events:${ORG_ID}:${CONVERSATION_ID}:extra`)).toBeNull();
    expect(parseChatEventChannel(`sayre:chat.events::${CONVERSATION_ID}`)).toBeNull();
    expect(parseChatEventChannel(`sayre:chat.events:${ORG_ID}:`)).toBeNull();
    expect(parseChatEventChannel('')).toBeNull();
    expect(parseChatEventChannel('sayre:chat.events')).toBeNull();
  });
});

describe('decodeChatEvent — accepted events', () => {
  // @spec AC-6
  it('AC-6: a progress envelope decodes to exactly the pinned progress key set', () => {
    const decoded = decodeChatEvent(CHANNEL, envelopeJson('chat.turn.progress', progressPayload()));

    expect(decoded).not.toBeNull();
    expect(decoded?.orgId).toBe(ORG_ID);
    expect(decoded?.conversationId).toBe(CONVERSATION_ID);
    expect(decoded?.turnId).toBe(TURN_ID);
    expect(decoded?.push).toEqual({
      type: 'chat.turn.progress',
      conversationId: CONVERSATION_ID,
      turnId: TURN_ID,
      seq: 1,
      kind: 'status',
      tool: null,
      detail: 'Preparing…',
      ts: TS,
    });
    expect(Object.keys(decoded?.push ?? {}).sort()).toEqual([
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
  it('AC-6: a completed envelope decodes to exactly the pinned completed/citation/metrics key sets', () => {
    const decoded = decodeChatEvent(
      CHANNEL,
      envelopeJson('chat.turn.completed', completedPayload()),
    );

    expect(decoded?.push).toEqual(completedPush([citation()]));
    expect(Object.keys(decoded?.push ?? {}).sort()).toEqual([
      'answer',
      'citations',
      'conversationId',
      'metrics',
      'ts',
      'turnId',
      'type',
    ]);
    const push = decoded?.push as { citations: unknown[]; metrics: unknown };
    expect(Object.keys(push.citations[0] as object).sort()).toEqual([
      'kind',
      'label',
      'nodeId',
      'resolvedNodeId',
    ]);
    expect(Object.keys(push.metrics as object).sort()).toEqual([
      'baselineTokens',
      'contextNodes',
      'ratio',
      'tokensUsed',
    ]);
  });

  // @spec AC-6
  it('AC-6: an error envelope decodes to exactly the pinned error key set', () => {
    const decoded = decodeChatEvent(CHANNEL, envelopeJson('chat.turn.error', errorPayload()));

    expect(decoded?.push).toEqual({
      type: 'chat.turn.error',
      conversationId: CONVERSATION_ID,
      turnId: TURN_ID,
      code: 'retrieval_failed',
      message: 'The question could not be answered.',
      ts: TS,
    });
    expect(Object.keys(decoded?.push ?? {}).sort()).toEqual([
      'code',
      'conversationId',
      'message',
      'ts',
      'turnId',
      'type',
    ]);
  });

  // @spec AC-6
  it('AC-6: extra keys on the worker payload and on a citation are ignored, never carried onto the push', () => {
    const decoded = decodeChatEvent(
      CHANNEL,
      envelopeJson(
        'chat.turn.completed',
        completedPayload({
          seq: 99, // a stray progress-shaped key on a terminal event
          internalPromptText: 'SECRET-PROMPT-NEVER-ON-THE-WIRE',
          citations: [citation({ internalScore: 0.99, path: '/src/auth/login.ts' })],
        }),
      ),
    );

    expect(decoded?.push).toEqual(completedPush([citation()]));
    expect(JSON.stringify(decoded?.push)).not.toContain('SECRET-PROMPT-NEVER-ON-THE-WIRE');
    expect(JSON.stringify(decoded?.push)).not.toContain('internalScore');
    expect(JSON.stringify(decoded?.push)).not.toContain('"seq"');
  });

  // @spec AC-6 EC-27
  it('AC-6/EC-27: `ts` and `seq` are relayed verbatim — never re-formatted, renumbered or defaulted', () => {
    const oddTs = '2026-08-11T00:00:00.123456+00:00';
    const decoded = decodeChatEvent(
      CHANNEL,
      envelopeJson('chat.turn.progress', progressPayload({ seq: 7, ts: oddTs })),
    );

    expect((decoded?.push as { ts: string }).ts).toBe(oddTs);
    expect((decoded?.push as { seq: number }).seq).toBe(7);
  });

  // @spec AC-8
  it('AC-8: orgId always comes from envelope.org_id, never from a payload field', () => {
    const decoded = decodeChatEvent(
      CHANNEL,
      envelopeJson('chat.turn.progress', progressPayload({ orgId: OTHER_ORG_ID })),
    );

    expect(decoded?.orgId).toBe(ORG_ID);
    expect(JSON.stringify(decoded?.push)).not.toContain(OTHER_ORG_ID);
  });
});

describe('decodeChatEvent — dropped events', () => {
  // @spec AC-7 EC-1
  it('AC-7/EC-1: non-JSON text, a JSON array, and an envelope missing a required field are dropped with a log', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(decodeChatEvent(CHANNEL, 'not json at all')).toBeNull();
    expect(decodeChatEvent(CHANNEL, JSON.stringify([1, 2, 3]))).toBeNull();
    expect(
      decodeChatEvent(
        CHANNEL,
        envelopeJson('chat.turn.progress', progressPayload(), { org_id: '' }),
      ),
    ).toBeNull();
    expect(
      decodeChatEvent(
        CHANNEL,
        envelopeJson('chat.turn.progress', progressPayload(), { message_id: undefined }),
      ),
    ).toBeNull();

    expect(logged).toHaveBeenCalled();
  });

  // @spec AC-7 EC-2
  it('AC-7/EC-2: an envelope org_id that disagrees with the channel org segment is dropped', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(
      decodeChatEvent(
        CHANNEL,
        envelopeJson('chat.turn.progress', progressPayload(), { org_id: OTHER_ORG_ID }),
      ),
    ).toBeNull();
    // ...and the mirror image: right envelope org, wrong channel org segment.
    expect(
      decodeChatEvent(
        `sayre:chat.events:${OTHER_ORG_ID}:${CONVERSATION_ID}`,
        envelopeJson('chat.turn.progress', progressPayload()),
      ),
    ).toBeNull();
  });

  // @spec AC-7 EC-3
  it('AC-7/EC-3: a payload conversationId that disagrees with the channel conversation segment is dropped', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(
      decodeChatEvent(
        CHANNEL,
        envelopeJson(
          'chat.turn.progress',
          progressPayload({ conversationId: OTHER_CONVERSATION_ID }),
        ),
      ),
    ).toBeNull();
    expect(
      decodeChatEvent(
        CHANNEL,
        envelopeJson('chat.turn.completed', completedPayload({ conversationId: undefined })),
      ),
    ).toBeNull();
  });

  // @spec AC-7 EC-4
  it('AC-7/EC-4: an envelope type outside the three pinned chat types is dropped', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    for (const type of ['graph.updated', 'chat.turn.request', 'chat.turn.started', '']) {
      expect(decodeChatEvent(CHANNEL, envelopeJson(type, progressPayload()))).toBeNull();
    }
  });

  // @spec EC-5
  it('EC-5: an envelope source other than sayre-chat-worker is dropped', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(
      decodeChatEvent(
        CHANNEL,
        envelopeJson('chat.turn.progress', progressPayload(), { source: 'ingestion-worker' }),
      ),
    ).toBeNull();
    expect(
      decodeChatEvent(
        CHANNEL,
        envelopeJson('chat.turn.progress', progressPayload(), { source: 'sayre-core-chat' }),
      ),
    ).toBeNull();
  });

  // @spec EC-6
  it('EC-6: an unparsable channel name is dropped even when the envelope itself is valid', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(
      decodeChatEvent('sayre:chat.events:only-one-segment', envelopeJson('chat.turn.progress', progressPayload())),
    ).toBeNull();
    expect(
      decodeChatEvent('sayre:graph.updated', envelopeJson('chat.turn.progress', progressPayload())),
    ).toBeNull();
  });

  // @spec EC-7
  it('EC-7: structurally invalid progress payloads are dropped', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const invalid = [
      progressPayload({ seq: 0 }),
      progressPayload({ seq: -1 }),
      progressPayload({ seq: 1.5 }),
      progressPayload({ seq: '1' }),
      progressPayload({ seq: undefined }),
      progressPayload({ kind: 'other' }),
      progressPayload({ kind: undefined }),
      progressPayload({ tool: 42 }),
      progressPayload({ detail: { text: 'x' } }),
      progressPayload({ turnId: '' }),
      progressPayload({ ts: '' }),
    ];

    for (const payload of invalid) {
      expect(decodeChatEvent(CHANNEL, envelopeJson('chat.turn.progress', payload))).toBeNull();
    }
  });

  // @spec EC-7
  it('EC-7: structurally invalid completed payloads are dropped', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const invalid = [
      completedPayload({ citations: 'not-an-array' }),
      completedPayload({ citations: undefined }),
      completedPayload({ citations: [citation({ nodeId: undefined })] }),
      completedPayload({ citations: [citation({ nodeId: '   ' })] }),
      completedPayload({ citations: [citation({ kind: 'function' })] }),
      completedPayload({ citations: [citation({ resolvedNodeId: 42 })] }),
      completedPayload({ citations: Array.from({ length: 25 }, () => citation()) }),
      completedPayload({ metrics: metrics({ ratio: 'high' }) }),
      completedPayload({ metrics: metrics({ ratio: Number.NaN }) }),
      completedPayload({ metrics: metrics({ contextNodes: undefined }) }),
      completedPayload({ metrics: undefined }),
      completedPayload({ answer: undefined }),
      completedPayload({ answer: 42 }),
    ];

    for (const payload of invalid) {
      expect(decodeChatEvent(CHANNEL, envelopeJson('chat.turn.completed', payload))).toBeNull();
    }
  });

  // @spec EC-7
  it('EC-7: exactly CHAT_MAX_CITATIONS (24) citations is accepted; 25 is dropped', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const atLimit = completedPayload({
      citations: Array.from({ length: 24 }, (_unused, index) => citation({ nodeId: `n-${index}` })),
    });
    expect(decodeChatEvent(CHANNEL, envelopeJson('chat.turn.completed', atLimit))).not.toBeNull();

    const overLimit = completedPayload({
      citations: Array.from({ length: 25 }, (_unused, index) => citation({ nodeId: `n-${index}` })),
    });
    expect(decodeChatEvent(CHANNEL, envelopeJson('chat.turn.completed', overLimit))).toBeNull();
  });

  // @spec EC-7
  it('EC-7: structurally invalid error payloads are dropped', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const invalid = [
      errorPayload({ code: '' }),
      errorPayload({ code: '   ' }),
      errorPayload({ code: undefined }),
      errorPayload({ message: '' }),
      errorPayload({ message: undefined }),
    ];

    for (const payload of invalid) {
      expect(decodeChatEvent(CHANNEL, envelopeJson('chat.turn.error', payload))).toBeNull();
    }
  });

  // @spec EC-7
  it('EC-7: a non-object / array payload is dropped', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(decodeChatEvent(CHANNEL, envelopeJson('chat.turn.progress', 'a string'))).toBeNull();
    expect(decodeChatEvent(CHANNEL, envelopeJson('chat.turn.progress', [progressPayload()]))).toBeNull();
    expect(decodeChatEvent(CHANNEL, envelopeJson('chat.turn.progress', null))).toBeNull();
  });

  // @spec AC-7
  it('AC-7: every drop logs the channel name and a fixed reason only — never payload content', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const secret = 'SECRET-ANSWER-TEXT-MUST-NEVER-BE-LOGGED';
    decodeChatEvent(
      CHANNEL,
      envelopeJson('chat.turn.completed', completedPayload({ answer: secret, metrics: 'nope' })),
    );

    expect(logged).toHaveBeenCalled();
    const serialized = JSON.stringify(logged.mock.calls);
    expect(serialized).toContain(CHANNEL);
    expect(serialized).not.toContain(secret);
  });

  // @spec AC-7
  it('AC-7: decodeChatEvent never throws, whatever it is handed', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(() => decodeChatEvent(CHANNEL, '')).not.toThrow();
    expect(() => decodeChatEvent('', '')).not.toThrow();
    expect(() => decodeChatEvent(CHANNEL, '{"payload":')).not.toThrow();
  });
});

describe('citationNodeIds', () => {
  // @spec AC-3
  it('AC-3: returns nodeId plus non-null resolvedNodeId ids, de-duplicated in first-appearance order', () => {
    const decoded = decodeChatEvent(
      CHANNEL,
      envelopeJson(
        'chat.turn.completed',
        completedPayload({
          citations: [
            citation({ nodeId: 'a', resolvedNodeId: 'canvas-a' }),
            citation({ nodeId: 'b', resolvedNodeId: null }),
            citation({ nodeId: 'a', resolvedNodeId: 'canvas-a' }), // duplicate
            citation({ nodeId: 'c', resolvedNodeId: 'b' }), // already seen as a nodeId
          ],
        }),
      ),
    );

    expect(citationNodeIds(decoded!.push)).toEqual(['a', 'canvas-a', 'b', 'c']);
  });

  // @spec EC-28
  it('EC-28: progress and error pushes yield an empty nodeIds list', () => {
    const progress = decodeChatEvent(CHANNEL, envelopeJson('chat.turn.progress', progressPayload()));
    const errored = decodeChatEvent(CHANNEL, envelopeJson('chat.turn.error', errorPayload()));

    expect(citationNodeIds(progress!.push)).toEqual([]);
    expect(citationNodeIds(errored!.push)).toEqual([]);
  });
});

describe('filterCitations', () => {
  function completedFrom(citations: Array<Record<string, unknown>>) {
    const decoded = decodeChatEvent(
      CHANNEL,
      envelopeJson('chat.turn.completed', completedPayload({ citations })),
    );
    return decoded!.push as never;
  }

  // @spec AC-3 EC-16
  it('AC-3/EC-16: a citation whose nodeId is unauthorized is dropped whole; the rest survive and metrics are untouched', () => {
    const push = completedFrom([
      citation({ nodeId: 'allowed', resolvedNodeId: 'canvas-allowed' }),
      citation({ nodeId: 'forbidden', resolvedNodeId: 'canvas-forbidden' }),
    ]);

    const filtered = filterCitations(push, new Set(['allowed', 'canvas-allowed']));

    expect(filtered.citations).toEqual([
      { nodeId: 'allowed', label: 'src/auth/login.ts', kind: 'file', resolvedNodeId: 'canvas-allowed' },
    ]);
    expect(JSON.stringify(filtered)).not.toContain('forbidden');
    // Counts stay exactly as the worker reported them — never recomputed.
    expect(filtered.metrics).toEqual({
      contextNodes: 7,
      tokensUsed: 1234,
      baselineTokens: 9876,
      ratio: 0.125,
    });
    expect(filtered.answer).toBe('Login is handled in `src/auth/login.ts`.');
  });

  // @spec EC-15
  it('EC-15: a citation with resolvedNodeId null whose nodeId is authorized is delivered unchanged', () => {
    const push = completedFrom([citation({ nodeId: 'allowed', resolvedNodeId: null })]);

    const filtered = filterCitations(push, new Set(['allowed']));

    expect(filtered.citations).toEqual([
      { nodeId: 'allowed', label: 'src/auth/login.ts', kind: 'file', resolvedNodeId: null },
    ]);
  });

  // @spec EC-17
  it('EC-17: an authorized nodeId with an unauthorized non-null resolvedNodeId drops the WHOLE citation', () => {
    const push = completedFrom([citation({ nodeId: 'allowed', resolvedNodeId: 'canvas-secret' })]);

    const filtered = filterCitations(push, new Set(['allowed']));

    expect(filtered.citations).toEqual([]);
    // Never half-delivered with the pointer nulled out.
    expect(JSON.stringify(filtered)).not.toContain('canvas-secret');
    expect(JSON.stringify(filtered)).not.toContain('"nodeId":"allowed"');
  });

  // @spec EC-18
  it('EC-18: when every citation is stripped the frame is still delivered with citations: [] and the full answer', () => {
    const push = completedFrom([
      citation({ nodeId: 'x', resolvedNodeId: null }),
      citation({ nodeId: 'y', resolvedNodeId: null }),
    ]);

    const filtered = filterCitations(push, new Set<string>());

    expect(filtered.type).toBe('chat.turn.completed');
    expect(filtered.citations).toEqual([]);
    expect(filtered.answer).toBe('Login is handled in `src/auth/login.ts`.');
    expect(filtered.metrics).toEqual({
      contextNodes: 7,
      tokensUsed: 1234,
      baselineTokens: 9876,
      ratio: 0.125,
    });
    expect(Object.keys(filtered).sort()).toEqual([
      'answer',
      'citations',
      'conversationId',
      'metrics',
      'ts',
      'turnId',
      'type',
    ]);
  });

  // @spec AC-3
  it('AC-3: returns a NEW push and never mutates the input', () => {
    const push = completedFrom([
      citation({ nodeId: 'allowed', resolvedNodeId: null }),
      citation({ nodeId: 'forbidden', resolvedNodeId: null }),
    ]);
    const before = JSON.stringify(push);

    const filtered = filterCitations(push, new Set(['allowed']));

    expect(filtered).not.toBe(push);
    expect(JSON.stringify(push)).toBe(before);
    expect(filtered.citations).toHaveLength(1);
  });
});
