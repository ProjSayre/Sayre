// Shared types for the Graph Query Service contract (Route -> Service -> Graph Query Service).
// See .claude/rules/service-layer.md and .claude/rules/graph-schema.md.

export interface Viewport {
  x: number;
  y: number;
  width: number; // > 0
  height: number; // > 0
  zoom: number; // > 0, defaults to 1 when absent
}

// Only Folder and File are ever canvas-rendered (CLAUDE.md / graph-schema rule).
// Function/Class are graph-internal and never surface through this service.
export type CanvasNodeLabel = 'Folder' | 'File';

export interface GraphNode {
  id: string;
  label: CanvasNodeLabel;
  name: string;
  path: string;
  parentId: string | null;
}

// W0-03 stub only emits CONTAINS. IMPORTS/CALLS/INHERITS arrive with the real
// client in W2-02. Keep the union closed (graph-schema rule: closed edge list).
export type StructuralEdgeType = 'CONTAINS';

export interface GraphEdge {
  id: string;
  type: StructuralEdgeType;
  source: string; // GraphNode.id
  target: string; // GraphNode.id
}

// orgId is a required, server-resolved parameter on every method below. This is
// deliberate: the Graph Query Service is the layer that injects org_id server-side
// and performs RBAC node-stripping (.claude/rules/security-multitenancy.md).
// Modeling it here now means W2-02 does not have to change any caller signature
// when it wires real enforcement in.
export interface GraphQueryService {
  getNodesInViewport(repoId: string, orgId: string, viewport: Viewport): Promise<GraphNode[]>;
  getStructuralEdges(repoId: string, orgId: string, nodes: GraphNode[]): Promise<GraphEdge[]>;
}
