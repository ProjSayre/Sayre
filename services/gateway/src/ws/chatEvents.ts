// CH-05 — the single validation gate for anything arriving on a chat Redis
// pub/sub channel: channel-name parsing, envelope/payload decoding, and
// citation-list filtering. Pure (no I/O) so it can be unit-tested without any
// Redis/Core dependency; ../redis/chatPubsub.ts is the only caller.
//
// Mirrors sayre_workers/chat/models.py and sayre_workers/chat/events.py on the
// Python side — see AC-13's pinned-string test.

import { assertValidEnvelope } from '@sayre/core';
import type {
  ChatCitation,
  ChatCitationKind,
  ChatTurnCompletedPush,
  ChatTurnErrorPush,
  ChatTurnProgressPush,
  ChatTurnPush,
} from '@sayre/shared-types';

/** Code constant on BOTH sides — mirrors sayre_workers/chat/models.py's
 *  CHAT_EVENT_CHANNEL_PREFIX. Deliberately not a packages/config name. */
export const CHAT_EVENT_CHANNEL_PREFIX = 'sayre:chat.events';

/** Mirrors the `source` every CH-04 chat event carries (sayre_workers/chat/events.py). */
export const CHAT_EVENT_SOURCE = 'sayre-chat-worker';

/** Mirrors sayre_workers/chat/models.py's CHAT_MAX_CITATIONS. */
export const CHAT_MAX_CITATIONS = 24;

const CHAT_CITATION_KINDS: ReadonlySet<ChatCitationKind> = new Set([
  'file',
  'folder',
  'feature',
  'ticket',
]);

const CHAT_EVENT_TYPES = new Set([
  'chat.turn.progress',
  'chat.turn.completed',
  'chat.turn.error',
]);

/** Mirrors sayre_workers/chat/events.py's chat_event_channel(). */
export function chatEventChannel(orgId: string, conversationId: string): string {
  return `${CHAT_EVENT_CHANNEL_PREFIX}:${orgId}:${conversationId}`;
}

export interface ChatChannelCoordinates {
  orgId: string;
  conversationId: string;
}

const CHAT_CHANNEL_RE = /^sayre:chat\.events:([^:]+):([^:]+)$/;

/** Strict parse of `sayre:chat.events:{orgId}:{conversationId}`; null when it does not match. */
export function parseChatEventChannel(channel: string): ChatChannelCoordinates | null {
  const match = CHAT_CHANNEL_RE.exec(channel);
  if (!match) return null;
  const [, orgId, conversationId] = match;
  if (!orgId || !conversationId) return null;
  return { orgId, conversationId };
}

export interface DecodedChatEvent {
  /** ALWAYS envelope.org_id (cross-checked against the channel) — never a body field. */
  orgId: string;
  conversationId: string;
  turnId: string;
  push: ChatTurnPush;
}

function logDrop(channel: string, reason: string): void {
  // Fixed reason string only — never payload content (mirrors redis/pubsub.ts).
  console.error('[gateway] discarding chat event', { channel, reason });
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function decodeProgressPayload(
  payload: Record<string, unknown>,
  conversationId: string,
  turnId: string,
): ChatTurnProgressPush | null {
  const { seq, kind, tool, detail, ts } = payload;
  if (
    typeof seq !== 'number' ||
    !Number.isInteger(seq) ||
    seq < 1 ||
    (kind !== 'status' && kind !== 'tool_call') ||
    !isNullableString(tool) ||
    !isNullableString(detail) ||
    !isNonBlankString(ts)
  ) {
    return null;
  }
  return {
    type: 'chat.turn.progress',
    conversationId,
    turnId,
    seq,
    kind,
    tool: tool ?? null,
    detail: detail ?? null,
    ts,
  };
}

function decodeCitation(raw: unknown): ChatCitation | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const candidate = raw as Record<string, unknown>;
  const { nodeId, label, kind, resolvedNodeId } = candidate;
  if (
    !isNonBlankString(nodeId) ||
    typeof label !== 'string' ||
    typeof kind !== 'string' ||
    !CHAT_CITATION_KINDS.has(kind as ChatCitationKind) ||
    !isNullableString(resolvedNodeId)
  ) {
    return null;
  }
  return {
    nodeId,
    label,
    kind: kind as ChatCitationKind,
    resolvedNodeId: resolvedNodeId ?? null,
  };
}

