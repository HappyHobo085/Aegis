import { Plus, X, Globe } from 'lucide-react';
import type { TabMeta, ViewId } from '../../shared/types';

interface TabStripProps {
  tabs: TabMeta[];
  activeId: ViewId;
  onActivate(id: ViewId): void;
  onClose(id: ViewId): void;
  onCreate(): void;
  onReorder(ids: ViewId[]): void;
  onSetPinned(id: ViewId, pinned: boolean): void;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function labelFor(tab: TabMeta): string {
  const t = tab.title?.trim();
  if (t && t.length > 0) return t;
  const h = hostOf(tab.url);
  return h.length > 0 ? h : 'New tab';
}

export function TabStrip({
  tabs,
  activeId,
  onActivate,
  onClose,
  onCreate,
  onReorder,
  onSetPinned,
}: TabStripProps) {
  return (
    <div className="tabstrip" role="tablist" aria-label="Open tabs">
      {tabs.map((t) => {
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
            ]
              .filter(Boolean)
              .join(' ')}
            draggable
            onClick={() => onActivate(t.id)}
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
            <Globe size={13} aria-hidden="true" className="tab__icon" />
            {!t.pinned && <span className="tab__title">{title}</span>}
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
    </div>
  );
}
