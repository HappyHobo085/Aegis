// src/popover/omniboxPayload.ts
//
// Validate the omnibox payload the surface received, before anything renders it.
//
// The payload arrives as `{ kind: PopoverKind; [key: string]: unknown }` — it came off the
// wire and `PopoverSurfacePayload` deliberately does not pretend otherwise. The panel would
// otherwise index straight into it, and the shapes it indexes are unforgiving:
//
//   - `OmniboxDropdown` calls `matches.filter(...)` and `text.length` on every row, so a
//     `titleMatches` that is a number is a **TypeError**, and a TypeError in the surface
//     webview takes the whole popover down — including the chrome's own keyboard path.
//   - `KIND_ICON[s.kind]` is indexed by an unvalidated string, which yields `undefined` and
//     then a React crash on `<undefined />`.
//
// So: a row that does not conform is DROPPED, and only a container that cannot be rendered at
// all refuses the whole payload. Dropping rows degrades to a partial list, which is strictly
// better than an empty box — and it cannot desynchronise the bounds check, because every
// index the panel can report is an index into its OWN (post-validation) array, so a reported
// index is always below the `itemCount` the chrome declared.
import type { OmniboxSuggestion } from '../lib/omnibox';

/** Ceiling on rows accepted from the wire. The chrome caps the omnibox at
 *  `OMNIBOX_LIMIT` (8); 64 is generous headroom for every popover, and a payload above it
 *  is a bug or an attack, never a layout. */
const MAX_ROWS = 64;

const KINDS = new Set(['navigate', 'favorite', 'saved', 'history', 'recent', 'search']);

export interface OmniboxPanelPayload {
  suggestions: OmniboxSuggestion[];
  /** The chrome's keyboard cursor, or -1 for "nothing highlighted". */
  activeIndex: number;
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

/** A match-index list: an array of non-negative integers. `Highlighted` additionally ignores
 *  out-of-range indices, so this is about not handing it something with no `filter`. */
function isIndexList(v: unknown): v is number[] {
  return Array.isArray(v) && v.every((n) => Number.isInteger(n) && n >= 0);
}

function asRow(v: unknown): OmniboxSuggestion | null {
  if (typeof v !== 'object' || v === null) return null;
  const r = v as Record<string, unknown>;
  if (!isString(r.id) || !isString(r.kind) || !KINDS.has(r.kind)) return null;
  if (!isString(r.title) || !isString(r.url) || !isString(r.target)) return null;
  if (!isIndexList(r.titleMatches) || !isIndexList(r.urlMatches)) return null;
  // Reuse the object rather than rebuilding it: the panel renders exactly what it validated,
  // so there is no second shape to keep in step. The casts are the validation.
  return r as unknown as OmniboxSuggestion;
}

/**
 * @param payload the raw `payload` object off the wire (`kind` is not needed here).
 * @returns the rows to render, or `null` when there is nothing renderable at all.
 */
export function parseOmniboxPayload(payload: unknown): OmniboxPanelPayload | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const raw = (payload as { suggestions?: unknown }).suggestions;
  if (!Array.isArray(raw) || raw.length > MAX_ROWS) return null;

  const suggestions: OmniboxSuggestion[] = [];
  for (const row of raw) {
    const ok = asRow(row);
    if (ok) suggestions.push(ok);
  }

  // A non-integer or absent cursor means "nothing highlighted", never a highlight on a row
  // that does not exist. Out-of-range values are left to the panel: `activeIndex` selects
  // nothing when it matches no row, which is the same visible outcome.
  const idx = (payload as { activeIndex?: unknown }).activeIndex;
  const activeIndex = Number.isInteger(idx) ? (idx as number) : -1;

  return { suggestions, activeIndex };
}
