import { CHILDREN, IN_EDGES, OUT_EDGES, REPO_EDGES } from "../../data";
import type { RepoEdge } from "../../data";

export interface AggEdge {
  fromId: string; // scope-child id
  toId: string; // scope-child id
  count: number; // underlying file-level edges
}

export interface EdgeKinds {
  imports: boolean;
  calls: boolean;
}

function kindOn(e: RepoEdge, kinds: EdgeKinds): boolean {
  return e.kind === "imports" ? kinds.imports : kinds.calls;
}

const cache = new Map<string, AggEdge[]>();

/**
 * Roll authored file edges up to the given scope's children (§7.5).
 * A→B counts edges from descendants-or-self of A into descendants-or-self of B.
 * Computed once per (scope, filter) and memoized.
 */
export function rollupScope(scopeId: string, kinds: EdgeKinds): AggEdge[] {
  const key = `${scopeId}:${kinds.imports ? 1 : 0}${kinds.calls ? 1 : 0}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const kids = CHILDREN.get(scopeId) ?? [];
  const counts = new Map<string, number>();
  const ownerOf = (fileId: string): string | null => {
    for (const k of kids) {
      if (fileId === k.id || fileId.startsWith(k.id + "/")) return k.id;
    }
    return null;
  };

  for (const e of REPO_EDGES) {
    if (!kindOn(e, kinds)) continue;
    const a = ownerOf(e.from);
    const b = ownerOf(e.to);
    if (!a || !b || a === b) continue;
    const k = `${a}→${b}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }

  const out: AggEdge[] = [...counts.entries()].map(([k, count]) => {
    const [fromId, toId] = k.split("→");
    return { fromId, toId, count };
  });
  cache.set(key, out);
  return out;
}

export function widthForCount(count: number): number {
  if (count >= 6) return 2;
  if (count >= 3) return 1.5;
  return 1;
}

/** global file-level counterparts for a selected file (§7.5 sidebar block) */
export function fileCounterparts(
  fileId: string,
  kinds: EdgeKinds,
): { incoming: RepoEdge[]; outgoing: RepoEdge[] } {
  const incoming = (IN_EDGES.get(fileId) ?? []).filter((e) => kindOn(e, kinds));
  const outgoing = (OUT_EDGES.get(fileId) ?? []).filter((e) => kindOn(e, kinds));
  return { incoming, outgoing };
}
