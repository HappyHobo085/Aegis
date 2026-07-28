// src/components/CommandPalette.tsx
//
// Global command palette (Ctrl+K) — fuzzy-searches tabs, bookmarks, history,
// actions, and settings in one unified, sectioned list. Keyboard-navigable,
// with highlighted match characters and recent-actions recall.

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { useDialog } from '../hooks/useDialog';
import { useChromeSurface } from '../hooks/useChromeSurfaces';
import { fuzzyMatch } from '../lib/fuzzySearch';
import type { FuzzyResult } from '../lib/fuzzySearch';
import { addRecent, getRecent } from '../lib/recentActions';
import {
  getTabResults,
  getBookmarkResults,
  getHistoryResults,
  getActionResults,
  getSettingsResults,
} from '../lib/commandPaletteData';
import type { PaletteResult } from '../lib/commandPaletteData';

// ── Backward-compatible legacy type (App.tsx / MobileApp.tsx may still import) ─

/** @deprecated Use PaletteResult from commandPaletteData.ts instead. */
export interface CommandAction {
  id: string;
  title: string;
  subtitle?: string;
  keywords?: string;
  group?: string;
  run(): void;
  secondaryLabel?: string;
  secondaryRun?(): void;
}

export interface CommandPaletteProps {
  open: boolean;
  /** @deprecated Pass nothing — results are fetched from commandPaletteData. */
  actions?: CommandAction[];
  onClose(): void;
}

// ── Section ordering ──────────────────────────────────────────────────────────

const SECTION_ORDER: PaletteResult['category'][] = [
  'tabs',
  'bookmarks',
  'history',
  'actions',
  'settings',
];

