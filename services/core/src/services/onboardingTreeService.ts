import type { AuthContext } from '../auth/context';
import { graphQueryService } from '../graph-query';
import type {
  GraphEdge,
  GraphNode,
  OnboardingGraphQueryService,
  OnboardingGraphStep,
} from '../graph-query/types';
import {
  createOnboardingSandboxRunner,
  type OnboardingSandboxRunner,
  type SandboxExecutionResult,
} from './onboardingSandboxService';
import { normalizeProductTreeRef } from './productTreeService';

export const DEFAULT_ONBOARDING_TREE_REF = 'refs/heads/main';

export interface OnboardingTree {
  authorization: 'server-filtered';
  repoId: string;
  refName: string;
  revisionSha: string;
  visibleNodeCount: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
  steps: OnboardingGraphStep[];
}

export interface OnboardingStepExecution extends SandboxExecutionResult {
  stepId: string;
  sequence: number;
  revisionSha: string;
}

export interface OnboardingTreeDependencies {
  graph?: OnboardingGraphQueryService;
  sandbox?: OnboardingSandboxRunner;
}

export class OnboardingTreeNotFoundError extends Error {
  constructor() {
    super('No authorized current-head Onboarding Tree was found.');
    this.name = 'OnboardingTreeNotFoundError';
  }
}

export class OnboardingStepNotFoundError extends Error {
  constructor() {
    super('No authorized current-head onboarding step was found.');
    this.name = 'OnboardingStepNotFoundError';
  }
}

function normalizeRepoId(repoId: string): string {
  const normalized = repoId.trim();
  if (!normalized) throw new RangeError('repoId is required');
  return normalized;
}

export async function getOnboardingTree(
  repoId: string,
  refName: string,
  ctx: AuthContext,
  graph: OnboardingGraphQueryService = graphQueryService,
): Promise<OnboardingTree> {
  const normalizedRepoId = normalizeRepoId(repoId);
  const normalizedRefName = normalizeProductTreeRef(refName);
  const projection = await graph.getOnboardingProjection(
    normalizedRepoId,
    normalizedRefName,
    ctx,
  );
  if (projection === null) throw new OnboardingTreeNotFoundError();
  // Edges are re-authorized against the same node set the projection returned,
  // so an edge can never reference a node the caller was not already granted.
  const edges = await graph.getStructuralEdges(
    normalizedRepoId,
    normalizedRefName,
    projection.nodes.map(({ id }) => id),
    ctx,
  );
  return {
    authorization: 'server-filtered',
    repoId: normalizedRepoId,
    refName: normalizedRefName,
    revisionSha: projection.revisionSha,
    visibleNodeCount: projection.nodes.length,
    nodes: projection.nodes,
    edges,
    steps: projection.steps,
  };
}

export async function executeOnboardingStep(
  repoId: string,
  stepId: string,
  refName: string,
  ctx: AuthContext,
  dependencies: OnboardingTreeDependencies = {},
): Promise<OnboardingStepExecution> {
  const normalizedStepId = stepId.trim();
  if (
    !normalizedStepId ||
    normalizedStepId.length > 512 ||
    normalizedStepId !== stepId
  ) {
    throw new OnboardingStepNotFoundError();
  }
  const tree = await getOnboardingTree(
    repoId,
    refName,
    ctx,
    dependencies.graph ?? graphQueryService,
  );
  const step = tree.steps.find(({ id }) => id === normalizedStepId);
  if (step === undefined) throw new OnboardingStepNotFoundError();

  // The command is resolved from the freshly authorized graph projection.
  // No request body field can replace or amend it.
  const result = await (
    dependencies.sandbox ?? createOnboardingSandboxRunner()
  ).run(step.command);
  return {
    ...result,
    stepId: step.id,
    sequence: step.sequence,
    revisionSha: tree.revisionSha,
  };
}
