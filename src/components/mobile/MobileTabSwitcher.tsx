import { Globe, Plus, X } from 'lucide-react';
import type { TabMeta, ViewId } from '../../../shared/types';
import { MobileSheet } from './MobileSheet';

interface MobileTabSwitcherProps {
  tabs: TabMeta[];
  activeId: ViewId;
  onSwitch(id: ViewId): void;
  onCloseTab(id: ViewId): void;
  onNewTab(): void;
  onClose(): void;
}

function label(t: TabMeta): string {
  if (t.title.length > 0) return t.title;
  try {
    const h = new URL(t.url).hostname;
    if (h.length > 0) return h;
  } catch {
    /* ignore */
  }
  return t.url || 'New tab';
}

export function MobileTabSwitcher({
  tabs,
  activeId,
  onSwitch,
  onCloseTab,
  onNewTab,
  onClose,
}: MobileTabSwitcherProps) {
  return (
    <MobileSheet title="Tabs" onClose={onClose}>
      <button type="button" className="mobile-tabs__new" onClick={onNewTab}>
        <Plus size={18} aria-hidden="true" />
        New tab
      </button>
      <ul className="mobile-tabs">
        {tabs.map((t) => {
          const name = label(t);
          return (
            <li
              key={t.id}
              className={
                t.id === activeId ? 'mobile-tabs__row mobile-tabs__row--active' : 'mobile-tabs__row'
              }
            >
              <button
                type="button"
                className="mobile-tabs__open"
                aria-label={`Switch to ${name}`}
                onClick={() => onSwitch(t.id)}
              >
                <Globe size={18} aria-hidden="true" />
                <span className="mobile-tabs__title">{name}</span>
              </button>
              <button
                type="button"
                className="mobile-tabs__close"
                aria-label={`Close ${name}`}
                onClick={() => onCloseTab(t.id)}
              >
                <X size={18} aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ul>
    </MobileSheet>
  );
}
