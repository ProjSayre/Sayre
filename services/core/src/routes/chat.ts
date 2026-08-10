// CH-03 — four thin "Ask Sayre" routes over chatService. No business logic:
// each handler is a call to chatService plus a response
// (.claude/rules/service-layer.md; enforced by the src/routes/** eslint
// override — see .eslintrc.json).

import { Router } from 'express';
import { requireAuthContext } from '../auth/context';
import { authenticate } from '../http/authenticate';
import { authorize } from '../http/authorize';
import { asyncHandler } from '../http/express';
import {
  createConversation,
  getConversation,
  listConversations,
  postTurn,
} from '../services/chatService';

export const chatRouter = Router();

chatRouter.post(
  '/chat/conversations',
  authenticate(),
  authorize('member'),
  asyncHandler(async (req, res) => {
    const conversation = await createConversation(req.body, requireAuthContext(req));
    res.status(201).json({ conversation });
  }),
);

chatRouter.get(
  '/chat/conversations',
  authenticate(),
  authorize('member'),
  asyncHandler(async (req, res) => {
    const conversations = await listConversations(req.query.limit, requireAuthContext(req));
    res.json({ conversations });
  }),
);

chatRouter.get(
  '/chat/conversations/:conversationId',
  authenticate(),
  authorize('member'),
  asyncHandler(async (req, res) => {
    const detail = await getConversation(req.params.conversationId, requireAuthContext(req));
    res.json(detail);
  }),
);

chatRouter.post(
  '/chat/conversations/:conversationId/turns',
  authenticate(),
  authorize('member'),
  asyncHandler(async (req, res) => {
    const result = await postTurn(req.params.conversationId, req.body, requireAuthContext(req));
    res.status(202).json(result);
  }),
);
