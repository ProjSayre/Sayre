'use client';

import { useMemo, useState } from 'react';
import type { OnboardingExecutionResponse } from '../../lib/onboardingTree';
import { useMock } from '../state';
import type { CanvasCommand, RendererId } from '../rendererRegistry';
import type { GraphEdge, GraphNode, OnboardingWorkflow } from '../types';
import { TechnicalTreeCanvas } from './TechnicalTreeCanvas';

interface OnboardingTreeCanvasProps {
  graphNodes: GraphNode[];
  graphEdges: GraphEdge[];
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

export function OnboardingTreeCanvas({
  graphNodes,
  graphEdges,
  workflow,
  renderer,
  command,
  selectedId,
  search,
  showMinimap,
  fitKey,
  onSelect,
}: OnboardingTreeCanvasProps) {
  const { isAdmin, reloadGraph, runOnboardingStep } = useMock();
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

  return (
    <div className="mock-onboarding-layout">
      <section className="mock-onboarding-graph" aria-label="Onboarding repository tree">
        <TechnicalTreeCanvas
          graphNodes={graphNodes}
          graphEdges={graphEdges}
          renderer={renderer}
          command={command}
          selectedId={selectedId}
          search={search}
          showMinimap={showMinimap}
          fitKey={fitKey}
          onSelect={onSelect}
        />
      </section>

      <aside className="mock-workflow" aria-label="Ordered setup workflow">
        <header className="mock-workflow-header">
          <span className="mock-drawer-kind">container-only setup</span>
          <h2>Onboarding workflow</h2>
          <p>
            Commands run in a disposable, networkless container without host
            mounts or repository secrets.
          </p>
          <span className="mock-workflow-revision">
            revision {workflow.revisionSha.slice(0, 10)}
          </span>
        </header>

        {workflow.steps.length === 0 ? (
          <p className="mock-workflow-empty">
            No setup steps were inferred for this repository revision.
          </p>
        ) : (
          <ol className="mock-workflow-steps">
            {workflow.steps.map((step) => {
              const blocked = step.requires.some(
                (requiredId) => !completed.has(requiredId),
              );
              const result = results[step.id];
              const running = runningStepId === step.id;
              return (
                <li key={step.id} className="mock-workflow-step">
                  <div className="mock-workflow-step-head">
                    <span>{step.sequence + 1}</span>
                    <strong>Setup step {step.sequence + 1}</strong>
                    {result !== undefined && !('error' in result) && (
                      <span
                        className={`mock-workflow-outcome mock-workflow-${result.status}`}
                      >
                        {result.status.replace('_', ' ')}
                      </span>
                    )}
                  </div>
                  <code>{step.command}</code>
                  <button
                    type="button"
                    className="mock-btn mock-btn-secondary mock-btn-sm"
                    disabled={!isAdmin || blocked || runningStepId !== null}
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
                    {!isAdmin
                      ? 'Admin access required'
                      : running
                        ? 'Running in sandbox…'
                        : blocked
                          ? 'Waiting for prerequisite'
                          : 'Run in sandbox'}
                  </button>
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
      </aside>
    </div>
  );
}
