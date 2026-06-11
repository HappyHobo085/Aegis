// src/components/Sidebar.tsx
import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { Bookmark, History, X } from 'lucide-react';
import { useHorizontalWheel } from '../hooks/useHorizontalWheel';

type Tab = 'history' | 'saved';

export interface SidebarProps {
  open: boolean;
  onClose(): void;
  history: ReactNode;
  saved: ReactNode;
}

export function Sidebar({ open, onClose, history, saved }: SidebarProps) {
  const [tab, setTab] = useState<Tab>('history');
  const tabsRef = useHorizontalWheel<HTMLDivElement>();
  const historyTabId = useId();
  const savedTabId = useId();
  const historyPanelId = useId();
  const savedPanelId = useId();

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
      <aside className="sidebar sidebar__panel" aria-label="Sidebar">
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
