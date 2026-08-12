// CH-05 — service-layer behaviour for the internal realtime chat-authorization
// call the gateway makes before EVERY push. Authored by `red` from
// .pipeline/spec.md before any implementation exists.
//
// Boundary note: this file measures what the SERVICE owes — the owner check,
// the ctx-only tenant/subject scope it hands the store, and the citation-node
// authorization it delegates to the Graph Query Service. The Cypher half is
// measured in ../graph-query/index.test.ts and the HTTP half in
// ../routes/realtimeInternal.test.ts.

import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../auth/context';
import type { ChatStore, StoredChatConversation } from '../db/chatStore';
import type { ChatCitationGraphQueryService } from '../graph-query/types';
import { ChatForbiddenError, ChatNotFoundError } from './chatService';
import { authorizeRealtimeChatPush } from './realtimeChatService';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const USER_A = '22222222-2222-4222-8222-222222222222';
const CONVERSATION_ID = '44444444-4444-4444-8444-444444444444';

const userCtx: AuthContext = {
  subjectType: 'user',
  userId: USER_A,
  orgId: ORG_A,
  roles: ['member'],
};

const agentKeyCtx: AuthContext = {
  subjectType: 'agent_key',
  agentKeyId: 'mcp_live_abc',
  orgId: ORG_A,
  roles: ['member'],
};

function conversation(): StoredChatConversation {
  return {
    id: CONVERSATION_ID,
    title: 'Why does auth fail?',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:05:00.000Z',
  };
}

function storeStub(overrides: Partial<Record<keyof ChatStore, unknown>> = {}): ChatStore & {
  getConversation: ReturnType<typeof vi.fn>;
} {
  return {
    createConversation: vi.fn(),
    listConversations: vi.fn(),
    getConversation: vi.fn(async () => ({ conversation: conversation(), turns: [] })),
    appendTurnPair: vi.fn(),
    markTurnDispatched: vi.fn(),
    ...overrides,
  } as never;
}

function graphStub(
  authorized: string[] = [],
): ChatCitationGraphQueryService & { getAuthorizedNodeIds: ReturnType<typeof vi.fn> } {
  return {
    getAuthorizedNodeIds: vi.fn(async () => authorized),
  } as never;
}

describe('authorizeRealtimeChatPush', () => {
  // @spec AC-11
  it('AC-11: the conversation owner gets { conversationId, authorizedNodeIds } filtered by the Graph Query Service', async () => {
    const store = storeStub();
    const graph = graphStub(['file-login']);

    const result = await authorizeRealtimeChatPush(
      { conversationId: CONVERSATION_ID, nodeIds: ['file-login', 'file-secret'] },
      userCtx,
      store,
      graph,
    );

    expect(result).toEqual({ conversationId: CONVERSATION_ID, authorizedNodeIds: ['file-login'] });
    expect(graph.getAuthorizedNodeIds).toHaveBeenCalledWith(['file-login', 'file-secret'], userCtx);
  });

  // @spec AC-11 AC-8
  it('AC-11/AC-8: the store is scoped ONLY by ctx org/user — body-supplied org or user fields have no effect', async () => {
    const store = storeStub();
    const graph = graphStub([]);

    await authorizeRealtimeChatPush(
      {
        conversationId: CONVERSATION_ID,
        nodeIds: ['n1'],
        orgId: 'attacker-org',
        org_id: 'attacker-org',
        userId: 'attacker-user',
      } as never,
      userCtx,
      store,
      graph,
    );

    expect(store.getConversation).toHaveBeenCalledTimes(1);
    const [owner, conversationId] = store.getConversation.mock.calls[0] as [
      { orgId: string; userId: string },
      string,
    ];
    expect(owner).toEqual({ orgId: ORG_A, userId: USER_A });
    expect(conversationId).toBe(CONVERSATION_ID);
    expect(JSON.stringify(store.getConversation.mock.calls)).not.toContain('attacker');
  });

  // @spec AC-11
  it('AC-11: an agent-key subject is refused with ChatForbiddenError before Postgres or the graph is touched', async () => {
    const store = storeStub();
    const graph = graphStub(['file-login']);

    await expect(
      authorizeRealtimeChatPush(
        { conversationId: CONVERSATION_ID, nodeIds: ['file-login'] },
        agentKeyCtx,
        store,
        graph,
      ),
    ).rejects.toBeInstanceOf(ChatForbiddenError);

    expect(store.getConversation).not.toHaveBeenCalled();
    expect(graph.getAuthorizedNodeIds).not.toHaveBeenCalled();
  });

  // @spec AC-11 EC-8
  it('AC-11/EC-8: a nonexistent conversation and one owned by another user raise the IDENTICAL ChatNotFoundError', async () => {
    const graph = graphStub(['file-login']);
    const absentStore = storeStub({ getConversation: vi.fn(async () => null) });
    const unownedStore = storeStub({ getConversation: vi.fn(async () => null) });

    const absent = await authorizeRealtimeChatPush(
      { conversationId: CONVERSATION_ID, nodeIds: ['file-login'] },
      userCtx,
      absentStore,
      graph,
    ).catch((error: unknown) => error);
    const unowned = await authorizeRealtimeChatPush(
      { conversationId: CONVERSATION_ID, nodeIds: ['file-login'] },
      userCtx,
      unownedStore,
      graph,
    ).catch((error: unknown) => error);

    expect(absent).toBeInstanceOf(ChatNotFoundError);
    expect(unowned).toBeInstanceOf(ChatNotFoundError);
    expect((absent as Error).message).toBe((unowned as Error).message);
    expect(graph.getAuthorizedNodeIds).not.toHaveBeenCalled();
  });

  // @spec AC-11
  it('AC-11: a malformed conversation id raises ChatNotFoundError without ever reaching Postgres', async () => {
    const store = storeStub();
    const graph = graphStub([]);

    for (const conversationId of ['', 'not-a-uuid', '../../etc/passwd']) {
      await expect(
        authorizeRealtimeChatPush({ conversationId, nodeIds: [] }, userCtx, store, graph),
      ).rejects.toBeInstanceOf(ChatNotFoundError);
    }

    expect(store.getConversation).not.toHaveBeenCalled();
  });

  // @spec EC-28
  it('EC-28: an empty nodeIds list still runs the ownership check but skips the graph query entirely', async () => {
    const store = storeStub();
    const graph = graphStub(['should-never-be-returned']);

    const result = await authorizeRealtimeChatPush(
      { conversationId: CONVERSATION_ID, nodeIds: [] },
      userCtx,
      store,
      graph,
    );

    expect(result).toEqual({ conversationId: CONVERSATION_ID, authorizedNodeIds: [] });
    expect(store.getConversation).toHaveBeenCalledTimes(1); // ownership half still enforced
    expect(graph.getAuthorizedNodeIds).not.toHaveBeenCalled();
  });

  // @spec AC-12
  it('AC-12: an unauthorized-for-everything scope yields an empty authorizedNodeIds rather than the requested ids', async () => {
    const store = storeStub();
    const graph = graphStub([]);

    const result = await authorizeRealtimeChatPush(
      { conversationId: CONVERSATION_ID, nodeIds: ['a', 'b', 'c'] },
      userCtx,
      store,
      graph,
    );

    expect(result.authorizedNodeIds).toEqual([]);
  });
});
