// CH-03 — persistence boundary for "Ask Sayre" conversations/turns.
//
// The `PostgresAgentSkillMdStore` idiom (src/db/agentSkillMdStore.ts): an
// interface, an injectable-deps Postgres implementation, a module-level
// singleton. Every operation runs inside `withOrgContext` (RLS gives org
// isolation); every query additionally filters `chat_conversations.user_id`
// so ownership is enforced even though RLS alone cannot express "this row's
// owner", not just an org boundary (.claude/rules/security-multitenancy.md).

import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { withOrgContext, type Db } from './client';
import { getRuntimeDb } from './installations';
import { chatConversations, chatTurns } from './schema';

export interface ChatOwnerScope {
  orgId: string;
  userId: string;
}

export type ChatTurnRole = 'user' | 'assistant';
export type ChatTurnStatus = 'pending' | 'running' | 'completed' | 'error';
export type ChatTreeView = 'technical' | 'product' | 'onboarding';

export interface ChatTurnScope {
  view: ChatTreeView | null;
  anchorNodeId: string | null;
}

export interface StoredChatConversation {
  id: string;
  title: string | null;
  createdAt: string; // ISO-8601
  updatedAt: string; // ISO-8601
}

export interface StoredChatTurn {
  id: string;
  conversationId: string;
  seq: number;
  role: ChatTurnRole;
  content: string;
  status: ChatTurnStatus;
  citations: unknown[] | null;
  metrics: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  scope: ChatTurnScope | null;
  requestTurnId: string | null;
  dispatchedAt: string | null;
  createdAt: string;
}

export interface AppendTurnPairInput {
  owner: ChatOwnerScope;
  conversationId: string;
  idempotencyKey: string;
  question: string;
  scope: ChatTurnScope;
  historyLimit: number;
}

export interface AppendTurnPairResult {
  /** false when an existing (org, conversation, idempotency_key) row was found. */
  created: boolean;
  userTurn: StoredChatTurn;
  assistantTurn: StoredChatTurn;
  /** Ascending by seq, at most `historyLimit`, `{ role, content }` only. */
  history: Array<{ role: ChatTurnRole; content: string }>;
}

export interface ChatStore {
  createConversation(owner: ChatOwnerScope, title: string | null): Promise<StoredChatConversation>;
  listConversations(owner: ChatOwnerScope, limit: number): Promise<StoredChatConversation[]>;
  /** null = no such conversation for this (org, user) — never distinguishes absent from unowned. */
  getConversation(
    owner: ChatOwnerScope,
    conversationId: string,
    turnLimit: number,
  ): Promise<{ conversation: StoredChatConversation; turns: StoredChatTurn[] } | null>;
  /** null = no such conversation for this (org, user). */
  appendTurnPair(input: AppendTurnPairInput): Promise<AppendTurnPairResult | null>;
  markTurnDispatched(owner: ChatOwnerScope, assistantTurnId: string): Promise<void>;
}

export interface PostgresChatStoreDeps {
  getDb: () => Promise<Db>;
  withOrg: <T>(db: Db, orgId: string, fn: (tx: Db) => Promise<T>) => Promise<T>;
}

const defaultDeps: PostgresChatStoreDeps = {
  getDb: getRuntimeDb,
  withOrg: withOrgContext,
};

/**
 * `JSON.stringify([orgId, conversationId])`, used as
 * `pg_advisory_xact_lock(hashtextextended(<key>, 0))` — the exact
 * `agentSkillMdLockKey` idiom (src/db/agentSkillMdStore.ts). JSON preserves
 * field boundaries without an ambiguous concatenation or an invalid NUL byte.
 */
export function chatConversationLockKey(orgId: string, conversationId: string): string {
  return JSON.stringify([orgId, conversationId]);
}

