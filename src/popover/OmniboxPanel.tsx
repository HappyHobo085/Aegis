// src/popover/OmniboxPanel.tsx
//
// The address-bar suggestion list, rendered on the popover surface.
//
// The SAME `OmniboxDropdown` the chrome renders — one component, two documents. That is the
// whole point of the split: the chrome keeps the authoritative copy (it owns the array, the
// debounce and the cursor) and the surface renders a mirror of what the chrome last sent.
// Nothing here derives state; every value arrives in the payload, and every user act leaves
// as an INDEX.
//
// Three things this panel deliberately does NOT do:
//
//   - It does not navigate. `picked({ index })` carries a row number, Rust bounds-checks it
//     against the `itemCount` the chrome declared, and the chrome then picks from its OWN
//     array. A poisoned suggestion title can therefore only ever make the chrome open a row
//     it already had open — which is the property the whole security boundary rests on.
//   - It does not trust the payload. `parseOmniboxPayload` drops anything it cannot render;
//     see that file for the shapes that would otherwise throw.
//   - It does not own focus. Rows are `<div role="option">` with no tab stop, and the surface
//     root is `aria-hidden`, so this webview can never become a keyboard scope. Arrow keys and
//     Enter are handled in the chrome and only RENDERED here.
import { OmniboxDropdown } from '../components/OmniboxDropdown';
import { parseOmniboxPayload } from './omniboxPayload';
import { reportHover, reportIndex } from './PopoverPanel';
import type { PanelProps } from './PopoverPanel';

/** Row ids for the surface's copy. The chrome's `aria-activedescendant` points at ITS OWN
 *  copy in ITS document — an id cannot cross documents — so the surface's ids are referenced
 *  by nobody, and giving them a distinct prefix keeps that from reading as an accident. */
const SURFACE_ID_PREFIX = 'aegis-surface-omnibox';

export function OmniboxPanel({ shown }: PanelProps): React.JSX.Element | null {
  const parsed = parseOmniboxPayload(shown.payload);
  if (!parsed) return null;
  return (
    <OmniboxDropdown
      suggestions={parsed.suggestions}
      activeIndex={parsed.activeIndex}
      idPrefix={SURFACE_ID_PREFIX}
      onPick={(_suggestion, index) => void reportIndex(shown, index)}
      onHover={(index) => void reportHover(shown, index)}
    />
  );
}
