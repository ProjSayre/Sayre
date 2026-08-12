/**
 * REST client over the three already-allowlisted core-proxy chat routes
 * (apps/web/app/api/core/[...path]/route.ts). No proxy change is needed or
 * permitted — see .pipeline/spec.md's Affected files.
 */

import { coreFetch } from '../../lib/coreFetch';
import {
  parseChatCitations,
  parseChatMetrics,
  type ChatCitation,
  type ChatMetrics,
  type ChatScope,
  type ChatTurnError,
  type ChatTurnRole,
  type ChatTurnStatus,
} from './chatContract';

export interface ChatConversation {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A server row, parsed. Client-local fields live on ChatTranscriptTurn, never here. */
export interface ChatTurnRecord {
  id: string;
  conversationId: string;
  seq: number;
  role: ChatTurnRole;
  content: string;
  status: ChatTurnStatus;
  citations: ChatCitation[] | null;
  metrics: ChatMetrics | null;
  error: ChatTurnError | null;
  createdAt: string;
}

export interface ChatConversationDetail {
  conversation: ChatConversation;
  turns: ChatTurnRecord[];
}

export interface PostTurnBody {
  question: string;
  scope: ChatScope;
  idempotencyKey: string;
}

export interface PostTurnResult {
  conversationId: string;
  userTurn: ChatTurnRecord;
  assistantTurn: ChatTurnRecord;
}

export class ChatRequestError extends Error {
  readonly status: number | null;
  /** true when status === 401 — EC-24's session-expiry signal. */
  readonly unauthenticated: boolean;

  constructor(status: number | null, message: string) {
    super(message);
    this.name = 'ChatRequestError';
    this.status = status;
    this.unauthenticated = status === 401;
  }
}

export interface ChatClient {
  /** POST /api/core/chat/conversations, body exactly `{}`. */
  createConversation(signal?: AbortSignal): Promise<ChatConversation>;
  /** GET /api/core/chat/conversations/:conversationId */
  getConversation(conversationId: string, signal?: AbortSignal): Promise<ChatConversationDetail>;
  /** POST /api/core/chat/conversations/:conversationId/turns, body exactly PostTurnBody. */
  postTurn(conversationId: string, body: PostTurnBody, signal?: AbortSignal): Promise<PostTurnResult>;
}

const ROLES: ReadonlySet<string> = new Set(['user', 'assistant']);
const STATUSES: ReadonlySet<string> = new Set(['pending', 'running', 'completed', 'error']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

class ContractViolation extends Error {}

function errorMessage(body: unknown): string {
  if (isRecord(body)) {
    const err = body.error;
    if (typeof err === 'string' && err.length > 0) return err;
    if (isRecord(err) && typeof err.message === 'string' && err.message.length > 0) return err.message;
  }
  return 'The request failed.';
}

function parseConversation(value: unknown): ChatConversation {
  if (!isRecord(value)) throw new ContractViolation('invalid conversation');
  const { id, title, createdAt, updatedAt } = value;
  if (
    !isString(id) ||
    (title !== null && !isString(title)) ||
    !isString(createdAt) ||
    !isString(updatedAt)
  ) {
    throw new ContractViolation('invalid conversation');
  }
  return { id, title: title ?? null, createdAt, updatedAt };
}

function parseCitationsField(value: unknown): ChatCitation[] | null {
  if (value === null || !Array.isArray(value)) return null;
  return parseChatCitations(value);
}

function parseErrorField(value: unknown): ChatTurnError | null {
  if (!isRecord(value)) return null;
  const { code, message } = value;
  if (!isString(code) || !isString(message)) return null;
  return { code, message };
}

function parseTurnRecord(value: unknown): ChatTurnRecord {
  if (!isRecord(value)) throw new ContractViolation('invalid turn');
  const { id, conversationId, seq, role, content, status, citations, metrics, error, createdAt } = value;
  if (
    !isString(id) ||
    !isString(conversationId) ||
    typeof seq !== 'number' ||
    !isString(role) || !ROLES.has(role) ||
    !isString(content) ||
    !isString(status) || !STATUSES.has(status) ||
    !isString(createdAt)
  ) {
    throw new ContractViolation('invalid turn');
  }
  return {
    id,
    conversationId,
    seq,
    role: role as ChatTurnRole,
    content,
    status: status as ChatTurnStatus,
    citations: parseCitationsField(citations),
    metrics: parseChatMetrics(metrics),
    error: parseErrorField(error),
    createdAt,
  };
}

function parseConversationDetail(value: unknown): ChatConversationDetail {
  if (!isRecord(value) || !Array.isArray(value.turns)) throw new ContractViolation('invalid conversation detail');
  return {
    conversation: parseConversation(value.conversation),
    turns: value.turns.map(parseTurnRecord),
  };
}

function parsePostTurnResult(value: unknown): PostTurnResult {
  if (!isRecord(value) || !isString(value.conversationId)) throw new ContractViolation('invalid turn response');
  return {
    conversationId: value.conversationId,
    userTurn: parseTurnRecord(value.userTurn),
    assistantTurn: parseTurnRecord(value.assistantTurn),
  };
}

async function request<T>(
  url: string,
  init: RequestInit,
  parse: (body: unknown) => T,
): Promise<T> {
  let response: Response;
  try {
    response = await coreFetch(url, init);
  } catch {
    throw new ChatRequestError(null, 'Sayre could not reach the server for this request.');
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    if (!response.ok) throw new ChatRequestError(response.status, 'The request failed.');
    throw new ChatRequestError(response.status, 'The response could not be read.');
  }
  if (!response.ok) throw new ChatRequestError(response.status, errorMessage(body));
  try {
    return parse(body);
  } catch {
    throw new ChatRequestError(response.status, 'The response did not match the expected shape.');
  }
}

/** Concrete client over `coreFetch` (apps/web/app/lib/coreFetch.ts). Injectable for tests. */
export const chatClient: ChatClient = {
  createConversation(signal) {
    return request(
      '/api/core/chat/conversations',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal },
      (body) => {
        if (!isRecord(body)) throw new ContractViolation('invalid conversation response');
        return parseConversation(body.conversation);
      },
    );
  },
  getConversation(conversationId, signal) {
    return request(
      `/api/core/chat/conversations/${encodeURIComponent(conversationId)}`,
      { method: 'GET', signal },
      parseConversationDetail,
    );
  },
  postTurn(conversationId, body, signal) {
    return request(
      `/api/core/chat/conversations/${encodeURIComponent(conversationId)}/turns`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      },
      parsePostTurnResult,
    );
  },
};

/** Matches CH-03's /^[A-Za-z0-9._:-]{8,200}$/ — `crypto.randomUUID()` when available, random hex otherwise. */
export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
