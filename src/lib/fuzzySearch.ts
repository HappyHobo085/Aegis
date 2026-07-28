// src/lib/fuzzySearch.ts
//
// Lightweight fuzzy search for the command palette.
// No external dependencies — pure string logic.

export interface FuzzyResult {
  score: number;
  /** Indices of matched characters in the original `target`. */
  matches: number[];
}

/**
 * Fuzzy-match `query` against `target` (case-insensitive).
 *
 * Scoring tiers:
 *   100  — exact match (query === target, ignoring case)
 *   80   — target starts with query
 *   60   — target contains query as a substring
 *   0-40 — character-by-character fuzzy match (score = 40 × matched/total)
 *
 * Returns `null` when no match is found.
 */
export function fuzzyMatch(query: string, target: string): FuzzyResult | null {
  if (query.length === 0) {
    // Empty query matches everything at the lowest score so rankResults can
    // still sort (all items tie at 0).
    return { score: 0, matches: [] };
  }

  const q = query.toLowerCase();
  const t = target.toLowerCase();

  // Exact match
  if (t === q) {
    return { score: 100, matches: Array.from({ length: target.length }, (_, i) => i) };
  }

  // Starts-with
  if (t.startsWith(q)) {
    return { score: 80, matches: Array.from({ length: q.length }, (_, i) => i) };
  }

  // Contains substring
  const idx = t.indexOf(q);
  if (idx !== -1) {
    return {
      score: 60,
      matches: Array.from({ length: q.length }, (_, i) => idx + i),
    };
  }

  // Fuzzy — each query char must appear in order inside the target
  const matches: number[] = [];
  let ti = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    while (ti < t.length) {
      if (t[ti] === ch) {
        matches.push(ti);
        ti++;
        break;
      }
      ti++;
    }
    // Query char not found
    if (matches.length <= qi) {
      return null;
    }
  }

  // Score proportional to what fraction of the target was consumed
  const score = Math.round((40 * matches.length) / t.length);
  return { score: Math.max(1, score), matches };
}

export interface RankedItem<T> {
  item: T;
  score: number;
  matches: number[];
}

/**
 * Fuzzy-match every item, drop non-matches, and sort descending by score.
 */
export function rankResults<T>(
  query: string,
  items: T[],
  keyFn: (item: T) => string,
): Array<RankedItem<T>> {
  const results: RankedItem<T>[] = [];
  for (const item of items) {
    const result = fuzzyMatch(query, keyFn(item));
    if (result !== null) {
      results.push({ item, score: result.score, matches: result.matches });
    }
  }
  results.sort((a, b) => b.score - a.score);
  return results;
}
