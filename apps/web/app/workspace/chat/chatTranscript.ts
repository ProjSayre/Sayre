/**
 * Pure transcript reducer: progress ordering/idempotency, terminal-event
 * precedence, and REST reconciliation. No I/O, no React — every ordering rule
 * in EC-1..EC-8/EC-10 is decided here so the provider only has to wire events
 * through, not reason about them.
 */

import type { ChatGatewayMessage, ChatProgressLine, ChatScope } from './chatContract';
import type { ChatConversationDetail, ChatTurnRecord } from './chatClient';

export interface ChatTranscriptTurn extends ChatTurnRecord {
  /** The scope this turn was posted with; null for turns first seen via reconcile. */
  scope: ChatScope | null;
  /** Locally accumulated, strictly increasing by seq. Survives reconcile (AC-12). */
  progress: ChatProgressLine[];
  lastProgressSeq: number | null;
}

export interface ChatTranscriptState {
  conversationId: string | null;
  /** Ascending by (seq, createdAt, id). No id appears twice. */
  turns: readonly ChatTranscriptTurn[];
}

export const emptyChatTranscript: ChatTranscriptState = Object.freeze({
  conversationId: null,
  turns: Object.freeze([]),
});

export function appendTurnPair(
  state: ChatTranscriptState,
  userTurn: ChatTurnRecord,
  assistantTurn: ChatTurnRecord,
  scope: ChatScope,
): ChatTranscriptState {
  const wrap = (turn: ChatTurnRecord): ChatTranscriptTurn => ({
    ...turn,
    scope,
    progress: [],
    lastProgressSeq: null,
  });
  return {
    conversationId: state.conversationId ?? userTurn.conversationId,
    turns: [...state.turns, wrap(userTurn), wrap(assistantTurn)],
  };
}

function isTerminalStatus(status: ChatTranscriptTurn['status']): boolean {
  return status === 'completed' || status === 'error';
}

function replaceTurnAt(
  state: ChatTranscriptState,
  index: number,
  nextTurn: ChatTranscriptTurn,
): ChatTranscriptState {
  const turns = state.turns.slice();
  turns[index] = nextTurn;
  return { conversationId: state.conversationId, turns };
}

/**
 * Ignores: a message for another conversationId (EC-5); an unknown turnId (EC-6);
 * a duplicate or lower seq (EC-1, EC-2); progress after a terminal state (EC-4);
 * a second terminal event (EC-8). Never reads `seq` off a terminal frame (EC-7).
 * Pure — returns the same reference when nothing changed.
 */
export function applyChatEvent(
  state: ChatTranscriptState,
  message: ChatGatewayMessage,
): ChatTranscriptState {
  if (message.conversationId !== state.conversationId) return state;
  const index = state.turns.findIndex((turn) => turn.id === message.turnId);
  if (index === -1) return state;
  const turn = state.turns[index]!;
  const isTerminal = isTerminalStatus(turn.status);

  if (message.type === 'chat.turn.progress') {
    if (isTerminal) return state;
    if (turn.lastProgressSeq !== null && message.seq <= turn.lastProgressSeq) return state;
    const nextTurn: ChatTranscriptTurn = {
      ...turn,
      status: turn.status === 'pending' ? 'running' : turn.status,
      progress: [
        ...turn.progress,
        { seq: message.seq, kind: message.kind, tool: message.tool, detail: message.detail, ts: message.ts },
      ],
      lastProgressSeq: message.seq,
    };
    return replaceTurnAt(state, index, nextTurn);
  }

  // Terminal frames: the first one wins (EC-8); `seq`, if smuggled onto one,
  // is never read (EC-7 — it simply is not part of either terminal variant).
  if (isTerminal) return state;

  if (message.type === 'chat.turn.completed') {
    const nextTurn: ChatTranscriptTurn = {
      ...turn,
      status: 'completed',
      content: message.answer,
      citations: message.citations,
      metrics: message.metrics,
      error: null,
    };
    return replaceTurnAt(state, index, nextTurn);
  }

  const nextTurn: ChatTranscriptTurn = {
    ...turn,
    status: 'error',
    error: { code: message.code, message: message.message },
  };
  return replaceTurnAt(state, index, nextTurn);
}

/** Server row wins per field; no id duplicated, no known turn dropped, local progress preserved. */
export function reconcileTranscript(
  state: ChatTranscriptState,
  detail: ChatConversationDetail,
): ChatTranscriptState {
  const serverById = new Map(detail.turns.map((row) => [row.id, row] as const));
  const localIds = new Set(state.turns.map((turn) => turn.id));

  const merged: ChatTranscriptTurn[] = state.turns.map((localTurn) => {
    const serverRow = serverById.get(localTurn.id);
    if (serverRow === undefined) return localTurn;
    return {
      ...serverRow,
      scope: localTurn.scope,
      progress: localTurn.progress,
      lastProgressSeq: localTurn.lastProgressSeq,
    };
  });

  for (const serverRow of detail.turns) {
    if (localIds.has(serverRow.id)) continue;
    merged.push({ ...serverRow, scope: null, progress: [], lastProgressSeq: null });
  }

  return {
    conversationId: state.conversationId ?? detail.conversation.id,
    turns: merged,
  };
}

/** True when any assistant turn is 'pending' or 'running'. */
export function hasActiveTurn(state: ChatTranscriptState): boolean {
  return state.turns.some(
    (turn) => turn.role === 'assistant' && (turn.status === 'pending' || turn.status === 'running'),
  );
}
