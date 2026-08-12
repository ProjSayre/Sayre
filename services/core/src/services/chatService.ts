// CH-03 — "Ask Sayre" business logic: validation, owner-only enforcement, the
// pinned chat.turn.request.v1 payload, and exactly-once publishing around
// `dispatched_at`. Route handlers (src/routes/chat.ts) call these functions
// and do nothing else (.claude/rules/service-layer.md).
//
// INVARIANT: org_id/user_id come ONLY from `ctx` (requireAuthContext(req)) —
// never from the request body/query (.claude/rules/security-multitenancy.md).

import type { AuthContext } from '../auth/context';
import {
  chatStore,
  type ChatOwnerScope,
  type ChatStore,
  type ChatTreeView,
  type ChatTurnRole,
  type ChatTurnScope,
  type ChatTurnStatus,
  type StoredChatConversation,
  type StoredChatTurn,
} from '../db/chatStore';
import { makeEnvelope, type MessageEnvelope } from '../queue/envelope';
import { publishChatTurnRequest, type ChatTurnRequestPayload } from '../queue/sqs';
import { mintEphemeralMcpCredential } from './ephemeralMcpCredentialService';

export const CHAT_QUESTION_MAX_CHARACTERS = 8_000;
export const CHAT_TITLE_MAX_CHARACTERS = 200;
export const CHAT_ANCHOR_NODE_ID_MAX_CHARACTERS = 512;
export const CHAT_HISTORY_MAX_TURNS = 12;
export const CHAT_CONVERSATION_LIST_DEFAULT_LIMIT = 50;
export const CHAT_CONVERSATION_LIST_MAX_LIMIT = 100;
export const CHAT_CONVERSATION_TURNS_LIMIT = 200;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]+$/u;
const TREE_VIEWS: ReadonlySet<ChatTreeView> = new Set(['technical', 'product', 'onboarding']);
const LIMIT_RE = /^\d{1,3}$/u;

export class ChatValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(issues.join(' ') || 'Invalid chat request.');
    this.name = 'ChatValidationError';
  }
}

export class ChatForbiddenError extends Error {
  constructor() {
    super('Only an authenticated user (not an agent key) may access chat conversations.');
    this.name = 'ChatForbiddenError';
  }
}

export class ChatNotFoundError extends Error {
  constructor() {
    super('Conversation not found.');
    this.name = 'ChatNotFoundError';
  }
}

export class ChatEnqueueError extends Error {
  constructor() {
    super('Chat turn could not be queued.');
    this.name = 'ChatEnqueueError';
  }
}

export interface ChatConversationView {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChatTurnView {
  id: string;
  conversationId: string;
  seq: number;
  role: ChatTurnRole;
  content: string;
  status: ChatTurnStatus;
  citations: unknown[] | null;
  metrics: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  createdAt: string;
}

export interface ChatConversationDetail {
  conversation: ChatConversationView;
  turns: ChatTurnView[];
}

export interface PostTurnResult {
  conversationId: string;
  userTurn: ChatTurnView;
  assistantTurn: ChatTurnView;
}

export type ChatTurnPublisher = (
  envelope: MessageEnvelope<ChatTurnRequestPayload>,
) => Promise<string>;

// Wrapped rather than assigned directly: some pre-existing route test suites
// fully replace `../queue/sqs` (`vi.mock('../queue/sqs', () => ({...}))`,
// no `importOriginal`) with a mock that never exports
// `publishChatTurnRequest` because they never touch chat. A bare top-level
// `= publishChatTurnRequest` would dereference that missing export the
// instant this module loads (which `createApp()` does transitively for every
// route test); wrapping defers the dereference to actual invocation, which
// none of those suites ever trigger.
export const defaultPublishChatTurn: ChatTurnPublisher = (envelope) =>
  publishChatTurnRequest(envelope);

/** Mints the CH-01 chat_ephemeral credential the worker will present to the MCP
 *  gateway. Returns the one-time token only; nothing else about the credential
 *  leaves this module. */
export type ChatCredentialMinter = (
  conversationId: string,
  ctx: AuthContext,
) => Promise<string>;

// Wrapped, not assigned directly — same rationale as `defaultPublishChatTurn`
// above it: route suites that `vi.mock` a whole module must not dereference a
// missing export at import time.
export const defaultMintChatCredential: ChatCredentialMinter = async (conversationId, ctx) =>
  (await mintEphemeralMcpCredential({ conversationId }, ctx)).token;

type UserCtx = Extract<AuthContext, { subjectType: 'user' }>;

function requireUser(ctx: AuthContext): UserCtx {
  if (ctx.subjectType !== 'user') throw new ChatForbiddenError();
  return ctx;
}

function ownerFrom(ctx: UserCtx): ChatOwnerScope {
  return { orgId: ctx.orgId, userId: ctx.userId };
}

function requireConversationId(conversationId: string): void {
  if (typeof conversationId !== 'string' || !UUID_RE.test(conversationId)) {
    // Never reaches Postgres — a malformed path segment looks exactly like an
    // absent conversation (EC-6), same existence-non-disclosure posture as
    // EC-8's owner check.
    throw new ChatNotFoundError();
  }
}

function requireBodyObject(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ChatValidationError(['request body must be a JSON object.']);
  }
  return input as Record<string, unknown>;
}

