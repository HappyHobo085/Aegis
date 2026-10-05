// src/popover/PopoverPanel.tsx
//
// Routes one payload to the panel that renders it. Every panel is a PURE component — props
// in, markup out — which is what keeps them testable in jsdom by rendering them directly,
// and what keeps IPC out of the surface: a panel reports through `picked()` and nothing else.
//
// `activeIndex` lives in the chrome, not here. Keyboard focus never leaves the address
// input (the surface is a different document and cannot be focused), so ↑/↓/Enter/Escape are
// handled there and only RENDERED here. That is also why the surface is `aria-hidden` — see
// the accessibility section of the spec.
import { picked } from '../lib/surfaceApi';
import { OmniboxPanel } from './OmniboxPanel';
import { SitePanel } from './SitePanel';
import { ShieldPanel } from './ShieldPanel';
import { ZoomPanel } from './ZoomPanel';
import type { PopoverSurfacePayload } from '../../shared/types';

export interface PanelProps {
  shown: PopoverSurfacePayload;
}

/** Report a row the user clicked. `index` is what the chrome declared as `itemCount`, so a
 *  stale row index is refused in Rust before the chrome ever sees it. */
export async function reportIndex(shown: PopoverSurfacePayload, index: number): Promise<void> {
  await picked({ id: shown.id, index });
}

/** Report a control inside a panel. The action name must be one the chrome declared in
 *  `actions`, or Rust drops the pick. */
export async function reportAction(
  shown: PopoverSurfacePayload,
  action: string,
  value?: unknown,
): Promise<void> {
  await picked({ id: shown.id, action, value });
}

/** Report the row the pointer is over, so the chrome's keyboard cursor follows the mouse.
 *
 * The index rides alongside the action rather than inside `value` on purpose: Rust
 * bounds-checks `index` against the `itemCount` the chrome declared, and a `value` is
 * unvalidated passthrough. This is a real behaviour, not a nicety — without it, hovering a
 * row and pressing Enter would open the keyboard-highlighted row instead of the one under
 * the pointer. `onMouseEnter` fires once per row entered rather than per mouse move, so this
 * is bounded by the row count without any throttling. */
export async function reportHover(shown: PopoverSurfacePayload, index: number): Promise<void> {
  await picked({ id: shown.id, action: 'hover', index });
}

/** The Phase-2 gate panel: renders a payload as plain text so the surface can be proven to
 *  receive, lay out and paint something before any real popover has been moved onto it.
 *
 *  Each of the four real panels replaces this one in the registry below; nothing else in
 *  the surface changes when they do. */
function TestPanel({ shown }: PanelProps): React.JSX.Element {
  return (
    <div className="popover popover--test" data-popover-id={shown.id}>
      <div className="popover__test-header">popover surface: {shown.id}</div>
      <pre className="popover__test-payload">{JSON.stringify(shown.payload, null, 2)}</pre>
      <button
        type="button"
        className="popover__test-button"
        onClick={() => void reportIndex(shown, 0)}
      >
        pick index 0
      </button>
    </div>
  );
}

/** The one place a payload's `kind` becomes a component. Adding a popover means adding a row
 *  here and nothing else — the chrome already sends the payload, and Rust already validates
 *  picks against it. */
const PANELS: Record<string, (props: PanelProps) => React.JSX.Element | null> = {
  test: TestPanel,
  'address-omnibox': OmniboxPanel,
  'address-site': SitePanel,
  'adblock-shield': ShieldPanel,
  'zoom-indicator': ZoomPanel,
};

export function PopoverPanel({ shown }: PanelProps): React.JSX.Element | null {
  const Panel = PANELS[shown.payload.kind];
  // An unknown kind renders nothing rather than throwing: `kind` comes off the wire, and a
  // blank panel plus a console error is a far better failure than a webview that dies and
  // takes the surface's rect with it.
  if (!Panel) {
    console.error(`[aegis] popover surface: no panel for kind ${String(shown.payload.kind)}`);
    return null;
  }
  return <Panel shown={shown} />;
}
