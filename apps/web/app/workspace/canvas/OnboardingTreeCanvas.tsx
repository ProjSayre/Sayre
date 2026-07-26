'use client';

import { useEffect, useMemo, useState } from 'react';
import type { OnboardingExecutionResponse } from '../../lib/onboardingTree';
import { useMock } from '../state';
import type { CanvasCommand, RendererId } from '../rendererRegistry';
import type {
  GraphEdge,
  GraphNode,
  OnboardingStep,
  OnboardingWorkflow,
} from '../types';
import { TechnicalTreeCanvas } from './TechnicalTreeCanvas';
import { copyText } from '../components/ui';

interface OnboardingTreeCanvasProps {
  graphNodes: GraphNode[];
  graphEdges: GraphEdge[];
  totalNodeCount: number;
  rootLabel: string;
  workflow: OnboardingWorkflow;
  renderer: RendererId;
  command: CanvasCommand | null;
  selectedId: string | null;
  search: string;
  showMinimap: boolean;
  fitKey: string;
  onSelect: (nodeId: string) => void;
}

type StepResult = OnboardingExecutionResponse | { error: string };

const SETUP_LANDMARKS = new Set([
  'readme.md',
  'agents.md',
  'contributing.md',
  'package.json',
  'pnpm-workspace.yaml',
  '.env.example',
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yml',
  'compose.yaml',
]);

function stepGuidance(command: string): {
  purpose: string;
  expected: string;
} {
  const normalized = command.trim().toLowerCase();
  if (
    /^(npm|pnpm|yarn|bun)\s+(install|i)(\s|$)/u.test(normalized)
  ) {
    return {
      purpose: 'Install the dependencies declared by this repository.',
      expected: 'The package manager finishes without dependency errors.',
    };
  }
  if (
    normalized.includes('migrate') ||
    normalized.includes('db:push') ||
    normalized.includes('prisma')
  ) {
    return {
      purpose: 'Prepare the local database schema required by the application.',
      expected: 'Schema or migration checks finish successfully.',
    };
  }
  if (normalized.includes('build')) {
    return {
      purpose: 'Compile the repository and catch production build errors.',
      expected: 'The build exits successfully with no compile failures.',
    };
  }
  if (
    normalized.includes('test') ||
    normalized.includes('check') ||
    normalized.includes('lint')
  ) {
    return {
      purpose: 'Run the repository checks associated with setup.',
      expected: 'The selected checks complete without failures.',
    };
  }
  if (
    normalized.includes(' dev') ||
    normalized.endsWith(' dev') ||
    normalized.includes(' start')
  ) {
    return {
      purpose: 'Start the local development application or services.',
      expected: 'The process starts and reports its local address or readiness.',
    };
  }
  return {
    purpose: 'Run a command inferred as part of this repository setup.',
    expected: 'The command exits successfully; verify its output locally.',
  };
}

function storedResults(revisionSha: string): Record<string, StepResult> {
  if (typeof window === 'undefined') return {};
  try {
    const value: unknown = JSON.parse(
      window.sessionStorage.getItem(
        `sayre:onboarding-results:${revisionSha}`,
      ) ?? '{}',
    );
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, StepResult>)
      : {};
  } catch {
    return {};
  }
}

function messageForExecutionError(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    error.status === 403
  ) {
    return 'Administrator access is required to run setup steps.';
  }
  if (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    error.status === 401
  ) {
    return 'Your session expired. Sign in again before running this step.';
  }
  return 'The sandbox could not run this step. Try again or inspect the service logs.';
}

function resultSummary(result: StepResult): string {
  if ('error' in result) return result.error;
  return [
    `${result.status.replace('_', ' ')} · ${result.durationMs.toLocaleString()} ms`,
    result.stdout,
    result.stderr,
  ]
    .filter((line) => line.length > 0)
    .join('\n');
}

