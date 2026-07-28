// src/components/Sidebar.tsx
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from 'react';
import { Bookmark, History, X } from 'lucide-react';
import { useHorizontalWheel } from '../hooks/useHorizontalWheel';
import { SIDEBAR_W } from '../lib/layout';

type Tab = 'history' | 'saved';

const WIDTH_KEY = 'aegis.sidebarWidth';
const MIN_WIDTH = 240;
const DEFAULT_WIDTH = SIDEBAR_W;
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
  initialTab?: Tab;
  onClose(): void;
  history: ReactNode;
  saved: ReactNode;
  /** Report the panel's current width so the content webview's inset can track it. */
  onWidthChange?(width: number): void;
}

export function Sidebar({
  open,
  initialTab = 'saved',
  onClose,
  history,
  saved,
  onWidthChange,
}: SidebarProps) {
  const [tab, setTab] = useState<Tab>(initialTab);
  // Width is read from localStorage on each open (the panel unmounts when closed),
  // so a resized width is remembered across re-opens and app restarts.
  const [width, setWidth] = useState<number>(readStoredWidth);
  const [dragging, setDragging] = useState(false);
  const tabsRef = useHorizontalWheel<HTMLDivElement>();
  const historyTabId = useId();
  const savedTabId = useId();
  const historyPanelId = useId();
  const savedPanelId = useId();

  useEffect(() => {
    if (open) setTab(initialTab);
  }, [open, initialTab]);

  // Report the width up so the content webview's right inset tracks the (resizable)
  // panel. A pointer DRAG fires dozens of moves/sec and each onWidthChange drives a
  // synchronous view.setLayout IPC on the GTK main thread, so while dragging we coalesce
  // to at most one report per animation frame; keyboard/open changes report immediately.
  // onWidthChange is read through a ref so a queued rAF callback never goes stale.
  const onWidthChangeRef = useRef(onWidthChange);
  onWidthChangeRef.current = onWidthChange;
  const rafRef = useRef<number | null>(null);
  const pendingWidthRef = useRef<number | null>(null);

  const reportWidth = useCallback((w: number, immediate: boolean): void => {
    if (immediate) {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      onWidthChangeRef.current?.(w);
      return;
    }
    pendingWidthRef.current = w;
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      if (pendingWidthRef.current != null) onWidthChangeRef.current?.(pendingWidthRef.current);
    });
  }, []);

  // Cancel any queued frame on unmount (the panel unmounts when closed).
  useEffect(
    () => () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  // Report the width (coalesced while dragging) and persist it once the drag settles —
  // a per-pixel localStorage write during a drag is wasteful and unnecessary.
  useEffect(() => {
    reportWidth(width, !dragging);
    if (!dragging) {
      try {
        window.localStorage.setItem(WIDTH_KEY, String(width));
      } catch {
        // localStorage unavailable — width simply isn't remembered.
      }
    }
  }, [width, dragging, reportWidth]);

  // Escape closes the panel while it's open. The sidebar is an INSET panel (the page
  // stays visible beside it), not a modal, so we don't trap focus — we just listen for
  // Escape on the document and call onClose. The listener is only attached while open.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

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
  const order: Tab[] = ['saved', 'history'];

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
