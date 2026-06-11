// src/components/SettingsModal.tsx
import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { useDialog } from '../hooks/useDialog';

type SettingsTab =
  | 'appearance'
  | 'search'
  | 'home'
  | 'filterLists'
  | 'myFilters'
  | 'allowlist'
  | 'downloads'
  | 'sitePermissions'
  | 'data';

const TAB_LABELS: Record<SettingsTab, string> = {
  appearance: 'Appearance',
  search: 'Search',
  home: 'Home',
  filterLists: 'Filter Lists',
  myFilters: 'My Filters',
  allowlist: 'Allowlist',
  downloads: 'Downloads',
  sitePermissions: 'Site permissions',
  data: 'Data',
};

const TAB_ORDER: SettingsTab[] = [
  'appearance',
  'search',
  'home',
  'filterLists',
  'myFilters',
  'allowlist',
  'downloads',
  'sitePermissions',
  'data',
];

export interface SettingsModalProps {
  onClose(): void;
  appearance: ReactNode;
  search: ReactNode;
  home: ReactNode;
  filterLists: ReactNode;
  myFilters: ReactNode;
  allowlist: ReactNode;
  downloads: ReactNode;
  sitePermissions: ReactNode;
  data: ReactNode;
}

export function SettingsModal({
  onClose,
  appearance,
  search,
  home,
  filterLists,
  myFilters,
  allowlist,
  downloads,
  sitePermissions,
  data,
}: SettingsModalProps) {
  const titleId = useId();
  const dialogRef = useDialog<HTMLDivElement>(onClose);
  const [tab, setTab] = useState<SettingsTab>('appearance');

  // Stable id pairs (tab control id + panel id) per section, for aria wiring.
  const appearanceTabId = useId();
  const searchTabId = useId();
  const homeTabId = useId();
  const filterListsTabId = useId();
  const myFiltersTabId = useId();
  const allowlistTabId = useId();
  const downloadsTabId = useId();
  const sitePermissionsTabId = useId();
  const dataTabId = useId();
  const panelId = useId();

  const tabIds: Record<SettingsTab, string> = {
    appearance: appearanceTabId,
    search: searchTabId,
    home: homeTabId,
    filterLists: filterListsTabId,
    myFilters: myFiltersTabId,
    allowlist: allowlistTabId,
    downloads: downloadsTabId,
    sitePermissions: sitePermissionsTabId,
    data: dataTabId,
  };

  const panels: Record<SettingsTab, ReactNode> = {
    appearance,
    search,
    home,
    filterLists,
    myFilters,
    allowlist,
    downloads,
    sitePermissions,
    data,
  };

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="settings-modal"
    >
      <div className="settings-modal__content">
        <div className="settings-modal__header">
          <h2 id={titleId} className="settings-modal__title">
            Settings
          </h2>
          <button
            type="button"
            className="settings-modal__close"
            aria-label="Close"
            onClick={onClose}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <div className="settings-modal__body">
          <div className="settings-modal__tabs" role="tablist" aria-label="Settings sections">
            {TAB_ORDER.map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                id={tabIds[t]}
                aria-controls={panelId}
                aria-selected={tab === t}
                className="settings-modal__tab"
                onClick={() => setTab(t)}
              >
                {TAB_LABELS[t]}
              </button>
            ))}
          </div>
          <div
            role="tabpanel"
            id={panelId}
            aria-labelledby={tabIds[tab]}
            className="settings-modal__panel"
          >
            {panels[tab]}
          </div>
        </div>
      </div>
    </div>
  );
}
