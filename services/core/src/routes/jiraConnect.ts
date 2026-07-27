import { Router } from 'express';
import type { AuthContext } from '../auth/context';
import { requireAuthContext, requireOrgId } from '../auth/context';
import { authenticate } from '../http/authenticate';
import { authorize, AuthorizationError } from '../http/authorize';
import { asyncHandler } from '../http/express';
import {
  disconnectJira,
  getJiraConnectionStatus,
  handleJiraCallback,
  JiraCallbackBadRequestError,
  JiraSingleSiteRequiredError,
  resolveConnectingUserLabel,
  startJiraConnect,
} from '../services/jiraConnectService';
import { getConfig } from '@sayre/config';

// Thin wrapper only — no business logic here (service-layer rule). Browser-
// facing routes: mounted after express.json() in app.ts, alongside
// routes/githubInstall.ts. The connect-start/status/disconnect routes are
// real-session-gated (authenticate() + authorize('admin')); the callback
// route intentionally stays unauthenticated — org/user binding comes from the
// signed `state` JWT (jira/jiraConnectState.ts), not a session, since it
// can't rely on a session surviving the Atlassian consent redirect.
export const jiraConnectRouter = Router();

// `authorize('admin')` already ran (subject-agnostic, per .claude/rules/
// security-multitenancy.md) before every route below that calls this, but a
// future `agent_key` AuthContext (reserved for W4-06, not constructed
// anywhere yet) has no `userId` to attribute a browser-only OAuth flow to --
// this is pure request-shape adaptation (service-layer rule), not business
// logic, so it lives in the route.
function requireUserId(ctx: AuthContext): string {
  if (ctx.subjectType !== 'user') {
    throw new AuthorizationError();
  }
  return ctx.userId;
}

function singleQueryValue(value: unknown): string | undefined {
  // A duplicate query param (`?code=a&code=b`) parses to an array in Express —
  // reject it as a clean 400 rather than letting an array reach the service
  // and crash (the WEB-07-style 500 noted in docs/post-mvp-backlog.md).
  if (Array.isArray(value)) throw new JiraCallbackBadRequestError('Duplicate query parameter.');
  return typeof value === 'string' ? value : undefined;
}

jiraConnectRouter.get(
  '/integrations/jira/connect',
  authenticate(),
  authorize('admin'),
  asyncHandler(async (req, res) => {
    const ctx = requireAuthContext(req);
    const orgId = requireOrgId(req);
    const userLabel = await resolveConnectingUserLabel({
      orgId,
      userId: requireUserId(ctx),
    });
    const result = await startJiraConnect({
      orgId,
      userId: requireUserId(ctx),
      userLabel,
    });
    res.redirect(302, result.redirectTo);
  }),
);

jiraConnectRouter.get(
  '/integrations/jira/callback',
  asyncHandler(async (req, res) => {
    try {
      const result = await handleJiraCallback({
        code: singleQueryValue(req.query.code),
        state: singleQueryValue(req.query.state),
        error: singleQueryValue(req.query.error),
      });
      res.redirect(302, result.redirectTo);
    } catch (error) {
      if (error instanceof JiraSingleSiteRequiredError) {
        const postConnectRedirect = getConfig('JIRA_POST_CONNECT_REDIRECT_URL');
        res.redirect(302, `${postConnectRedirect}?jira_error=multiple_sites`);
        return;
      }
      throw error;
    }
  }),
);

jiraConnectRouter.get(
  '/integrations/jira/status',
  authenticate(),
  authorize('admin'),
  asyncHandler(async (req, res) => {
    res.json(await getJiraConnectionStatus({ orgId: requireOrgId(req) }));
  }),
);

jiraConnectRouter.post(
  '/integrations/jira/disconnect',
  authenticate(),
  authorize('admin'),
  asyncHandler(async (req, res) => {
    const ctx = requireAuthContext(req);
    const orgId = requireOrgId(req);
    const actorLabel = await resolveConnectingUserLabel({
      orgId,
      userId: requireUserId(ctx),
    });
    res.json(
      await disconnectJira({ orgId, actorUserId: requireUserId(ctx), actorLabel }),
    );
  }),
);
