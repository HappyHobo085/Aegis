// src/components/SettingsModal.tsx
import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { useDialog } from '../hooks/useDialog';
import { useHorizontalWheel } from '../hooks/useHorizontalWheel';
import { useChromeSurface } from '../hooks/useChromeSurfaces';

import { FilterListsTab } from './FilterListsTab';
import { VaultSettingsTab } from './VaultSettingsTab';
import { MyFiltersTab } from './MyFiltersTab';
import { SyncSettingsTab } from './SyncSettingsTab';
import { ProxySettingsTab } from './ProxySettingsTab';
import { SecurityTab } from './SecurityTab';
import type { SecurityTabProps } from './SecurityTab';
import { HttpsTab } from './HttpsTab';
import { WebrtcTab } from './WebrtcTab';
import { FingerprintTab } from './FingerprintTab';
import type { FilterListsTabProps } from './FilterListsTab';
import type { MyFiltersTabProps } from './MyFiltersTab';
import type { ProxySettingsTabProps } from './ProxySettingsTab';
import type { HttpsTabProps } from './HttpsTab';
import type { WebrtcTabProps } from './WebrtcTab';
import type { FingerprintTabProps } from './FingerprintTab';
import type { UseVault } from '../hooks/useVault';
import type { UseSync } from '../hooks/useSync';
import type { Settings } from '../../shared/types';
import type { ProtectionSummary } from '../lib/protectionSummary';
import type { AdblockState } from '../../shared/types';

// These six tabs used to be `lazy(() => import(...))` behind a `<Suspense>` boundary, each its
// own chunk loaded on first selection. That was dropped deliberately: with the React Compiler
// enabled, a tab's FIRST mount suspended and then never re-rendered after the dynamic import
// resolved, so the panel committed nothing and every element inside it stayed unreachable. That
// broke 5 interaction specs outright and made a 6th (`vault.create.submit`) surface a
// pre-existing first-mount ordering dependency. The tabs are small and the whole renderer is
// ~114 KB gzipped against a 512 KB (non-blocking) CI threshold, so six extra eager chunks cost
// little and buy a tab panel that is present the instant it is selected.

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
  // `security` is the Security section's OVERVIEW. The id was deliberately kept (and only
  // the label changed) so `openSettings('security')` — the padlock menu's "Privacy
  // settings" in both shells — keeps landing on the protection summary with no call-site
  // change. The three controls that used to share this tab now have their own ids.
  | 'security'
  | 'https'
  | 'webrtc'
  | 'fingerprint'
  | 'proxy'
  | 'vault'
  | 'sync'
  | 'data';

/** Exported so a test can derive the rail's accessible names from the declaration
 *  instead of hand-listing them — see `SettingsModal.test.tsx`. */
export const TAB_LABELS: Record<SettingsTab, string> = {
  appearance: 'Appearance',
  search: 'Search',
  home: 'Home',
  tabs: 'Tabs',
  filterLists: 'Filter Lists',
  myFilters: 'My Filters',
  allowlist: 'Allowlist',
  downloads: 'Downloads',
  sitePermissions: 'Site permissions',
  security: 'Overview',
  https: 'HTTPS',
  webrtc: 'WebRTC',
  fingerprint: 'Fingerprinting',
  proxy: 'Proxy',
  vault: 'Passwords',
  sync: 'Sync',
  data: 'Data',
};

export const TAB_SUMMARIES: Record<SettingsTab, string> = {
  appearance: 'Theme, accent, and visual preferences',
  search: 'Default search behavior',
  home: 'Home page and start destination',
  tabs: 'Tab behavior and private browsing',
  filterLists: 'Built-in and subscribed block lists',
  myFilters: 'Custom blocking rules',
  allowlist: 'Sites exempt from ad blocking',
  downloads: 'File download behavior',
  sitePermissions: 'Camera, microphone, and site access',
  security: 'Your overall protection status',
  https: 'Force a secure connection',
  webrtc: 'Local IP leak protection',
  fingerprint: 'Anti-fingerprinting noise',
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
  { title: 'Appearance', tabs: ['appearance', 'home', 'search', 'tabs'] },
  { title: 'Privacy', tabs: ['sitePermissions'] },
  { title: 'Security', tabs: ['security', 'https', 'webrtc', 'fingerprint'] },
  { title: 'Blocking', tabs: ['filterLists', 'myFilters', 'allowlist'] },
  { title: 'Network', tabs: ['proxy', 'sync'] },
  // Passwords live here rather than under Privacy: a credential store is not a privacy
  // control, and leaving it filed under a privacy heading mislabels what it holds.
  { title: 'Data', tabs: ['downloads', 'data', 'vault'] },
];

export const TAB_ORDER: SettingsTab[] = TAB_GROUPS.flatMap((g) => g.tabs);

