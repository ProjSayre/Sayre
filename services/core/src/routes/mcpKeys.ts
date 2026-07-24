import { Router } from 'express';
import { requireAuthContext } from '../auth/context';
import { authenticate } from '../http/authenticate';
import { authorize } from '../http/authorize';
import { asyncHandler } from '../http/express';
import {
  getMcpKeySettings,
  issueMcpKey,
  revokeMcpKey,
  updateMcpRateLimit,
} from '../services/mcpKeyService';

// Thin browser/admin adapter. Key generation, authorization ceilings,
// revocation, and persistence all remain in the service layer.
export const mcpKeysRouter = Router();

mcpKeysRouter.get(
  '/settings/mcp',
  authenticate(),
  authorize('admin'),
  asyncHandler(async (req, res) => {
    res.json(await getMcpKeySettings(requireAuthContext(req)));
  }),
);

mcpKeysRouter.post(
  '/settings/mcp/keys',
  authenticate(),
  authorize('admin'),
  asyncHandler(async (req, res) => {
    res.status(201).json(
      await issueMcpKey(req.body, requireAuthContext(req)),
    );
  }),
);

mcpKeysRouter.delete(
  '/settings/mcp/keys/:keyId',
  authenticate(),
  authorize('admin'),
  asyncHandler(async (req, res) => {
    res.json(
      await revokeMcpKey(req.params.keyId, requireAuthContext(req)),
    );
  }),
);

mcpKeysRouter.put(
  '/settings/mcp/rate-limit',
  authenticate(),
  authorize('admin'),
  asyncHandler(async (req, res) => {
    res.json(
      await updateMcpRateLimit(req.body, requireAuthContext(req)),
    );
  }),
);
