import type { JsonValue, WorkspacePackDocument, WorkspacePackDiffEntry } from './contracts';

function sortValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    const record = value as { readonly [key: string]: JsonValue };
    return Object.fromEntries(
      Object.keys(record).sort().map((key) => [key, sortValue(record[key]!)]),
    );
  }
  return value;
}

export function canonicalizeWorkspacePack(pack: WorkspacePackDocument): string {
  return `${JSON.stringify(sortValue(pack as unknown as JsonValue), null, 2)}\n`;
}

export function diffWorkspacePacks(before: WorkspacePackDocument, after: WorkspacePackDocument): readonly WorkspacePackDiffEntry[] {
  const entries: WorkspacePackDiffEntry[] = [];
  function walk(left: JsonValue | undefined, right: JsonValue | undefined, path: string): void {
    if (JSON.stringify(left) === JSON.stringify(right)) return;
    if (left !== undefined && right !== undefined && left !== null && right !== null && typeof left === 'object' && typeof right === 'object' && !Array.isArray(left) && !Array.isArray(right)) {
      const leftRecord = left as { readonly [key: string]: JsonValue };
      const rightRecord = right as { readonly [key: string]: JsonValue };
      const keys = new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)]);
      for (const key of [...keys].sort()) walk(leftRecord[key], rightRecord[key], `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`);
      return;
    }
    entries.push({ path: path || '/', before: left, after: right });
  }
  walk(before as unknown as JsonValue, after as unknown as JsonValue, '');
  return entries;
}
