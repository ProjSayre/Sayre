import { Router } from 'express';
import { requireAuthContext } from '../auth/context';
import { authenticate } from '../http/authenticate';
import { authorize } from '../http/authorize';
import { asyncHandler } from '../http/express';
import { getRepositoryCatalog } from '../services/repositoryCatalogService';

// Thin read-only adapter. Tenant identity comes exclusively from authenticate().
export const repositoryCatalogRouter = Router();

repositoryCatalogRouter.get(
  '/repositories',
  authenticate(),
  authorize('member'),
  asyncHandler(async (req, res) => {
    res.json(await getRepositoryCatalog(requireAuthContext(req)));
  }),
);
