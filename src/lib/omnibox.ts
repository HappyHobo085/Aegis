// src/lib/omnibox.ts
//
// Pure ranking logic for the address-bar suggestion list (the "omnibox").
// No React, no IPC — everything here is a deterministic function of the query plus
// the caller-supplied stores, so it is unit-testable and reused by both shells
// (the desktop AddressBar and the Android MobileTopBar).
//
// Ordering contract, highest priority first:
//   1. "Go to …"      — only when the typed text is an address, not a phrase.
//   2. Favorites      — user-pinned, so they outrank equally-good history hits.
//   3. Saved pages    — explicitly kept by the user.
//   4. History        — best match wins; ties break toward the more recent visit.
//   5. "Search for …" — always last, as the escape hatch for a phrase.

import type { Favorite, HistoryEntry, SavedItem } from '../../shared/types';
import { addressParse, isUrlLikeInput } from './addressParse';
import { fuzzyMatch } from './fuzzySearch';

export type OmniboxKind = 'navigate' | 'favorite' | 'saved' | 'history' | 'recent' | 'search';

export interface OmniboxSuggestion {
  /** Stable per-render key (also the listbox option id). */
  id: string;
  kind: OmniboxKind;
  /** Primary label: page title, bookmark name, or the typed phrase. */
  title: string;
  /** Secondary label: the URL (empty for a search row). */
  url: string;
  /** Exactly what Enter navigates to — a concrete http(s) URL. */
  target: string;
  /** Indices in `title` to emphasise; empty when the match came from the URL. */
  titleMatches: number[];
  /** Indices in `url` to emphasise. */
  urlMatches: number[];
}

/** Rows shown at once. Chrome shows ~8; the list scrolls beyond that. */
export const OMNIBOX_LIMIT = 8;
/** Rows shown for an empty query (the "Recent" jump-back list). */
export const OMNIBOX_RECENT_LIMIT = 6;

// Source weights. A favorite the user pinned outranks an identical history hit;
// a saved page sits between the two.
const FAVORITE_WEIGHT = 30;
const SAVED_WEIGHT = 14;
const HISTORY_WEIGHT = 0;
/** Most-recent history bonus, in score points, decaying to 0 after ~3 days. */
const RECENCY_WEIGHT = 12;
const RECENCY_HALF_LIFE_DAYS = 1.5;
/** Bonus when the query IS the host of the candidate (a direct hit). */
const HOST_MATCH_BONUS = 60;

const DAY_MS = 86_400_000;

