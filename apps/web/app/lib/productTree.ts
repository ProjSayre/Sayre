import { Position, type Node } from '@xyflow/react';
import type {
  AuthorizedCanvasNode,
  AuthorizedCanvasPayload,
} from './scaleGraph';
import { coreFetch } from './coreFetch';

export interface ProductTreeNode {
  id: string;
  label: 'Folder' | 'File';
  name: string;
  path: string;
  parentId: string | null;
}

export interface ProductTreeRecentEdit {
  fileId: string;
  filePath: string;
  editedAt: string;
  editorName: string | null;
  editorLogin: string | null;
  pullRequestTitle: string | null;
  pullRequestUrl: string | null;
}

export interface ProductTreeFile {
  id: string;
  name: string;
  path: string;
}

export interface ProductTreeFeature {
  id: string;
  name: string;
  description: string | null;
  team: string | null;
  memberIds: string[];
  filesIncluded: ProductTreeFile[];
  recentEdits: ProductTreeRecentEdit[];
}

export interface ProductTreeResponse {
  authorization: 'server-filtered';
  repoId: string;
  refName: string;
  visibleNodeCount: number;
  nodes: ProductTreeNode[];
  features: ProductTreeFeature[];
}

export interface ProductTreeBoundary {
  id: string;
  label: string;
  memberIds: string[];
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ProductTreePresentation {
  response: ProductTreeResponse;
  canvas: AuthorizedCanvasPayload;
  boundaries: ProductTreeBoundary[];
}

export interface ProductTreeNodeData extends Record<string, unknown> {
  label: string;
  kind: 'Folder' | 'File';
  path: string;
}

export interface FetchProductTreeOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export class ProductTreeResponseError extends Error {
  constructor(message = 'The Product Tree response is invalid.') {
    super(message);
    this.name = 'ProductTreeResponseError';
  }
}

export class ProductTreeRequestError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = 'ProductTreeRequestError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(
  record: Record<string, unknown>,
  field: string,
  options: { allowEmpty?: boolean } = {},
): string {
  const value = record[field];
  if (
    typeof value !== 'string' ||
    (!options.allowEmpty && value.trim().length === 0)
  ) {
    throw new ProductTreeResponseError();
  }
  return value;
}

function optionalString(
  record: Record<string, unknown>,
  field: string,
): string | null {
  const value = record[field];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ProductTreeResponseError();
  }
  return value;
}

function parseNode(value: unknown): ProductTreeNode {
  if (!isRecord(value)) throw new ProductTreeResponseError();
  const label = value.label;
  if (label !== 'Folder' && label !== 'File') {
    throw new ProductTreeResponseError();
  }
  const parentId = value.parentId;
  if (
    parentId !== null &&
    (typeof parentId !== 'string' || parentId.trim().length === 0)
  ) {
    throw new ProductTreeResponseError();
  }
  return {
    id: requiredString(value, 'id'),
    label,
    name: requiredString(value, 'name'),
    path: requiredString(value, 'path', { allowEmpty: true }),
    parentId,
  };
}

function parseFile(value: unknown): ProductTreeFile {
  if (!isRecord(value)) throw new ProductTreeResponseError();
  return {
    id: requiredString(value, 'id'),
    name: requiredString(value, 'name'),
    path: requiredString(value, 'path', { allowEmpty: true }),
  };
}

function parseRecentEdit(value: unknown): ProductTreeRecentEdit {
  if (!isRecord(value)) throw new ProductTreeResponseError();
  const editedAt = requiredString(value, 'editedAt');
  if (!Number.isFinite(Date.parse(editedAt))) {
    throw new ProductTreeResponseError();
  }
  const pullRequestUrl = optionalString(value, 'pullRequestUrl');
  if (pullRequestUrl !== null) {
    try {
      const protocol = new URL(pullRequestUrl).protocol;
      if (protocol !== 'https:' && protocol !== 'http:') {
        throw new ProductTreeResponseError();
      }
    } catch (error) {
      if (error instanceof ProductTreeResponseError) throw error;
      throw new ProductTreeResponseError();
    }
  }

  return {
    fileId: requiredString(value, 'fileId'),
    filePath: requiredString(value, 'filePath', { allowEmpty: true }),
    editedAt,
    editorName: optionalString(value, 'editorName'),
    editorLogin: optionalString(value, 'editorLogin'),
    pullRequestTitle: optionalString(value, 'pullRequestTitle'),
    pullRequestUrl,
  };
}

