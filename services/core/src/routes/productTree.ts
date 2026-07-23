import { Router } from 'express';
import { requireAuthContext } from '../auth/context';
import { authenticate } from '../http/authenticate';
import { authorize } from '../http/authorize';
import { asyncHandler } from '../http/express';
import {
  DEFAULT_PRODUCT_TREE_REF,
  getProductTree,
} from '../services/productTreeService';

export const productTreeRouter = Router();

function refFromQuery(value: unknown): string {
  if (value === undefined) return DEFAULT_PRODUCT_TREE_REF;
  if (typeof value !== 'string') {
    throw new RangeError('ref must be supplied once as a string');
  }
  return value;
}

productTreeRouter.get(
  '/repos/:repoId/product-tree',
  authenticate(),
  authorize('member'),
  asyncHandler(async (req, res) => {
    try {
      const tree = await getProductTree(
        req.params.repoId,
        refFromQuery(req.query.ref),
        requireAuthContext(req),
      );
      res.json(tree);
    } catch (error) {
      if (error instanceof RangeError) {
        res.status(400).json({ error: error.message });
        return;
      }
      throw error;
    }
  }),
);
