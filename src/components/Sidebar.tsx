// src/components/Sidebar.tsx
import { useEffect, useId, useState } from 'react';
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from 'react';
import { Bookmark, History, X } from 'lucide-react';
import { useHorizontalWheel } from '../hooks/useHorizontalWheel';

type Tab = 'history' | 'saved';

const WIDTH_KEY = 'aegis.sidebarWidth';
const MIN_WIDTH = 240;
const DEFAULT_WIDTH = 280;
const KEY_STEP = 24; // px per arrow-key press

/** Largest allowed width: leave a sliver of the page visible, never swallow it whole. */
function maxWidth(): number {
  if (typeof window === 'undefined') return 900;
  return Math.min(Math.max(MIN_WIDTH, window.innerWidth - 80), 900);
}

function clampWidth(w: number): number {
  return Math.max(MIN_WIDTH, Math.min(maxWidth(), Math.round(w)));
}

/** Read the remembered width (clamped) from localStorage, falling back to the default. */
function readStoredWidth(): number {
  try {
    const raw = window.localStorage.getItem(WIDTH_KEY);
    if (raw == null) return DEFAULT_WIDTH;
    const n = Number(raw);
    return Number.isFinite(n) ? clampWidth(n) : DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
}

export interface SidebarProps {
  open: boolean;
  onClose(): void;
  history: ReactNode;
  saved: ReactNode;
}

export function Sidebar({ open, onClose, history, saved }: SidebarProps) {
  const [tab, setTab] = useState<Tab>('history');
  // Width is read from localStorage on each open (the panel unmounts when closed),
  // so a resized width is remembered across re-opens and app restarts.
  const [width, setWidth] = useState<number>(readStoredWidth);
  const [dragging, setDragging] = useState(false);
  const tabsRef = useHorizontalWheel<HTMLDivElement>();
  const historyTabId = useId();
  const savedTabId = useId();
  const historyPanelId = useId();
  const savedPanelId = useId();

  // Persist the width whenever it changes (idempotent — StrictMode-safe).
  useEffect(() => {
    try {
      window.localStorage.setItem(WIDTH_KEY, String(width));
    } catch {
      // localStorage unavailable — width simply isn't remembered.
    }
  }, [width]);

  const onResizePointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDragging(true);
  };

  const onResizePointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (!dragging) return;
    // Panel is anchored to the right edge, so its width is the gap from the pointer
    // to the right edge of the window.
    setWidth(clampWidth(window.innerWidth - e.clientX));
  };

  const endDrag = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const el = e.target as HTMLElement;
    if (el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
    setDragging(false);
  };

  const onResizeKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    // Left edge: dragging/arrowing LEFT widens, RIGHT narrows.
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      setWidth((w) => clampWidth(w + KEY_STEP));
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      setWidth((w) => clampWidth(w - KEY_STEP));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setWidth(clampWidth(maxWidth()));
    } else if (e.key === 'End') {
      e.preventDefault();
      setWidth(MIN_WIDTH);
    }
  };

  const tabIds: Record<Tab, string> = {
    history: historyTabId,
    saved: savedTabId,
  };
  const panelIds: Record<Tab, string> = {
    history: historyPanelId,
    saved: savedPanelId,
  };
  const labels: Record<Tab, string> = {
    history: 'History',
    saved: 'Saved',
  };
  const tabIcons: Record<Tab, ReactNode> = {
    history: <History size={14} aria-hidden="true" />,
    saved: <Bookmark size={14} aria-hidden="true" />,
  };
  const panels: Record<Tab, ReactNode> = {
    history,
    saved,
  };
  const order: Tab[] = ['history', 'saved'];

  if (!open) return null;

  return (
    <>
      <div className="sidebar__scrim" onClick={onClose} aria-hidden="true" />
      <aside
        className={`sidebar sidebar__panel${dragging ? ' sidebar__panel--dragging' : ''}`}
        style={{ width }}
        aria-label="Sidebar"
      >
        <div
          className="sidebar__resize"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          aria-valuenow={width}
          aria-valuemin={MIN_WIDTH}
          aria-valuemax={maxWidth()}
          tabIndex={0}
          onPointerDown={onResizePointerDown}
          onPointerMove={onResizePointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onKeyDown={onResizeKeyDown}
        />
        <div className="sidebar__head">
          <div ref={tabsRef} className="sidebar__tabs" role="tablist" aria-label="Sidebar panels">
            {order.map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                id={tabIds[t]}
                aria-controls={panelIds[t]}
                aria-selected={tab === t}
                className="sidebar__tab"
                onClick={() => setTab(t)}
              >
                {tabIcons[t]}
                {labels[t]}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="sidebar__close"
            aria-label="Close sidebar"
            onClick={onClose}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <div
          role="tabpanel"
          id={panelIds[tab]}
          aria-labelledby={tabIds[tab]}
          className="sidebar__content"
        >
          {panels[tab]}
        </div>
      </aside>
    </>
  );
}
