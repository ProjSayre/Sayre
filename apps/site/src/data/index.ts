import { REPO_NODES } from "./repo";
import { REPO_EDGES } from "./edges";
import { FEATURES } from "./features";
import { TICKETS } from "./tickets";
import { PEOPLE } from "./people";
import { PERSONAS } from "./personas";
import type { Feature, Person, RepoEdge, RepoNode, Ticket } from "./types";

export * from "./types";
export { REPO_EDGES } from "./edges";
export { FEATURES } from "./features";
export { TICKETS } from "./tickets";
export { PEOPLE } from "./people";
export { PERSONAS } from "./personas";
export { REPO_OVERVIEW } from "./copy";

export const ROOT_ID = "acme";

export const NODES: RepoNode[] = REPO_NODES;

export const NODE_BY_ID: ReadonlyMap<string, RepoNode> = new Map(NODES.map((n) => [n.id, n]));

/** children sorted dirs-first alphabetical, then files alphabetical */
export const CHILDREN: ReadonlyMap<string, RepoNode[]> = (() => {
  const map = new Map<string, RepoNode[]>();
  for (const n of NODES) {
    if (n.parentId === null) continue;
    const list = map.get(n.parentId) ?? [];
    list.push(n);
    map.set(n.parentId, list);
  }
  for (const list of map.values()) {
    list.sort((a, b) => {
      const ad = a.type !== "file" ? 0 : 1;
      const bd = b.type !== "file" ? 0 : 1;
      if (ad !== bd) return ad - bd;
      return a.name.localeCompare(b.name);
    });
  }
  return map;
})();

export function childrenOf(id: string): RepoNode[] {
  return CHILDREN.get(id) ?? [];
}

export function isFolder(n: RepoNode): boolean {
  return n.type !== "file";
}

/** ghost remainder: total files minus what the authored direct children account for */
export function ghostCount(folderId: string): number {
  const folder = NODE_BY_ID.get(folderId);
  if (!folder || folder.type === "file" || folder.fileCount === undefined) return 0;
  let accounted = 0;
  for (const c of childrenOf(folderId)) {
    accounted += c.type === "file" ? 1 : (c.fileCount ?? 0);
  }
  return Math.max(0, folder.fileCount - accounted);
}

/** ancestor ids, root first, excluding the node itself */
export function ancestorIds(id: string): string[] {
  const out: string[] = [];
  let cur = NODE_BY_ID.get(id)?.parentId ?? null;
  while (cur !== null) {
    out.unshift(cur);
    cur = NODE_BY_ID.get(cur)?.parentId ?? null;
  }
  return out;
}

export function depthOf(id: string): number {
  return ancestorIds(id).length;
}

export function isDescendantOrSelf(id: string, ancestor: string): boolean {
  if (id === ancestor) return true;
  if (ancestor === ROOT_ID) return true;
  return id.startsWith(ancestor + "/");
}

/** display path: root renders as "acme/", others as their id (files verbatim, dirs with trailing /) */
export function displayPath(n: RepoNode): string {
  if (n.type === "root") return "acme/";
  return n.type === "folder" ? n.id + "/" : n.id;
}

export const OUT_EDGES: ReadonlyMap<string, RepoEdge[]> = (() => {
  const m = new Map<string, RepoEdge[]>();
  for (const e of REPO_EDGES) {
    const l = m.get(e.from) ?? [];
    l.push(e);
    m.set(e.from, l);
  }
  return m;
})();

export const IN_EDGES: ReadonlyMap<string, RepoEdge[]> = (() => {
  const m = new Map<string, RepoEdge[]>();
  for (const e of REPO_EDGES) {
    const l = m.get(e.to) ?? [];
    l.push(e);
    m.set(e.to, l);
  }
  return m;
})();

export const FEATURE_BY_ID: ReadonlyMap<string, Feature> = new Map(FEATURES.map((f) => [f.id, f]));
export const TICKET_BY_ID: ReadonlyMap<string, Ticket> = new Map(TICKETS.map((t) => [t.id, t]));
export const PERSON_BY_ID: ReadonlyMap<string, Person> = new Map(PEOPLE.map((p) => [p.id, p]));

export function ownerNames(ids: string[] | undefined): string[] {
  if (!ids) return [];
  return ids.map((id) => PERSON_BY_ID.get(id)?.name ?? id);
}

/** sum of feature member files (27) — feeds the features status line */
export const FEATURE_FILE_TOTAL = FEATURES.reduce((sum, f) => sum + f.memberIds.length, 0);

/** distinct parent directories of a feature's member files — drives node radius */
export function featureDirCount(f: Feature): number {
  return new Set(f.memberIds.map((id) => NODE_BY_ID.get(id)?.parentId ?? "")).size;
}

/** member file ids shared between two features */
export function sharedMembers(a: Feature, b: Feature): string[] {
  const set = new Set(a.memberIds);
  return b.memberIds.filter((id) => set.has(id));
}

export const CONTRIBUTOR_COUNT = PEOPLE.length;

export const ROOT_FILE_COUNT = NODE_BY_ID.get(ROOT_ID)?.fileCount ?? 0;

/** suggested hero files for the empty ⌘k query */
export const SUGGESTED_FILES: string[] = [
  "apps/web/src/checkout/PaymentForm.tsx",
  "packages/core/src/currency.ts",
  "apps/web/src/checkout/useCheckout.ts",
  "packages/core/src/session.ts",
  "services/search-indexer/src/retry.ts",
  "packages/ui/src/PriceTag.tsx",
];

/** default persona / initial load state (spec §8.6) */
export const INITIAL_PERSONA = PERSONAS[1]; // tech lead

/** initial filetree expansion (spec §7.2) */
export const INITIAL_EXPANDED: string[] = [
  "acme",
  "apps",
  "apps/web",
  "apps/web/src",
  "apps/web/src/checkout",
  "packages",
  "services",
  "services/search-indexer",
  "services/search-indexer/src",
];
