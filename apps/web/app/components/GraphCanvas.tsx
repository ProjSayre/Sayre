'use client';

import { useCallback, useMemo, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  useEdgesState,
  useNodesState,
} from '@xyflow/react';
import { mockEdges, mockNodes } from '../lib/mockGraph';
import {
  createScaleFixture,
  rendererForVisibleNodeCount,
  type AuthorizedCanvasNode,
} from '../lib/scaleGraph';
import { SigmaCanvas } from './SigmaCanvas';
import { ProviderStateStatus } from './ProviderStateBanner';
import type { ProviderStateSelection } from '../lib/providerState';

interface SelectedNode {
  kind: 'Folder' | 'File';
  label: string;
  path: string;
}

interface ReactFlowCanvasProps {
  onSelect: (node: SelectedNode) => void;
}

function ReactFlowCanvas({ onSelect }: ReactFlowCanvasProps) {
  const [nodes, , onNodesChange] = useNodesState(mockNodes);
  const [edges, , onEdgesChange] = useEdgesState(mockEdges);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeClick={(_event, node) => onSelect(node.data)}
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
        nodeColor={(node) => (node.data.kind === 'Folder' ? '#f7c66c' : '#77a7ff')}
      />
    </ReactFlow>
  );
}

export function GraphCanvas({
  selection,
}: {
  selection: ProviderStateSelection | null;
}) {
  const [fixture, setFixture] = useState<'small' | 'scale'>('small');
  const [selected, setSelected] = useState<SelectedNode>(mockNodes[0].data);
  const scalePayload = useMemo(() => createScaleFixture(), []);
  const visibleNodeCount = fixture === 'scale' ? scalePayload.visibleNodeCount : mockNodes.length;
  const renderer = rendererForVisibleNodeCount(visibleNodeCount);
  const selectScaleNode = useCallback(
    (node: AuthorizedCanvasNode) => setSelected(node),
    [],
  );

  return (
    <div className="graph-canvas" aria-label="Interactive repository graph">
      <ProviderStateStatus selection={selection} />
      <div className="renderer-switcher" aria-label="Graph scale fixture">
        <div className="renderer-switcher-buttons">
          <button
            type="button"
            className={fixture === 'small' ? 'active' : ''}
            aria-pressed={fixture === 'small'}
            onClick={() => {
              setFixture('small');
              setSelected(mockNodes[0].data);
            }}
          >
            20 nodes
          </button>
          <button
            type="button"
            className={fixture === 'scale' ? 'active' : ''}
            aria-pressed={fixture === 'scale'}
            onClick={() => {
              setFixture('scale');
              setSelected(scalePayload.nodes[0]);
            }}
          >
            2,000 nodes
          </button>
        </div>
        <span>
          {renderer === 'sigma' ? 'Sigma · WebGL' : 'React Flow'} ·{' '}
          {visibleNodeCount.toLocaleString()} authorized nodes
        </span>
      </div>

      {renderer === 'sigma' ? (
        <SigmaCanvas payload={scalePayload} onSelect={selectScaleNode} />
      ) : (
        <ReactFlowCanvas onSelect={setSelected} />
      )}

      <aside className="node-inspector canvas-node-inspector" aria-live="polite">
        <span className="node-inspector-label">Selected {selected.kind}</span>
        <h3>{selected.label}</h3>
        <p title={selected.path}>{selected.path || '/'}</p>
      </aside>
    </div>
  );
}
