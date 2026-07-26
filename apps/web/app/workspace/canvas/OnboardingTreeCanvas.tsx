'use client';

import { useMemo, useState } from 'react';
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
  const { dispatch, isAdmin, reloadGraph, runOnboardingStep } = useMock();
  const [runningStepId, setRunningStepId] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, StepResult>>({});

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

  const openTechnicalTree = (): void => {
    dispatch({
      type: 'patch',
      patch: {
        view: 'technical',
        selectedFeatureId: null,
        drawerOpen: false,
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
              <h2>Get {rootLabel} running</h2>
              <p>
                Follow the generated setup plan in order. Sayre unlocks each
                command when its prerequisites succeed.
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
              Safe to try: commands run in a disposable, networkless container
              with no host mounts or repository secrets.
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
            <h3>No setup plan for this revision</h3>
            <p>
              Nothing is waiting on you. Sayre did not infer any safe setup
              commands for this repository revision.
            </p>
            <button
              type="button"
              className="mock-btn mock-btn-secondary"
              onClick={openTechnicalTree}
            >
              Explore the Technical Tree
            </button>
          </div>
        ) : (
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
                  <div className="mock-workflow-step-actions">
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
                          ? 'Admin access required'
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
              Compact top-down structure used to orient this setup plan.
              Showing {graphNodes.length.toLocaleString()} of{' '}
              {totalNodeCount.toLocaleString()} authorized nodes.
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