function storedConversation(
  row: typeof chatConversations.$inferSelect,
): StoredChatConversation {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function storedTurn(row: typeof chatTurns.$inferSelect): StoredChatTurn {
  return {
    id: row.id,
    conversationId: row.conversationId,
    seq: row.seq,
    role: row.role as ChatTurnRole,
    content: row.content,
    status: row.status as ChatTurnStatus,
    citations: (row.citations as unknown[] | null) ?? null,
    metrics: (row.metrics as Record<string, unknown> | null) ?? null,
    error: (row.error as Record<string, unknown> | null) ?? null,
    scope: (row.scope as ChatTurnScope | null) ?? null,
    requestTurnId: row.requestTurnId,
    dispatchedAt: row.dispatchedAt ? row.dispatchedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

function ownerConversationPredicate(owner: ChatOwnerScope, conversationId: string) {
  return and(
    eq(chatConversations.orgId, owner.orgId),
    eq(chatConversations.id, conversationId),
    eq(chatConversations.userId, owner.userId),
  );
}

export class PostgresChatStore implements ChatStore {
  constructor(private readonly deps: PostgresChatStoreDeps = defaultDeps) {}

  async createConversation(
    owner: ChatOwnerScope,
    title: string | null,
  ): Promise<StoredChatConversation> {
    const db = await this.deps.getDb();
    return this.deps.withOrg(db, owner.orgId, async (tx) => {
      const [row] = await tx
        .insert(chatConversations)
        .values({ orgId: owner.orgId, userId: owner.userId, title })
        .returning();
      if (!row) throw new Error('chat conversation insert returned no row.');
      return storedConversation(row);
    });
  }

  async listConversations(
    owner: ChatOwnerScope,
    limit: number,
  ): Promise<StoredChatConversation[]> {
    const db = await this.deps.getDb();
    return this.deps.withOrg(db, owner.orgId, async (tx) => {
      const rows = await tx
        .select()
        .from(chatConversations)
        .where(and(eq(chatConversations.orgId, owner.orgId), eq(chatConversations.userId, owner.userId)))
        .orderBy(desc(chatConversations.updatedAt))
        .limit(limit);
      return rows.map(storedConversation);
    });
  }

  async getConversation(
    owner: ChatOwnerScope,
    conversationId: string,
    turnLimit: number,
  ): Promise<{ conversation: StoredChatConversation; turns: StoredChatTurn[] } | null> {
    const db = await this.deps.getDb();
    return this.deps.withOrg(db, owner.orgId, async (tx) => {
      const conversationRows = await tx
        .select()
        .from(chatConversations)
        .where(ownerConversationPredicate(owner, conversationId))
        .limit(1);
      const conversationRow = conversationRows[0];
      if (!conversationRow) return null;

      // Newest `turnLimit` turns, then re-ordered ascending by seq (EC-16).
      const turnRows = await tx
        .select()
        .from(chatTurns)
        .where(and(eq(chatTurns.orgId, owner.orgId), eq(chatTurns.conversationId, conversationId)))
        .orderBy(desc(chatTurns.seq))
        .limit(turnLimit);

      return {
        conversation: storedConversation(conversationRow),
        turns: turnRows.map(storedTurn).reverse(),
      };
    });
  }

  async appendTurnPair(input: AppendTurnPairInput): Promise<AppendTurnPairResult | null> {
    const { owner, conversationId } = input;
    const db = await this.deps.getDb();
    return this.deps.withOrg(db, owner.orgId, async (tx) => {
      // A transaction-scoped advisory lock serializes concurrent posts to the
      // SAME conversation — the exact `PostgresAgentSkillMdStore.append` idiom.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${chatConversationLockKey(owner.orgId, conversationId)}, 0))`,
      );

      const conversationRows = await tx
        .select({ id: chatConversations.id })
        .from(chatConversations)
        .where(ownerConversationPredicate(owner, conversationId))
        .limit(1);
      if (!conversationRows[0]) return null;

      const existing = await this.existingPair(tx, owner.orgId, conversationId, input.idempotencyKey);
      if (existing) {
        const history = await this.history(
          tx,
          owner.orgId,
          conversationId,
          existing.userTurn.seq,
          input.historyLimit,
        );
        return { created: false, userTurn: existing.userTurn, assistantTurn: existing.assistantTurn, history };
      }

      const lastTurnRows = await tx
        .select({ seq: chatTurns.seq })
        .from(chatTurns)
        .where(and(eq(chatTurns.orgId, owner.orgId), eq(chatTurns.conversationId, conversationId)))
        .orderBy(desc(chatTurns.seq))
        .limit(1);
      const userSeq = (lastTurnRows[0]?.seq ?? 0) + 1;

      const [userRow] = await tx
        .insert(chatTurns)
        .values({
          orgId: owner.orgId,
          conversationId,
          seq: userSeq,
          role: 'user',
          content: input.question,
          status: 'completed',
          scope: input.scope,
          idempotencyKey: input.idempotencyKey,
        })
        .returning();
      if (!userRow) throw new Error('chat user turn insert returned no row.');

      const [assistantRow] = await tx
        .insert(chatTurns)
        .values({
          orgId: owner.orgId,
          conversationId,
          seq: userSeq + 1,
          role: 'assistant',
          content: '',
          status: 'pending',
          requestTurnId: userRow.id,
        })
        .returning();
      if (!assistantRow) throw new Error('chat assistant turn insert returned no row.');

      await tx
        .update(chatConversations)
        .set({ updatedAt: new Date() })
        .where(and(eq(chatConversations.orgId, owner.orgId), eq(chatConversations.id, conversationId)));

      const history = await this.history(tx, owner.orgId, conversationId, userRow.seq, input.historyLimit);

      return {
        created: true,
        userTurn: storedTurn(userRow),
        assistantTurn: storedTurn(assistantRow),
        history,
      };
    });
  }

  async markTurnDispatched(owner: ChatOwnerScope, assistantTurnId: string): Promise<void> {
    const db = await this.deps.getDb();
    await this.deps.withOrg(db, owner.orgId, async (tx) => {
      await tx
        .update(chatTurns)
        .set({ dispatchedAt: new Date() })
        .where(and(eq(chatTurns.orgId, owner.orgId), eq(chatTurns.id, assistantTurnId)));
    });
  }

  private async existingPair(
    tx: Db,
    orgId: string,
    conversationId: string,
    idempotencyKey: string,
  ): Promise<{ userTurn: StoredChatTurn; assistantTurn: StoredChatTurn } | null> {
    const userRows = await tx
      .select()
      .from(chatTurns)
      .where(
        and(
          eq(chatTurns.orgId, orgId),
          eq(chatTurns.conversationId, conversationId),
          eq(chatTurns.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    const userRow = userRows[0];
    if (!userRow) return null;

    const assistantRows = await tx
      .select()
      .from(chatTurns)
      .where(and(eq(chatTurns.orgId, orgId), eq(chatTurns.requestTurnId, userRow.id)))
      .limit(1);
    const assistantRow = assistantRows[0];
    if (!assistantRow) {
      throw new Error('chat turn pair is missing its paired assistant turn.');
    }
    return { userTurn: storedTurn(userRow), assistantTurn: storedTurn(assistantRow) };
  }

  /** Newest `limit` COMPLETED turns strictly before `beforeSeq`, ascending. */
  private async history(
    tx: Db,
    orgId: string,
    conversationId: string,
    beforeSeq: number,
    limit: number,
  ): Promise<Array<{ role: ChatTurnRole; content: string }>> {
    const rows = await tx
      .select({ role: chatTurns.role, content: chatTurns.content })
      .from(chatTurns)
      .where(
        and(
          eq(chatTurns.orgId, orgId),
          eq(chatTurns.conversationId, conversationId),
          eq(chatTurns.status, 'completed'),
          lt(chatTurns.seq, beforeSeq),
        ),
      )
      .orderBy(desc(chatTurns.seq))
      .limit(limit);
    return rows.reverse().map((row) => ({ role: row.role as ChatTurnRole, content: row.content }));
  }
}

export const chatStore: ChatStore = new PostgresChatStore();
