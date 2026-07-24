'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ViewportPortal,
} from '@xyflow/react';
import {
  ProductTreeRequestError,
  fetchProductTree,
  selectedFeaturePanel,
  toProductTreeReactFlowNodes,
  type ProductTreeBoundary,
  type ProductTreePresentation,
  type ProductTreeRecentEdit,
} from '../lib/productTree';
import { rendererForVisibleNodeCount } from '../lib/scaleGraph';
import { SigmaCanvas } from './SigmaCanvas';

interface ProductTreeCanvasProps {
  repoId: string | null;
  refName: string;
}

type CanvasState =
  | { status: 'missing' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; presentation: ProductTreePresentation };

function messageForError(error: unknown): string {
  if (error instanceof ProductTreeRequestError) return error.message;
  return 'The Product Tree could not be loaded. Try again.';
}

function CanvasMessage({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="graph-canvas-state" role="status">
      <strong>{title}</strong>
      <p>{children}</p>
    </div>
  );
}

function activateBoundary(
  event: React.KeyboardEvent<SVGGElement>,
  boundaryId: string,
  onSelect: (boundaryId: string) => void,
): void {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  onSelect(boundaryId);
}

function FeatureBoundaries({
  boundaries,
  onSelect,
}: {
  boundaries: ProductTreeBoundary[];
  onSelect: (boundaryId: string) => void;
}) {
  return (
    <ViewportPortal>
      {boundaries.map((boundary) => (
        <div
          className="react-flow-feature-boundary"
          key={boundary.id}
          style={{
            transform: `translate(${boundary.x}px, ${boundary.y}px)`,
            width: boundary.width,
            height: boundary.height,
          }}
        >
          <svg width={boundary.width} height={boundary.height}>
            <g
              role="button"
              tabIndex={0}
              aria-label={`Open ${boundary.label} feature details`}
              onClick={(event) => {
                event.stopPropagation();
                onSelect(boundary.id);
              }}
              onKeyDown={(event) => activateBoundary(event, boundary.id, onSelect)}
            >
              <rect
                className="feature-boundary-visible"
                x={1}
                y={1}
                width={boundary.width - 2}
                height={boundary.height - 2}
                rx={18}
              />
              <rect
                className="feature-boundary-hit"
                x={1}
                y={1}
                width={boundary.width - 2}
                height={boundary.height - 2}
                rx={18}
              />
              <text className="feature-boundary-label" x={14} y={22}>
                {boundary.label}
              </text>
            </g>
          </svg>
        </div>
      ))}
    </ViewportPortal>
  );
}

function ReactFlowProductCanvas({
  presentation,
  onSelectFeature,
}: {
  presentation: ProductTreePresentation;
  onSelectFeature: (featureId: string) => void;
}) {
  const nodes = useMemo(
    () => toProductTreeReactFlowNodes(presentation.canvas),
    [presentation],
  );
  const featureForNode = useMemo(() => {
    const result = new Map<string, string>();
    for (const boundary of presentation.boundaries) {
      for (const memberId of boundary.memberIds) {
        if (!result.has(memberId)) result.set(memberId, boundary.id);
      }
    }
    return result;
  }, [presentation.boundaries]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={[]}
      onNodeClick={(_event, node) => {
        const featureId = featureForNode.get(node.id);
        if (featureId !== undefined) onSelectFeature(featureId);
      }}
      fitView
      fitViewOptions={{ padding: 0.25 }}
      minZoom={0.25}
      maxZoom={1.8}
      nodesConnectable={false}
      nodesDraggable={false}
      elementsSelectable
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="#222b35" />
      <Controls showInteractive={false} position="bottom-left" />
      <MiniMap
        pannable
        zoomable
        position="bottom-right"
        maskColor="rgba(5, 8, 12, 0.72)"
        nodeColor={(node) => (node.data.kind === 'Folder' ? '#f7c66c' : '#77a7ff')}
      />
      <FeatureBoundaries
        boundaries={presentation.boundaries}
        onSelect={onSelectFeature}
      />
    </ReactFlow>
  );
}

function editorLabel(edit: ProductTreeRecentEdit): string {
  if (edit.editorName !== null) return edit.editorName;
  if (edit.editorLogin !== null) return `@${edit.editorLogin}`;
  return 'Unknown editor';
}

