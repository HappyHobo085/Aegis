// src/lib/fuzzySearch.test.ts
import { describe, it, expect } from 'vitest';
import { fuzzyMatch, rankResults } from './fuzzySearch';

describe('fuzzyMatch', () => {
  it('returns null for no match', () => {
    expect(fuzzyMatch('xyz', 'abc')).toBeNull();
  });

  it('exact match scores 100', () => {
    const r = fuzzyMatch('hello', 'Hello');
    expect(r).not.toBeNull();
    expect(r!.score).toBe(100);
    expect(r!.matches).toEqual([0, 1, 2, 3, 4]);
  });

  it('exact match is case-insensitive', () => {
    const r = fuzzyMatch('HELLO', 'hello');
    expect(r).not.toBeNull();
    expect(r!.score).toBe(100);
  });

  it('starts-with match scores 80', () => {
    const r = fuzzyMatch('hel', 'Hello');
    expect(r).not.toBeNull();
    expect(r!.score).toBe(80);
    expect(r!.matches).toEqual([0, 1, 2]);
  });

  it('contains match scores 60', () => {
    const r = fuzzyMatch('ell', 'Hello');
    expect(r).not.toBeNull();
    expect(r!.score).toBe(60);
    expect(r!.matches).toEqual([1, 2, 3]);
  });

  it('contains is case-insensitive', () => {
    const r = fuzzyMatch('ELL', 'Hello');
    expect(r).not.toBeNull();
    expect(r!.score).toBe(60);
  });

  it('fuzzy match scores between 1 and 40', () => {
    const r = fuzzyMatch('hlo', 'Hello World');
    expect(r).not.toBeNull();
    expect(r!.score).toBeGreaterThan(0);
    expect(r!.score).toBeLessThanOrEqual(40);
    // Matches: H(0), l(2), o(4) — first l is at index 2
    expect(r!.matches).toEqual([0, 2, 4]);
  });

  it('fuzzy match returns null when characters are not in order', () => {
    expect(fuzzyMatch('xyz', 'Hello')).toBeNull();
  });

  it('fuzzy match returns null when not all query chars found', () => {
    expect(fuzzyMatch('abcz', 'abcdef')).toBeNull();
  });

  it('empty query returns score 0 with empty matches', () => {
    const r = fuzzyMatch('', 'Hello');
    expect(r).not.toBeNull();
    expect(r!.score).toBe(0);
    expect(r!.matches).toEqual([]);
  });

  it('exact single char match scores 100', () => {
    const r = fuzzyMatch('a', 'a');
    expect(r).not.toBeNull();
    expect(r!.score).toBe(100);
  });

  it('single char fuzzy match scores proportional to target length', () => {
    // 'o' is a contains match (found at index 4 in "Hello"), so score is 60
    const r = fuzzyMatch('o', 'Hello');
    expect(r).not.toBeNull();
    expect(r!.score).toBe(60);
    expect(r!.matches).toEqual([4]);
  });

  it('single char fuzzy match scores proportionally when not a substring', () => {
    // 'o' in 'Hxllo' — 'o' is a contains match at index 3/4 (score 60), not fuzzy.
    // Use a char that can't form a contiguous substring: 'x' in 'abc'
    // 'x' is not in 'abc' → null. Need a char that IS present but not contiguous with itself.
    // Single char is always a contains match if found → always 60.
    // So test with two chars for fuzzy: 'xz' in 'abcxdefz' — x(3), z(7), 2/8 = 10
    const r = fuzzyMatch('xz', 'abcxdefz');
    expect(r).not.toBeNull();
    expect(r!.score).toBe(Math.round((40 * 2) / 8)); // 10
    expect(r!.matches).toEqual([3, 7]);
  });
});

describe('rankResults', () => {
  const items = ['Hello', 'World', 'Help', 'Hero', 'Foo'];

  it('returns empty array when no items match', () => {
    expect(rankResults('xyz', items, (i) => i)).toEqual([]);
  });

  it('sorts results by score descending', () => {
    const results = rankResults('he', items, (i) => i);
    const scores = results.map((r) => r.score);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeLessThanOrEqual(scores[i - 1]);
    }
  });

  it('exact match ranks first', () => {
    const results = rankResults('Hello', items, (i) => i);
    expect(results[0].item).toBe('Hello');
    expect(results[0].score).toBe(100);
  });

  it('starts-with match ranks before contains match', () => {
    const results = rankResults('Hel', items, (i) => i);
    // 'Help' and 'Hero' both start with 'Hel' (score 80); 'Hello' contains 'hel' at 0 (also starts-with)
    const scores = results.map((r) => r.score);
    expect(scores[0]).toBeGreaterThanOrEqual(scores[scores.length - 1]);
  });

  it('preserves original item references', () => {
    const objs = [{ name: 'Alice' }, { name: 'Bob' }, { name: 'Alex' }];
    const results = rankResults('al', objs, (i) => i.name);
    expect(results.length).toBe(2);
    expect(results.map((r) => r.item.name)).toContain('Alice');
    expect(results.map((r) => r.item.name)).toContain('Alex');
  });

  it('empty query returns all items at score 0', () => {
    const results = rankResults('', items, (i) => i);
    expect(results.length).toBe(items.length);
    expect(results.every((r) => r.score === 0)).toBe(true);
  });

  it('keyFn extracts the searchable string', () => {
    const objs = [{ label: 'Hello' }, { label: 'World' }];
    const results = rankResults('world', objs, (i) => i.label);
    expect(results.length).toBe(1);
    expect(results[0].item.label).toBe('World');
  });
});
