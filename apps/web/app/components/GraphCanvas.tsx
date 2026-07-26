'use client';

import { useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  useEdgesState,
  useNodesState,
} from '@xyflow/react';
import {
  rendererForVisibleNodeCount,
  coverageColor,
  type AuthorizedCanvasNode,
  type AuthorizedCanvasPayload,
} from '../lib/scaleGraph';
import {
  TechnicalTreeRequestError,
  fetchTechnicalTree,
  toReactFlowElements,
  type GraphNodeData,
} from '../lib/technicalTree';
import { ProviderStateStatus } from './ProviderStateBanner';
import type { ProviderStateSelection } from '../lib/providerState';
import { NodeOverlayPanel } from './NodeOverlayPanel';

// `sigma` touches WebGL2RenderingContext at module-load time, which doesn't
// exist during Next.js SSR. ssr: false keeps that import out of the server
// bundle entirely instead of merely deferring its use.
const SigmaCanvas = dynamic(() => import('./SigmaCanvas').then((m) => m.SigmaCanvas), {
  ssr: false,
});

interface GraphCanvasProps {
  repoId: string | null;
  providerStateSelection: ProviderStateSelection | null;
}

interface ReactFlowCanvasProps {
  payload: AuthorizedCanvasPayload;
  onSelect: (nodeId: string) => void;
}

type CanvasState =
  | { status: 'missing' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; payload: AuthorizedCanvasPayload };

function ReactFlowCanvas({ payload, onSelect }: ReactFlowCanvasProps) {
  const elements = useMemo(() => toReactFlowElements(payload), [payload]);
  const [nodes, setNodes, onNodesChange] = useNodesState(elements.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(elements.edges);

  useEffect(() => {
    setNodes(elements.nodes);
    setEdges(elements.edges);
  }, [elements, setEdges, setNodes]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeClick={(_event, node) => onSelect(node.id)}
      fitView
      fitViewOptions={{ padding: 0.22 }}
      minZoom={0.35}
      maxZoom={1.8}
      nodesConnectable={false}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="#222b35" />
      <Controls showInteractive={false} position="bottom-left" />
      <MiniMap
        pannable
        zoomable
        position="bottom-right"
        maskColor="rgba(5, 8, 12, 0.72)"
        nodeColor={(node) =>
          node.data.kind === 'Folder'
            ? '#f7c66c'
            : coverageColor((node.data as GraphNodeData).coverage?.status)
        }
      />
    </ReactFlow>
  );
}

function messageForError(error: unknown): string {
  if (error instanceof TechnicalTreeRequestError) return error.message;
  return 'The Technical Tree could not be loaded. Try again.';
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

function selectedNode(
  payload: AuthorizedCanvasPayload,
  selectedId: string | null,
): AuthorizedCanvasNode {
  return payload.nodes.find((node) => node.id === selectedId) ?? payload.nodes[0];
}

export function GraphCanvas({
  repoId,
  providerStateSelection,
}: GraphCanvasProps) {
  const [requestVersion, setRequestVersion] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [state, setState] = useState<CanvasState>(
    repoId === null ? { status: 'missing' } : { status: 'loading' },
  );

  useEffect(() => {
    setSelectedId(null);
    if (repoId === null) {
      setState({ status: 'missing' });
      return undefined;
    }

    let active = true;
    const controller = new AbortController();
    setState({ status: 'loading' });
    void fetchTechnicalTree(repoId, { signal: controller.signal })
      .then((payload) => {
        if (active) setState({ status: 'ready', payload });
      })
      .catch((error: unknown) => {
        if (active) setState({ status: 'error', message: messageForError(error) });
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [repoId, requestVersion]);

  if (state.status === 'missing') {
    return (
      <div className="graph-canvas" aria-label="Technical Tree repository graph">
        <ProviderStateStatus selection={providerStateSelection} />
        <CanvasMessage title="Select a repository">
          Add a registered repository ID with <code>?repoId=&lt;id&gt;</code>.
        </CanvasMessage>
      </div>
    );
  }

  if (state.status === 'loading') {
    return (
      <div className="graph-canvas" aria-label="Technical Tree repository graph" aria-busy="true">
        <ProviderStateStatus selection={providerStateSelection} />
        <CanvasMessage title="Loading Technical Tree">
          Requesting the authorized repository projection.
        </CanvasMessage>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="graph-canvas" aria-label="Technical Tree repository graph">
        <ProviderStateStatus selection={providerStateSelection} />
        <div className="graph-canvas-state" role="alert">
          <strong>Unable to load Technical Tree</strong>
          <p>{state.message}</p>
          <button type="button" onClick={() => setRequestVersion((version) => version + 1)}>
            Try again
          </button>
        </div>
      </div>
    );
  }

  const { payload } = state;
  if (payload.nodes.length === 0) {
    return (
      <div className="graph-canvas" aria-label="Technical Tree repository graph">
        <ProviderStateStatus selection={providerStateSelection} />
        <CanvasMessage title="No structural nodes yet">
          The repository is authorized, but its full parse has not produced Folder/File nodes.
        </CanvasMessage>
      </div>
    );
  }

  const renderer = rendererForVisibleNodeCount(payload.visibleNodeCount);
  const selected = selectedNode(payload, selectedId);
  return (
    <div className="graph-canvas" aria-label="Interactive Technical Tree repository graph">
      <ProviderStateStatus selection={providerStateSelection} />
      <div className="renderer-status" aria-label="Technical Tree renderer">
        {renderer === 'sigma' ? 'Sigma · WebGL' : 'React Flow'} ·{' '}
        {payload.visibleNodeCount.toLocaleString()} authorized nodes
      </div>

      {renderer === 'sigma' ? (
        <SigmaCanvas payload={payload} onSelect={(node) => setSelectedId(node.id)} />
      ) : (
        <ReactFlowCanvas payload={payload} onSelect={setSelectedId} />
      )}

      {selected.kind === 'File' && selected.coverage !== undefined && (
        <div
          className={`coverage-summary coverage-summary-${selected.coverage.status}`}
          aria-label={`Coverage ${selected.coverage.status}`}
        >
          <strong>{selected.coverage.status}</strong>
          <span>
            {selected.coverage.coveringTests.toLocaleString()}{' '}
            {selected.coverage.coveringTests === 1 ? 'test' : 'tests'}
            {selected.coverage.lastRun === null
              ? ' · never measured'
              : ` · ${new Date(selected.coverage.lastRun).toLocaleString()}`}
          </span>
        </div>
      )}
      <NodeOverlayPanel nodeId={selected.id} />
    </div>
  );
}
