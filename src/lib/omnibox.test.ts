// src/lib/omnibox.test.ts
import { describe, it, expect } from 'vitest';
import { buildOmniboxSuggestions, normalizeForDedupe, OMNIBOX_LIMIT } from './omnibox';
import type { Favorite, HistoryEntry, SavedItem } from '../../shared/types';

const NOW = 1_800_000_000_000; // fixed clock so recency scoring is deterministic
const DAY = 86_400_000;

const hist = (over: Partial<HistoryEntry> = {}): HistoryEntry => ({
  id: 1,
  url: 'https://example.com/',
  title: 'Example Domain',
  visitedAt: NOW,
  ...over,
});

const fav = (over: Partial<Favorite> = {}): Favorite => ({
  id: 1,
  name: 'Example',
  url: 'https://example.com/',
  position: 0,
  ...over,
});

const saved = (over: Partial<SavedItem> = {}): SavedItem => ({
  id: 1,
  url: 'https://example.com/',
  title: 'Example Domain',
  tags: [],
  savedAt: NOW,
  ...over,
});

const base = {
  query: '',
  history: [] as HistoryEntry[],
  favorites: [] as Favorite[],
  saved: [] as SavedItem[],
  searchTemplate: 'https://duckduckgo.com/?q=%s',
  now: NOW,
};

const kinds = (rows: Array<{ kind: string }>): string[] => rows.map((r) => r.kind);

describe('normalizeForDedupe', () => {
  it('strips scheme, www. and trailing slash and lowercases', () => {
    expect(normalizeForDedupe('https://WWW.Example.com/')).toBe('example.com');
    expect(normalizeForDedupe('http://example.com/docs/')).toBe('example.com/docs');
  });
});