function toConversationView(conversation: StoredChatConversation): ChatConversationView {
  return {
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
  };
}

function toTurnView(turn: StoredChatTurn): ChatTurnView {
  return {
    id: turn.id,
    conversationId: turn.conversationId,
    seq: turn.seq,
    role: turn.role,
    content: turn.content,
    status: turn.status,
    citations: turn.citations,
    metrics: turn.metrics,
    error: turn.error,
    createdAt: turn.createdAt,
  };
}

function validateTitle(value: unknown, issues: string[]): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    issues.push('title must be a string.');
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.includes('\0')) {
    issues.push('title must not contain NUL characters.');
  }
  if (trimmed.length > CHAT_TITLE_MAX_CHARACTERS) {
    issues.push(`title must be at most ${CHAT_TITLE_MAX_CHARACTERS} characters.`);
  }
  return trimmed;
}

function validateQuestion(value: unknown, issues: string[]): string {
  if (typeof value !== 'string') {
    issues.push('question must be a string.');
    return '';
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    issues.push('question must not be blank.');
  }
  if (trimmed.includes('\0')) {
    issues.push('question must not contain NUL characters.');
  }
  if (trimmed.length > CHAT_QUESTION_MAX_CHARACTERS) {
    issues.push(`question must be at most ${CHAT_QUESTION_MAX_CHARACTERS} characters.`);
  }
  return trimmed;
}

function validateIdempotencyKey(value: unknown, issues: string[]): string {
  if (typeof value !== 'string') {
    issues.push('idempotencyKey must be a string.');
    return '';
  }
  const trimmed = value.trim();
  if (trimmed.length < 8 || trimmed.length > 200 || !IDEMPOTENCY_KEY_RE.test(trimmed)) {
    issues.push(
      'idempotencyKey must be 8-200 characters matching [A-Za-z0-9._:-].',
    );
  }
  return trimmed;
}

function validateScope(value: unknown, issues: string[]): ChatTurnScope {
  if (value === undefined || value === null) {
    return { view: null, anchorNodeId: null };
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    issues.push('scope must be an object.');
    return { view: null, anchorNodeId: null };
  }
  const raw = value as Record<string, unknown>;

  let view: ChatTreeView | null = null;
  if (raw.view !== undefined && raw.view !== null) {
    if (typeof raw.view !== 'string' || !TREE_VIEWS.has(raw.view as ChatTreeView)) {
      issues.push('scope.view must be one of technical, product, onboarding.');
    } else {
      view = raw.view as ChatTreeView;
    }
  }

  let anchorNodeId: string | null = null;
  if (raw.anchorNodeId !== undefined && raw.anchorNodeId !== null) {
    if (typeof raw.anchorNodeId !== 'string') {
      issues.push('scope.anchorNodeId must be a string.');
    } else {
      const trimmed = raw.anchorNodeId.trim();
      if (trimmed.length === 0) {
        issues.push('scope.anchorNodeId must not be blank.');
      } else if (trimmed.length > CHAT_ANCHOR_NODE_ID_MAX_CHARACTERS) {
        issues.push(
          `scope.anchorNodeId must be at most ${CHAT_ANCHOR_NODE_ID_MAX_CHARACTERS} characters.`,
        );
      } else if (trimmed.includes('\0')) {
        issues.push('scope.anchorNodeId must not contain NUL characters.');
      } else {
        anchorNodeId = trimmed;
      }
    }
  }

  return { view, anchorNodeId };
}

function parseListLimit(raw: unknown, issues: string[]): number {
  if (raw === undefined) return CHAT_CONVERSATION_LIST_DEFAULT_LIMIT;
  if (typeof raw !== 'string' || !LIMIT_RE.test(raw)) {
    issues.push(`limit must be an integer from 1 to ${CHAT_CONVERSATION_LIST_MAX_LIMIT}.`);
    return CHAT_CONVERSATION_LIST_DEFAULT_LIMIT;
  }
  const parsed = Number(raw);
  if (parsed < 1 || parsed > CHAT_CONVERSATION_LIST_MAX_LIMIT) {
    issues.push(`limit must be an integer from 1 to ${CHAT_CONVERSATION_LIST_MAX_LIMIT}.`);
  }
  return parsed;
}

