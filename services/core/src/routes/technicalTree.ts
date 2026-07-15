import { Router } from 'express';
import { getTechnicalTree } from '../services/technicalTreeService';
import { parseViewport } from '../http/viewport';
import { requireOrgId } from '../http/tenantContext';
import { asyncHandler } from '../http/express';

// Thin wrapper only — no business logic here (service-layer rule).
// This route never imports the graph-query client, a DB client, or a queue —
// only services + http adapters (see .eslintrc.json overrides on src/routes/**).
export const technicalTreeRouter = Router();

technicalTreeRouter.get(
  '/repos/:repoId/technical-tree',
  asyncHandler(async (req, res) => {
    const viewport = parseViewport(req.query);
    const tree = await getTechnicalTree(req.params.repoId, requireOrgId(req), viewport);
    res.json(tree);
  }),
);
