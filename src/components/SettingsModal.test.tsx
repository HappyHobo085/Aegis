// src/components/SettingsModal.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Settings } from '../../shared/types';
import {
  SettingsModal,
  TAB_GROUPS,
  TAB_LABELS,
  TAB_ORDER,
  type SettingsTab,
} from './SettingsModal';

// Mock the heavy lazy-loaded tab components so tests don't trigger code-split chunks.
// `SettingsModal` imports each tab as a NAMED export (it stopped `lazy()`-importing
// them), so the mock has to provide that binding. `default` is kept because the
// dynamic-import shape is the one these mocks were originally written for.
vi.mock('./FilterListsTab', () => ({
  FilterListsTab: () => <div data-testid="panel-filterLists">FILTER LISTS</div>,
  default: () => <div data-testid="panel-filterLists">FILTER LISTS</div>,
}));
// `SettingsModal` imports each tab as a NAMED export (it stopped `lazy()`-importing
// them), so the mock has to provide that binding. `default` is kept because the
// dynamic-import shape is the one these mocks were originally written for.
vi.mock('./VaultSettingsTab', () => ({
  VaultSettingsTab: () => <div data-testid="panel-vault">VAULT</div>,
  default: () => <div data-testid="panel-vault">VAULT</div>,
}));
// `SettingsModal` imports each tab as a NAMED export (it stopped `lazy()`-importing
// them), so the mock has to provide that binding. `default` is kept because the
// dynamic-import shape is the one these mocks were originally written for.
vi.mock('./MyFiltersTab', () => ({
  MyFiltersTab: () => <div data-testid="panel-myFilters">MY FILTERS</div>,
  default: () => <div data-testid="panel-myFilters">MY FILTERS</div>,
}));
// `SettingsModal` imports each tab as a NAMED export (it stopped `lazy()`-importing
// them), so the mock has to provide that binding. `default` is kept because the
// dynamic-import shape is the one these mocks were originally written for.
vi.mock('./SyncSettingsTab', () => ({
  SyncSettingsTab: () => <div data-testid="panel-sync">SYNC</div>,
  default: () => <div data-testid="panel-sync">SYNC</div>,
}));
// `SettingsModal` imports each tab as a NAMED export (it stopped `lazy()`-importing
// them), so the mock has to provide that binding. `default` is kept because the
// dynamic-import shape is the one these mocks were originally written for.
vi.mock('./ProxySettingsTab', () => ({
  ProxySettingsTab: () => <div data-testid="panel-proxy">PROXY</div>,
  default: () => <div data-testid="panel-proxy">PROXY</div>,
}));
// `SettingsModal` imports each tab as a NAMED export (it stopped `lazy()`-importing
// them), so the mock has to provide that binding. `default` is kept because the
// dynamic-import shape is the one these mocks were originally written for.
vi.mock('./SecurityTab', () => ({
  SecurityTab: () => <div data-testid="panel-security">SECURITY OVERVIEW</div>,
  default: () => <div data-testid="panel-security">SECURITY OVERVIEW</div>,
}));
// The three tabs the Security tab was split into. Each gets its own mock so a test can
// assert that selecting one renders THAT panel and not the others — which is the whole
// observable of the split.
vi.mock('./HttpsTab', () => ({
  HttpsTab: () => <div data-testid="panel-https">HTTPS</div>,
  default: () => <div data-testid="panel-https">HTTPS</div>,
}));
vi.mock('./WebrtcTab', () => ({
  WebrtcTab: () => <div data-testid="panel-webrtc">WEBRTC</div>,
  default: () => <div data-testid="panel-webrtc">WEBRTC</div>,
}));
vi.mock('./FingerprintTab', () => ({
  FingerprintTab: () => <div data-testid="panel-fingerprint">FINGERPRINTING</div>,
  default: () => <div data-testid="panel-fingerprint">FINGERPRINTING</div>,
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
  } as never,
  // The three split tabs carry their own props bundles. Before the split all of these
  // rode inside `security`; now each panel receives only the stores it reads.
  https: {
    settings: {} as never,
    update: vi.fn(),
    listExceptions: vi.fn(),
    removeException: vi.fn(),
  } as never,
  webrtc: {
    settings: {} as never,
    update: vi.fn(),
    webrtcExempt: { exemptHosts: [] as string[] },
    toggleWebrtcExempt: vi.fn(),
    removeWebrtcExempt: vi.fn(),
  } as never,
  fingerprint: {
    settings: {} as never,
    update: vi.fn(),
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
      // The rejected-vault-write report. `null` is the common case (the core quarantined
      // nothing), and it is deliberately a required field rather than an optional one with a
      // default: a fixture that forgot it should fail the type check, not silently render a
      // panel that cannot report a rejected write.
      quarantined: null,
    },
    onSetServerUrl: vi.fn(),
    settings: {} as Settings,
    update: vi.fn(),
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

  // DERIVED from `TAB_GROUPS`, not hand-listed. The hand-written version of this test
  // enumerated thirteen names while the rail carried fourteen — it had silently dropped
  // `proxy` — and `src/AGENTS.md` then documented it as the test that "walks every tab".
  // A list that has to be updated by hand is a list that goes stale; deriving it means a
  // new tab (or a dropped one) shows up as a failure here instead of silence.
  it('renders a tab for every tab in every group, and nothing else', () => {
    render(<SettingsModal {...props()} />);
    const tablist = screen.getByRole('tablist', { name: /settings sections/i });
    expect(tablist).toBeInTheDocument();
    const declared = TAB_ORDER.map((t) => TAB_LABELS[t]);
    const rendered = screen.getAllByRole('tab').map((t) => t.getAttribute('aria-label'));
    // Equal as SETS and as LENGTHS: no undeclared tab in the rail, and no declared tab
    // missing from it. Either half alone would pass on a duplicated name.
    expect([...rendered].sort()).toEqual([...declared].sort());
  });

  // The comparison above CANNOT catch a tab dropped from `TAB_GROUPS` — both sides are
  // derived from it, so removing a tab removes it from both and they stay equal. Proved
  // by mutation: deleting `'vault'` from the Data group left that assertion green.
  //
  // `TAB_LABELS` is `Record<SettingsTab, string>`, so its KEYS are the whole `SettingsTab`
  // union — a second, INDEPENDENT declaration. Every one of those keys must appear in
  // `TAB_ORDER`, which is what "no tab was dropped from the rail" actually means. It
  // still cannot catch a tab missing from BOTH declarations — but that is a compile
  // error, because `TAB_LABELS`' value type names the union member.
  it('no tab declared in TAB_LABELS is missing from the rail', () => {
    const inRail = new Set(TAB_ORDER);
    const missing = Object.keys(TAB_LABELS).filter((t) => !inRail.has(t as SettingsTab));
    expect(missing).toEqual([]);
  });

  // The Security split: each of the three former sub-controls is its own tab, and the
  // Overview keeps the id `security` so `openSettings('security')` still resolves.
  it('splits the Security tab into Overview, HTTPS, WebRTC and Fingerprinting', async () => {
    render(<SettingsModal {...props()} />);
    expect(screen.getByRole('tab', { name: /^overview$/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /^https$/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /^webrtc$/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /^fingerprinting$/i })).toBeInTheDocument();
    // No tab may still be called plain "Security" — that was the pre-split name.
    expect(screen.queryByRole('tab', { name: /^security$/i })).toBeNull();

    // Each selects its OWN panel, and only its own.
    for (const [tabName, testId] of [
      [/^overview$/i, 'panel-security'],
      [/^https$/i, 'panel-https'],
      [/^webrtc$/i, 'panel-webrtc'],
      [/^fingerprinting$/i, 'panel-fingerprint'],
    ] as const) {
      await userEvent.click(screen.getByRole('tab', { name: tabName }));
      await waitFor(() => {
        expect(screen.getByTestId(testId)).toBeInTheDocument();
      });
      expect(screen.getAllByTestId(/^panel-/).map((n) => n.getAttribute('data-testid'))).toEqual([
        testId,
      ]);
    }
  });

  it('groups the Security tabs under one Security section', () => {
    render(<SettingsModal {...props()} />);
    const groups = Array.from(document.querySelectorAll('.settings-modal__tab-group-label')).map(
      (n) => n.textContent,
    );
    expect(groups).toEqual(TAB_GROUPS.map((g) => g.title));
    // The four Security tabs are consecutive in the flat order, i.e. same group.
    const at = (t: string) => TAB_ORDER.indexOf(t as never);
    expect(at('https') - at('security')).toBe(1);
    expect(at('webrtc') - at('https')).toBe(1);
    expect(at('fingerprint') - at('webrtc')).toBe(1);
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

// The tab rail is a `role="tablist"` with a roving tabindex — exactly one tab is
// `tabIndex={0}`, the rest `-1`, and the arrow keys move the selection AND the focus
// together. None of that was exercised before this block: no test pressed an arrow
// key in the rail, and none typed in the settings search, so the whole keyboard
// navigation and the query that reorders the rail were untested.
describe('SettingsModal roving tabindex and search', () => {
  const tab = (name: RegExp): HTMLElement => screen.getByRole('tab', { name });
  const searchBox = (): HTMLElement => screen.getByPlaceholderText(/search settings/i);
  /** A matcher for whatever `TAB_ORDER` says the last tab is, so the wrap assertions
   *  below cannot drift out of date when the rail is regrouped. */
  const lastLabel = (): RegExp =>
    new RegExp(`^${TAB_LABELS[TAB_ORDER[TAB_ORDER.length - 1]]}$`, 'i');

  it('moves the selection and the focus with the arrow keys, wrapping at both ends', () => {
    render(<SettingsModal {...props()} />);
    const appearance = tab(/^appearance$/i);
    appearance.focus();
    // The rail is GROUPED, not flat: `TAB_ORDER` is the flattened group order, so the
    // tab after Appearance is Home — not Search.
    fireEvent.keyDown(appearance, { key: 'ArrowRight' });
    const home = tab(/^home$/i);
    expect(home).toHaveAttribute('aria-selected', 'true');
    expect(home).toHaveFocus();
    expect(appearance).toHaveAttribute('aria-selected', 'false');
    expect(appearance).toHaveAttribute('tabindex', '-1');
    expect(home).toHaveAttribute('tabindex', '0');
    fireEvent.keyDown(home, { key: 'ArrowDown' });
    expect(tab(/^search$/i)).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(tab(/^search$/i), { key: 'ArrowUp' });
    expect(home).toHaveAttribute('aria-selected', 'true');
    // Step back once more to reach the first tab, then check the wrap: Up from there
    // must land on the LAST tab rather than moving nowhere.
    fireEvent.keyDown(home, { key: 'ArrowLeft' });
    expect(appearance).toHaveAttribute('aria-selected', 'true');
    expect(screen.getAllByRole('tab')[0]).toBe(appearance); // precondition: it is the first
    fireEvent.keyDown(appearance, { key: 'ArrowUp' });
    const lastTab = tab(lastLabel());
    expect(lastTab).toHaveAttribute('aria-selected', 'true');
    expect(lastTab).toHaveFocus();
  });

  it('jumps to the ends with Home and End', () => {
    render(<SettingsModal {...props()} />);
    const appearance = tab(/^appearance$/i);
    appearance.focus();
    fireEvent.keyDown(appearance, { key: 'End' });
    expect(tab(lastLabel())).toHaveAttribute('aria-selected', 'true');
    expect(tab(lastLabel())).toHaveFocus();
    fireEvent.keyDown(tab(lastLabel()), { key: 'Home' });
    expect(appearance).toHaveAttribute('aria-selected', 'true');
    expect(appearance).toHaveFocus();
  });

  // The rail's LAST tab is Passwords, not Data: `vault` moved into the Data group when
  // Privacy stopped filing a credential store as a privacy control. These two tests used
  // to hard-code `data`, which is exactly the kind of literal that goes stale on a
  // reorder — they are now written against `TAB_ORDER`'s own tail.
  it('ends the rail on Passwords', () => {
    render(<SettingsModal {...props()} />);
    expect(screen.getAllByRole('tab').at(-1)).toBe(tab(/^passwords$/i));
  });

  it('cancels the default action for every key it claims, so the page does not scroll too', () => {
    render(<SettingsModal {...props()} />);
    const appearance = tab(/^appearance$/i);
    appearance.focus();
    // `fireEvent` returns the event's dispatch result, which is `false` exactly when a
    // handler called `preventDefault()`. Each of these keys is one the rail claims, and
    // a key the rail claims but does not cancel both scrolls the page and moves the tab.
    for (const key of ['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End']) {
      expect(fireEvent.keyDown(document.activeElement ?? appearance, { key })).toBe(false);
    }
  });

  it('moves within the FILTERED rail, so Up from the first match wraps to the last match', async () => {
    render(<SettingsModal {...props()} />);
    await userEvent.type(searchBox(), 'block');
    // "block" matches exactly the three Blocking tabs — two by summary, one by label.
    expect(screen.getAllByRole('tab')).toHaveLength(3);
    expect(screen.queryByRole('tab', { name: /^appearance$/i })).toBeNull();
    tab(/filter lists/i).focus();
    fireEvent.keyDown(tab(/filter lists/i), { key: 'Home' });
    expect(tab(/filter lists/i)).toHaveAttribute('aria-selected', 'true');
    // Up from the first MATCH must wrap to the last MATCH. Stepping through the
    // unfiltered TAB_ORDER here would land on Passwords, which is not in the rail at
    // all — the panel would render with no controlling tab on screen.
    fireEvent.keyDown(tab(/filter lists/i), { key: 'ArrowUp' });
    expect(tab(/allowlist/i)).toHaveAttribute('aria-selected', 'true');
    expect(tab(/allowlist/i)).toHaveFocus();
  });

  it('moves the selection to the first visible tab when the query hides the selected one', async () => {
    render(<SettingsModal {...props()} />);
    await userEvent.click(tab(/^data$/i));
    expect(screen.getByTestId('panel-data')).toBeInTheDocument();
    await userEvent.type(searchBox(), 'block');
    expect(screen.queryByRole('tab', { name: /^data$/i })).toBeNull();
    // Leaving Data selected would render its panel while the tab that controls it is
    // not on screen, so the selection falls to the first tab still in the rail.
    expect(tab(/filter lists/i)).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => {
      expect(screen.getByTestId('panel-filterLists')).toBeInTheDocument();
    });
  });

  it('shows the search hint instead of a panel when the query matches nothing', async () => {
    render(<SettingsModal {...props()} />);
    await userEvent.type(searchBox(), 'zzzz');
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(screen.getByText(/no settings match/i)).toBeInTheDocument();
    expect(
      screen.getByText(/try searching for privacy, downloads, proxy, sync, or tabs/i),
    ).toBeInTheDocument();
  });

  // The hint is copy the user reads, and it names sections by their OLD names — "privacy"
  // no longer holds the protection controls, and there is no longer a tab called
  // "Security". A hint that points at a tab that has been renamed is the same class of
  // dead pointer as the Proxy tab's "in the Security tab".
  it('names topics that exist in the current rail', async () => {
    render(<SettingsModal {...props()} />);
    await userEvent.type(searchBox(), 'zzzz');
    const hint = screen.getByText(/try searching for/i).textContent ?? '';
    // "Try searching for privacy, downloads, proxy, sync, or tabs." — the topics after
    // "for" are how a user with no result is told where to look. Each must be findable:
    // the settings search matches a tab by its LABEL, so a topic naming a tab that has
    // been renamed is a dead pointer. It is the same defect as the Proxy tab's old
    // "in the Security tab" copy, in the one place every stalled search is guaranteed to
    // read. Derived from `TAB_LABELS`, so renaming a tab reds this instead of rotting.
    const topics = hint
      .replace(/^.*\bfor\b\s*/i, '')
      .split(/,|\bor\b/i)
      .map((t) => t.trim().replace(/[.?]$/, '').toLowerCase())
      .filter(Boolean);
    expect(topics.length).toBeGreaterThanOrEqual(4);
    const labels = TAB_ORDER.map((t) => TAB_LABELS[t].toLowerCase());
    const groupTitles = TAB_GROUPS.map((g) => g.title.toLowerCase());
    for (const topic of topics) {
      // Reachable means: a group title OR a tab label. NOT the summary — the filter
      // substring-matches the title and the label only, so a hint naming a topic that
      // appears only in a summary would send the user nowhere.
      const asGroup = groupTitles.some((g) => g.startsWith(topic) || topic.startsWith(g));
      const asLabel = labels.some((l) => l.startsWith(topic) || topic.startsWith(l));
      expect(
        asGroup || asLabel,
        `the no-results hint names "${topic}", which is neither a section title nor a tab label`,
      ).toBe(true);
    }
  });
});
