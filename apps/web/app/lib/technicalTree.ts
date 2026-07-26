import {
  MarkerType,
  Position,
  type Edge,
  type Node,
} from '@xyflow/react';
import type {
  AuthorizedCanvasEdge,
  AuthorizedCanvasNode,
  AuthorizedCanvasPayload,
} from './scaleGraph';
import { coreFetch } from './coreFetch';

export interface Viewport {
  x: number;
  y: number;
  width: number;
  height: number;
  zoom: number;
}

export interface TechnicalTreeNode {
  id: string;
  label: 'Folder' | 'File';
  name: string;
  path: string;
  parentId: string | null;
}

export interface TechnicalTreeEdge {
  id: string;
  type: 'CONTAINS' | 'IMPORTS';
  source: string;
  target: string;
}

export interface TechnicalTreeResponse {
  authorization: 'server-filtered';
  visibleNodeCount: number;
  nodes: TechnicalTreeNode[];
  edges: TechnicalTreeEdge[];
}

export interface GraphNodeData extends Record<string, unknown> {
  label: string;
  kind: 'Folder' | 'File';
  path: string;
}

export interface FetchTechnicalTreeOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  viewport?: Viewport;
}

export class TechnicalTreeResponseError extends Error {
  constructor(message = 'The Technical Tree response is invalid.') {
    super(message);
    this.name = 'TechnicalTreeResponseError';
  }
}

export class TechnicalTreeRequestError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = 'TechnicalTreeRequestError';
  }
}

export const DEFAULT_TECHNICAL_TREE_VIEWPORT: Viewport = {
  x: -1_000_000,
  y: -1_000_000,
  width: 2_000_000,
  height: 2_000_000,
  zoom: 1,
};

export function normalizeRepositoryIdParam(
  value: string | string[] | undefined,
): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(
  record: Record<string, unknown>,
  field: string,
  options: { allowEmpty?: boolean } = {},
): string {
  const value = record[field];
  if (
    typeof value !== 'string' ||
    (!options.allowEmpty && value.trim().length === 0)
  ) {
    throw new TechnicalTreeResponseError();
  }
  return value;
}

function parseNode(value: unknown): TechnicalTreeNode {
  if (!isRecord(value)) throw new TechnicalTreeResponseError();
  const label = value.label;
  if (label !== 'Folder' && label !== 'File') {
    throw new TechnicalTreeResponseError();
  }

  const parentId = value.parentId;
  if (parentId !== null && (typeof parentId !== 'string' || parentId.trim().length === 0)) {
    throw new TechnicalTreeResponseError();
  }

  return {
    id: requireString(value, 'id'),
    label,
    name: requireString(value, 'name'),
    path: requireString(value, 'path', { allowEmpty: true }),
    parentId,
  };
}

function parseEdge(value: unknown): TechnicalTreeEdge {
  if (!isRecord(value)) throw new TechnicalTreeResponseError();
  const type = value.type;
  if (type !== 'CONTAINS' && type !== 'IMPORTS') {
    throw new TechnicalTreeResponseError();
  }

  return {
    id: requireString(value, 'id'),
    type,
    source: requireString(value, 'source'),
    target: requireString(value, 'target'),
  };
}

function assertUniqueIds(values: readonly { id: string }[]): void {
  if (new Set(values.map(({ id }) => id)).size !== values.length) {
    throw new TechnicalTreeResponseError();
  }
}

export function parseTechnicalTreeResponse(value: unknown): TechnicalTreeResponse {
  if (
    !isRecord(value) ||
    value.authorization !== 'server-filtered' ||
    !Number.isSafeInteger(value.visibleNodeCount) ||
    (value.visibleNodeCount as number) < 0 ||
    !Array.isArray(value.nodes) ||
    !Array.isArray(value.edges)
  ) {
    throw new TechnicalTreeResponseError();
  }

  const nodes = value.nodes.map(parseNode);
  const edges = value.edges.map(parseEdge);
  assertUniqueIds(nodes);
  assertUniqueIds(edges);

  if (value.visibleNodeCount !== nodes.length) {
    throw new TechnicalTreeResponseError();
  }

  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  for (const edge of edges) {
    const source = nodesById.get(edge.source);
    const target = nodesById.get(edge.target);
    if (!source || !target) throw new TechnicalTreeResponseError();
    if (edge.type === 'CONTAINS' && source.label !== 'Folder') {
      throw new TechnicalTreeResponseError();
    }
    if (edge.type === 'IMPORTS' && (source.label !== 'File' || target.label !== 'File')) {
      throw new TechnicalTreeResponseError();
    }
  }

  return {
    authorization: 'server-filtered',
    visibleNodeCount: value.visibleNodeCount as number,
    nodes,
    edges,
  };
}

