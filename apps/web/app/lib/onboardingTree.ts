import type { AuthorizedCanvasPayload } from './scaleGraph';
import { coreFetch } from './coreFetch';

export interface OnboardingTreeNode {
  id: string;
  label: 'Folder' | 'File';
  name: string;
  path: string;
  parentId: string | null;
}

export interface OnboardingTreeStep {
  id: string;
  sequence: number;
  command: string;
  requires: string[];
}

export interface OnboardingTreeResponse {
  authorization: 'server-filtered';
  repoId: string;
  refName: string;
  revisionSha: string;
  visibleNodeCount: number;
  nodes: OnboardingTreeNode[];
  steps: OnboardingTreeStep[];
}

export interface OnboardingTreePresentation {
  response: OnboardingTreeResponse;
  canvas: AuthorizedCanvasPayload;
}

export interface OnboardingExecutionResponse {
  sandbox: 'container';
  status: 'succeeded' | 'failed' | 'timed_out';
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  stepId: string;
  sequence: number;
  revisionSha: string;
}

export class OnboardingTreeResponseError extends Error {
  constructor(message = 'The Onboarding Tree response is invalid.') {
    super(message);
    this.name = 'OnboardingTreeResponseError';
  }
}

export class OnboardingTreeRequestError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = 'OnboardingTreeRequestError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(
  value: Record<string, unknown>,
  name: string,
  allowEmpty = false,
): string {
  const field = value[name];
  if (
    typeof field !== 'string' ||
    (!allowEmpty && field.trim().length === 0)
  ) {
    throw new OnboardingTreeResponseError();
  }
  return field;
}

function parseNode(value: unknown): OnboardingTreeNode {
  if (!isRecord(value)) throw new OnboardingTreeResponseError();
  if (value.label !== 'Folder' && value.label !== 'File') {
    throw new OnboardingTreeResponseError();
  }
  if (
    value.parentId !== null &&
    (typeof value.parentId !== 'string' || !value.parentId)
  ) {
    throw new OnboardingTreeResponseError();
  }
  return {
    id: stringField(value, 'id'),
    label: value.label,
    name: stringField(value, 'name'),
    path: stringField(value, 'path', true),
    parentId: value.parentId,
  };
}

function parseStep(value: unknown): OnboardingTreeStep {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.sequence) ||
    (value.sequence as number) < 0 ||
    !Array.isArray(value.requires) ||
    value.requires.some(
      (requiredId) => typeof requiredId !== 'string' || !requiredId,
    )
  ) {
    throw new OnboardingTreeResponseError();
  }
  return {
    id: stringField(value, 'id'),
    sequence: value.sequence as number,
    command: stringField(value, 'command'),
    requires: [...new Set(value.requires as string[])],
  };
}

function assertWorkflow(steps: readonly OnboardingTreeStep[]): void {
  const byId = new Map(steps.map((step) => [step.id, step]));
  if (byId.size !== steps.length) throw new OnboardingTreeResponseError();
  const sequences = new Set<number>();
  for (const step of steps) {
    if (sequences.has(step.sequence)) throw new OnboardingTreeResponseError();
    sequences.add(step.sequence);
  }
  const ordered = [...steps].sort((a, b) => a.sequence - b.sequence);
  for (const [index, step] of ordered.entries()) {
    if (step.sequence !== index) throw new OnboardingTreeResponseError();
    for (const requiredId of step.requires) {
      const required = byId.get(requiredId);
      if (required === undefined || required.sequence >= step.sequence) {
        throw new OnboardingTreeResponseError();
      }
    }
  }
}

export function parseOnboardingTreeResponse(value: unknown): OnboardingTreeResponse {
  if (
    !isRecord(value) ||
    value.authorization !== 'server-filtered' ||
    !Number.isSafeInteger(value.visibleNodeCount) ||
    (value.visibleNodeCount as number) < 0 ||
    !Array.isArray(value.nodes) ||
    !Array.isArray(value.steps)
  ) {
    throw new OnboardingTreeResponseError();
  }
  const revisionSha = stringField(value, 'revisionSha');
  if (!/^[a-f0-9]{40,64}$/iu.test(revisionSha)) {
    throw new OnboardingTreeResponseError();
  }
  const nodes = value.nodes.map(parseNode);
  const steps = value.steps.map(parseStep);
  if (
    new Set(nodes.map(({ id }) => id)).size !== nodes.length ||
    value.visibleNodeCount !== nodes.length ||
    nodes.some(
      ({ parentId }) =>
        parentId !== null && !nodes.some(({ id }) => id === parentId),
    )
  ) {
    throw new OnboardingTreeResponseError();
  }
  assertWorkflow(steps);
  return {
    authorization: 'server-filtered',
    repoId: stringField(value, 'repoId'),
    refName: stringField(value, 'refName'),
    revisionSha,
    visibleNodeCount: value.visibleNodeCount as number,
    nodes,
    steps: [...steps].sort((a, b) => a.sequence - b.sequence),
  };
}

