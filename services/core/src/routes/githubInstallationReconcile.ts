import { Router } from 'express';
import { requireAuthContext } from '../auth/context';
import { authenticate } from '../http/authenticate';
import { authorize } from '../http/authorize';
import { asyncHandler } from '../http/express';
import { reconcileInstallationRepositories } from '../services/githubInstallationReconcileService';

// Thin HTTP adapter only — no business logic here (service-layer rule). Mutating (writes
// rows + enqueues), so POST — not GET, despite the ticket's original "GET
// /repositories/reconcile" phrasing (see spec.md) — a side-effecting action must not be a
// cacheable/prefetchable GET. Admin-or-owner gated: authorize('admin') already admits
// 'owner' (see http/authorize.ts's ROLE_RANK). Org identity comes ONLY from authenticate()
// via requireAuthContext(), never from the request body/query.
export const githubInstallationReconcileRouter = Router();

githubInstallationReconcileRouter.post(
  '/integrations/github/reconcile',
  authenticate(),
  authorize('admin'),
  asyncHandler(async (req, res) => {
    // W7-01 (AC-10): reconcile is now async/row-write-only — 202 Accepted, not 200.
    res.status(202).json(await reconcileInstallationRepositories(requireAuthContext(req)));
  }),
);
