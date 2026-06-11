// src/components/Sidebar.tsx
import { useId, useState } from 'react';
import type { ReactNode } from 'react';

type Tab = 'history' | 'saved' | 'downloads';

export interface SidebarProps {
  open: boolean;
  onToggle(): void;
  history: ReactNode;
  saved: ReactNode;
  downloads: ReactNode;
}

export function Sidebar({ open, onToggle, history, saved, downloads }: SidebarProps) {
  const [tab, setTab] = useState<Tab>('history');
  const historyTabId = useId();
  const savedTabId = useId();
  const downloadsTabId = useId();
  const historyPanelId = useId();
  const savedPanelId = useId();
  const downloadsPanelId = useId();

  const tabIds: Record<Tab, string> = {
    history: historyTabId,
    saved: savedTabId,
    downloads: downloadsTabId,
  };
  const panelIds: Record<Tab, string> = {
    history: historyPanelId,
    saved: savedPanelId,
    downloads: downloadsPanelId,
  };
  const labels: Record<Tab, string> = {
    history: 'History',
    saved: 'Saved',
    downloads: 'Downloads',
  };
  const panels: Record<Tab, ReactNode> = {
    history,
    saved,
    downloads,
  };
  const order: Tab[] = ['history', 'saved', 'downloads'];

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
                {labels[t]}
              </button>
            ))}
          </div>
          <div role="tabpanel" id={panelIds[tab]} aria-labelledby={tabIds[tab]}>
            {panels[tab]}
          </div>
        </div>
      )}
    </aside>
  );
}
