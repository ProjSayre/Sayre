import { Router } from 'express';
import {
  DEFAULT_TECHNICAL_TREE_REF,
  getTechnicalTree,
} from '../services/technicalTreeService';
import { parseViewport } from '../http/viewport';
import { canonicalRefName } from '../refName';
import { requireAuthContext } from '../auth/context';
import { authenticate } from '../http/authenticate';
import { authorize } from '../http/authorize';
import { asyncHandler } from '../http/express';

// Thin wrapper only — no business logic here (service-layer rule).
// This route never imports the graph-query client, a DB client, or a queue —
// only services + http adapters (see .eslintrc.json overrides on src/routes/**).
export const technicalTreeRouter = Router();

function refNameFromQuery(value: unknown): string | null {
  if (value === undefined) return DEFAULT_TECHNICAL_TREE_REF;
  return canonicalRefName(value);
}

technicalTreeRouter.get(
  '/repos/:repoId/technical-tree',
  authenticate(),
  authorize('member'),
  asyncHandler(async (req, res) => {
    const viewport = parseViewport(req.query);
    const refName = refNameFromQuery(req.query.refName);
    if (refName === null) {
      res.status(400).json({ error: 'invalid technical tree refName' });
      return;
    }
    const tree = await getTechnicalTree(
      req.params.repoId,
      refName,
      viewport,
      requireAuthContext(req),
    );
    res.json(tree);
  }),
);
