import Graph from 'graphology';

export const SIGMA_NODE_THRESHOLD = 500;

export type CanvasNodeKind = 'Folder' | 'File';
export type GraphRenderer = 'react-flow' | 'sigma';

export interface AuthorizedCanvasNode {
  id: string;
  kind: CanvasNodeKind;
  label: string;
  path: string;
  x: number;
  y: number;
}

export interface AuthorizedCanvasEdge {
  id: string;
  source: string;
  target: string;
  relationship: 'CONTAINS';
}

/**
 * This is the client contract after Graph Query Service authorization. The
 * client may lay out or visually filter these nodes, but it may never use
 * graphology to decide which nodes a user is allowed to receive.
 */
export interface AuthorizedCanvasPayload {
  authorization: 'server-filtered';
  visibleNodeCount: number;
  nodes: AuthorizedCanvasNode[];
  edges: AuthorizedCanvasEdge[];
}

export const GRAPHLOGY_PRESENTATION_ALLOWLIST = [
  'construct graph from server-filtered payload',
  'read and update presentation attributes',
  'extract an induced subgraph from server-supplied node ids',
  'apply client-side layout coordinates',
] as const;

export function rendererForVisibleNodeCount(visibleNodeCount: number): GraphRenderer {
  if (!Number.isSafeInteger(visibleNodeCount) || visibleNodeCount < 0) {
    throw new RangeError('visibleNodeCount must be a non-negative safe integer');
  }
  return visibleNodeCount > SIGMA_NODE_THRESHOLD ? 'sigma' : 'react-flow';
}

export function createScaleFixture(nodeCount = 2_000): AuthorizedCanvasPayload {
  if (!Number.isSafeInteger(nodeCount) || nodeCount < 2) {
    throw new RangeError('scale fixture requires at least two nodes');
  }

  const folderCount = Math.max(1, Math.floor(nodeCount / 10));
  const columns = Math.ceil(Math.sqrt(nodeCount));
  const nodes: AuthorizedCanvasNode[] = [];
  const edges: AuthorizedCanvasEdge[] = [];

  for (let index = 0; index < nodeCount; index += 1) {
    const kind: CanvasNodeKind = index < folderCount ? 'Folder' : 'File';
    const folderIndex = kind === 'Folder' ? index : index % folderCount;
    const id = kind === 'Folder' ? `folder-${index}` : `file-${index - folderCount}`;
    const row = Math.floor(index / columns);
    const column = index % columns;
    const label = kind === 'Folder' ? `package-${index}` : `module-${index - folderCount}.ts`;
    const path =
      index === 0
        ? ''
        : kind === 'Folder'
          ? `packages/package-${index}`
          : `packages/package-${folderIndex}/${label}`;

    nodes.push({
      id,
      kind,
      label: index === 0 ? 'scale-fixture' : label,
      path,
      x: column * 7 + (row % 3) * 0.7,
      y: row * 5 + (column % 5) * 0.18,
    });

    if (index === 0) continue;
    const parent =
      kind === 'Folder'
        ? 'folder-0'
        : `folder-${folderIndex}`;
    edges.push({
      id: `contains-${parent}-${id}`,
      source: parent,
      target: id,
      relationship: 'CONTAINS',
    });
  }

  return {
    authorization: 'server-filtered',
    visibleNodeCount: nodes.length,
    nodes,
    edges,
  };
}

export function toPresentationGraph(payload: AuthorizedCanvasPayload): Graph {
  if (payload.authorization !== 'server-filtered') {
    throw new Error('Sigma accepts only server-filtered canvas payloads');
  }
  if (payload.visibleNodeCount !== payload.nodes.length) {
    throw new Error('visible node-count signal does not match the authorized payload');
  }

  const graph = new Graph({ type: 'directed', multi: false });
  for (const node of payload.nodes) {
    graph.addNode(node.id, {
      x: node.x,
      y: node.y,
      size: node.kind === 'Folder' ? 5 : 2.6,
      color: node.kind === 'Folder' ? '#f7c66c' : '#77a7ff',
      label: node.label,
      kind: node.kind,
      path: node.path,
    });
  }
  for (const edge of payload.edges) {
    if (!graph.hasNode(edge.source) || !graph.hasNode(edge.target)) {
      throw new Error(`edge ${edge.id} references a node outside the authorized payload`);
    }
    graph.addDirectedEdgeWithKey(edge.id, edge.source, edge.target, {
      color: '#303b47',
      size: 0.45,
      relationship: edge.relationship,
    });
  }
  return graph;
}
