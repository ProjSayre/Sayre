import express, { type Express } from 'express';
import { healthRouter } from './routes/health';
import { technicalTreeRouter } from './routes/technicalTree';
import { tenantContext } from './http/tenantContext';
import { errorHandler } from './http/express';

export function createApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(tenantContext);
  app.get('/', (_req, res) => res.json({ message: 'Sayre core API' }));
  app.use(healthRouter);
  app.use(technicalTreeRouter);
  app.use(errorHandler);
  return app;
}
