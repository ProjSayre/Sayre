import express, { type Express } from 'express';
import { healthRouter } from './routes/health';

export function createApp(): Express {
  const app = express();
  app.use(express.json());
  app.get('/', (_req, res) => res.json({ message: 'Sayre core API' }));
  app.use(healthRouter);
  return app;
}
