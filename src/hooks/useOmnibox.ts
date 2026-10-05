// src/hooks/useOmnibox.ts
//
// Owns the address-bar suggestion list: the debounced history lookup, the merged
// ranking (see lib/omnibox.ts), and the active-row cursor for keyboard navigation.
//
// Split of responsibility:
//   lib/omnibox.ts   — pure ranking (unit-tested without React or IPC)
//   this hook        — IPC + timing + the active index
//   OmniboxDropdown  — presentation only
//
// `dismissed` is deliberately separate from `active`: Escape/blur closes the list
// while the input keeps focus, and any subsequent keystroke re-opens it.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Favorite, HistoryEntry, PopoverPick, SavedItem } from '../../shared/types';
import { aegis } from '../lib/ipcClient';
import { buildOmniboxSuggestions } from '../lib/omnibox';
import type { OmniboxSuggestion } from '../lib/omnibox';

/** How long to wait after the last keystroke before querying history. */
const DEBOUNCE_MS = 90;

/** The popover id the omnibox owns. Part of `PopoverId`, and Rust drops a pick whose id is not
 *  the one it currently has placed — so this is a filter, not a lookup. */
const POPOVER_ID = 'address-omnibox';

export interface UseOmniboxArgs {
  /** The current text of the address-bar input (controlled by the caller). */
  query: string;
  /** The input has focus — the list is only eligible to open while focused. */
  active: boolean;
  favorites: Favorite[];
  saved: SavedItem[];
  searchTemplate: string;
  /** Escape/blur closed the list for the current text. */
  dismissed: boolean;
  /** Called with the chrome's OWN suggestion object when the popover surface reports that row
   *  as picked. The surface only ever sends an INDEX — Rust bounds-checks it against the
   *  `itemCount` this hook's caller declared, and this hook then resolves it against the array
   *  it built. Passing the object rather than letting the caller re-index is what makes "the
   *  chrome acts on its own data" structural instead of a convention. */
  onPickSuggestion(suggestion: OmniboxSuggestion): void;
}

export interface UseOmnibox {
  suggestions: OmniboxSuggestion[];
  /** The dropdown should be visible. */
  open: boolean;
  /** Index into `suggestions`, or -1 for "nothing highlighted". */
  activeIndex: number;
  /** Move the highlight by `delta`, wrapping at both ends. */
  moveActive(delta: number): void;
  setActiveIndex(index: number): void;
}

export function useOmnibox(args: UseOmniboxArgs): UseOmnibox {
  const { query, active, favorites, saved, searchTemplate, dismissed, onPickSuggestion } = args;
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);

  // Monotonic token: only the newest query's result may land, so a slow earlier
  // request can't overwrite a fast later one while the user is still typing.
  const seq = useRef(0);
  const trimmed = query.trim();

  const suggestions = useMemo(
    () => buildOmniboxSuggestions({ query, history, favorites, saved, searchTemplate }),
    [query, history, favorites, saved, searchTemplate],
  );

  // The rows and the callback, held in refs so the pick subscription can be armed ONCE for the
  // hook's life and still read the values as they are NOW. Re-subscribing per keystroke would
  // leave a window on every render in which a pick is delivered to nobody — which is a click
  // that silently does nothing, the exact failure the handshake exists to prevent on the
  // surface's side. Synced in an effect rather than during render so a render that is thrown
  // away (StrictMode, a suspended render) cannot leave the ref pointing at rows that were never
  // committed.
  const rowsRef = useRef<OmniboxSuggestion[]>(suggestions);
  const onPickRef = useRef(onPickSuggestion);
  useEffect(() => {
    rowsRef.current = suggestions;
    onPickRef.current = onPickSuggestion;
  });

  // FIRST effect deliberately, and `subscribeBeforeFetch.test.tsx` holds it there: this hook
  // both subscribes and seeds, so a pick arriving inside the seed's window would otherwise be
  // lost. The seed is behind a 90 ms debounce, which makes that window wide.
  useEffect(() => {
    return aegis.popover.onPicked((pick: PopoverPick) => {
      // Another popover's pick. One surface serves all four, so this filter is load-bearing.
      if (pick.id !== POPOVER_ID) return;
      const rows = rowsRef.current;
      const { index } = pick;
      // Re-checked here even though Rust already bounds-checked it: the registry can be a
      // render behind this array, and picking `rows[undefined]` would navigate to nothing.
      if (typeof index !== 'number' || !Number.isInteger(index)) return;
      if (index < 0 || index >= rows.length) return;
      if (pick.action === 'hover') {
        setActiveIndex(index);
        return;
      }
      // An absent action means a bare row pick. Anything else this hook does not know is
      // ignored rather than guessed at: an unknown action is a version skew, and acting on it
      // would mean running a command whose meaning the surface invented.
      if (pick.action === undefined || pick.action === 'pick') {
        onPickRef.current(rows[index]);
      }
    });
  }, []);

  useEffect(() => {
    if (!active) return;
    const mine = ++seq.current;
    const timer = window.setTimeout(() => {
      const request = trimmed.length > 0 ? aegis.history.search(trimmed) : aegis.history.list();
      void request
        .then((entries) => {
          if (mine !== seq.current) return;
          // The IPC boundary is untyped in practice (a backend that fails to
          // deserialize hands back the raw `{}` of invoke), so never trust the
          // shape to be an array — the ranking code indexes and sorts it.
          setHistory(Array.isArray(entries) ? entries : []);
        })
        .catch(() => {
          if (mine !== seq.current) return;
          setHistory([]);
        });
    }, DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      // Invalidate the in-flight request if the effect re-runs before it resolves.
      if (mine === seq.current) seq.current += 1;
    };
  }, [trimmed, active]);

  // Only open when there is something to show. Every non-empty query yields at
  // least the "Search for …" row, so in practice this gates the empty-query case
  // (no focus, or nothing in history yet).
  const open = active && !dismissed && suggestions.length > 0;

  // The cursor is meaningless once the list shrinks or the text changes, so clamp
  // it to the current rows. A background history refresh that returns the same
  // number of rows therefore preserves the user's arrow-key position.
  useEffect(() => {
    setActiveIndex((prev) => (prev < 0 ? -1 : Math.min(prev, suggestions.length - 1)));
  }, [suggestions.length, trimmed]);

  const moveActive = useCallback(
    (delta: number) => {
      setActiveIndex((prev) => {
        if (suggestions.length === 0) return -1;
        const from = prev < 0 ? (delta > 0 ? -1 : 0) : prev;
        return (from + delta + suggestions.length) % suggestions.length;
      });
    },
    [suggestions.length],
  );

  return { suggestions, open, activeIndex, moveActive, setActiveIndex };
}
