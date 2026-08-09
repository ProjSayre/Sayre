import { canonicalizeWorkspacePack, diffWorkspacePacks } from './canonicalize';
import { WORKSPACE_PACK_LIMITS, UNSAFE_KEY } from './limits';
import { validateWorkspacePackCompatibility } from './parse';
import type {
  JsonValue,
  WorkspaceComponentCatalogContract,
  WorkspacePackDocument,
  WorkspacePackPatchOperation,
  WorkspacePackPatchResult,
} from './contracts';

const ALLOWED_ROOTS = new Set(['metadata', 'theme', 'defaultLayoutId', 'defaultViewId', 'layouts', 'views', 'settingsOrder']);
const METADATA_FIELDS = new Set(['name', 'version', 'description', 'author', 'license', 'tags', 'derivedFrom']);

function segments(path: string): string[] {
  if (!path.startsWith('/')) throw new Error('Patch path must be an absolute JSON pointer.');
  const encoded = path.slice(1).split('/');
  if (encoded.some((segment) => /~(?![01])/u.test(segment))) throw new Error('Patch path contains an invalid JSON-pointer escape.');
  const result = encoded.map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (result.some((segment) => segment.length === 0 || UNSAFE_KEY.test(segment))) throw new Error('Unsafe patch path.');
  if (result.length > WORKSPACE_PACK_LIMITS.depth) throw new Error('Patch path exceeds maximum depth.');
  if (!ALLOWED_ROOTS.has(result[0]!)) throw new Error('Patch root is not allowed.');
  if (result[0] === 'metadata' && !METADATA_FIELDS.has(result[1]!)) throw new Error('Metadata field is not patchable.');
  return result;
}

function parentAt(root: Record<string, unknown>, parts: string[]): { parent: Record<string, unknown> | unknown[]; key: string } {
  let current: unknown = root;
  for (const part of parts.slice(0, -1)) {
    if (Array.isArray(current)) {
      const index = Number(part);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) throw new Error('Patch array index is outside bounds.');
      current = current[index];
    } else if (current !== null && typeof current === 'object' && Object.hasOwn(current, part)) current = (current as Record<string, unknown>)[part];
    else throw new Error('Patch path does not exist.');
  }
  if (current === null || typeof current !== 'object') throw new Error('Patch parent is not a container.');
  return { parent: current as Record<string, unknown> | unknown[], key: parts.at(-1)! };
}

export function applyWorkspacePackPatch(pack: WorkspacePackDocument, operations: readonly WorkspacePackPatchOperation[], catalog: WorkspaceComponentCatalogContract): WorkspacePackPatchResult {
  if (!Array.isArray(operations)) throw new Error('Patch operations must be an array.');
  if (operations.length > WORKSPACE_PACK_LIMITS.operations) throw new Error('Too many patch operations.');
  const next = structuredClone(pack) as unknown as Record<string, unknown>;
  const touched = new Set<string>();
  for (const operation of operations) {
    if (operation === null || typeof operation !== 'object' || Array.isArray(operation)) throw new Error('Patch operation must be an object.');
    const allowedFields = operation.op === 'remove' ? ['op', 'path'] : ['op', 'path', 'value'];
    if (!['add', 'replace', 'remove'].includes(operation.op) || typeof operation.path !== 'string' || Object.keys(operation).some((field) => !allowedFields.includes(field)) || (operation.op !== 'remove' && !Object.hasOwn(operation, 'value'))) throw new Error('Patch operation is malformed or contains unknown fields.');
    const parts = segments(operation.path);
    if ([...touched].some((path) => path === operation.path || path.startsWith(`${operation.path}/`) || operation.path.startsWith(`${path}/`))) throw new Error('Overlapping patch operations are not allowed.');
    touched.add(operation.path);
    const { parent, key } = parentAt(next, parts);
    if (Array.isArray(parent)) {
      const index = key === '-' ? parent.length : Number(key);
      if (!Number.isInteger(index) || index < 0 || index > parent.length) throw new Error('Patch array index is outside bounds.');
      if (operation.op === 'add') parent.splice(index, 0, structuredClone(operation.value));
      else {
        if (index >= parent.length) throw new Error('Patch array index is outside bounds.');
        if (operation.op === 'remove') parent.splice(index, 1);
        else parent[index] = structuredClone(operation.value);
      }
    } else {
      const exists = Object.hasOwn(parent, key);
      if (operation.op !== 'add' && !exists) throw new Error('Patch path does not exist.');
      if (operation.op === 'remove') delete parent[key];
      else parent[key] = structuredClone(operation.value) as unknown;
    }
  }
  const validated = validateWorkspacePackCompatibility(next as unknown as WorkspacePackDocument, catalog);
  if (!validated.ok) throw new Error(validated.violations.map((item) => `${item.path}: ${item.message}`).join('; '));
  const changedPaths = diffWorkspacePacks(pack, validated.pack).map((item) => item.path);
  return { pack: validated.pack, changedPaths, canonicalJson: canonicalizeWorkspacePack(validated.pack) };
}

export type { WorkspacePackPatchOperation } from './contracts';