function assertUniqueIds(values: readonly { id: string }[]): void {
  if (new Set(values.map(({ id }) => id)).size !== values.length) {
    throw new ProductTreeResponseError();
  }
}

function parseFeature(value: unknown): ProductTreeFeature {
  if (
    !isRecord(value) ||
    !Array.isArray(value.memberIds) ||
    !Array.isArray(value.filesIncluded) ||
    !Array.isArray(value.recentEdits)
  ) {
    throw new ProductTreeResponseError();
  }
  if (
    value.memberIds.length === 0 ||
    value.memberIds.some(
      (id) => typeof id !== 'string' || id.trim().length === 0,
    ) ||
    new Set(value.memberIds).size !== value.memberIds.length
  ) {
    throw new ProductTreeResponseError();
  }
  const filesIncluded = value.filesIncluded.map(parseFile);
  assertUniqueIds(filesIncluded);
  return {
    id: requiredString(value, 'id'),
    name: requiredString(value, 'name'),
    description: optionalString(value, 'description'),
    team: optionalString(value, 'team'),
    memberIds: value.memberIds,
    filesIncluded,
    recentEdits: value.recentEdits.map(parseRecentEdit),
  };
}

export function parseProductTreeResponse(value: unknown): ProductTreeResponse {
  if (
    !isRecord(value) ||
    value.authorization !== 'server-filtered' ||
    !Number.isSafeInteger(value.visibleNodeCount) ||
    (value.visibleNodeCount as number) < 0 ||
    !Array.isArray(value.nodes) ||
    !Array.isArray(value.features)
  ) {
    throw new ProductTreeResponseError();
  }

  const nodes = value.nodes.map(parseNode);
  const features = value.features.map(parseFeature);
  assertUniqueIds(nodes);
  assertUniqueIds(features);
  if (value.visibleNodeCount !== nodes.length) {
    throw new ProductTreeResponseError();
  }

  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const referenced = new Set<string>();
  for (const feature of features) {
    const fileIds = new Set(feature.filesIncluded.map(({ id }) => id));
    if (
      fileIds.size !== feature.memberIds.length ||
      feature.memberIds.some((id) => !fileIds.has(id))
    ) {
      throw new ProductTreeResponseError();
    }

    for (const file of feature.filesIncluded) {
      const node = nodesById.get(file.id);
      if (
        node?.label !== 'File' ||
        node.name !== file.name ||
        node.path !== file.path
      ) {
        throw new ProductTreeResponseError();
      }
      referenced.add(file.id);
    }
    for (const edit of feature.recentEdits) {
      const node = nodesById.get(edit.fileId);
      if (
        !fileIds.has(edit.fileId) ||
        node?.label !== 'File' ||
        node.path !== edit.filePath
      ) {
        throw new ProductTreeResponseError();
      }
    }
  }
  if (nodes.some((node) => !referenced.has(node.id))) {
    throw new ProductTreeResponseError();
  }

  return {
    authorization: 'server-filtered',
    repoId: requiredString(value, 'repoId'),
    refName: requiredString(value, 'refName'),
    visibleNodeCount: value.visibleNodeCount as number,
    nodes,
    features,
  };
}

function requestError(status: number): ProductTreeRequestError {
  if (status === 401) {
    return new ProductTreeRequestError('Sign in to view this repository.', status);
  }
  if (status === 403) {
    return new ProductTreeRequestError(
      'You do not have access to this repository.',
      status,
    );
  }
  return new ProductTreeRequestError('The Product Tree could not be loaded.', status);
}

export async function fetchProductTree(
  repoId: string,
  refName: string,
  options: FetchProductTreeOptions = {},
): Promise<ProductTreePresentation> {
  const normalizedRepoId = repoId.trim();
  const normalizedRefName = refName.trim();
  if (!normalizedRepoId || !normalizedRefName) {
    throw new RangeError('A repository ID and ref are required.');
  }
  const response = await (options.fetchImpl ?? coreFetch)(
    `/api/core/repos/${encodeURIComponent(normalizedRepoId)}/product-tree?ref=${encodeURIComponent(normalizedRefName)}`,
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
    throw new ProductTreeResponseError();
  }
  return toProductTreePresentation(parseProductTreeResponse(value));
}

