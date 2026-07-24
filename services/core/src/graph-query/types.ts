// Shared types for the Graph Query Service contract (Route -> Service -> Graph Query Service).
// See .claude/rules/service-layer.md and .claude/rules/graph-schema.md.

import type { AuthContext } from '../auth/context';

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

// Folder/File are the only canvas nodes, so only relationships whose endpoints
// are both canvas-renderable can leave this service. CALLS/INHERITS remain
// graph-internal because their endpoints are Function/Class nodes.
export type StructuralEdgeType = 'CONTAINS' | 'IMPORTS';

export interface GraphEdge {
  id: string;
  type: StructuralEdgeType;
  source: string; // GraphNode.id
  target: string; // GraphNode.id
}

// W2-03: affected-nodes result for a realtime `graph.updated` fan-out. Itemized
// removals require an authorization-aware deletion ledger; until one exists the
// implementation returns no removal IDs and the gateway emits graph.resync.
export interface AffectedNodes {
  visible: GraphNode[]; // authorized Folder/File nodes currently present among the given paths
  removed: string[]; // stable node UIDs the caller was authorized to see, now absent
}

// Retrieval uses the same Folder/File authorization boundary as the canvas, but
// also needs immutable repository/ref/revision scope so the worker can constrain
// its tenant chunk read to the graph projection that produced these nodes.
export interface RetrievalGraphNode {
  id: string;
  label: CanvasNodeLabel;
  name: string;
  path: string;
  repositoryId: string;
  refName: string;
  revisionSha: string;
  distance: number;
}

export interface RetrievalTraversal {
  anchor: RetrievalGraphNode;
  nodes: RetrievalGraphNode[];
}

export interface FeatureRecentEdit {
  fileId: string;
  filePath: string;
  editedAt: string;
  editorName: string | null;
  editorLogin: string | null;
  pullRequestTitle: string | null;
  pullRequestUrl: string | null;
}

export interface FeatureMember extends GraphNode {
  label: 'File';
  recentEdit: FeatureRecentEdit | null;
}

/**
 * Feature is graph-internal metadata for a presentation boundary. Only its
 * already-authorized File members may become canvas nodes.
 */
export interface FeatureCluster {
  id: string;
  name: string;
  description: string | null;
  team: string | null;
  revisionSha: string;
  members: FeatureMember[];
}

// Every method receives the complete, server-resolved AuthContext. This keeps
// REST, realtime, and future MCP callers on one authorization path and prevents
// a caller from supplying its own tenant or subject identity.
export interface GraphQueryService {
  getNodesInViewport(
    repoId: string,
    viewport: Viewport,
    ctx: AuthContext,
  ): Promise<GraphNode[]>;
  getStructuralEdges(nodeIds: readonly string[], ctx: AuthContext): Promise<GraphEdge[]>;
  getAffectedNodes(
    repoId: string,
    paths: readonly string[],
    ctx: AuthContext,
  ): Promise<AffectedNodes>;
  getFeatureClusters(
    repoId: string,
    refName: string,
    ctx: AuthContext,
  ): Promise<FeatureCluster[]>;
}

// Kept separate from GraphQueryService so existing canvas/realtime test doubles
// do not need retrieval methods. RbacGraphQueryService implements both, and the
// service-layer functions in services/retrievalContextService depend only on
// this narrow contract.
export interface RetrievalGraphQueryService {
  resolveRetrievalAnchors(
    terms: readonly string[],
    exactNodeId: string | null,
    limit: number,
    ctx: AuthContext,
  ): Promise<RetrievalGraphNode[]>;
  traverseRetrievalContext(
    anchorId: string,
    intentTerms: readonly string[],
    maxHops: number,
    maxNodes: number,
    ctx: AuthContext,
  ): Promise<RetrievalTraversal | null>;
}
