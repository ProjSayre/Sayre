// Dev-only dataset invariant checks (spec §5.2 + appendix A pins).
// Imported from main.tsx under import.meta.env.DEV; logs console.error on drift.

import {
  CHILDREN,
  FEATURES,
  IN_EDGES,
  NODE_BY_ID,
  NODES,
  OUT_EDGES,
  REPO_EDGES,
  ROOT_ID,
  TICKET_BY_ID,
  childrenOf,
  isDescendantOrSelf,
} from "./index";

function err(msg: string): void {
  console.error(`[sayre data] ${msg}`);
}

export function validateDataset(): void {
  // fileCount consistency: parent count >= children folder counts + direct files
  for (const n of NODES) {
    if (n.type === "file") continue;
    if (n.fileCount === undefined) {
      err(`folder ${n.id} missing fileCount`);
      continue;
    }
    let accounted = 0;
    for (const c of childrenOf(n.id)) {
      accounted += c.type === "file" ? 1 : (c.fileCount ?? 0);
    }
    if (accounted > n.fileCount) {
      err(`folder ${n.id} fileCount ${n.fileCount} < accounted ${accounted}`);
    }
  }

  // edges reference authored FILE nodes
  for (const e of REPO_EDGES) {
    for (const id of [e.from, e.to]) {
      const node = NODE_BY_ID.get(id);
      if (!node) err(`edge references unauthored node ${id}`);
      else if (node.type !== "file") err(`edge endpoint ${id} is not a file`);
    }
  }

  // currency.ts pinned: exactly 6 in, 1 out
  const cur = "packages/core/src/currency.ts";
  const inN = (IN_EDGES.get(cur) ?? []).length;
  const outN = (OUT_EDGES.get(cur) ?? []).length;
  if (inN !== 6 || outN !== 1) err(`currency.ts must be 6 in · 1 out, got ${inN} in · ${outN} out`);

  // tests.coveredBy paths resolve to authored file nodes; exactly 2 failing
  let failing = 0;
  for (const n of NODES) {
    const t = n.meta.tests;
    if (!t) continue;
    if (t.status === "fail") failing++;
    for (const p of t.coveredBy) {
      const covered = NODE_BY_ID.get(p);
      if (!covered || covered.type !== "file") err(`${n.id} coveredBy unauthored ${p}`);
    }
  }
  if (failing !== 2) err(`expected exactly 2 failing tests, got ${failing}`);

  // features: memberIds are authored files; openTickets matches linked open/in-progress
  for (const f of FEATURES) {
    for (const id of f.memberIds) {
      const m = NODE_BY_ID.get(id);
      if (!m || m.type !== "file") err(`feature ${f.id} member ${id} not an authored file`);
    }
    const open = f.ticketIds.filter((tid) => {
      const t = TICKET_BY_ID.get(tid);
      if (!t) {
        err(`feature ${f.id} links unknown ticket ${tid}`);
        return false;
      }
      return t.status === "open" || t.status === "in progress";
    }).length;
    if (open !== f.stats.openTickets) {
      err(`feature ${f.id} stats.openTickets ${f.stats.openTickets} != linked open ${open}`);
    }
    if (f.recentEdits.length !== 3) err(`feature ${f.id} must have exactly 3 recentEdits`);
  }

  // node ticket/feature references resolve
  for (const n of NODES) {
    for (const tid of n.meta.ticketIds ?? []) {
      if (!TICKET_BY_ID.get(tid)) err(`${n.id} links unknown ticket ${tid}`);
    }
  }

  // directionality: no sibling pair at any authored scope with aggregate edges both ways
  for (const scope of NODES.filter((n) => n.type !== "file")) {
    const kids = childrenOf(scope.id);
    if (kids.length < 2) continue;
    const owner = (fileId: string): string | null => {
      for (const k of kids) if (isDescendantOrSelf(fileId, k.id) && (k.id === fileId || fileId.startsWith(k.id + "/"))) return k.id;
      return null;
    };
    const pairs = new Set<string>();
    for (const e of REPO_EDGES) {
      const a = owner(e.from);
      const b = owner(e.to);
      if (!a || !b || a === b) continue;
      if (pairs.has(`${b}→${a}`)) err(`scope ${scope.id}: bidirectional aggregate between ${a} and ${b}`);
      pairs.add(`${a}→${b}`);
    }
  }

  // sanity: children map has no orphans
  for (const id of CHILDREN.keys()) {
    if (!NODE_BY_ID.get(id)) err(`children map references unknown parent ${id}`);
  }
  if (!NODE_BY_ID.get(ROOT_ID)) err("missing root node");
}