/** Scheme + `www.` + trailing slash removed, so `https://A.com/` and `a.com` dedupe. */
export function normalizeForDedupe(url: string): string {
  return url
    .trim()
    .replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '')
    .replace(/^www\./i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** Match quality of `query` against one candidate, as { score, title, url } matches. */
function scoreCandidate(
  query: string,
  title: string,
  url: string,
): { score: number; titleMatches: number[]; urlMatches: number[] } {
  const titleHit = fuzzyMatch(query, title);
  const urlHit = url.length > 0 ? fuzzyMatch(query, url) : null;
  // Rank on the better of the two, but remember where it came from so the caller
  // can highlight the right string. A title hit always wins the highlight.
  const useTitle = titleHit !== null && (urlHit === null || titleHit.score >= urlHit.score);
  const score = useTitle ? titleHit!.score : (urlHit?.score ?? 0);
  return {
    score,
    titleMatches: useTitle ? titleHit!.matches : [],
    urlMatches: useTitle ? (urlHit?.matches ?? []) : (urlHit?.matches ?? []),
  };
}

function recencyBonus(visitedAt: number, now: number): number {
  const ageDays = Math.max(0, (now - visitedAt) / DAY_MS);
  return Math.max(0, RECENCY_WEIGHT * Math.exp(-ageDays / RECENCY_HALF_LIFE_DAYS));
}

export interface OmniboxInput {
  query: string;
  history: HistoryEntry[];
  favorites: Favorite[];
  saved: SavedItem[];
  /** The active search template (`…?q=%s`) used for the "Search for …" row. */
  searchTemplate: string;
  /** Injected for deterministic tests. */
  now?: number;
  limit?: number;
}

interface Candidate {
  kind: Exclude<OmniboxKind, 'navigate' | 'search' | 'recent'>;
  id: string;
  title: string;
  url: string;
  score: number;
  titleMatches: number[];
  urlMatches: number[];
}

/**
 * Build the ranked suggestion list for `query`.
 *
 * An empty query returns the most recently visited pages (Chrome's "top sites"
 * behaviour on focus) so the dropdown is useful before a single keystroke.
 */
export function buildOmniboxSuggestions(input: OmniboxInput): OmniboxSuggestion[] {
  const { history, favorites, saved, searchTemplate } = input;
  const now = input.now ?? Date.now();
  const query = input.query.trim();
  const limit = input.limit ?? OMNIBOX_LIMIT;

  // ── Empty query: recent history, newest first ──────────────────────────
  if (query.length === 0) {
    const recentLimit = Math.min(limit, OMNIBOX_RECENT_LIMIT);
    return [...history]
      .sort((a, b) => b.visitedAt - a.visitedAt)
      .slice(0, recentLimit)
      .map<OmniboxSuggestion>((entry) => ({
        id: `recent:${entry.id}`,
        kind: 'recent',
        title: entry.title || entry.url,
        url: entry.url,
        target: entry.url,
        titleMatches: [],
        urlMatches: [],
      }));
  }

  const queryHost = isUrlLikeInput(query) ? normalizeForDedupe(query).split('/')[0] : '';
  const candidates: Candidate[] = [];

  for (const fav of favorites) {
    const { score, titleMatches, urlMatches } = scoreCandidate(query, fav.name, fav.url);
    if (score <= 0) continue;
    candidates.push({
      kind: 'favorite',
      id: `favorite:${fav.id}`,
      title: fav.name,
      url: fav.url,
      score: score + FAVORITE_WEIGHT,
      titleMatches,
      urlMatches,
    });
  }

  for (const item of saved) {
    const { score, titleMatches, urlMatches } = scoreCandidate(query, item.title, item.url);
    if (score <= 0) continue;
    candidates.push({
      kind: 'saved',
      id: `saved:${item.id}`,
      title: item.title || item.url,
      url: item.url,
      score: score + SAVED_WEIGHT,
      titleMatches,
      urlMatches,
    });
  }

  for (const entry of history) {
    const { score, titleMatches, urlMatches } = scoreCandidate(query, entry.title, entry.url);
    if (score <= 0) continue;
    candidates.push({
      kind: 'history',
      id: `history:${entry.id}`,
      title: entry.title || entry.url,
      url: entry.url,
      score: score + HISTORY_WEIGHT + recencyBonus(entry.visitedAt, now),
      titleMatches,
      urlMatches,
    });
  }

  // Rank, then drop duplicate URLs keeping the strongest (a bookmarked page should
  // not also appear as a bare history row).
  candidates.sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  const ranked: Candidate[] = [];
  for (const candidate of candidates) {
    const key = normalizeForDedupe(candidate.url);
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    ranked.push(candidate);
  }

  // A direct host hit floats to the very top, above favorites with a weaker
  // textual match — typing the address you want should never be out-ranked.
  if (queryHost.length > 0) {
    const exact = ranked.find((c) => normalizeForDedupe(c.url).split('/')[0] === queryHost);
    if (exact) {
      exact.score += HOST_MATCH_BONUS;
      ranked.sort((a, b) => b.score - a.score);
    }
  }

  // The "Search for …" row is the escape hatch for a phrase — but only when
  // there is a real template to build it from. A missing/blank template (the
  // AddressBar renders without stores, unit tests) would otherwise produce a row
  // that navigates to the empty string, so the row is dropped and its reserved
  // slot goes to the store rows instead.
  const canSearch = searchTemplate.includes('%s');

  // Reserve the last row for the "Search for …" escape hatch, so at most
  // `limit - 1` store rows precede it.
  const head: OmniboxSuggestion[] = [];
  if (isUrlLikeInput(query)) {
    const parsed = addressParse(query, { currentUrl: '', searchTemplate });
    if (parsed.kind === 'navigate') {
      head.push({
        id: 'navigate:0',
        kind: 'navigate',
        title: `Go to ${parsed.url}`,
        url: parsed.url,
        target: parsed.url,
        titleMatches: [],
        urlMatches: [],
      });
    }
  }

  const storeRows = ranked.slice(0, Math.max(0, limit - head.length - (canSearch ? 1 : 0)));
  const rows: OmniboxSuggestion[] = [
    ...head,
    ...storeRows.map<OmniboxSuggestion>((c) => ({
      id: c.id,
      kind: c.kind,
      title: c.title,
      url: c.url,
      target: c.url,
      titleMatches: c.titleMatches,
      urlMatches: c.urlMatches,
    })),
  ];

  if (canSearch) {
    rows.push({
      id: 'search:0',
      kind: 'search',
      title: `Search for “${query}”`,
      url: '',
      target: searchTemplate.replace('%s', encodeURIComponent(query)),
      titleMatches: [],
      urlMatches: [],
    });
  }

  return rows;
}
