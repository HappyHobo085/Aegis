// src/components/SettingsModal.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsModal } from './SettingsModal';

// Mock the heavy lazy-loaded tab components so tests don't trigger code-split chunks.
vi.mock('./FilterListsTab', () => ({
  default: () => <div data-testid="panel-filterLists">FILTER LISTS</div>,
}));
vi.mock('./VaultSettingsTab', () => ({
  default: () => <div data-testid="panel-vault">VAULT</div>,
}));
vi.mock('./MyFiltersTab', () => ({
  default: () => <div data-testid="panel-myFilters">MY FILTERS</div>,
}));
vi.mock('./SyncSettingsTab', () => ({
  default: () => <div data-testid="panel-sync">SYNC</div>,
}));
vi.mock('./ProxySettingsTab', () => ({
  default: () => <div data-testid="panel-proxy">PROXY</div>,
}));
vi.mock('./SecurityTab', () => ({
  default: () => <div data-testid="panel-security">SECURITY</div>,
}));

const lightPanels = () => ({
  appearance: <div data-testid="panel-appearance">APPEARANCE</div>,
  search: <div data-testid="panel-search">SEARCH</div>,
  home: <div data-testid="panel-home">HOME</div>,
  tabs: <div data-testid="panel-tabs">TABS</div>,
  allowlist: <div data-testid="panel-allowlist">ALLOWLIST</div>,
  downloads: <div data-testid="panel-downloads">DOWNLOADS</div>,
  sitePermissions: <div data-testid="panel-sitePermissions">SITE PERMISSIONS</div>,
  data: <div data-testid="panel-data">DATA</div>,
});

/** Minimal mock data for the heavy tabs — the mocked components ignore these anyway. */
const heavyData = {
  filterLists: { subs: [], setEnabled: vi.fn(), add: vi.fn(), remove: vi.fn(), updateNow: vi.fn() },
  myFilters: { text: '', save: vi.fn() },
  security: {
    protection: {
      privateMode: false,
      httpsOnly: false,
      webrtcPolicy: 'public-only',
      fingerprintLevel: 'off',
      fingerprintAllowed: false,
      proxyActive: false,
      proxyUri: null,
    },
    adblockState: { enabled: true, allowlistedHosts: [], sessionBlocked: 0 },
    blockedHere: 0,
    onHarden: vi.fn(),
    onOpenProxy: vi.fn(),
    settings: {} as never,
    update: vi.fn(),
    listExceptions: vi.fn(),
    removeException: vi.fn(),
    fingerprintState: { level: 'off' as const, allowlistedHosts: [] as string[] },
    toggleFingerprintAllowlist: vi.fn(),
    removeFingerprintAllowlist: vi.fn(),
  } as never,
  proxy: {
    state: {
      mode: 'off' as const,
      scheme: 'http' as const,
      host: '',
      port: 0,
      bypassHosts: [],
      active: false,
      uri: null,
    },
    setConfig: vi.fn(),
    test: vi.fn(),
  },
  vault: {
    state: { exists: false, unlocked: false, count: 0, undecryptable: 0, syncEnabled: false },
    create: vi.fn(),
    unlock: vi.fn(),
    lock: vi.fn(),
    list: vi.fn(),
    add: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    search: vi.fn(),
    _setRecordsRef: { current: null },
  } as never,
  sync: {
    sync: {
      state: {
        enabled: false,
        status: 'disabled' as const,
        serverUrl: '',
        lastSyncMs: 0,
        lastError: '',
        deviceId: '',
        accountId: '',
        vaultBacking: 'none' as const,
        hasStoredRoot: false,
      },
      enableNew: vi.fn(),
      enableFromPhrase: vi.fn(),
      unlock: vi.fn(),
      disable: vi.fn(),
      syncNow: vi.fn(),
      testConnection: vi.fn(),
      getRecoveryPhrase: vi.fn(),
      listDevices: vi.fn(),
      removeDevice: vi.fn(),
    },
    onSetServerUrl: vi.fn(),
  },
};

const props = (over: Partial<React.ComponentProps<typeof SettingsModal>> = {}) => ({
  onClose: vi.fn(),
  ...lightPanels(),
  ...heavyData,
  ...over,
});

describe('SettingsModal', () => {
  it('renders as a modal dialog named Settings', () => {
    render(<SettingsModal {...props()} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName(/settings/i);
  });

  it('renders a tablist with all thirteen tabs', () => {
    render(<SettingsModal {...props()} />);
    const tablist = screen.getByRole('tablist', { name: /settings sections/i });
    expect(tablist).toBeInTheDocument();
    for (const name of [
      /appearance/i,
      /search/i,
      /^home$/i,
      /^tabs$/i,
      /filter lists/i,
      /my filters/i,
      /allowlist/i,
      /^downloads$/i,
      /site permissions/i,
      /^security$/i,
      /^passwords$/i,
      /^sync$/i,
      /^data$/i,
    ]) {
      expect(screen.getByRole('tab', { name })).toBeInTheDocument();
    }
  });

  it('renders settings search as its own row outside the tablist', () => {
    render(<SettingsModal {...props()} />);
    const tablist = screen.getByRole('tablist', { name: /settings sections/i });
    const search = screen.getByRole('search');
    expect(search).toContainElement(screen.getByPlaceholderText(/search settings/i));
    expect(tablist).not.toContainElement(search);
  });

  it('shows the Appearance panel by default and marks its tab selected', () => {
    render(<SettingsModal {...props()} />);
    expect(screen.getByRole('tab', { name: /appearance/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByTestId('panel-appearance')).toBeInTheDocument();
    expect(screen.queryByTestId('panel-search')).not.toBeInTheDocument();
  });

  it('switches to another tab on click', async () => {
    render(<SettingsModal {...props()} />);
    await userEvent.click(screen.getByRole('tab', { name: /filter lists/i }));
    expect(screen.getByRole('tab', { name: /filter lists/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await waitFor(() => {
      expect(screen.getByTestId('panel-filterLists')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('panel-appearance')).not.toBeInTheDocument();
  });

  it('the active tabpanel is labelled by its tab', async () => {
    render(<SettingsModal {...props()} />);
    await userEvent.click(screen.getByRole('tab', { name: /my filters/i }));
    await waitFor(() => {
      expect(screen.getByTestId('panel-myFilters')).toBeInTheDocument();
    });
    const panel = screen.getByRole('tabpanel');
    expect(panel).toHaveAccessibleName(/my filters/i);
  });

  it('closes on the Close button and on Escape', async () => {
    const p = props();
    render(<SettingsModal {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /^close$/i }));
    expect(p.onClose).toHaveBeenCalledTimes(1);
    (p.onClose as ReturnType<typeof vi.fn>).mockClear();
    await userEvent.keyboard('{Escape}');
    expect(p.onClose).toHaveBeenCalledTimes(1);
  });
});
