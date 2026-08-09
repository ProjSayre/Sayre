/**
 * The frozen v1 shape set. Adding a shape is a design-review event: `isWorkspaceShapePayload`
 * rejects anything outside `WORKSPACE_SHAPES` rather than accepting it structurally.
 */
export const WORKSPACE_SHAPES = ['collection', 'tree', 'graph', 'document'] as const;
export type WorkspaceShapeId = (typeof WORKSPACE_SHAPES)[number];

export interface WorkspaceCollectionItem {
  id: string; title: string; subtitle?: string; group?: string;
  status?: string; timestamp?: string;
  ref?: { kind: 'node' | 'feature' | 'external'; id: string };
}
export interface WorkspaceCollectionPayload { shape: 'collection'; items: readonly WorkspaceCollectionItem[]; groups?: readonly { id: string; label: string }[] }
export interface WorkspaceTreeNode { id: string; parentId: string | null; label: string; kind: string }
export interface WorkspaceTreePayload { shape: 'tree'; nodes: readonly WorkspaceTreeNode[] }
export interface WorkspaceGraphShapePayload { shape: 'graph'; nodes: readonly { id: string; label: string; kind: string }[]; edges: readonly { source: string; target: string; type: string }[] }
export interface WorkspaceDocumentPayload { shape: 'document'; title: string; blocks: readonly { kind: 'heading' | 'paragraph' | 'list' | 'code'; text: string; items?: readonly string[] }[] }
export type WorkspaceShapePayload = WorkspaceCollectionPayload | WorkspaceTreePayload | WorkspaceGraphShapePayload | WorkspaceDocumentPayload;

const DOCUMENT_BLOCK_KINDS = new Set(['heading', 'paragraph', 'list', 'code']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isCollectionItem(value: unknown): value is WorkspaceCollectionItem {
  if (!isPlainObject(value)) return false;
  if (typeof value.id !== 'string' || typeof value.title !== 'string') return false;
  if (!isOptionalString(value.subtitle) || !isOptionalString(value.group) || !isOptionalString(value.status) || !isOptionalString(value.timestamp)) return false;
  if (value.ref !== undefined) {
    const ref = value.ref;
    if (!isPlainObject(ref)) return false;
    if (ref.kind !== 'node' && ref.kind !== 'feature' && ref.kind !== 'external') return false;
    if (typeof ref.id !== 'string') return false;
  }
  return true;
}

function isCollectionPayload(value: Record<string, unknown>): boolean {
  if (!Array.isArray(value.items) || !value.items.every(isCollectionItem)) return false;
  if (value.groups !== undefined) {
    if (!Array.isArray(value.groups)) return false;
    if (!value.groups.every((group) => isPlainObject(group) && typeof group.id === 'string' && typeof group.label === 'string')) return false;
  }
  return true;
}

function isTreeNode(value: unknown): value is WorkspaceTreeNode {
  if (!isPlainObject(value)) return false;
  if (typeof value.id !== 'string' || typeof value.label !== 'string' || typeof value.kind !== 'string') return false;
  return value.parentId === null || typeof value.parentId === 'string';
}

function isTreePayload(value: Record<string, unknown>): boolean {
  return Array.isArray(value.nodes) && value.nodes.every(isTreeNode);
}

function isGraphNode(value: unknown): value is { id: string; label: string; kind: string } {
  return isPlainObject(value) && typeof value.id === 'string' && typeof value.label === 'string' && typeof value.kind === 'string';
}

function isGraphEdge(value: unknown): value is { source: string; target: string; type: string } {
  return isPlainObject(value) && typeof value.source === 'string' && typeof value.target === 'string' && typeof value.type === 'string';
}

function isGraphPayload(value: Record<string, unknown>): boolean {
  return Array.isArray(value.nodes) && value.nodes.every(isGraphNode) && Array.isArray(value.edges) && value.edges.every(isGraphEdge);
}

function isDocumentBlock(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  if (typeof value.kind !== 'string' || !DOCUMENT_BLOCK_KINDS.has(value.kind)) return false;
  if (typeof value.text !== 'string') return false;
  if (value.items === undefined) return true;
  return Array.isArray(value.items) && value.items.every((item) => typeof item === 'string');
}

function isDocumentPayload(value: Record<string, unknown>): boolean {
  return typeof value.title === 'string' && Array.isArray(value.blocks) && value.blocks.every(isDocumentBlock);
}

/** Never throws: malformed input is reported through the boolean return, not an exception. */
export function isWorkspaceShapePayload(shape: WorkspaceShapeId, value: unknown): value is WorkspaceShapePayload {
  if (!isPlainObject(value) || value.shape !== shape) return false;
  switch (shape) {
    case 'collection': return isCollectionPayload(value);
    case 'tree': return isTreePayload(value);
    case 'graph': return isGraphPayload(value);
    case 'document': return isDocumentPayload(value);
    default: return false;
  }
}
