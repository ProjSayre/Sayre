// STUB — replaced by W2-02, no Neo4j driver here.
//
// This is a fixture-returning placeholder for the real Graph Query Service.
// W2-02 replaces the implementation below with an openCypher client against
// Neo4j (see docs/architecture.md and Open Question 4 in .pipeline/spec.md
// for W0-03: Node core owns runtime graph queries). Until then this module
// deliberately ignores `viewport`/`repoId`/`orgId` for filtering/RBAC purposes
// (that is W2-02's job) but the parameters exist on the interface today so
// callers never have to change when the real client lands.
//
// Do not import `neo4j-driver` (or any other data client) into this file.

import type { AffectedNodes, GraphEdge, GraphNode, GraphQueryService, Viewport } from './types';

export * from './types';

const ROOT_FOLDER: GraphNode = {
  id: 'folder-root',
  label: 'Folder',
  name: 'src',
  path: '/src',
  parentId: null,
};

const CHILD_FILES: GraphNode[] = [
  {
    id: 'file-index',
    label: 'File',
    name: 'index.ts',
    path: '/src/index.ts',
    parentId: ROOT_FOLDER.id,
  },
  {
    id: 'file-app',
    label: 'File',
    name: 'app.ts',
    path: '/src/app.ts',
    parentId: ROOT_FOLDER.id,
  },
];

const FIXTURE_NODES: GraphNode[] = [ROOT_FOLDER, ...CHILD_FILES];

// Fixture stub ignores repoId/orgId/viewport (real filtering is W2-02); the
// params exist so callers don't have to change when the real client lands.
/* eslint-disable @typescript-eslint/no-unused-vars */
async function getNodesInViewport(
  _repoId: string,
  _orgId: string,
  _viewport: Viewport,
): Promise<GraphNode[]> {
  return FIXTURE_NODES;
}
/* eslint-enable @typescript-eslint/no-unused-vars */

async function getStructuralEdges(
  _repoId: string,
  _orgId: string,
  nodes: GraphNode[],
): Promise<GraphEdge[]> {
  const idsInScope = new Set(nodes.map((node) => node.id));
  return nodes
    .filter((node) => node.parentId !== null && idsInScope.has(node.parentId))
    .map((node) => ({
      id: `edge-${node.parentId}-${node.id}`,
      type: 'CONTAINS' as const,
      source: node.parentId as string,
      target: node.id,
    }));
}

// Fixture stub ignores repoId/orgId (real RBAC filtering is W2-02). Deterministic:
// a `path` with a matching fixture node is "visible"; a `path` with no matching
// fixture node is reported in `removed` (using the path itself as a placeholder
// identifier -- the stub has no deletion history to resolve a real stable node
// UID; see the AffectedNodes doc comment in ./types.ts).
async function getAffectedNodes(
  _repoId: string,
  _orgId: string,
  paths: string[],
): Promise<AffectedNodes> {
  const byPath = new Map(FIXTURE_NODES.map((node) => [node.path, node] as const));
  const visible: GraphNode[] = [];
  const removed: string[] = [];
  for (const path of paths) {
    const node = byPath.get(path);
    if (node) {
      visible.push(node);
    } else {
      removed.push(path);
    }
  }
  return { visible, removed };
}

export const graphQueryService: GraphQueryService = {
  getNodesInViewport,
  getStructuralEdges,
  getAffectedNodes,
};