const SECTION_LABELS: Record<PaletteResult['category'], string> = {
  tabs: 'Tabs',
  bookmarks: 'Bookmarks',
  history: 'History',
  actions: 'Actions',
  settings: 'Settings',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Render a string with fuzzy-matched characters wrapped in <mark>. */
function HighlightedTitle({ text, matches }: { text: string; matches: number[] }) {
  if (matches.length === 0) return <>{text}</>;
  const matchSet = new Set(matches);
  const parts: React.ReactNode[] = [];
  let buf = '';
  for (let i = 0; i < text.length; i++) {
    if (matchSet.has(i)) {
      if (buf) {
        parts.push(buf);
        buf = '';
      }
      parts.push(
        <mark key={i} className="command-palette__highlight">
          {text[i]}
        </mark>,
      );
    } else {
      buf += text[i];
    }
  }
  if (buf) parts.push(buf);
  return <>{parts}</>;
}

/** A row in the flat list — either a section header or a result item. */
interface FlatRow {
  kind: 'header';
  label: string;
  key: string;
}
interface FlatItem {
  kind: 'item';
  result: PaletteResult;
  matches: number[];
  flatIndex: number;
  key: string;
}
type FlatEntry = FlatRow | FlatItem;

// ── Component ─────────────────────────────────────────────────────────────────

export function CommandPalette({ open, onClose }: CommandPaletteProps) {
  useChromeSurface('commandPalette', open);

  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [recentIds, setRecentIds] = useState<string[]>(() => getRecent());
  const titleId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const dialogRef = useDialog<HTMLDivElement>(onClose, { initialFocus: inputRef });

  // ── Fetch all result sets on each keystroke ───────────────────────────────

  const [tabResults, setTabResults] = useState<PaletteResult[]>([]);
  const [bookmarkResults, setBookmarkResults] = useState<PaletteResult[]>([]);
  const [historyResults, setHistoryResults] = useState<PaletteResult[]>([]);

  const actionResults = useMemo(() => getActionResults(query), [query]);
  const settingsResults = useMemo(() => getSettingsResults(query), [query]);

  // Fire async fetchers on each query change (debounced 200ms)
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      const q = query;
      void getTabResults(q).then((r) => {
        if (!cancelled) setTabResults(r);
      });
      void getBookmarkResults(q).then((r) => {
        if (!cancelled) setBookmarkResults(r);
      });
      void getHistoryResults(q).then((r) => {
        if (!cancelled) setHistoryResults(r);
      });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  // ── Recent results (shown when query is empty) ────────────────────────────

  const recentResults = useMemo<PaletteResult[]>(() => {
    if (query.trim().length > 0) return [];
    // Collect all results from all categories (empty query = everything matches)
    const all = [
      ...tabResults,
      ...bookmarkResults,
      ...historyResults,
      ...actionResults,
      ...settingsResults,
    ];
    // Return only the last-5 recent ones, preserving recent order
    return recentIds
      .map((id) => all.find((r) => r.id === id))
      .filter((r): r is PaletteResult => r !== undefined);
  }, [
    query,
    recentIds,
    tabResults,
    bookmarkResults,
    historyResults,
    actionResults,
    settingsResults,
  ]);

  // ── Merge, group, build flat list ─────────────────────────────────────────

  const { flatEntries, totalItems } = useMemo(() => {
    const grouped = new Map<PaletteResult['category'], PaletteResult[]>();
    const categorized = new Set<PaletteResult>();

    if (query.trim().length === 0 && recentResults.length > 0) {
      // Show recent as a flat list under a "Recent" header
      const entries: FlatEntry[] = [
        { kind: 'header', label: 'Recent', key: 'hdr:recent' },
        ...recentResults.map((r, i) => ({
          kind: 'item' as const,
          result: r,
          matches: [] as number[],
          flatIndex: i,
          key: r.id,
        })),
      ];
      return { flatEntries: entries, totalItems: entries.filter((e) => e.kind === 'item').length };
    }

    // Populate groups in section order
    const sources: [PaletteResult['category'], PaletteResult[]][] = [
      ['tabs', tabResults],
      ['bookmarks', bookmarkResults],
      ['history', historyResults],
      ['actions', actionResults],
      ['settings', settingsResults],
    ];

    for (const [cat, items] of sources) {
      if (items.length > 0) {
        grouped.set(cat, items);
        for (const item of items) categorized.add(item);
      }
    }

    const entries: FlatEntry[] = [];
    let flatIdx = 0;
    for (const cat of SECTION_ORDER) {
      const items = categorized.size > 0 ? grouped.get(cat) : undefined;
      if (!items || items.length === 0) continue;
      entries.push({ kind: 'header', label: SECTION_LABELS[cat], key: `hdr:${cat}` });
      for (const result of items) {
        // Re-run fuzzy for match indices (the data modules already filtered, but
        // we need the indices for highlighting; for empty query the matches are [])
        const fm = fuzzyMatch(query, result.title);
        entries.push({
          kind: 'item',
          result,
          matches: fm?.matches ?? [],
          flatIndex: flatIdx,
          key: result.id,
        });
        flatIdx++;
      }
    }

    return { flatEntries: entries, totalItems: flatIdx };
  }, [
    query,
    tabResults,
    bookmarkResults,
    historyResults,
    actionResults,
    settingsResults,
    recentResults,
  ]);

  const itemCount = totalItems;

  // ── Reset on open ─────────────────────────────────────────────────────────

  useEffect(() => {
    if (open) {
      setQuery('');
      setSelectedIndex(0);
      setRecentIds(getRecent());
    }
  }, [open]);

  // Keep selectedIndex in bounds
  useEffect(() => {
    setSelectedIndex((i) => Math.min(i, Math.max(0, itemCount - 1)));
  }, [itemCount]);

  // ── Scroll selected item into view ────────────────────────────────────────

  useEffect(() => {
    if (!listRef.current) return;
    const selected = listRef.current.querySelector(
      '[data-palette-item="true"][aria-selected="true"]',
    );
    selected?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  // ── Execute an action ─────────────────────────────────────────────────────

  const execute = useCallback(
    (result: PaletteResult) => {
      addRecent(result.id);
      onClose();
      void result.action();
    },
    [onClose],
  );

  // ── Keyboard handling ─────────────────────────────────────────────────────

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown': {
          e.preventDefault();
          setSelectedIndex((i) => (i + 1) % Math.max(1, itemCount));
          break;
        }
        case 'ArrowUp': {
          e.preventDefault();
          setSelectedIndex((i) => (i - 1 + itemCount) % Math.max(1, itemCount));
          break;
        }
        case 'Enter': {
          e.preventDefault();
          // Find the nth item-kind entry matching selectedIndex
          let count = 0;
          for (const entry of flatEntries) {
            if (entry.kind === 'item') {
              if (count === selectedIndex) {
                execute(entry.result);
                return;
              }
              count++;
            }
          }
          break;
        }
        case 'Tab': {
          // Trap focus inside the palette
          e.preventDefault();
          inputRef.current?.focus();
          break;
        }
        case 'Escape': {
          e.preventDefault();
          onClose();
          break;
        }
      }
    },
    [flatEntries, itemCount, selectedIndex, execute, onClose],
  );

  if (!open) return null;

  // ── Render ────────────────────────────────────────────────────────────────

  // Build a mapping from flatIndex → item entry for quick look-up during rendering
  let itemCounter = 0;

  return (
    <div className="command-palette__scrim" role="presentation" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="command-palette"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id={titleId} className="sr-only">
          Command palette
        </h2>
        <div className="command-palette__search">
          <Search size={18} aria-hidden="true" />
          <input
            ref={inputRef}
            type="search"
            aria-label="Search commands"
            placeholder="Search commands, tabs, and settings"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
          />
        </div>
        <ul className="command-palette__list" role="listbox" aria-label="Commands" ref={listRef}>
          {flatEntries.map((entry) => {
            if (entry.kind === 'header') {
              return (
                <li key={entry.key} className="command-palette__section-header" role="presentation">
                  {entry.label}
                </li>
              );
            }

            const flatIdx = itemCounter++;
            const isSelected = flatIdx === selectedIndex;
            const { result, matches } = entry;

            return (
              <li key={entry.key}>
                <button
                  type="button"
                  data-palette-item="true"
                  className={`command-palette__item${isSelected ? ' command-palette__item--active' : ''}`}
                  role="option"
                  aria-selected={isSelected}
                  onMouseEnter={() => setSelectedIndex(flatIdx)}
                  onClick={() => execute(result)}
                >
                  {result.icon && (
                    <span className="command-palette__item-icon" aria-hidden="true">
                      {result.icon}
                    </span>
                  )}
                  <span className="command-palette__item-title">
                    <HighlightedTitle text={result.title} matches={matches} />
                  </span>
                  {result.subtitle && (
                    <span className="command-palette__item-subtitle">{result.subtitle}</span>
                  )}
                </button>
              </li>
            );
          })}
          {itemCount === 0 && (
            <li className="command-palette__empty" role="presentation">
              No results.
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}