function ProductFeaturePanel({
  presentation,
  selectedFeatureId,
}: {
  presentation: ProductTreePresentation;
  selectedFeatureId: string | null;
}) {
  const feature = selectedFeaturePanel(
    presentation.response,
    selectedFeatureId,
  );
  if (feature === null) {
    return (
      <aside className="product-feature-panel product-feature-panel-empty">
        <span className="node-inspector-label">Feature details</span>
        <h3>Select a dashed boundary</h3>
        <p>The boundary panel shows only server-authorized graph metadata.</p>
      </aside>
    );
  }

  return (
    <aside
      className="product-feature-panel"
      aria-live="polite"
      aria-label={`${feature.name} feature metadata`}
    >
      <span className="node-inspector-label">Feature cluster</span>
      <h3>{feature.name}</h3>
      <dl>
        <div>
          <dt>Description</dt>
          <dd>{feature.description ?? 'Not available'}</dd>
        </div>
        <div>
          <dt>Team</dt>
          <dd>{feature.team ?? 'Not available'}</dd>
        </div>
        <div>
          <dt>Files Included</dt>
          <dd>
            <ul>
              {feature.filesIncluded.map((file) => (
                <li key={file.id} title={file.path}>
                  <strong>{file.name}</strong>
                  <span>{file.path}</span>
                </li>
              ))}
            </ul>
          </dd>
        </div>
        <div>
          <dt>Recent Edits</dt>
          <dd>
            {feature.recentEdits.length === 0 ? (
              'No recent edits available'
            ) : (
              <ul>
                {feature.recentEdits.map((edit) => (
                  <li key={`${edit.fileId}:${edit.editedAt}`}>
                    <strong>{edit.filePath}</strong>
                    <span>
                      {editorLabel(edit)} ·{' '}
                      <time dateTime={edit.editedAt}>
                        {new Date(edit.editedAt).toLocaleString()}
                      </time>
                    </span>
                    {edit.pullRequestTitle !== null && (
                      <span>{edit.pullRequestTitle}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </div>
      </dl>
    </aside>
  );
}

export function ProductTreeCanvas({
  repoId,
  refName,
}: ProductTreeCanvasProps) {
  const [requestVersion, setRequestVersion] = useState(0);
  const [selectedFeatureId, setSelectedFeatureId] = useState<string | null>(null);
  const [state, setState] = useState<CanvasState>(
    repoId === null ? { status: 'missing' } : { status: 'loading' },
  );

  useEffect(() => {
    setSelectedFeatureId(null);
    if (repoId === null) {
      setState({ status: 'missing' });
      return undefined;
    }

    let active = true;
    const controller = new AbortController();
    setState({ status: 'loading' });
    void fetchProductTree(repoId, refName, { signal: controller.signal })
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
      <div className="graph-canvas" aria-label="Product Tree repository graph">
        <CanvasMessage title="Select a repository">
          Add a registered repository ID with <code>?repoId=&lt;id&gt;</code>.
        </CanvasMessage>
      </div>
    );
  }
  if (state.status === 'loading') {
    return (
      <div
        className="graph-canvas"
        aria-label="Product Tree repository graph"
        aria-busy="true"
      >
        <CanvasMessage title="Loading Product Tree">
          Requesting the authorized current-head Feature projection.
        </CanvasMessage>
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <div className="graph-canvas" aria-label="Product Tree repository graph">
        <div className="graph-canvas-state" role="alert">
          <strong>Unable to load Product Tree</strong>
          <p>{state.message}</p>
          <button
            type="button"
            onClick={() => setRequestVersion((version) => version + 1)}
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  const { presentation } = state;
  if (presentation.response.features.length === 0) {
    return (
      <div className="graph-canvas" aria-label="Product Tree repository graph">
        <CanvasMessage title="No current Feature clusters">
          No authorized W3-01 Feature projection is available for this ref yet.
        </CanvasMessage>
      </div>
    );
  }

  const renderer = rendererForVisibleNodeCount(
    presentation.canvas.visibleNodeCount,
  );
  const featureForNode = new Map<string, string>();
  for (const boundary of presentation.boundaries) {
    for (const memberId of boundary.memberIds) {
      if (!featureForNode.has(memberId)) {
        featureForNode.set(memberId, boundary.id);
      }
    }
  }

  return (
    <div
      className="graph-canvas product-tree-canvas"
      aria-label="Interactive Product Tree repository graph"
    >
      <div className="renderer-status" aria-label="Product Tree renderer">
        {renderer === 'sigma' ? 'Sigma · WebGL' : 'React Flow'} ·{' '}
        {presentation.canvas.visibleNodeCount.toLocaleString()} authorized nodes
      </div>

      {renderer === 'sigma' ? (
        <SigmaCanvas
          payload={presentation.canvas}
          boundaries={presentation.boundaries}
          onSelectBoundary={setSelectedFeatureId}
          onSelect={(node) => {
            const featureId = featureForNode.get(node.id);
            if (featureId !== undefined) setSelectedFeatureId(featureId);
          }}
        />
      ) : (
        <ReactFlowProductCanvas
          presentation={presentation}
          onSelectFeature={setSelectedFeatureId}
        />
      )}

      <ProductFeaturePanel
        presentation={presentation}
        selectedFeatureId={selectedFeatureId}
      />
    </div>
  );
}