const CLUSTER_COLUMN_WIDTH = 520;
const CLUSTER_GAP = 72;
const NODE_COLUMN_WIDTH = 190;
const NODE_ROW_HEIGHT = 82;
const NODE_WIDTH = 150;
const NODE_HEIGHT = 46;
const BOUNDARY_PADDING_X = 34;
const BOUNDARY_PADDING_Y = 44;

export function toProductTreePresentation(
  response: ProductTreeResponse,
): ProductTreePresentation {
  const sortedFeatures = [...response.features].sort(
    (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
  const primaryFeature = new Map<string, string>();
  for (const feature of sortedFeatures) {
    for (const memberId of feature.memberIds) {
      if (!primaryFeature.has(memberId)) primaryFeature.set(memberId, feature.id);
    }
  }

  const positions = new Map<string, { x: number; y: number }>();
  const columnCursors = [0, 0, 0];
  for (const feature of sortedFeatures) {
    const primaryMembers = feature.memberIds.filter(
      (memberId) => primaryFeature.get(memberId) === feature.id,
    );
    const column = columnCursors.indexOf(Math.min(...columnCursors));
    const baseX = column * CLUSTER_COLUMN_WIDTH;
    const baseY = columnCursors[column] ?? 0;
    primaryMembers.forEach((memberId, index) => {
      positions.set(memberId, {
        x: baseX + (index % 2) * NODE_COLUMN_WIDTH,
        y: baseY + Math.floor(index / 2) * NODE_ROW_HEIGHT,
      });
    });
    const rows = Math.max(1, Math.ceil(primaryMembers.length / 2));
    columnCursors[column] = baseY + rows * NODE_ROW_HEIGHT + CLUSTER_GAP;
  }

  const canvasNodes: AuthorizedCanvasNode[] = response.nodes.map((node) => {
    const position = positions.get(node.id);
    if (position === undefined) throw new ProductTreeResponseError();
    return {
      id: node.id,
      kind: node.label,
      label: node.name,
      path: node.path,
      ...position,
    };
  });
  const positionedById = new Map(canvasNodes.map((node) => [node.id, node]));
  const boundaries = sortedFeatures.map<ProductTreeBoundary>((feature) => {
    const members = feature.memberIds.map((id) => {
      const node = positionedById.get(id);
      if (node === undefined) throw new ProductTreeResponseError();
      return node;
    });
    const minX = Math.min(...members.map(({ x }) => x));
    const minY = Math.min(...members.map(({ y }) => y));
    const maxX = Math.max(...members.map(({ x }) => x + NODE_WIDTH));
    const maxY = Math.max(...members.map(({ y }) => y + NODE_HEIGHT));
    return {
      id: feature.id,
      label: feature.name,
      memberIds: feature.memberIds,
      x: minX - BOUNDARY_PADDING_X,
      y: minY - BOUNDARY_PADDING_Y,
      width: maxX - minX + BOUNDARY_PADDING_X * 2,
      height: maxY - minY + BOUNDARY_PADDING_Y * 2,
    };
  });

  return {
    response,
    canvas: {
      authorization: 'server-filtered',
      visibleNodeCount: response.visibleNodeCount,
      nodes: canvasNodes,
      edges: [],
    },
    boundaries,
  };
}

export function toProductTreeReactFlowNodes(
  payload: AuthorizedCanvasPayload,
): Node<ProductTreeNodeData>[] {
  return payload.nodes.map((node) => ({
    id: node.id,
    position: { x: node.x, y: node.y },
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
    className: node.kind === 'Folder' ? 'graph-node-folder' : 'graph-node-file',
    data: { label: node.label, kind: node.kind, path: node.path },
  }));
}

export function selectedFeaturePanel(
  response: ProductTreeResponse,
  featureId: string | null,
): ProductTreeFeature | null {
  if (featureId === null) return null;
  return response.features.find((feature) => feature.id === featureId) ?? null;
}
