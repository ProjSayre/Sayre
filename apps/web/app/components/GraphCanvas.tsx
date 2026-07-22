'use client';

import { useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Node,
} from '@xyflow/react';
import { mockEdges, mockNodes, type GraphNodeData } from '../lib/mockGraph';

export function GraphCanvas() {
  const [nodes, , onNodesChange] = useNodesState(mockNodes);
  const [edges, , onEdgesChange] = useEdgesState(mockEdges);
  const [selected, setSelected] = useState<Node<GraphNodeData>>(mockNodes[0]);

  return (
    <div className="graph-canvas" aria-label="Interactive repository graph">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={(_event, node) => setSelected(node)}
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
        <Panel position="top-right">
          <aside className="node-inspector" aria-live="polite">
            <span className="node-inspector-label">Selected {selected.data.kind}</span>
            <h3>{selected.data.label}</h3>
            <p title={selected.data.path}>{selected.data.path || '/'}</p>
          </aside>
        </Panel>
      </ReactFlow>
    </div>
  );
}
