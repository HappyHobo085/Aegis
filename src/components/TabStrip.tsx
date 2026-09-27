import { useRef, useState, useCallback, useEffect, useMemo } from 'react';
import { Plus, X, Globe, EyeOff } from 'lucide-react';
import type { TabMeta, ViewId } from '../../shared/types';
import { hostOf } from '../lib/url';

// --- Conditional virtualization constants ---
const OVERSCAN = 3;
const VIRTUALIZATION_THRESHOLD = 50;
const PINNED_EST_WIDTH = 38; // ~36px max-width + 2px gap
const UNPINNED_EST_WIDTH = 142; // ~140px avg + 2px gap

function estTabWidth(tab: TabMeta): number {
  return tab.pinned ? PINNED_EST_WIDTH : UNPINNED_EST_WIDTH;
}

interface TabStripProps {
  tabs: TabMeta[];
  activeId: ViewId;
  onActivate(id: ViewId): void;
  onClose(id: ViewId): void;
  onCreate(): void;
  onCreatePrivate(): void;
  onReorder(ids: ViewId[]): void;
  onSetPinned(id: ViewId, pinned: boolean): void;
}

function labelFor(tab: TabMeta): string {
  const t = tab.title?.trim();
  if (t && t.length > 0) return t;
  const h = hostOf(tab.url);
  return h || 'New tab';
}

