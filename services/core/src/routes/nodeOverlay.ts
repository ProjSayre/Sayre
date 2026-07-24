import { Router } from 'express';
import { requireAuthContext } from '../auth/context';
import { authenticate } from '../http/authenticate';
import { authorize } from '../http/authorize';
import { asyncHandler } from '../http/express';
import {
  AgentSkillMdValidationError,
  getAgentSkillMdHistory,
  saveAgentSkillMd,
} from '../services/agentSkillMdService';
import { getNodeOverlay } from '../services/nodeOverlayService';

export const nodeOverlayRouter = Router();

function historyLimit(value: unknown): number {
  if (value === undefined) return 25;
  if (typeof value !== 'string' || !/^\d{1,3}$/u.test(value)) {
    throw new AgentSkillMdValidationError(['limit must be an integer from 1 to 100.']);
  }
  const parsed = Number(value);
  if (parsed < 1 || parsed > 100) {
    throw new AgentSkillMdValidationError(['limit must be an integer from 1 to 100.']);
  }
  return parsed;
}

nodeOverlayRouter.get(
  '/nodes/:nodeId/overlay',
  authenticate(),
  authorize('member'),
  asyncHandler(async (req, res) => {
    const overlay = await getNodeOverlay(req.params.nodeId, requireAuthContext(req));
    if (overlay === null) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json(overlay);
  }),
);

nodeOverlayRouter.get(
  '/nodes/:nodeId/agent-skill-md/history',
  authenticate(),
  authorize('member'),
  asyncHandler(async (req, res) => {
    const versions = await getAgentSkillMdHistory(
      req.params.nodeId,
      requireAuthContext(req),
      historyLimit(req.query.limit),
    );
    res.json({ versions });
  }),
);

nodeOverlayRouter.put(
  '/nodes/:nodeId/agent-skill-md',
  authenticate(),
  authorize('admin'),
  asyncHandler(async (req, res) => {
    const saved = await saveAgentSkillMd(
      req.params.nodeId,
      {
        content: (req.body as Record<string, unknown> | undefined)?.content,
        expectedVersion: (req.body as Record<string, unknown> | undefined)
          ?.expectedVersion,
      },
      requireAuthContext(req),
    );
    res.json(saved);
  }),
);
