// src/components/Sidebar.tsx
import { useId, useState } from 'react';
import type { ReactNode } from 'react';

type Tab = 'history' | 'saved';

export interface SidebarProps {
  open: boolean;
  onToggle(): void;
  history: ReactNode;
  saved: ReactNode;
}

export function Sidebar({ open, onToggle, history, saved }: SidebarProps) {
  const [tab, setTab] = useState<Tab>('history');
  const historyTabId = useId();
  const savedTabId = useId();
  const historyPanelId = useId();
  const savedPanelId = useId();

  return (
    <aside className="sidebar" aria-label="Sidebar">
      <button
        type="button"
        className="sidebar__toggle"
        aria-label="Toggle sidebar"
        aria-expanded={open}
        onClick={onToggle}
      >
        {'☰'}
      </button>
      {open && (
        <div className="sidebar__body">
          <div className="sidebar__tabs" role="tablist" aria-label="Sidebar panels">
            <button
              type="button"
              role="tab"
              id={historyTabId}
              aria-controls={historyPanelId}
              aria-selected={tab === 'history'}
              className="sidebar__tab"
              onClick={() => setTab('history')}
            >
              History
            </button>
            <button
              type="button"
              role="tab"
              id={savedTabId}
              aria-controls={savedPanelId}
              aria-selected={tab === 'saved'}
              className="sidebar__tab"
              onClick={() => setTab('saved')}
            >
              Saved
            </button>
          </div>
          {tab === 'history' ? (
            <div role="tabpanel" id={historyPanelId} aria-labelledby={historyTabId}>
              {history}
            </div>
          ) : (
            <div role="tabpanel" id={savedPanelId} aria-labelledby={savedTabId}>
              {saved}
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
