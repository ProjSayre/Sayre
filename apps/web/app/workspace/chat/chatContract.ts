/**
 * Ask Sayre chat contract: constants, value types, and the pure
 * parsers/formatters that guard the pinned `chat.turn.*` gateway frames and
 * their embedded citation/metrics payloads.
 *
 * Deliberately local to apps/web rather than folded into
 * `@sayre/shared-types`'s `GatewayToClientMessage` union — CH-05 owns the
 * gateway side of the contract and this ticket's diff is confined to
 * apps/web/. See .pipeline/spec.md's Open question OQ-1.
 */

import type { ViewId } from '../types';

/** CH-03's own limit (services/core/src/services/chatService.ts). Mirrored, not imported — services/core is out of bounds. */
export const CHAT_QUESTION_MAX_CHARACTERS = 8_000;
export const CHAT_DEGRADED_POLL_INTERVAL_MS = 3_000;
export const CHAT_DEGRADED_POLL_MAX_ATTEMPTS = 20;
export const CHAT_PANEL_ELEMENT_ID = 'ask-sayre-panel';
export const CHAT_INPUT_ELEMENT_ID = 'ask-sayre-input';

export type ChatTurnRole = 'user' | 'assistant';
export type ChatTurnStatus = 'pending' | 'running' | 'completed' | 'error';
export type ChatProgressKind = 'status' | 'tool_call';

/** Closed presentational enum. 'unknown' is the client's own bucket for any kind it cannot draw. */
export type ChatCitationKind = 'file' | 'folder' | 'feature' | 'ticket' | 'unknown';
export const CHAT_DRAWABLE_CITATION_KINDS: readonly ChatCitationKind[] =
  Object.freeze(['file', 'folder', 'feature', 'ticket']);

export interface ChatScope {
  view: ViewId;
  anchorNodeId: string | null;
}

export interface ChatCitation {
  nodeId: string;
  label: string;
  kind: ChatCitationKind;
  resolvedNodeId: string | null;
}

export interface ChatMetrics {
  contextNodes: number;
  tokensUsed: number;
  baselineTokens: number;
  ratio: number;
}

export interface ChatTurnError {
  code: string;
  message: string;
}

export interface ChatProgressLine {
  seq: number;
  kind: ChatProgressKind;
  tool: string | null;
  detail: string | null;
  ts: string;
}

/**
 * PINNED WIRE CONTRACT — the three `chat.turn.*` frames CH-05 fans out, with the
 * worker envelope's `type` hoisted and its payload fields flattened (the same
 * shape `parseGatewayMessage` already uses for `graph.*`). Terminal frames carry
 * NO `seq` (see EC-7). Deliberately local to apps/web rather than added to
 * `@sayre/shared-types`'s `GatewayToClientMessage` — see Open questions OQ-1.
 */
export type ChatGatewayMessage =
  | ({ type: 'chat.turn.progress'; conversationId: string; turnId: string } & ChatProgressLine)
  | {
      type: 'chat.turn.completed';
      conversationId: string;
      turnId: string;
      answer: string;
      citations: ChatCitation[];
      metrics: ChatMetrics | null;
      ts: string;
    }
  | {
      type: 'chat.turn.error';
      conversationId: string;
      turnId: string;
      code: string;
      message: string;
      ts: string;
    };