export function TabStrip({
  tabs,
  activeId,
  onActivate,
  onClose,
  onCreate,
  onCreatePrivate,
  onReorder,
  onSetPinned,
}: TabStripProps) {
  const stripRef = useRef<HTMLDivElement | null>(null);

  // Track the dragged tab id for the duration of a drag operation.
  const draggedTabIdRef = useRef<number | null>(null);

  // --- Virtualization state ---
  const isVirtualized = tabs.length > VIRTUALIZATION_THRESHOLD;
  const [scrollLeft, setScrollLeft] = useState(0);
  const rafRef = useRef<number>(0);

  // Precompute cumulative estimated positions for every tab.
  // positions[i] = the pixel offset where tab i would start.
  const { positions, totalWidth } = useMemo(() => {
    if (!isVirtualized) return { positions: [] as number[], totalWidth: 0 };
    const pos = new Array<number>(tabs.length);
    let acc = 0;
    for (let i = 0; i < tabs.length; i++) {
      pos[i] = acc;
      acc += estTabWidth(tabs[i]);
    }
    return { positions: pos, totalWidth: acc };
  }, [tabs, isVirtualized]);

  // Derive the visible range from the current scroll offset.
  const { start, end } = useMemo(() => {
    if (!isVirtualized || positions.length === 0) {
      return { start: 0, end: tabs.length - 1 };
    }
    const el = stripRef.current;
    const viewLeft = scrollLeft;
    const viewRight = scrollLeft + (el?.clientWidth ?? 800);

    let s = tabs.length; // sentinel: no visible tab yet
    let e = -1;

    for (let i = 0; i < tabs.length; i++) {
      const tabRight = positions[i] + estTabWidth(tabs[i]);
      if (tabRight > viewLeft && positions[i] < viewRight) {
        if (s === tabs.length) s = i;
        e = i;
      }
    }

    // Clamp with overscan
    s = Math.max(0, s - OVERSCAN);
    e = Math.min(tabs.length - 1, (e < 0 ? 0 : e) + OVERSCAN);

    return { start: s, end: e };
  }, [scrollLeft, isVirtualized, positions, tabs.length]);

  // RAF-debounced scroll handler
  const onScroll = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      setScrollLeft(stripRef.current?.scrollLeft ?? 0);
    });
  }, []);

  // Attach scroll listener only in virtualized mode; sync initial scrollLeft
  useEffect(() => {
    const el = stripRef.current;
    if (!el || !isVirtualized) return;
    setScrollLeft(el.scrollLeft);
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(rafRef.current);
    };
  }, [onScroll, isVirtualized]);

  // Roving-tabindex keyboard nav: arrows move focus between tabs, Enter/Space
  // activates, Delete/Backspace closes. (The strip was pointer-only before.)
  //
  // `index` is ABSOLUTE (into `tabs`), but the DOM only holds the virtualized window
  // `tabs.slice(start, end + 1)` once `tabs.length > VIRTUALIZATION_THRESHOLD`. Wrapping over
  // the DOM length therefore jumped to a wrong tab (e.g. ArrowRight on the first rendered tab
  // computed `n+1 % windowLength`, which can land back on the same tab, and End jumped into the
  // middle of the window instead of the last tab). Wrap over the FULL list, then resolve the
  // absolute index to a rendered node by its `data-tab-index`.
  const focusTabAt = (index: number): void => {
    const strip = stripRef.current;
    if (!strip || tabs.length === 0) return;
    const clamped = (index + tabs.length) % tabs.length;
    const el = strip.querySelector<HTMLElement>(`[data-tab-index="${clamped}"]`);
    if (el) {
      el.focus();
      return;
    }
    // The target is outside the rendered window — scroll it into view. The window is derived
    // from scrollLeft, so scrolling re-renders and then the node exists.
    const px = positions[clamped];
    if (px !== undefined) {
      strip.scrollTo({ left: Math.max(0, px - strip.clientWidth / 2), behavior: 'auto' });
    }
  };
  const onTabKeyDown = (e: React.KeyboardEvent, t: TabMeta, index: number): void => {
    switch (e.key) {
      case 'Enter':
      case ' ':
        e.preventDefault();
        onActivate(t.id);
        break;
      case 'ArrowRight':
        e.preventDefault();
        focusTabAt(index + 1);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        focusTabAt(index - 1);
        break;
      case 'Home':
        e.preventDefault();
        focusTabAt(0);
        break;
      case 'End':
        e.preventDefault();
        focusTabAt(tabs.length - 1);
        break;
      case 'Delete':
      case 'Backspace':
        if (!t.pinned) {
          e.preventDefault();
          onClose(t.id);
        }
        break;
    }
  };

  // Shared tab-node renderer (used by both paths).
  const renderTabNode = (t: TabMeta, index: number) => {
    const title = labelFor(t);
    const isActive = t.id === activeId;
    return (
      <div
        key={t.id}
        // Absolute index into `tabs` — `focusTabAt` uses it to map keyboard nav onto the
        // virtualized window (the DOM only holds tabs.slice(start, end + 1)).
        data-tab-index={index}
        role="tab"
        aria-selected={isActive}
        tabIndex={isActive ? 0 : -1}
        aria-label={title}
        className={[
          'tab',
          isActive ? 'tab--active' : '',
          t.live ? '' : 'tab--asleep',
          t.pinned ? 'tab--pinned' : '',
          t.private ? 'tab--private' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        draggable
        onClick={() => onActivate(t.id)}
        onKeyDown={(e) => onTabKeyDown(e, t, index)}
        onDragStart={(e) => {
          draggedTabIdRef.current = t.id;
          e.dataTransfer.setData('text/tab-id', String(t.id));
          e.dataTransfer.effectAllowed = 'move';
        }}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
        }}
        onDrop={(e) => {
          e.preventDefault();

          const dragged = draggedTabIdRef.current ?? Number(e.dataTransfer.getData('text/tab-id'));
          draggedTabIdRef.current = null;
          if (!dragged || dragged === t.id) return;

          // Reorder: move the dragged tab to just before the drop target.
          const order = tabs.map((x) => x.id).filter((id) => id !== dragged);
          const at = order.indexOf(t.id);
          order.splice(at, 0, dragged);
          onReorder(order);
        }}
        onAuxClick={(e) => {
          if (e.button === 1) onClose(t.id);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          onSetPinned(t.id, !t.pinned);
        }}
      >
        {t.private ? (
          <EyeOff size={13} aria-hidden="true" className="tab__icon" />
        ) : (
          <Globe size={13} aria-hidden="true" className="tab__icon" />
        )}
        {!t.pinned && <span className="tab__title">{title}</span>}
        {!t.pinned && !t.live && (
          <span className="tab__badge" title="Sleeping tab">
            Asleep
          </span>
        )}
        {!t.pinned && t.private && (
          <span className="tab__badge tab__badge--private" title="Private tab">
            Private
          </span>
        )}
        {!t.pinned && (
          <button
            type="button"
            className="tab__close"
            aria-label={`Close ${title}`}
            title="Close tab"
            onClick={(e) => {
              e.stopPropagation();
              onClose(t.id);
            }}
          >
            <X size={12} aria-hidden="true" />
          </button>
        )}
      </div>
    );
  };

  // New-tab buttons (always rendered at the end).
  const newTabButtons = (
    <>
      <button
        type="button"
        className="tabstrip__new"
        aria-label="New tab"
        title="New tab"
        onClick={onCreate}
      >
        <Plus size={16} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="tabstrip__new tabstrip__new--private"
        aria-label="New private tab"
        title="New private tab (Ctrl+Shift+N)"
        onClick={onCreatePrivate}
      >
        <EyeOff size={15} aria-hidden="true" />
      </button>
    </>
  );

  // --- Virtualized padding (used only when isVirtualized is true) ---
  const leftPad = isVirtualized ? (positions[start] ?? 0) : 0;
  const rightPad = isVirtualized
    ? totalWidth -
      (positions[end] !== undefined ? positions[end] + estTabWidth(tabs[end]) : totalWidth)
    : 0;

  // --- Non-virtualized: render all tabs (unchanged behavior for <=50 tabs) ---
  const tabStripNode = !isVirtualized ? (
    <div className="tabstrip" role="tablist" aria-label="Open tabs" ref={stripRef}>
      {tabs.map((t, index) => renderTabNode(t, index))}
      {newTabButtons}
    </div>
  ) : (
    <div className="tabstrip" role="tablist" aria-label="Open tabs" ref={stripRef}>
      {leftPad > 0 && <div style={{ minWidth: leftPad, flexShrink: 0 }} aria-hidden="true" />}
      {tabs.slice(start, end + 1).map((t, localIdx) => renderTabNode(t, start + localIdx))}
      {rightPad > 0 && <div style={{ minWidth: rightPad, flexShrink: 0 }} aria-hidden="true" />}
      {newTabButtons}
    </div>
  );

  return tabStripNode;
}
