// Hand-rolled subsequence fuzzy matcher (§10). Case-insensitive over the full
// path; score = contiguity + earliness + filename-hit bonus.

export interface FuzzyHit {
  score: number;
  positions: number[];
}

export function fuzzyMatch(query: string, target: string): FuzzyHit | null {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (q.length === 0) return { score: 0, positions: [] };
  if (q.length > t.length) return null;

  const filenameStart = target.lastIndexOf("/") + 1;
  const positions: number[] = [];
  let score = 0;
  let ti = 0;
  let prev = -2;

  for (let qi = 0; qi < q.length; qi++) {
    const idx = t.indexOf(q[qi], ti);
    if (idx === -1) return null;
    positions.push(idx);
    score += 2;
    if (idx === prev + 1) score += 3; // contiguity
    if (idx >= filenameStart) score += 2; // filename hit
    prev = idx;
    ti = idx + 1;
  }

  // earliness: earlier first hits rank higher
  score += Math.max(0, 12 - positions[0] * 0.25);
  // shorter targets win ties
  score += Math.max(0, 6 - target.length * 0.02);
  return { score, positions };
}
