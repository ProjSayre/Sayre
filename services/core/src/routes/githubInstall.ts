import { Router } from 'express';
import { handleGithubAppCallback, startGithubAppInstall } from '../services/githubAppInstallService';
import { getGitHubIntegrationStatus } from '../services/githubIntegrationStatusService';
import { requireOrgId } from '../auth/context';
import { authenticate } from '../http/authenticate';
import { authorize } from '../http/authorize';
import { asyncHandler } from '../http/express';

// Thin wrapper only — no business logic here (service-layer rule). Browser-
// facing routes: mounted after express.json() in app.ts. The install-start
// route is real-session-gated (authenticate() + authorize('admin'), W1-03,
// closing O-1); the callback route intentionally stays unauthenticated — org
// binding comes from the signed `state` JWT (github/installState.ts), not a
// session, since it can't rely on a session surviving the GitHub redirect.
export const githubInstallRouter = Router();

githubInstallRouter.get(
  '/integrations/github/status',
  authenticate(),
  authorize('admin'),
  asyncHandler(async (req, res) => {
    res.json(await getGitHubIntegrationStatus(requireOrgId(req)));
  }),
);

githubInstallRouter.get(
  '/integrations/github/install',
  authenticate(),
  authorize('admin'),
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
