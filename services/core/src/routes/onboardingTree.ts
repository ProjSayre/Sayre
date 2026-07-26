import { Router } from 'express';
import { requireAuthContext } from '../auth/context';
import { authenticate } from '../http/authenticate';
import { authorize } from '../http/authorize';
import { asyncHandler } from '../http/express';
import {
  DEFAULT_ONBOARDING_TREE_REF,
  OnboardingStepNotFoundError,
  OnboardingTreeNotFoundError,
  executeOnboardingStep,
  getOnboardingTree,
  type OnboardingTreeDependencies,
} from '../services/onboardingTreeService';

function refFromQuery(value: unknown): string {
  if (value === undefined) return DEFAULT_ONBOARDING_TREE_REF;
  if (typeof value !== 'string') {
    throw new RangeError('ref must be supplied once as a string');
  }
  return value;
}

export function createOnboardingTreeRouter(
  dependencies: OnboardingTreeDependencies = {},
): Router {
  const router = Router();

  router.get(
    '/repos/:repoId/onboarding-tree',
    authenticate(),
    authorize('member'),
    asyncHandler(async (req, res) => {
      try {
        const tree = await getOnboardingTree(
          req.params.repoId,
          refFromQuery(req.query.ref),
          requireAuthContext(req),
          dependencies.graph,
        );
        res.json(tree);
      } catch (error) {
        if (error instanceof RangeError) {
          res.status(400).json({ error: error.message });
          return;
        }
        if (error instanceof OnboardingTreeNotFoundError) {
          res.status(404).json({ error: error.message });
          return;
        }
        throw error;
      }
    }),
  );

  router.post(
    '/repos/:repoId/onboarding-steps/:stepId/execute',
    authenticate(),
    authorize('admin'),
    asyncHandler(async (req, res) => {
      try {
        const result = await executeOnboardingStep(
          req.params.repoId,
          req.params.stepId,
          refFromQuery(req.query.ref),
          requireAuthContext(req),
          dependencies,
        );
        res.status(result.status === 'succeeded' ? 200 : 422).json(result);
      } catch (error) {
        if (error instanceof RangeError) {
          res.status(400).json({ error: error.message });
          return;
        }
        if (
          error instanceof OnboardingTreeNotFoundError ||
          error instanceof OnboardingStepNotFoundError
        ) {
          res.status(404).json({ error: error.message });
          return;
        }
        throw error;
      }
    }),
  );

  return router;
}

export const onboardingTreeRouter = createOnboardingTreeRouter();
