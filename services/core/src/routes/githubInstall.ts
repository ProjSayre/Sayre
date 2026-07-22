import { Router } from 'express';
import { handleGithubAppCallback, startGithubAppInstall } from '../services/githubAppInstallService';
import { requireOrgId } from '../http/tenantContext';
import { asyncHandler } from '../http/express';

// Thin wrapper only — no business logic here (service-layer rule). Browser-
// facing routes: mounted after express.json() + tenantContext in app.ts (see
// O-1 — the install route is gated behind the dev-placeholder tenantContext
// until W1-03 lands real session auth; the callback route intentionally does
// NOT depend on tenantContext, since org binding comes from the signed
// `state`, not a session).
export const githubInstallRouter = Router();

githubInstallRouter.get(
  '/integrations/github/install',
  asyncHandler(async (req, res) => {
    const result = await startGithubAppInstall({ orgId: requireOrgId(req) });
    res.redirect(302, result.redirectTo);
  }),
);

githubInstallRouter.get(
  '/integrations/github/callback',
  asyncHandler(async (req, res) => {
    const result = await handleGithubAppCallback({
      installationId: req.query.installation_id as string | undefined,
      setupAction: req.query.setup_action as string | undefined,
      state: req.query.state as string | undefined,
      code: req.query.code as string | undefined,
    });
    res.redirect(302, result.redirectTo);
  }),
);
