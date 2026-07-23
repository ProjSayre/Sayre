import { Router } from 'express';
import { requireAuthContext } from '../auth/context';
import { authenticate } from '../http/authenticate';
import { authorize } from '../http/authorize';
import { asyncHandler } from '../http/express';
import {
  getProviderSettings,
  updateProviderSettings,
} from '../services/providerSettingsService';

// Thin HTTP adapter only. Tenant/admin checks and settings validation remain in
// the service layer; persistence remains behind ProviderSettingsStore.
export const providerSettingsRouter = Router();

providerSettingsRouter.get(
  '/settings/model-providers',
  authenticate(),
  authorize('admin'),
  asyncHandler(async (req, res) => {
    res.json(await getProviderSettings(requireAuthContext(req)));
  }),
);

providerSettingsRouter.put(
  '/settings/model-providers/:purpose',
  authenticate(),
  authorize('admin'),
  asyncHandler(async (req, res) => {
    res.json(
      await updateProviderSettings(
        req.params.purpose,
        req.body,
        requireAuthContext(req),
      ),
    );
  }),
);
