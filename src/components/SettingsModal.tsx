// src/components/SettingsModal.tsx
import { useEffect, useId, useMemo, useRef, useState } from 'react';
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

const TAB_SUMMARIES: Record<SettingsTab, string> = {
  appearance: 'Theme, accent, and visual preferences',
  search: 'Default search behavior',
  home: 'Home page and start destination',
  tabs: 'Tab behavior and private browsing',
  filterLists: 'Built-in and subscribed block lists',
  myFilters: 'Custom blocking rules',
  allowlist: 'Sites exempt from ad blocking',
  downloads: 'File download behavior',
  sitePermissions: 'Camera, microphone, and site access',
  security: 'Safety, WebRTC, and fingerprinting',
  proxy: 'Network proxy routing',
  vault: 'Saved passwords and vault lock',
  sync: 'Encrypted sync across devices',
  data: 'Import, export, and local data controls',
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
  const [tabQuery, setTabQuery] = useState('');
  const normalizedQuery = tabQuery.trim().toLowerCase();
  const visibleGroups = useMemo(
    () =>
      TAB_GROUPS.map((group) => ({
        ...group,
        tabs: group.tabs.filter((t) => {
          if (normalizedQuery.length === 0) return true;
          return (
            TAB_LABELS[t].toLowerCase().includes(normalizedQuery) ||
            TAB_SUMMARIES[t].toLowerCase().includes(normalizedQuery) ||
            group.title.toLowerCase().includes(normalizedQuery)
          );
        }),
      })).filter((group) => group.tabs.length > 0),
    [normalizedQuery],
  );
  const visibleTabOrder = useMemo(() => visibleGroups.flatMap((g) => g.tabs), [visibleGroups]);

  useEffect(() => {
    if (visibleTabOrder.length > 0 && !visibleTabOrder.includes(tab)) {
      setTab(visibleTabOrder[0]);
    }
  }, [tab, visibleTabOrder]);

  // Roving arrow-key navigation across the (grouped) tab rail. Up/Left and Down/Right
  // move + activate the previous/next tab; Home/End jump to the ends.
  const tabRefs = useRef<Partial<Record<SettingsTab, HTMLButtonElement | null>>>({});
  const moveTab = (delta: number): void => {
    const order = visibleTabOrder.length > 0 ? visibleTabOrder : TAB_ORDER;
    const i = order.indexOf(tab);
    const next = order[(i + delta + order.length) % order.length];
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
        if (visibleTabOrder.length === 0) return;
        setTab(visibleTabOrder[0]);
        tabRefs.current[visibleTabOrder[0]]?.focus();
        break;
      case 'End': {
        e.preventDefault();
        if (visibleTabOrder.length === 0) return;
        const last = visibleTabOrder[visibleTabOrder.length - 1];
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

        <div className="settings-modal__search" role="search">
          <label className="sr-only" htmlFor={`${titleId}-search`}>
            Search settings
          </label>
          <input
            id={`${titleId}-search`}
            type="search"
            placeholder="Search settings"
            value={tabQuery}
            onChange={(e) => setTabQuery(e.target.value)}
          />
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
            {visibleGroups.map((group) => (
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
                    aria-label={TAB_LABELS[t]}
                    aria-controls={panelId}
                    aria-selected={tab === t}
                    tabIndex={tab === t ? 0 : -1}
                    className="settings-modal__tab"
                    onClick={() => setTab(t)}
                  >
                    <span className="settings-modal__tab-label">{TAB_LABELS[t]}</span>
                    <span className="settings-modal__tab-summary">{TAB_SUMMARIES[t]}</span>
                  </button>
                ))}
              </div>
            ))}
            {visibleGroups.length === 0 && (
              <p className="settings-modal__no-results">No settings match “{tabQuery.trim()}”.</p>
            )}
          </div>
          <div
            role="tabpanel"
            id={panelId}
            aria-labelledby={tabIds[tab]}
            className="settings-modal__panel"
          >
            {visibleGroups.length === 0 ? (
              <div className="settings-modal__empty-panel">
                Try searching for privacy, downloads, proxy, sync, or tabs.
              </div>
            ) : (
              panels[tab]
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
