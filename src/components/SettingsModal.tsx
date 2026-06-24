// src/components/SettingsModal.tsx
import { useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { useDialog } from '../hooks/useDialog';
import { useHorizontalWheel } from '../hooks/useHorizontalWheel';
import { useChromeSurface } from '../hooks/useChromeSurfaces';

export type SettingsTab =
  | 'appearance'
  | 'search'
  | 'home'
  | 'tabs'
  | 'filterLists'
  | 'myFilters'
  | 'allowlist'
  | 'downloads'
  | 'sitePermissions'
  | 'security'
  | 'proxy'
  | 'vault'
  | 'sync'
  | 'data';

const TAB_LABELS: Record<SettingsTab, string> = {
  appearance: 'Appearance',
  search: 'Search',
  home: 'Home',
  tabs: 'Tabs',
  filterLists: 'Filter Lists',
  myFilters: 'My Filters',
  allowlist: 'Allowlist',
  downloads: 'Downloads',
  sitePermissions: 'Site permissions',
  security: 'Security',
  proxy: 'Proxy',
  vault: 'Passwords',
  sync: 'Sync',
  data: 'Data',
};

/** Settings tabs grouped into labelled sections so related controls sit together
 *  instead of in one flat 14-item strip. The flattened group order IS the tab order. */
export interface SettingsGroup {
  title: string;
  tabs: SettingsTab[];
}

export const TAB_GROUPS: SettingsGroup[] = [
  { title: 'Browser', tabs: ['appearance', 'home', 'search', 'tabs', 'downloads'] },
  { title: 'Ad blocking', tabs: ['filterLists', 'myFilters', 'allowlist'] },
  { title: 'Privacy & security', tabs: ['security', 'sitePermissions', 'proxy', 'vault'] },
  { title: 'Data & sync', tabs: ['sync', 'data'] },
];

export const TAB_ORDER: SettingsTab[] = TAB_GROUPS.flatMap((g) => g.tabs);

export interface SettingsModalProps {
  onClose(): void;
  appearance: ReactNode;
  search: ReactNode;
  home: ReactNode;
  tabs: ReactNode;
  filterLists: ReactNode;
  myFilters: ReactNode;
  allowlist: ReactNode;
  downloads: ReactNode;
  sitePermissions: ReactNode;
  security: ReactNode;
  proxy: ReactNode;
  vault: ReactNode;
  sync: ReactNode;
  data: ReactNode;
}

export function SettingsModal({
  onClose,
  appearance,
  search,
  home,
  tabs,
  filterLists,
  myFilters,
  allowlist,
  downloads,
  sitePermissions,
  security,
  proxy,
  vault,
  sync,
  data,
}: SettingsModalProps) {
  useChromeSurface('settings', true);
  const titleId = useId();
  const dialogRef = useDialog<HTMLDivElement>(onClose);
  const tabsRef = useHorizontalWheel<HTMLDivElement>();
  const [tab, setTab] = useState<SettingsTab>('appearance');

  // Roving arrow-key navigation across the (grouped) tab rail. Up/Left and Down/Right
  // move + activate the previous/next tab; Home/End jump to the ends.
  const tabRefs = useRef<Partial<Record<SettingsTab, HTMLButtonElement | null>>>({});
  const moveTab = (delta: number): void => {
    const i = TAB_ORDER.indexOf(tab);
    const next = TAB_ORDER[(i + delta + TAB_ORDER.length) % TAB_ORDER.length];
    setTab(next);
    tabRefs.current[next]?.focus();
  };
  const onTabKeyDown = (e: React.KeyboardEvent): void => {
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowRight':
        e.preventDefault();
        moveTab(1);
        break;
      case 'ArrowUp':
      case 'ArrowLeft':
        e.preventDefault();
        moveTab(-1);
        break;
      case 'Home':
        e.preventDefault();
        setTab(TAB_ORDER[0]);
        tabRefs.current[TAB_ORDER[0]]?.focus();
        break;
      case 'End': {
        e.preventDefault();
        const last = TAB_ORDER[TAB_ORDER.length - 1];
        setTab(last);
        tabRefs.current[last]?.focus();
        break;
      }
    }
  };

  // Stable id pairs (tab control id + panel id) per section, for aria wiring.
  const appearanceTabId = useId();
  const searchTabId = useId();
  const homeTabId = useId();
  const tabsTabId = useId();
  const filterListsTabId = useId();
  const myFiltersTabId = useId();
  const allowlistTabId = useId();
  const downloadsTabId = useId();
  const sitePermissionsTabId = useId();
  const securityTabId = useId();
  const proxyTabId = useId();
  const vaultTabId = useId();
  const syncTabId = useId();
  const dataTabId = useId();
  const panelId = useId();

  const tabIds: Record<SettingsTab, string> = {
    appearance: appearanceTabId,
    search: searchTabId,
    home: homeTabId,
    tabs: tabsTabId,
    filterLists: filterListsTabId,
    myFilters: myFiltersTabId,
    allowlist: allowlistTabId,
    downloads: downloadsTabId,
    sitePermissions: sitePermissionsTabId,
    security: securityTabId,
    proxy: proxyTabId,
    vault: vaultTabId,
    sync: syncTabId,
    data: dataTabId,
  };

  const panels: Record<SettingsTab, ReactNode> = {
    appearance,
    search,
    home,
    tabs,
    filterLists,
    myFilters,
    allowlist,
    downloads,
    sitePermissions,
    security,
    proxy,
    vault,
    sync,
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
          <div
            ref={tabsRef}
            className="settings-modal__tabs"
            role="tablist"
            aria-orientation="vertical"
            aria-label="Settings sections"
            onKeyDown={onTabKeyDown}
          >
            {TAB_GROUPS.map((group) => (
              <div key={group.title} className="settings-modal__tab-group" role="presentation">
                <div className="settings-modal__tab-group-label" aria-hidden="true">
                  {group.title}
                </div>
                {group.tabs.map((t) => (
                  <button
                    key={t}
                    ref={(el) => {
                      tabRefs.current[t] = el;
                    }}
                    type="button"
                    role="tab"
                    id={tabIds[t]}
                    aria-controls={panelId}
                    aria-selected={tab === t}
                    tabIndex={tab === t ? 0 : -1}
                    className="settings-modal__tab"
                    onClick={() => setTab(t)}
                  >
                    {TAB_LABELS[t]}
                  </button>
                ))}
              </div>
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
