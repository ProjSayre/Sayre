import express, { type Express } from 'express';
import { healthRouter } from './routes/health';
import { technicalTreeRouter } from './routes/technicalTree';
import { realtimeInternalRouter } from './routes/realtimeInternal';
import { githubWebhookRouter } from './routes/githubWebhook';
import { githubInstallRouter } from './routes/githubInstall';
import { providerJobStateRouter } from './routes/providerJobState';
import { errorHandler } from './http/express';

export function createApp(): Express {
  const app = express();
  // Mounted BEFORE express.json(): the webhook needs the raw bytes GitHub
  // signed (express.json() would parse-and-discard them), and it is
  // signature-validated, not session-validated — no authenticate()/authorize()
  // here, and no user session to attach; org_id is resolved from the
  // installation id inside the service, not from a request-scoped auth context.
  app.use('/webhooks/github', express.raw({ type: '*/*', limit: '5mb' }), githubWebhookRouter);
  app.use(express.json());
  app.get('/', (_req, res) => res.json({ message: 'Sayre core API' }));
  app.use(healthRouter);
  app.use(technicalTreeRouter);
  app.use(providerJobStateRouter);
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
  app.use(errorHandler);
  return app;
}