/**
 * Tabs that need their data props from the parent — they render only when selected, so the
 * panel branches on `tab` alone. (Formerly `LAZY_TABS`: these were the code-split ones. The name
 * now describes the data flow, which is the thing that still matters.)
 */
const DATA_DRIVEN_TABS: ReadonlySet<SettingsTab> = new Set([
  'filterLists',
  'myFilters',
  'security',
  'https',
  'webrtc',
  'fingerprint',
  'proxy',
  'vault',
  'sync',
]);

/**
 * Props for the Security section's Overview tab — the protection summary plus the
 * always-on malicious-site note. This type used to be a 14-field bundle covering all
 * four Security tabs; the split gave each tab its own props, so a panel now receives
 * only the stores it actually reads.
 */
export type { HttpsTabProps, WebrtcTabProps, FingerprintTabProps };

/** Data props for the sync panel. */
export interface SyncPanelProps {
  sync: UseSync;
  onSetServerUrl: (url: string) => void | Promise<void>;
  /** The current settings — the panel reads/writes the `syncVault` opt-in through these. */
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
}

export interface SettingsModalProps {
  onClose(): void;
  initialTab?: SettingsTab;
  quickActions?: ReactNode;

  // Light tabs — eagerly rendered, passed as ReactNode
  appearance: ReactNode;
  search: ReactNode;
  home: ReactNode;
  tabs: ReactNode;
  allowlist: ReactNode;
  downloads: ReactNode;
  sitePermissions: ReactNode;
  data: ReactNode;

  // Data-driven tabs — need these props, rendered only when selected
  filterLists: FilterListsTabProps;
  myFilters: MyFiltersTabProps;
  security: SecurityTabProps;
  https: HttpsTabProps;
  webrtc: WebrtcTabProps;
  fingerprint: FingerprintTabProps;
  proxy: ProxySettingsTabProps;
  vault: UseVault;
  sync: SyncPanelProps;
}

export function SettingsModal({
  onClose,
  initialTab = 'appearance',
  quickActions,
  appearance,
  search,
  home,
  tabs,
  allowlist,
  downloads,
  sitePermissions,
  data,
  filterLists,
  myFilters,
  security,
  https,
  webrtc,
  fingerprint,
  proxy,
  vault,
  sync,
}: SettingsModalProps) {
  useChromeSurface('settings', true);
  const titleId = useId();
  const dialogRef = useDialog<HTMLDivElement>(onClose);
  const tabsRef = useHorizontalWheel<HTMLDivElement>();
  const [tab, setTab] = useState<SettingsTab>(initialTab);
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
  const httpsTabId = useId();
  const webrtcTabId = useId();
  const fingerprintTabId = useId();
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
    https: httpsTabId,
    webrtc: webrtcTabId,
    fingerprint: fingerprintTabId,
    proxy: proxyTabId,
    vault: vaultTabId,
    sync: syncTabId,
    data: dataTabId,
  };

  /** Eagerly-rendered panels (light tabs only). */
  const panels: Record<string, ReactNode> = {
    appearance,
    search,
    home,
    tabs,
    allowlist,
    downloads,
    sitePermissions,
    data,
  };

  /** Render the active panel — data-driven tabs get props, self-contained tabs render bare. */
  const renderPanel = (): ReactNode => {
    if (visibleGroups.length === 0) {
      return (
        <div className="settings-modal__empty-panel">
          Try searching for privacy, downloads, proxy, sync, or tabs.
        </div>
      );
    }

    if (!DATA_DRIVEN_TABS.has(tab)) {
      return panels[tab] ?? null;
    }

    return (
      <>
        {tab === 'filterLists' && <FilterListsTab {...filterLists} />}
        {tab === 'myFilters' && <MyFiltersTab {...myFilters} />}
        {tab === 'security' && <SecurityTab {...security} />}
        {tab === 'https' && <HttpsTab {...https} />}
        {tab === 'webrtc' && <WebrtcTab {...webrtc} />}
        {tab === 'fingerprint' && <FingerprintTab {...fingerprint} />}
        {tab === 'proxy' && <ProxySettingsTab {...proxy} />}
        {tab === 'vault' && <VaultSettingsTab vault={vault} />}
        {tab === 'sync' && <SyncSettingsTab {...sync} />}
      </>
    );
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

        {quickActions && <div className="settings-modal__quick-actions">{quickActions}</div>}

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
              <p className="settings-modal__no-results">No settings match "{tabQuery.trim()}".</p>
            )}
          </div>
          <div
            role="tabpanel"
            id={panelId}
            aria-labelledby={tabIds[tab]}
            className="settings-modal__panel"
          >
            {renderPanel()}
          </div>
        </div>
      </div>
    </div>
  );
}
