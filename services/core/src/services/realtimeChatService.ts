// CH-05 — business logic for the internal realtime chat-authorization call
// (.claude/rules/service-layer.md). The gateway calls this via
// `POST /internal/realtime/chat-authorization` before EVERY chat push,
// re-asking whether the connection's subject still owns the conversation and
// which of the event's citation node ids they may currently see.
//
// INVARIANT: `ctx` is resolved server-side by the caller (requireAuthContext)
// — org_id/user_id are NEVER read from the request body
// (.claude/rules/security-multitenancy.md).

import type { RealtimeChatAuthorization } from '@sayre/shared-types';
import type { AuthContext } from '../auth/context';
import { chatStore, type ChatStore } from '../db/chatStore';
import { graphQueryService } from '../graph-query';
import type { ChatCitationGraphQueryService } from '../graph-query/types';
import { ChatForbiddenError, ChatNotFoundError, requireConversationId } from './chatService';

export async function authorizeRealtimeChatPush(
  input: { conversationId: string; nodeIds: readonly string[] },
  ctx: AuthContext,
  store: ChatStore = chatStore,
  graph: ChatCitationGraphQueryService = graphQueryService,
): Promise<RealtimeChatAuthorization> {
  if (ctx.subjectType !== 'user') throw new ChatForbiddenError();

  requireConversationId(input.conversationId);

  const conversation = await store.getConversation(
    { orgId: ctx.orgId, userId: ctx.userId },
    input.conversationId,
    0,
  );
  if (conversation === null) throw new ChatNotFoundError();

  if (input.nodeIds.length === 0) {
    return { conversationId: input.conversationId, authorizedNodeIds: [] };
  }

  const authorizedNodeIds = await graph.getAuthorizedNodeIds(input.nodeIds, ctx);
  return { conversationId: input.conversationId, authorizedNodeIds };
}