export async function createConversation(
  input: unknown,
  ctx: AuthContext,
  store: ChatStore = chatStore,
): Promise<ChatConversationView> {
  const userCtx = requireUser(ctx);
  const body = requireBodyObject(input);
  const issues: string[] = [];
  const title = validateTitle(body.title, issues);
  if (issues.length > 0) throw new ChatValidationError(issues);

  const conversation = await store.createConversation(ownerFrom(userCtx), title);
  return toConversationView(conversation);
}

export async function listConversations(
  rawLimit: unknown,
  ctx: AuthContext,
  store: ChatStore = chatStore,
): Promise<ChatConversationView[]> {
  const userCtx = requireUser(ctx);
  const issues: string[] = [];
  const limit = parseListLimit(rawLimit, issues);
  if (issues.length > 0) throw new ChatValidationError(issues);

  const rows = await store.listConversations(ownerFrom(userCtx), limit);
  return rows.map(toConversationView);
}

export async function getConversation(
  conversationId: string,
  ctx: AuthContext,
  store: ChatStore = chatStore,
): Promise<ChatConversationDetail> {
  const userCtx = requireUser(ctx);
  requireConversationId(conversationId);

  const detail = await store.getConversation(
    ownerFrom(userCtx),
    conversationId,
    CHAT_CONVERSATION_TURNS_LIMIT,
  );
  if (detail === null) throw new ChatNotFoundError();

  return {
    conversation: toConversationView(detail.conversation),
    turns: detail.turns.map(toTurnView),
  };
}

function buildChatTurnEnvelope(
  owner: ChatOwnerScope,
  conversationId: string,
  assistantTurnId: string,
  question: string,
  scope: ChatTurnScope,
  history: Array<{ role: ChatTurnRole; content: string }>,
  mcpCredential: string,
): MessageEnvelope<ChatTurnRequestPayload> {
  // PINNED WIRE CONTRACT (spec.md "chat.turn.request.v1") — key order is part
  // of the contract; CH-04 consumes this verbatim.
  const payload: ChatTurnRequestPayload = {
    schema: 'chat.turn.request.v1',
    turnId: assistantTurnId,
    conversationId,
    orgId: owner.orgId,
    userId: owner.userId,
    question,
    scope,
    history,
    mcpCredential,
  };
  return makeEnvelope<ChatTurnRequestPayload>({
    org_id: owner.orgId,
    type: 'chat.turn.request',
    source: 'sayre-core-chat',
    schema_version: 1,
    idempotency_key: `chat.turn:${assistantTurnId}`,
    payload,
  });
}

export async function postTurn(
  conversationId: string,
  input: unknown,
  ctx: AuthContext,
  store: ChatStore = chatStore,
  publish: ChatTurnPublisher = defaultPublishChatTurn,
  mint: ChatCredentialMinter = defaultMintChatCredential,
): Promise<PostTurnResult> {
  const userCtx = requireUser(ctx);
  const body = requireBodyObject(input);
  const issues: string[] = [];
  const idempotencyKey = validateIdempotencyKey(body.idempotencyKey, issues);
  const question = validateQuestion(body.question, issues);
  const scope = validateScope(body.scope, issues);
  if (issues.length > 0) throw new ChatValidationError(issues);
  requireConversationId(conversationId);

  const owner = ownerFrom(userCtx);
  const result = await store.appendTurnPair({
    owner,
    conversationId,
    idempotencyKey,
    question,
    scope,
    historyLimit: CHAT_HISTORY_MAX_TURNS,
  });
  if (result === null) throw new ChatNotFoundError();

  if (result.assistantTurn.dispatchedAt === null) {
    try {
      // CH-04: rebuild the republished payload from the STORED user turn, not
      // this invocation's request body, so a repair republish is byte-
      // identical to the original dispatch even when a retry's body differs
      // (AC-14 / EC-25 — the CH-03 LOW finding; see spec.md "Decision:
      // CH-03 retry-path finding").
      const token = await mint(conversationId, userCtx);
      const envelope = buildChatTurnEnvelope(
        owner,
        conversationId,
        result.assistantTurn.id,
        result.userTurn.content,
        result.userTurn.scope ?? { view: null, anchorNodeId: null },
        result.history,
        token,
      );
      await publish(envelope);
      await store.markTurnDispatched(owner, result.assistantTurn.id);
    } catch {
      // Never leak minter/permission-store/SQS/AWS detail (queue URL, region,
      // error code) — the committed rows are never rolled back; the turn
      // simply stays pending with dispatched_at null until the next retry
      // (EC-13, EC-24, OQ-7).
      throw new ChatEnqueueError();
    }
  }

  return {
    conversationId,
    userTurn: toTurnView(result.userTurn),
    assistantTurn: toTurnView(result.assistantTurn),
  };
}
