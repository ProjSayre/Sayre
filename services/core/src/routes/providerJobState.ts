import { Router } from 'express';
import { requireAuthContext } from '../auth/context';
import { authenticate } from '../http/authenticate';
import { authorize } from '../http/authorize';
import { asyncHandler } from '../http/express';
import {
  getProviderJobState,
  parseProviderJobStateQuery,
} from '../services/providerJobStateService';

// Thin HTTP adapter only: parsing/auth middleware here, permission and persistence
// behavior in providerJobStateService.
export const providerJobStateRouter = Router();

providerJobStateRouter.get(
  '/repos/:repoId/provider-state',
  authenticate(),
  authorize('member'),
  asyncHandler(async (req, res) => {
    const query = parseProviderJobStateQuery({
      refName: req.query.refName,
      surface: req.query.surface,
    });
    const state = await getProviderJobState(
      req.params.repoId,
      query,
      requireAuthContext(req),
    );
    res.json(state);
  }),
);
