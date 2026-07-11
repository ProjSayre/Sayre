import { useMemo } from "react";
import { FEATURES, NODES, SUGGESTED_FILES } from "../../data";
import type { Tab } from "../../data";
import { fuzzyMatch } from "./fuzzy";

export interface SearchRow {
  kind: "node" | "feature";
  id: string;
  positions: number[]; // match positions over the row's target (node path / feature name)
}

/**
 * Search follows the active graph (design v2): the features tab searches the
 * four features plus their member files; filetree/relations search every
 * authored node. Empty query → suggestions for the current context.
 */
export function useContextSearch(query: string, tab: Tab, limit = 8): SearchRow[] {
  return useMemo<SearchRow[]>(() => {
    const q = query.trim();

    if (tab === "features") {
      if (q === "") {
        return FEATURES.map((f) => ({ kind: "feature" as const, id: f.id, positions: [] }));
      }
      const hits: (SearchRow & { score: number })[] = [];
      for (const f of FEATURES) {
        const hit = fuzzyMatch(q, f.name);
        // features are what this graph displays — rank them above member files
        if (hit) hits.push({ kind: "feature", id: f.id, positions: hit.positions, score: hit.score + 12 });
      }
      const members = new Set<string>();
      for (const f of FEATURES) for (const id of f.memberIds) members.add(id);
      for (const id of members) {
        const hit = fuzzyMatch(q, id);
        if (hit) hits.push({ kind: "node", id, positions: hit.positions, score: hit.score });
      }
      hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
      return hits.slice(0, limit);
    }

    if (q === "") {
      return SUGGESTED_FILES.map((id) => ({ kind: "node" as const, id, positions: [] }));
    }
    const hits: (SearchRow & { score: number })[] = [];
    for (const n of NODES) {
      if (n.type === "root") continue;
      const hit = fuzzyMatch(q, n.id);
      if (hit) hits.push({ kind: "node", id: n.id, positions: hit.positions, score: hit.score });
    }
    hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return hits.slice(0, limit);
  }, [query, tab, limit]);
}