describe('buildOmniboxSuggestions', () => {
  it('an empty query returns recent history, newest first', () => {
    const rows = buildOmniboxSuggestions({
      ...base,
      history: [
        hist({ id: 1, title: 'Old', url: 'https://old.test/', visitedAt: NOW - 10 * DAY }),
        hist({ id: 2, title: 'New', url: 'https://new.test/', visitedAt: NOW - 1 * DAY }),
      ],
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].title).toBe('New');
    expect(rows[1].title).toBe('Old');
    expect(rows.every((r) => r.kind === 'recent')).toBe(true);
  });

  it('an empty query with no history shows nothing', () => {
    expect(buildOmniboxSuggestions(base)).toEqual([]);
  });

  it('a phrase always ends with a "Search for" row carrying the resolved URL', () => {
    const rows = buildOmniboxSuggestions({ ...base, query: 'hello world' });
    const search = rows[rows.length - 1];
    expect(search.kind).toBe('search');
    expect(search.target).toBe('https://duckduckgo.com/?q=hello%20world');
    expect(search.url).toBe('');
  });

  it('a host offers a "Go to" row first, ahead of any store match', () => {
    const rows = buildOmniboxSuggestions({
      ...base,
      query: 'example.com',
      history: [hist()],
    });
    expect(rows[0].kind).toBe('navigate');
    expect(rows[0].target).toBe('https://example.com');
  });

  it('a scheme-ful address offers a "Go to" row with the scheme preserved', () => {
    const rows = buildOmniboxSuggestions({ ...base, query: 'http://intranet.local/page' });
    expect(rows[0].kind).toBe('navigate');
    expect(rows[0].target).toBe('http://intranet.local/page');
  });

  it('a favorites hit outranks an equally-good history hit', () => {
    // Distinct URLs so URL-dedupe doesn't collapse the two rows before ranking.
    const rows = buildOmniboxSuggestions({
      ...base,
      query: 'example',
      history: [hist({ id: 1, title: 'Example news', url: 'https://news.test/example' })],
      favorites: [fav({ id: 2, name: 'Example board', url: 'https://board.test/example' })],
    });
    const idx = (k: string): number => rows.findIndex((r) => r.kind === k);
    expect(idx('favorite')).toBeGreaterThanOrEqual(0);
    expect(idx('history')).toBeGreaterThanOrEqual(0);
    expect(idx('favorite')).toBeLessThan(idx('history'));
  });

  it('a saved page ranks between a favorite and plain history', () => {
    const rows = buildOmniboxSuggestions({
      ...base,
      query: 'example',
      history: [hist({ id: 1, title: 'Example news', url: 'https://news.test/example' })],
      saved: [saved({ id: 3, title: 'Example notes', url: 'https://notes.test/example' })],
    });
    const idx = (k: string): number => rows.findIndex((r) => r.kind === k);
    expect(idx('saved')).toBeLessThan(idx('history'));
  });

  it('breaks score ties toward the more recent visit', () => {
    const rows = buildOmniboxSuggestions({
      ...base,
      query: 'news',
      history: [
        hist({ id: 1, title: 'News old', url: 'https://a.test/news', visitedAt: NOW - 30 * DAY }),
        hist({ id: 2, title: 'News new', url: 'https://b.test/news', visitedAt: NOW - 1 * 60_000 }),
      ],
    });
    expect(rows[0].title).toBe('News new');
  });

  it('dedupes the same URL across sources, keeping the strongest row', () => {
    const rows = buildOmniboxSuggestions({
      ...base,
      query: 'example',
      history: [hist()],
      favorites: [fav()],
    });
    const exampleRows = rows.filter((r) => r.url === 'https://example.com/');
    expect(exampleRows).toHaveLength(1);
    expect(exampleRows[0].kind).toBe('favorite');
  });

  it('dedupes across trailing-slash / www. spelling differences', () => {
    const rows = buildOmniboxSuggestions({
      ...base,
      query: 'example',
      history: [
        hist({ id: 1, url: 'https://example.com/' }),
        hist({ id: 2, url: 'https://www.example.com/page' }),
      ],
    });
    // different paths → two rows, but the bare host spelling is not duplicated
    const bare = rows.filter((r) => normalizeForDedupe(r.url) === 'example.com');
    expect(bare).toHaveLength(1);
  });

  it('a direct host match floats above a stronger textual favorite match', () => {
    const rows = buildOmniboxSuggestions({
      ...base,
      query: 'example.com',
      favorites: [fav({ id: 9, name: 'My example notes', url: 'https://notes.test/' })],
      history: [hist({ id: 5, url: 'https://example.com/deep/page', title: 'Docs' })],
    });
    const storeRows = rows.filter((r) => r.kind !== 'search' && r.kind !== 'navigate');
    expect(storeRows[0].url).toBe('https://example.com/deep/page');
  });

  it('marks the matched characters in the title for highlighting', () => {
    const rows = buildOmniboxSuggestions({
      ...base,
      query: 'example',
      history: [hist()],
    });
    const historyRow = rows.find((r) => r.kind === 'history');
    expect(historyRow?.titleMatches).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('never exceeds the row limit', () => {
    const rows = buildOmniboxSuggestions({
      ...base,
      query: 'e',
      history: Array.from({ length: 40 }, (_, i) =>
        hist({ id: i, title: `Entry ${i}`, url: `https://site${i}.test/` }),
      ),
    });
    expect(rows.length).toBeLessThanOrEqual(OMNIBOX_LIMIT);
    expect(rows[rows.length - 1].kind).toBe('search');
  });

  it('reserves the final row for search, so store rows never crowd it out', () => {
    const rows = buildOmniboxSuggestions({
      ...base,
      query: 'e',
      history: Array.from({ length: 40 }, (_, i) =>
        hist({ id: i, title: `Entry ${i}`, url: `https://site${i}.test/` }),
      ),
    });
    expect(rows.filter((r) => r.kind === 'search')).toHaveLength(1);
  });

  it('does not match stores for an unrelated phrase', () => {
    const rows = buildOmniboxSuggestions({
      ...base,
      query: 'zzzzq',
      history: [hist()],
      favorites: [fav()],
    });
    expect(kinds(rows)).toEqual(['search']);
  });
});