function decodeCompletedPayload(
  payload: Record<string, unknown>,
  conversationId: string,
  turnId: string,
): ChatTurnCompletedPush | null {
  const { answer, citations, metrics, ts } = payload;
  if (typeof answer !== 'string' || !isNonBlankString(ts) || !Array.isArray(citations)) {
    return null;
  }
  if (citations.length > CHAT_MAX_CITATIONS) return null;

  const decodedCitations: ChatCitation[] = [];
  for (const rawCitation of citations) {
    const decoded = decodeCitation(rawCitation);
    if (!decoded) return null;
    decodedCitations.push(decoded);
  }

  if (typeof metrics !== 'object' || metrics === null || Array.isArray(metrics)) return null;
  const { contextNodes, tokensUsed, baselineTokens, ratio } = metrics as Record<string, unknown>;
  if (
    !isFiniteNumber(contextNodes) ||
    !isFiniteNumber(tokensUsed) ||
    !isFiniteNumber(baselineTokens) ||
    !isFiniteNumber(ratio)
  ) {
    return null;
  }

  return {
    type: 'chat.turn.completed',
    conversationId,
    turnId,
    answer,
    citations: decodedCitations,
    metrics: { contextNodes, tokensUsed, baselineTokens, ratio },
    ts,
  };
}

function decodeErrorPayload(
  payload: Record<string, unknown>,
  conversationId: string,
  turnId: string,
): ChatTurnErrorPush | null {
  const { code, message, ts } = payload;
  if (!isNonBlankString(code) || !isNonBlankString(message) || !isNonBlankString(ts)) {
    return null;
  }
  return { type: 'chat.turn.error', conversationId, turnId, code, message, ts };
}

/**
 * The single validation gate for anything arriving on a chat channel. Returns
 * null (never throws) for: a non-JSON / assertValidEnvelope-failing envelope; an
 * unparsable channel; envelope.org_id !== the channel's org segment;
 * envelope.source !== CHAT_EVENT_SOURCE; an envelope.type outside the three
 * pinned types; payload.conversationId !== the channel's conversation segment; or
 * any structurally invalid payload for its type. Logs the channel name and a
 * fixed reason ONLY — never payload content.
 */
export function decodeChatEvent(channel: string, rawMessage: string): DecodedChatEvent | null {
  let envelope: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(rawMessage);
    assertValidEnvelope(parsed);
    envelope = parsed as unknown as Record<string, unknown>;
  } catch {
    logDrop(channel, 'invalid envelope');
    return null;
  }

  const coords = parseChatEventChannel(channel);
  if (!coords) {
    logDrop(channel, 'unparsable channel');
    return null;
  }

  if (envelope.org_id !== coords.orgId) {
    logDrop(channel, 'envelope org_id disagrees with channel');
    return null;
  }

  if (envelope.source !== CHAT_EVENT_SOURCE) {
    logDrop(channel, 'unexpected envelope source');
    return null;
  }

  const type = envelope.type;
  if (typeof type !== 'string' || !CHAT_EVENT_TYPES.has(type)) {
    logDrop(channel, 'unrecognized envelope type');
    return null;
  }

  const payload = envelope.payload;
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    logDrop(channel, 'payload is not an object');
    return null;
  }
  const payloadRecord = payload as Record<string, unknown>;

  if (payloadRecord.conversationId !== coords.conversationId) {
    logDrop(channel, 'payload conversationId disagrees with channel');
    return null;
  }
  const { turnId } = payloadRecord;
  if (!isNonBlankString(turnId)) {
    logDrop(channel, 'missing or blank turnId');
    return null;
  }

  const conversationId = coords.conversationId;
  let push: ChatTurnPush | null;
  switch (type) {
    case 'chat.turn.progress':
      push = decodeProgressPayload(payloadRecord, conversationId, turnId);
      break;
    case 'chat.turn.completed':
      push = decodeCompletedPayload(payloadRecord, conversationId, turnId);
      break;
    default:
      push = decodeErrorPayload(payloadRecord, conversationId, turnId);
      break;
  }

  if (!push) {
    logDrop(channel, 'structurally invalid payload');
    return null;
  }

  return { orgId: coords.orgId, conversationId, turnId, push };
}

/** De-duplicated nodeId + non-null resolvedNodeId ids, first-appearance order. `[]` for progress/error. */
export function citationNodeIds(push: ChatTurnPush): string[] {
  if (push.type !== 'chat.turn.completed') return [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const citation of push.citations) {
    if (!seen.has(citation.nodeId)) {
      seen.add(citation.nodeId);
      ids.push(citation.nodeId);
    }
    if (citation.resolvedNodeId !== null && !seen.has(citation.resolvedNodeId)) {
      seen.add(citation.resolvedNodeId);
      ids.push(citation.resolvedNodeId);
    }
  }
  return ids;
}

/**
 * Returns a NEW completed push whose `citations` keeps only entries where
 * `nodeId` is authorized AND (`resolvedNodeId` is null OR also authorized).
 * `metrics` is copied through unchanged (counts stay as reported).
 */
export function filterCitations(
  push: ChatTurnCompletedPush,
  authorizedNodeIds: ReadonlySet<string>,
): ChatTurnCompletedPush {
  const citations = push.citations.filter(
    (citation) =>
      authorizedNodeIds.has(citation.nodeId) &&
      (citation.resolvedNodeId === null || authorizedNodeIds.has(citation.resolvedNodeId)),
  );
  return { ...push, citations };
}
