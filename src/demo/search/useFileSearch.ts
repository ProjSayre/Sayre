import { useMemo } from "react";
import { NODES, SUGGESTED_FILES } from "../../data";
import { fuzzyMatch } from "./fuzzy";

export interface SearchRow {
  id: string;
  positions: number[];
}

/** fuzzy rows for a query — empty query returns the suggested hero files (§10) */
export function useFileSearch(query: string, limit = 8): SearchRow[] {
  return useMemo<SearchRow[]>(() => {
    if (query.trim() === "") {
      return SUGGESTED_FILES.map((id) => ({ id, positions: [] }));
    }
    const hits: { id: string; score: number; positions: number[] }[] = [];
    for (const n of NODES) {
      if (n.type === "root") continue;
      const hit = fuzzyMatch(query.trim(), n.id);
      if (hit) hits.push({ id: n.id, score: hit.score, positions: hit.positions });
    }
    hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return hits.slice(0, limit);
  }, [query, limit]);
}
