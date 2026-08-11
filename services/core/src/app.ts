import express, { type Express } from 'express';
import { healthRouter } from './routes/health';
import { technicalTreeRouter } from './routes/technicalTree';
import { productTreeRouter } from './routes/productTree';
import { realtimeInternalRouter } from './routes/realtimeInternal';
import { githubWebhookRouter, GITHUB_WEBHOOK_MAX_BODY_BYTES } from './routes/githubWebhook';
import { githubInstallRouter } from './routes/githubInstall';
import { githubInstallationReconcileRouter } from './routes/githubInstallationReconcile';
import { jiraConnectRouter } from './routes/jiraConnect';
import { loginRouter } from './routes/login';
import { providerSettingsRouter } from './routes/providerSettings';
import { providerJobStateRouter } from './routes/providerJobState';
import { nodeOverlayRouter } from './routes/nodeOverlay';
import { repositoryCatalogRouter } from './routes/repositoryCatalog';
import { onboardingTreeRouter } from './routes/onboardingTree';
import { mcpKeysRouter } from './routes/mcpKeys';
import { mcpGatewayRouter } from './mcp/gateway';
import { errorHandler } from './http/express';

export function createApp(): Express {
  const app = express();
  // Mounted BEFORE express.json(): the webhook needs the raw bytes GitHub
  // signed (express.json() would parse-and-discard them), and it is
  // signature-validated, not session-validated — no authenticate()/authorize()
  // here, and no user session to attach; org_id is resolved from the
  // installation id inside the service, not from a request-scoped auth context.
  //
  // GAP-9 (W1-02 gapfill, AC-6): body-size cap decision, recorded here where the
  // limit lives. Kept at GITHUB_WEBHOOK_MAX_BODY_BYTES (5 MB), deliberately NOT
  // raised to GitHub's 25 MB ceiling. This route is UNAUTHENTICATED — every byte is
  // buffered in memory before the HMAC signature can even be checked — so a bigger
  // cap is a bigger pre-authentication denial-of-service lever for an unverified
  // caller, not just a compatibility knob. 5 MB is still >10x the largest payload
  // the supported event types realistically produce. If a genuine oversized delivery
  // is ever observed (see the warning wired into http/express.ts's entity.too.large
  // branch), raising it is a one-line follow-up.
  app.use(
    '/webhooks/github',
    express.raw({ type: '*/*', limit: GITHUB_WEBHOOK_MAX_BODY_BYTES }),
    githubWebhookRouter,
  );
  app.use(express.json());
  app.get('/', (_req, res) => res.json({ message: 'Sayre core API' }));
  app.use(healthRouter);
  app.use(technicalTreeRouter);
  app.use(providerJobStateRouter);
  app.use(productTreeRouter);
  app.use(onboardingTreeRouter);
  // Internal-only (services/gateway callers only in a real deployment — see
  // routes/realtimeInternal.ts's header comment for the network-isolation
  // requirement). Mounted here, after express.json(), alongside the other
  // session-authenticated routes.
  app.use(realtimeInternalRouter);
  // Browser-facing GitHub App install flow (W1-06). Mounted AFTER
  // express.json(), NOT under the raw-body webhook path. authenticate()/
  // authorize() are applied per-route inside routes/githubInstall.ts (install-
  // start only; the callback route resolves org from the signed `state` JWT
  // and stays exempt — it can't rely on a session surviving the GitHub redirect).
  app.use(githubInstallRouter);
  // Real "Sign in with GitHub" login/signup (AUTH-01) — the only production
  // path that mints a session besides the dev-only devSessionContext(). Both
  // routes are unauthenticated: the login-start route IS the entry point, and
  // the callback route's trust anchor is the signed login-state `state` JWT,
  // not a session (see routes/login.ts / auth/loginState.ts).
  app.use(loginRouter);
  app.use(providerSettingsRouter);
  app.use(nodeOverlayRouter);
  app.use(repositoryCatalogRouter);
  // Manual reconciliation backstop for missed/out-of-order installation_repositories
  // webhook deliveries (W2-09). Mounted after express.json(), alongside the other
  // session-authenticated routes; authenticate()/authorize('admin') applied per-route
  // inside routes/githubInstallationReconcile.ts.
  app.use(githubInstallationReconcileRouter);
  // Browser-facing Jira OAuth 3LO connect flow (W3-10) — the Jira equivalent
  // of the GitHub install flow above. Mounted after express.json(), alongside
  // the other session-authenticated routes; authenticate()/authorize('admin')
  // applied per-route inside routes/jiraConnect.ts (the callback route stays
  // unauthenticated for the same reason githubInstall's callback does).
  app.use(jiraConnectRouter);
  app.use(mcpKeysRouter);
  app.use(mcpGatewayRouter);
  app.use(errorHandler);
  return app;
}
