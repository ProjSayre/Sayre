import type { InstalledWorkspacePack, WorkspacePackRef } from '../../../../../packages/workspace-packs/src/runtime';

const REFERENCE = /^([a-z0-9][a-z0-9.-]{2,63})@(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/;

export function resolveWorkspacePackReference(raw: string | null | undefined, installed: readonly InstalledWorkspacePack[]): { ok: true; ref: WorkspacePackRef; pack: InstalledWorkspacePack } | { ok: false; requested: string | null } {
  if (raw === null || raw === undefined || !REFERENCE.test(raw)) return { ok: false, requested: raw ?? null };
  const separator = raw.lastIndexOf('@');
  const ref = { id: raw.slice(0, separator), version: raw.slice(separator + 1) };
  const pack = installed.find((item) => item.ref.id === ref.id && item.ref.version === ref.version);
  return pack ? { ok: true, ref, pack } : { ok: false, requested: raw };
}

export function mergeWorkspacePackRegistry(builtins: readonly InstalledWorkspacePack[], installed: readonly InstalledWorkspacePack[]): readonly InstalledWorkspacePack[] {
  const entries = new Map(builtins.map((item) => [`${item.ref.id}@${item.ref.version}`, item]));
  for (const item of installed) if (!entries.has(`${item.ref.id}@${item.ref.version}`)) entries.set(`${item.ref.id}@${item.ref.version}`, item);
  return [...entries.values()];
}
