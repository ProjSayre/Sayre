import { Router } from 'express';
import { getRealtimeGraphDelta } from '../services/realtimeDeltaService';
import { parseRealtimeDeltaRequest } from '../http/realtimeDeltaRequest';
import { requireOrgId } from '../auth/context';
import { authenticate } from '../http/authenticate';
import { authorize } from '../http/authorize';
import { asyncHandler } from '../http/express';

// INTERNAL-ONLY route (W2-03 O-2) — called only by services/gateway, which
// forwards the connected WebSocket client's session token so this endpoint can
// re-run authenticate() and re-derive org_id/roles server-side on every push,
// not just at WS-subscribe time (.claude/rules/security-multitenancy.md).
//
// This MUST NEVER be reachable from the public internet in a real deployment —
// the `/internal/` path prefix is a naming convention, not an enforcement
// mechanism by itself. Production deployments must additionally firewall this
// route at the network layer (e.g. only routable from the gateway's private
// subnet/security group, never through the public API Gateway/load balancer
// that fronts the rest of services/core). authenticate()/authorize('member')
// below are defense-in-depth against a caller with a stolen-but-valid session
// token, not a substitute for that network boundary — there is no existing
// "internal-only" gating middleware elsewhere in this codebase to reuse
// (checked services/core/src/http/**), so this comment is the documented
// contract until one exists.
//
// Thin wrapper only — no business logic here (service-layer rule). Never
// imports the graph-query client, a DB client, or a queue directly (src/routes/**
// lint gate, .eslintrc.json overrides).
export const realtimeInternalRouter = Router();

realtimeInternalRouter.post(
  '/internal/realtime/graph-delta',
  authenticate(),
  authorize('member'),
  asyncHandler(async (req, res) => {
    const { repoId, changedPaths, fullRebuild, graphVersion } = parseRealtimeDeltaRequest(req.body);
    const delta = await getRealtimeGraphDelta(repoId, requireOrgId(req), {
      changedPaths,
      fullRebuild,
      graphVersion,
    });
    res.json(delta);
  }),
);
