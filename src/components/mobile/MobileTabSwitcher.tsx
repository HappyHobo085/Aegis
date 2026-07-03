import { Globe, Plus, X, EyeOff } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { TabMeta, ViewId } from '../../../shared/types';
import { MobileSheet } from './MobileSheet';

interface MobileTabSwitcherProps {
  tabs: TabMeta[];
  activeId: ViewId;
  onSwitch(id: ViewId): void;
  onCloseTab(id: ViewId): void;
  onNewTab(): void;
  onNewPrivateTab(): void;
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
  onNewPrivateTab,
  onClose,
}: MobileTabSwitcherProps) {
  const [query, setQuery] = useState('');
  const filteredTabs = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return tabs;
    return tabs.filter((tab) => `${label(tab)} ${tab.url}`.toLowerCase().includes(q));
  }, [query, tabs]);

  return (
    <MobileSheet title="Tabs" onClose={onClose}>
      <label className="mobile-tabs__search">
        <span className="sr-only">Search open tabs</span>
        <input
          type="search"
          placeholder="Search tabs"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <button type="button" className="mobile-tabs__new" aria-label="New tab" onClick={onNewTab}>
        <Plus size={18} aria-hidden="true" />
        New tab
      </button>
      <button
        type="button"
        className="mobile-tabs__new mobile-tabs__new--private"
        aria-label="New private tab"
        onClick={onNewPrivateTab}
      >
        <EyeOff size={18} aria-hidden="true" />
        New private tab
      </button>
      <ul className="mobile-tabs">
        {filteredTabs.map((t) => {
          const name = label(t);
          return (
            <li
              key={t.id}
              className={[
                'mobile-tabs__row',
                t.id === activeId ? 'mobile-tabs__row--active' : '',
                t.private ? 'mobile-tabs__row--private' : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <button
                type="button"
                className="mobile-tabs__open"
                aria-label={`Switch to ${name}`}
                onClick={() => onSwitch(t.id)}
              >
                {t.private ? (
                  <EyeOff size={18} aria-hidden="true" className="mobile-tabs__icon--private" />
                ) : (
                  <Globe size={18} aria-hidden="true" />
                )}
                <span className="mobile-tabs__title">
                  {name}
                  <span className="mobile-tabs__meta">
                    {t.private ? 'Private' : 'Regular'}
                    {!t.live ? ' · asleep' : ''}
                  </span>
                </span>
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
      {filteredTabs.length === 0 && <p className="mobile-tabs__empty">No open tabs match.</p>}
    </MobileSheet>
  );
}
