import { Router } from 'express';
import { getHealthStatus } from '../services/health';

// Thin wrapper only — no business logic here (service-layer rule).
export const healthRouter = Router();
healthRouter.get('/health', (_req, res) => {
  res.json(getHealthStatus());
});