function requirementLabel(
  step: OnboardingStep,
  stepById: ReadonlyMap<string, OnboardingStep>,
): string | null {
  if (step.requires.length === 0) return null;
  const numbers = step.requires
    .map((requiredId) => stepById.get(requiredId)?.sequence)
    .filter((sequence): sequence is number => sequence !== undefined)
    .map((sequence) => sequence + 1);
  if (numbers.length === 0) return null;
  return `Requires ${numbers.length === 1 ? 'step' : 'steps'} ${numbers.join(', ')}`;
}

export function OnboardingTreeCanvas({
  graphNodes,
  graphEdges,
  totalNodeCount,
  rootLabel,
  workflow,
  renderer,
  command,
  selectedId,
  search,
  showMinimap,
  fitKey,
  onSelect,
}: OnboardingTreeCanvasProps) {
  const {
    dispatch,
    isAdmin,
    reloadGraph,
    runOnboardingStep,
    semanticState,
    state,
  } = useMock();
  const [runningStepId, setRunningStepId] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, StepResult>>(() =>
    storedResults(workflow.revisionSha),
  );
  const [copiedStepId, setCopiedStepId] = useState<string | null>(null);
  const [copyFailedStepId, setCopyFailedStepId] = useState<string | null>(
    null,
  );

  useEffect(() => {
    try {
      window.sessionStorage.setItem(
        `sayre:onboarding-results:${workflow.revisionSha}`,
        JSON.stringify(results),
      );
    } catch {
      // Session persistence is a convenience; setup remains usable without it.
    }
  }, [results, workflow.revisionSha]);

  const completed = useMemo(
    () =>
      new Set(
        Object.entries(results)
          .filter(
            (entry): entry is [string, OnboardingExecutionResponse] =>
              !('error' in entry[1]) && entry[1].status === 'succeeded',
          )
          .map(([stepId]) => stepId),
      ),
    [results],
  );
  const stepById = useMemo(
    () => new Map(workflow.steps.map((step) => [step.id, step])),
    [workflow.steps],
  );
  const nextStepId =
    workflow.steps.find(
      (step) =>
        !completed.has(step.id) &&
        step.requires.every((requiredId) => completed.has(requiredId)),
    )?.id ?? null;
  const progress =
    workflow.steps.length === 0
      ? 0
      : Math.round((completed.size / workflow.steps.length) * 100);
  const setupLandmarks = graphNodes.filter(
    (node) =>
      node.kind === 'File' && SETUP_LANDMARKS.has(node.name.toLowerCase()),
  );

  const openTechnicalTree = (): void => {
    dispatch({
      type: 'patch',
      patch: {
        view: 'technical',
        selectedFeatureId: null,
        drawerOpen: state.selectedNodeId !== null,
        search: '',
      },
    });
  };

  return (
    <div className="mock-onboarding-layout">
      <section className="mock-workflow" aria-label="Ordered setup workflow">
        <header className="mock-workflow-header">
          <span className="mock-drawer-kind">guided repository setup</span>
          <div className="mock-workflow-title-row">
            <div>
              <h2>Review setup for {rootLabel}</h2>
              <p>
                Sayre proposes an ordered plan. Review and copy each command;
                prerequisites unlock as earlier checks succeed.
              </p>
            </div>
            {workflow.steps.length > 0 && (
              <strong className="mock-workflow-progress-label">
                {completed.size} of {workflow.steps.length} complete
              </strong>
            )}
          </div>
          {workflow.steps.length > 0 && (
            <div
              className="mock-workflow-progress"
              role="progressbar"
              aria-label="Onboarding setup progress"
              aria-valuemin={0}
              aria-valuemax={workflow.steps.length}
              aria-valuenow={completed.size}
            >
              <span style={{ width: `${progress}%` }} />
            </div>
          )}
          <div className="mock-workflow-safety">
            <span aria-hidden="true">◇</span>
            <p>
              Constrained check: the sandbox has no checkout, network, host
              mounts, or repository secrets. Its result is not proof the
              repository runs; copy commands into your local checkout to finish
              setup.
            </p>
          </div>
          <span className="mock-workflow-revision">
            revision {workflow.revisionSha.slice(0, 10)}
          </span>
        </header>

        {workflow.steps.length === 0 ? (
          <div className="mock-workflow-empty">
            <span className="mock-workflow-empty-mark" aria-hidden="true">
              —
            </span>
            <h3>
              {semanticState.status === 'generating'
                ? 'Setup analysis is still running'
                : semanticState.status === 'failed'
                  ? 'Automated setup plan unavailable'
                  : 'No verified setup steps detected'}
            </h3>
            <p>
              {semanticState.status === 'generating'
                ? 'Repository structure is ready now, but suggested setup steps may still appear.'
                : semanticState.status === 'failed'
                  ? 'Sayre could not generate a plan for this revision. Continue with the repository documentation and structure.'
                  : 'This does not confirm the repository is ready. Start with the repository setup landmarks below and verify the documentation.'}
            </p>
            {setupLandmarks.length > 0 && (
              <div
                className="mock-workflow-landmarks"
                aria-label="Repository setup landmarks"
              >
                <strong>Repository essentials</strong>
                <div>
                  {setupLandmarks.map((landmark) => (
                    <button
                      key={landmark.id}
                      type="button"
                      className="mock-btn mock-btn-ghost mock-btn-sm"
                      onClick={() => onSelect(landmark.id)}
                    >
                      {landmark.name} →
                    </button>
                  ))}
                </div>
              </div>
            )}
            <button
              type="button"
              className="mock-btn mock-btn-secondary"
              onClick={openTechnicalTree}
            >
              Explore the Technical Tree
            </button>
          </div>
        ) : (
          <>
            {!isAdmin && (
              <div className="mock-workflow-member-note" role="note">
                <strong>Run locally</strong>
                You can copy every command into your checkout. Sandbox
                execution is admin-only and is not required to use this plan.
              </div>
            )}
            <ol className="mock-workflow-steps">
            {workflow.steps.map((step) => {
              const blocked = step.requires.some(
                (requiredId) => !completed.has(requiredId),
              );
              const result = results[step.id];
              const running = runningStepId === step.id;
              const succeeded =
                result !== undefined &&
                !('error' in result) &&
                result.status === 'succeeded';
              const failed =
                result !== undefined &&
                ('error' in result || result.status !== 'succeeded');
              const isNext = step.id === nextStepId;
              const requirement = requirementLabel(step, stepById);
              const guidance = stepGuidance(step.command);
              const statusLabel = succeeded
                ? 'Complete'
                : running
                  ? 'Running'
                  : blocked
                    ? 'Locked'
                    : failed
                      ? 'Retry'
                      : isNext
                        ? step.sequence === 0
                          ? 'Start here'
                          : 'Up next'
                        : 'Ready';

              return (
                <li
                  key={step.id}
                  className={[
                    'mock-workflow-step',
                    isNext ? 'mock-workflow-step-next' : '',
                    succeeded ? 'mock-workflow-step-complete' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  aria-current={isNext ? 'step' : undefined}
                >
                  <div className="mock-workflow-step-head">
                    <span aria-hidden="true">
                      {succeeded ? '✓' : step.sequence + 1}
                    </span>
                    <div>
                      <strong>Step {step.sequence + 1}</strong>
                      {requirement !== null && <small>{requirement}</small>}
                    </div>
                    <span
                      className={[
                        'mock-workflow-state',
                        succeeded
                          ? 'mock-workflow-state-complete'
                          : isNext && !failed
                            ? 'mock-workflow-state-next'
                            : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                    >
                      {statusLabel}
                    </span>
                  </div>
                  <code>{step.command}</code>
                  <div className="mock-workflow-guidance">
                    <p>
                      <strong>Why</strong>
                      {guidance.purpose}
                    </p>
                    <p>
                      <strong>Expected</strong>
                      {guidance.expected}
                    </p>
                  </div>
                  <div className="mock-workflow-step-actions">
                    <button
                      type="button"
                      className="mock-btn mock-btn-ghost"
                      onClick={() => {
                        void copyText(step.command).then((copied) => {
                          if (copied) {
                            setCopyFailedStepId(null);
                            setCopiedStepId(step.id);
                            window.setTimeout(
                              () =>
                                setCopiedStepId((current) =>
                                  current === step.id ? null : current,
                                ),
                              1_500,
                            );
                          } else {
                            setCopyFailedStepId(step.id);
                          }
                        });
                      }}
                    >
                      {copiedStepId === step.id
                        ? 'Copied'
                        : copyFailedStepId === step.id
                          ? 'Select command to copy'
                          : 'Copy command'}
                    </button>
                    <button
                      type="button"
                      className={`mock-btn ${
                        isNext && !failed
                          ? 'mock-btn-primary'
                          : 'mock-btn-secondary'
                      }`}
                      disabled={
                        succeeded ||
                        !isAdmin ||
                        blocked ||
                        runningStepId !== null
                      }
                      onClick={() => {
                        setRunningStepId(step.id);
                        void runOnboardingStep(step.id)
                          .then((execution) => {
                            if (execution.revisionSha !== workflow.revisionSha) {
                              setResults((current) => ({
                                ...current,
                                [step.id]: {
                                  error:
                                    'The repository changed while this workflow was open. The tree is refreshing.',
                                },
                              }));
                              reloadGraph();
                              return;
                            }
                            setResults((current) => ({
                              ...current,
                              [step.id]: execution,
                            }));
                          })
                          .catch((error: unknown) => {
                            setResults((current) => ({
                              ...current,
                              [step.id]: {
                                error: messageForExecutionError(error),
                              },
                            }));
                          })
                          .finally(() => setRunningStepId(null));
                      }}
                    >
                      {succeeded
                        ? 'Completed'
                        : !isAdmin
                          ? 'Admin sandbox only'
                          : running
                            ? 'Running in sandbox…'
                            : blocked
                              ? 'Complete prerequisites first'
                              : failed
                                ? 'Retry in sandbox'
                                : 'Run in sandbox'}
                    </button>
                  </div>
                  {result !== undefined && (
                    <pre
                      className={`mock-workflow-result${
                        'error' in result || result.status !== 'succeeded'
                          ? ' mock-workflow-result-error'
                          : ''
                      }`}
                      aria-live="polite"
                    >
                      {resultSummary(result)}
                    </pre>
                  )}
                </li>
              );
            })}
            </ol>
          </>
        )}
      </section>

      <aside
        className="mock-onboarding-context"
        aria-label="Onboarding repository context"
      >
        <header className="mock-onboarding-context-header">
          <div>
            <span className="mock-drawer-kind">repository context</span>
            <h3>{rootLabel}</h3>
            <p>
              Setup landmarks and top-level structure for orientation. Showing{' '}
              {graphNodes.length.toLocaleString()} of{' '}
              {totalNodeCount.toLocaleString()} repository nodes you can view.
            </p>
          </div>
          <button
            type="button"
            className="mock-btn mock-btn-ghost"
            onClick={openTechnicalTree}
          >
            Open Technical Tree →
          </button>
        </header>
        <section
          className="mock-onboarding-graph"
          aria-label="Onboarding repository tree"
        >
          <TechnicalTreeCanvas
            graphNodes={graphNodes}
            graphEdges={graphEdges}
            rootLabel={rootLabel}
            renderer={renderer}
            command={command}
            selectedId={selectedId}
            search={search}
            showMinimap={showMinimap}
            fitKey={fitKey}
            onSelect={onSelect}
          />
        </section>
      </aside>
    </div>
  );
}
