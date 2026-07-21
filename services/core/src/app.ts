import express, { type Express } from 'express';
import { healthRouter } from './routes/health';
import { technicalTreeRouter } from './routes/technicalTree';
import { githubWebhookRouter } from './routes/githubWebhook';
import { tenantContext } from './http/tenantContext';
import { errorHandler } from './http/express';

export function createApp(): Express {
  const app = express();
  // Mounted BEFORE express.json() and tenantContext: the webhook needs the raw
  // bytes GitHub signed (express.json() would parse-and-discard them), and there is
  // no user session to attach tenant context to — org_id is resolved from the
  // installation id inside the service, not from a request-scoped org context.
  app.use('/webhooks/github', express.raw({ type: '*/*', limit: '5mb' }), githubWebhookRouter);
  app.use(express.json());
  app.use(tenantContext);
  app.get('/', (_req, res) => res.json({ message: 'Sayre core API' }));
  app.use(healthRouter);
  app.use(technicalTreeRouter);
  app.use(errorHandler);
  return app;
}