const PROGRESS_KINDS: ReadonlySet<string> = new Set(['status', 'tool_call']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function parseProgress(value: Record<string, unknown>): ChatGatewayMessage | null {
  if (
    !isNonEmptyString(value.conversationId) ||
    !isNonEmptyString(value.turnId) ||
    !Number.isSafeInteger(value.seq) ||
    typeof value.kind !== 'string' ||
    !PROGRESS_KINDS.has(value.kind) ||
    !isNullableString(value.tool) ||
    !isNullableString(value.detail) ||
    typeof value.ts !== 'string'
  ) {
    return null;
  }
  return {
    type: 'chat.turn.progress',
    conversationId: value.conversationId,
    turnId: value.turnId,
    seq: value.seq as number,
    kind: value.kind as ChatProgressKind,
    tool: value.tool,
    detail: value.detail,
    ts: value.ts,
  };
}

function parseCompleted(value: Record<string, unknown>): ChatGatewayMessage | null {
  if (
    !isNonEmptyString(value.conversationId) ||
    !isNonEmptyString(value.turnId) ||
    typeof value.answer !== 'string' ||
    typeof value.ts !== 'string'
  ) {
    return null;
  }
  return {
    type: 'chat.turn.completed',
    conversationId: value.conversationId,
    turnId: value.turnId,
    answer: value.answer,
    citations: parseChatCitations(value.citations),
    metrics: parseChatMetrics(value.metrics),
    ts: value.ts,
  };
}

function parseError(value: Record<string, unknown>): ChatGatewayMessage | null {
  if (
    !isNonEmptyString(value.conversationId) ||
    !isNonEmptyString(value.turnId) ||
    typeof value.code !== 'string' ||
    typeof value.message !== 'string' ||
    typeof value.ts !== 'string'
  ) {
    return null;
  }
  return {
    type: 'chat.turn.error',
    conversationId: value.conversationId,
    turnId: value.turnId,
    code: value.code,
    message: value.message,
    ts: value.ts,
  };
}

/** Returns null for any non-JSON, non-object, or structurally invalid frame. Never throws. */
export function parseChatGatewayMessage(raw: unknown): ChatGatewayMessage | null {
  if (typeof raw !== 'string') return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value.type !== 'string') return null;
  if (value.type === 'chat.turn.progress') return parseProgress(value);
  if (value.type === 'chat.turn.completed') return parseCompleted(value);
  if (value.type === 'chat.turn.error') return parseError(value);
  return null;
}

/** Drops malformed entries; maps any kind outside CHAT_DRAWABLE_CITATION_KINDS to 'unknown'. */
export function parseChatCitations(value: unknown): ChatCitation[] {
  if (!Array.isArray(value)) return [];
  const citations: ChatCitation[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    if (typeof item.nodeId !== 'string' || typeof item.label !== 'string') continue;
    if (item.resolvedNodeId !== null && typeof item.resolvedNodeId !== 'string') continue;
    if (typeof item.kind !== 'string') continue;
    const kind: ChatCitationKind = CHAT_DRAWABLE_CITATION_KINDS.includes(item.kind as ChatCitationKind)
      ? (item.kind as ChatCitationKind)
      : 'unknown';
    citations.push({
      nodeId: item.nodeId,
      label: item.label,
      kind,
      resolvedNodeId: item.resolvedNodeId as string | null,
    });
  }
  return citations;
}

/** Returns null when metrics is missing, not an object, or has a non-numeric/non-finite field. */
export function parseChatMetrics(value: unknown): ChatMetrics | null {
  if (!isRecord(value)) return null;
  const { contextNodes, tokensUsed, baselineTokens, ratio } = value;
  if (
    typeof contextNodes !== 'number' || !Number.isFinite(contextNodes) ||
    typeof tokensUsed !== 'number' || !Number.isFinite(tokensUsed) ||
    typeof baselineTokens !== 'number' || !Number.isFinite(baselineTokens) ||
    typeof ratio !== 'number' || !Number.isFinite(ratio)
  ) {
    return null;
  }
  return { contextNodes, tokensUsed, baselineTokens, ratio };
}

/**
 * 'N context nodes · X tokens · R× less than full repo', or
 * 'N context nodes · X tokens' when baselineTokens is 0 or ratio is 0/negative/non-finite.
 * Never divides — it only formats the server-supplied ratio.
 */
export function formatChatMetrics(metrics: ChatMetrics): string {
  const base = `${metrics.contextNodes} context nodes · ${metrics.tokensUsed} tokens`;
  const usableRatio = metrics.baselineTokens !== 0 && Number.isFinite(metrics.ratio) && metrics.ratio > 0;
  if (!usableRatio) return base;
  return `${base} · ${metrics.ratio}× less than full repo`;
}
