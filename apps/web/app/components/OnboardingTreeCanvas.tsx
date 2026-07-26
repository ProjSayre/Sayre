'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
} from '@xyflow/react';
import {
  OnboardingTreeRequestError,
  fetchOnboardingTree,
  runOnboardingStep,
  type OnboardingExecutionResponse,
  type OnboardingTreePresentation,
} from '../lib/onboardingTree';
import { rendererForVisibleNodeCount } from '../lib/scaleGraph';
import { toReactFlowElements } from '../lib/technicalTree';
import { SigmaCanvas } from './SigmaCanvas';

interface OnboardingTreeCanvasProps {
  repoId: string | null;
  refName: string;
}

type CanvasState =
  | { status: 'missing' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; presentation: OnboardingTreePresentation };

function messageForError(error: unknown): string {
  return error instanceof OnboardingTreeRequestError
    ? error.message
    : 'The Onboarding Tree could not be loaded. Try again.';
}

function WorkflowPanel({
  repoId,
  refName,
  presentation,
}: {
  repoId: string;
  refName: string;
  presentation: OnboardingTreePresentation;
}) {
  const [running, setRunning] = useState<string | null>(null);
  const [results, setResults] = useState<
    Record<string, OnboardingExecutionResponse | string>
  >({});
  const completed = new Set(
    Object.entries(results)
      .filter(([, result]) => typeof result !== 'string' && result.status === 'succeeded')
      .map(([stepId]) => stepId),
  );

  return (
    <aside className="onboarding-workflow" aria-label="Ordered setup workflow">
      <header>
        <span className="node-inspector-label">Container-only setup</span>
        <h2>Onboarding workflow</h2>
        <p>No checkout, secret, network, or host path is mounted into a step.</p>
      </header>
      <ol>
        {presentation.response.steps.map((step) => {
          const blocked = step.requires.some((requiredId) => !completed.has(requiredId));
          const result = results[step.id];
          return (
            <li key={step.id}>
              <div className="onboarding-step-heading">
                <span>{step.sequence + 1}</span>
                <strong>Setup step {step.sequence + 1}</strong>
              </div>
              <code>{step.command}</code>
              <button
                type="button"
                disabled={blocked || running !== null}
                onClick={() => {
                  setRunning(step.id);
                  void runOnboardingStep(repoId, refName, step.id)
                    .then((execution) => {
                      setResults((current) => ({
                        ...current,
                        [step.id]: execution,
                      }));
                    })
                    .catch((error: unknown) => {
                      setResults((current) => ({
                        ...current,
                        [step.id]: messageForError(error),
                      }));
                    })
                    .finally(() => setRunning(null));
                }}
              >
                {running === step.id
                  ? 'Running in sandbox…'
                  : blocked
                    ? 'Waiting for prerequisite'
                    : 'Run in sandbox'}
              </button>
              {result !== undefined && (
                <pre
                  className={
                    typeof result === 'string' || result.status !== 'succeeded'
                      ? 'onboarding-result onboarding-result-error'
                      : 'onboarding-result'
                  }
                >
                  {typeof result === 'string'
                    ? result
                    : [
                        `${result.status} · ${result.durationMs}ms`,
                        result.stdout,
                        result.stderr,
                      ].filter(Boolean).join('\n')}
                </pre>
              )}
            </li>
          );
        })}
      </ol>
    </aside>
  );
}

function ReactFlowOnboardingCanvas({
  presentation,
}: {
  presentation: OnboardingTreePresentation;
}) {
  const elements = useMemo(
    () => toReactFlowElements(presentation.canvas),
    [presentation],
  );
  return (
    <ReactFlow
      nodes={elements.nodes}
      edges={elements.edges}
      fitView
      fitViewOptions={{ padding: 0.25 }}
      minZoom={0.25}
      maxZoom={1.8}
      nodesConnectable={false}
      nodesDraggable={false}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="#222b35" />
      <Controls showInteractive={false} position="bottom-left" />
      <MiniMap
        pannable
        zoomable
        maskColor="rgba(5, 8, 12, 0.72)"
        nodeColor={(node) => (node.data.kind === 'Folder' ? '#f7c66c' : '#77a7ff')}
      />
    </ReactFlow>
  );
}

export function OnboardingTreeCanvas({
  repoId,
  refName,
}: OnboardingTreeCanvasProps) {
  const [requestVersion, setRequestVersion] = useState(0);
  const [state, setState] = useState<CanvasState>(
    repoId === null ? { status: 'missing' } : { status: 'loading' },
  );

  useEffect(() => {
    if (repoId === null) {
      setState({ status: 'missing' });
      return undefined;
    }
    let active = true;
    const controller = new AbortController();
    setState({ status: 'loading' });
    void fetchOnboardingTree(repoId, refName, { signal: controller.signal })
      .then((presentation) => {
        if (active) setState({ status: 'ready', presentation });
      })
      .catch((error: unknown) => {
        if (active) setState({ status: 'error', message: messageForError(error) });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [refName, repoId, requestVersion]);

  if (state.status === 'missing') {
    return (
      <div className="graph-canvas graph-canvas-state" role="status">
        <strong>Select a repository</strong>
        <p>Add a registered repository ID with <code>?repoId=&lt;id&gt;</code>.</p>
      </div>
    );
  }
  if (state.status === 'loading') {
    return (
      <div className="graph-canvas graph-canvas-state" role="status" aria-busy="true">
        <strong>Loading Onboarding Tree</strong>
        <p>Requesting the authorized current-head workflow.</p>
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <div className="graph-canvas graph-canvas-state" role="alert">
        <strong>Unable to load Onboarding Tree</strong>
        <p>{state.message}</p>
        <button type="button" onClick={() => setRequestVersion((value) => value + 1)}>
          Try again
        </button>
      </div>
    );
  }

  const renderer = rendererForVisibleNodeCount(
    state.presentation.canvas.visibleNodeCount,
  );
  return (
    <div className="graph-canvas onboarding-tree-canvas">
      <div className="renderer-status">
        {renderer === 'sigma' ? 'Sigma · WebGL' : 'React Flow'} ·{' '}
        {state.presentation.canvas.visibleNodeCount.toLocaleString()} authorized nodes
      </div>
      {renderer === 'sigma' ? (
        <SigmaCanvas payload={state.presentation.canvas} onSelect={() => undefined} />
      ) : (
        <ReactFlowOnboardingCanvas presentation={state.presentation} />
      )}
      <WorkflowPanel
        repoId={repoId as string}
        refName={refName}
        presentation={state.presentation}
      />
    </div>
  );
}