function pathDepth(path: string): number {
  return path.split('/').filter(Boolean).length;
}

function layoutNodes(nodes: readonly TechnicalTreeNode[]): AuthorizedCanvasNode[] {
  const rowsByDepth = new Map<number, TechnicalTreeNode[]>();
  for (const node of nodes) {
    const depth = pathDepth(node.path);
    const row = rowsByDepth.get(depth) ?? [];
    row.push(node);
    rowsByDepth.set(depth, row);
  }

  const positioned: AuthorizedCanvasNode[] = [];
  for (const [depth, row] of [...rowsByDepth.entries()].sort(([a], [b]) => a - b)) {
    row.sort((a, b) => a.path.localeCompare(b.path) || a.id.localeCompare(b.id));
    const center = (row.length - 1) / 2;
    row.forEach((node, index) => {
      positioned.push({
        id: node.id,
        kind: node.label,
        label: node.name,
        path: node.path,
        x: depth * 260,
        y: (index - center) * 92,
      });
    });
  }
  return positioned;
}

export function toAuthorizedCanvasPayload(
  response: TechnicalTreeResponse,
): AuthorizedCanvasPayload {
  const edges: AuthorizedCanvasEdge[] = response.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    relationship: edge.type,
  }));

  return {
    authorization: 'server-filtered',
    visibleNodeCount: response.visibleNodeCount,
    nodes: layoutNodes(response.nodes),
    edges,
  };
}

function assertViewport(viewport: Viewport): void {
  if (
    ![
      viewport.x,
      viewport.y,
      viewport.width,
      viewport.height,
      viewport.zoom,
    ].every(Number.isFinite) ||
    viewport.width <= 0 ||
    viewport.height <= 0 ||
    viewport.zoom <= 0
  ) {
    throw new RangeError('Viewport must have finite coordinates and positive dimensions.');
  }
}

function requestError(status: number): TechnicalTreeRequestError {
  if (status === 401) {
    return new TechnicalTreeRequestError('Sign in to view this repository.', status);
  }
  if (status === 403) {
    return new TechnicalTreeRequestError(
      'You do not have access to this repository.',
      status,
    );
  }
  return new TechnicalTreeRequestError('The Technical Tree could not be loaded.', status);
}

export async function fetchTechnicalTree(
  repoId: string,
  options: FetchTechnicalTreeOptions = {},
): Promise<AuthorizedCanvasPayload> {
  const normalizedRepoId = repoId.trim();
  if (normalizedRepoId.length === 0) {
    throw new RangeError('A repository ID is required.');
  }

  const viewport = options.viewport ?? DEFAULT_TECHNICAL_TREE_VIEWPORT;
  assertViewport(viewport);
  const params = new URLSearchParams({
    x: String(viewport.x),
    y: String(viewport.y),
    width: String(viewport.width),
    height: String(viewport.height),
    zoom: String(viewport.zoom),
  });

  const response = await (options.fetchImpl ?? coreFetch)(
    `/api/core/repos/${encodeURIComponent(normalizedRepoId)}/technical-tree?${params}`,
    {
      method: 'GET',
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
      signal: options.signal,
    },
  );

  if (!response.ok) throw requestError(response.status);

  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new TechnicalTreeResponseError();
  }

  return toAuthorizedCanvasPayload(parseTechnicalTreeResponse(value));
}

export function toReactFlowElements(payload: AuthorizedCanvasPayload): {
  nodes: Node<GraphNodeData>[];
  edges: Edge[];
} {
  const nodes: Node<GraphNodeData>[] = payload.nodes.map((node) => ({
    id: node.id,
    position: { x: node.x, y: node.y },
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
    className: node.kind === 'Folder' ? 'graph-node-folder' : 'graph-node-file',
    data: { label: node.label, kind: node.kind, path: node.path },
  }));

  const edges: Edge[] = payload.edges.map((edge) => {
    const isImport = edge.relationship === 'IMPORTS';
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: isImport ? 'default' : 'smoothstep',
      animated: isImport,
      className: isImport ? 'graph-edge-import' : 'graph-edge-contains',
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: isImport ? '#688bc0' : '#3b4653',
        width: 14,
        height: 14,
      },
      data: { relationship: edge.relationship },
    };
  });

  return { nodes, edges };
}