function requestError(status: number): OnboardingTreeRequestError {
  if (status === 401) {
    return new OnboardingTreeRequestError('Sign in to view onboarding.', status);
  }
  if (status === 403) {
    return new OnboardingTreeRequestError(
      'Administrator access is required to run setup steps.',
      status,
    );
  }
  if (status === 404) {
    return new OnboardingTreeRequestError(
      'No current Onboarding Tree is available for this repository.',
      status,
    );
  }
  return new OnboardingTreeRequestError(
    'The Onboarding Tree request failed.',
    status,
  );
}

export function toOnboardingTreePresentation(
  response: OnboardingTreeResponse,
): OnboardingTreePresentation {
  const ordered = [...response.nodes].sort(
    (a, b) =>
      a.path.split('/').length - b.path.split('/').length ||
      a.path.localeCompare(b.path),
  );
  const rowsByDepth = new Map<number, number>();
  const nodes = ordered.map((node) => {
    const depth = node.path === '' ? 0 : node.path.split('/').length;
    const row = rowsByDepth.get(depth) ?? 0;
    rowsByDepth.set(depth, row + 1);
    return {
      id: node.id,
      kind: node.label,
      label: node.name,
      path: node.path,
      x: depth * 230,
      y: row * 78,
    };
  });
  const ids = new Set(nodes.map(({ id }) => id));
  const edges = ordered.flatMap((node) =>
    node.parentId !== null && ids.has(node.parentId)
      ? [{
          id: `CONTAINS:${node.parentId}:${node.id}`,
          source: node.parentId,
          target: node.id,
          relationship: 'CONTAINS' as const,
        }]
      : [],
  );
  return {
    response,
    canvas: {
      authorization: 'server-filtered',
      visibleNodeCount: nodes.length,
      nodes,
      edges,
    },
  };
}

export async function fetchOnboardingTree(
  repoId: string,
  refName: string,
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<OnboardingTreePresentation> {
  const response = await (options.fetchImpl ?? coreFetch)(
    `/api/core/repos/${encodeURIComponent(repoId)}/onboarding-tree?ref=${encodeURIComponent(refName)}`,
    {
      method: 'GET',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
      signal: options.signal,
    },
  );
  if (!response.ok) throw requestError(response.status);
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new OnboardingTreeResponseError();
  }
  return toOnboardingTreePresentation(parseOnboardingTreeResponse(value));
}

export async function runOnboardingStep(
  repoId: string,
  refName: string,
  stepId: string,
  fetchImpl: typeof fetch = coreFetch,
): Promise<OnboardingExecutionResponse> {
  const response = await fetchImpl(
    `/api/core/repos/${encodeURIComponent(repoId)}/onboarding-steps/${encodeURIComponent(stepId)}/execute?ref=${encodeURIComponent(refName)}`,
    {
      method: 'POST',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    },
  );
  if (!response.ok && response.status !== 422) throw requestError(response.status);
  const value: unknown = await response.json();
  if (
    !isRecord(value) ||
    value.sandbox !== 'container' ||
    !['succeeded', 'failed', 'timed_out'].includes(String(value.status)) ||
    (value.exitCode !== null && !Number.isSafeInteger(value.exitCode)) ||
    !Number.isSafeInteger(value.durationMs) ||
    (value.durationMs as number) < 0 ||
    !Number.isSafeInteger(value.sequence)
  ) {
    throw new OnboardingTreeResponseError();
  }
  const revisionSha = stringField(value, 'revisionSha');
  if (!/^[a-f0-9]{40,64}$/iu.test(revisionSha)) {
    throw new OnboardingTreeResponseError();
  }
  return {
    sandbox: 'container',
    status: value.status as OnboardingExecutionResponse['status'],
    exitCode: value.exitCode as number | null,
    stdout: stringField(value, 'stdout', true),
    stderr: stringField(value, 'stderr', true),
    durationMs: value.durationMs as number,
    stepId: stringField(value, 'stepId'),
    sequence: value.sequence as number,
    revisionSha,
  };
}
