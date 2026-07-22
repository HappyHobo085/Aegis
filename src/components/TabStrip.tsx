import { useRef } from 'react';
import { Plus, X, Globe, EyeOff } from 'lucide-react';
import type { TabMeta, ViewId } from '../../shared/types';
import { hostOf } from '../lib/url';

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

  // Roving-tabindex keyboard nav: arrows move focus between tabs, Enter/Space
  // activates, Delete/Backspace closes. (The strip was pointer-only before.)
  const focusTabAt = (index: number): void => {
    const els = stripRef.current?.querySelectorAll<HTMLElement>('[role="tab"]');
    if (!els || els.length === 0) return;
    const clamped = (index + els.length) % els.length;
    els[clamped]?.focus();
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

  return (
    <div className="tabstrip" role="tablist" aria-label="Open tabs" ref={stripRef}>
      {tabs.map((t, index) => {
        const title = labelFor(t);
        const isActive = t.id === activeId;
        return (
          <div
            key={t.id}
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
            onDragStart={(e) => e.dataTransfer.setData('text/tab-id', String(t.id))}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const dragged = Number(e.dataTransfer.getData('text/tab-id'));
              if (!dragged || dragged === t.id) return;
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
      })}
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
    </div>
  );
}
