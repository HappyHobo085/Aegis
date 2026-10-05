import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MockInstance } from 'vitest';
import type { HistoryEntry } from '../../shared/types';
import { aegis } from '../lib/ipcClient';
import { AddressBar } from './AddressBar';
import type { OmniboxStores } from './AddressBar';
import type { ProtectionSummary } from '../lib/protectionSummary';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

const SEARCH = 'https://duckduckgo.com/?q=%s';

const stores: OmniboxStores = { favorites: [], saved: [], searchTemplate: SEARCH };

function entry(over: Partial<HistoryEntry> = {}): HistoryEntry {
  return { id: 1, url: 'https://a.example/', title: 'A', visitedAt: 1_700_000_000_000, ...over };
}

/** The omnibox debounces 90ms before it queries history. */
async function settle() {
  await waitFor(() => expect(aegis.history.search).toHaveBeenCalled(), { timeout: 2000 });
}

/** One protection summary for every test in this file: the site panel and the omnibox
 *  read the same two flags out of it. */
const protection = {
  httpsOnly: true,
  privateMode: false,
  blockedCount: 0,
  trackerCount: 0,
  thirdPartyCookiesBlocked: false,
} as unknown as ProtectionSummary;

describe('AddressBar', () => {
  it('shows the URL and adopts a prop change while not focused', () => {
    const { rerender } = render(<AddressBar url="https://a.example/" onSubmit={vi.fn()} />);
    const input = screen.getByRole('combobox', { name: /address/i });
    expect(input).toHaveValue('https://a.example/');
    rerender(<AddressBar url="https://b.example/" onSubmit={vi.fn()} />);
    expect(input).toHaveValue('https://b.example/');
  });

  it('does not clobber in-progress typing when the URL changes while focused', async () => {
    const { rerender } = render(<AddressBar url="https://a.example/" onSubmit={vi.fn()} />);
    const input = screen.getByRole('combobox', { name: /address/i });
    await userEvent.click(input);
    await userEvent.clear(input);
    await userEvent.type(input, 'my-search');
    // A background navigation updates the URL prop while the user is typing.
    rerender(<AddressBar url="https://background-nav.example/" onSubmit={vi.fn()} />);
    expect(input).toHaveValue('my-search');
  });

  it('reverts an unsubmitted edit to the live URL on blur', async () => {
    render(<AddressBar url="https://a.example/" onSubmit={vi.fn()} />);
    const input = screen.getByRole('combobox', { name: /address/i });
    await userEvent.click(input);
    await userEvent.clear(input);
    await userEvent.type(input, 'half-typed');
    await userEvent.tab();
    expect(input).toHaveValue('https://a.example/');
  });

  it('submits the typed value', async () => {
    const onSubmit = vi.fn();
    render(<AddressBar url="https://a.example/" onSubmit={onSubmit} />);
    const input = screen.getByRole('combobox', { name: /address/i });
    await userEvent.click(input);
    await userEvent.clear(input);
    await userEvent.type(input, 'cats{Enter}');
    expect(onSubmit).toHaveBeenCalledWith('cats');
  });
});

describe('AddressBar omnibox', () => {
  let search: MockInstance<typeof aegis.history.search>;
  let list: MockInstance<typeof aegis.history.list>;

  beforeEach(() => {
    // Spied, not module-mocked: ipcClient is the real chokepoint here and the
    // other AddressBar tests exercise the unmocked version on purpose.
    search = vi.spyOn(aegis.history, 'search').mockResolvedValue([]);
    list = vi.spyOn(aegis.history, 'list').mockResolvedValue([]);
  });

  afterEach(() => {
    search.mockRestore();
    list.mockRestore();
  });

  it('stays closed until the field is focused', async () => {
    render(<AddressBar url="about:blank" omnibox={stores} onSubmit={vi.fn()} />);
    const input = screen.getByRole('combobox', { name: /address/i });
    expect(input).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('listbox')).toBeNull();

    await userEvent.click(input);
    await userEvent.type(input, 'a');
    await settle();
    // The "Search for …" row always exists for a non-empty query, so the list
    // opens on the first keystroke.
    await waitFor(() => expect(screen.getByRole('listbox')).toBeTruthy());
    expect(input).toHaveAttribute('aria-expanded', 'true');
  });

  it('lists history, favorites and saved pages plus a search row', async () => {
    search.mockResolvedValue([entry({ id: 1, url: 'https://news.example/story', title: 'Story' })]);
    render(
      <AddressBar
        url="about:blank"
        onSubmit={vi.fn()}
        omnibox={{
          favorites: [{ id: 9, name: 'Docs', url: 'https://docs.example/', position: 0 }],
          saved: [
            { id: 4, url: 'https://saved.example/post', title: 'Post', tags: [], savedAt: 1 },
          ],
          searchTemplate: SEARCH,
        }}
      />,
    );
    await userEvent.click(screen.getByRole('combobox', { name: /address/i }));
    await userEvent.type(screen.getByRole('combobox', { name: /address/i }), 'example');
    await settle();

    const options = await screen.findAllByRole('option');
    const titles = options.map((o) => o.textContent ?? '');
    expect(titles.some((t) => t.includes('Docs'))).toBe(true);
    expect(titles.some((t) => t.includes('Post'))).toBe(true);
    expect(titles.some((t) => t.includes('Story'))).toBe(true);
    // The search row is always last.
    expect(titles[titles.length - 1]).toContain('Search for');
  });

  it('navigates with the resolved URL when Enter picks a search row', async () => {
    const onSubmit = vi.fn();
    render(<AddressBar url="about:blank" omnibox={stores} onSubmit={onSubmit} />);
    const input = screen.getByRole('combobox', { name: /address/i });
    await userEvent.click(input);
    await userEvent.type(input, ' kittens');
    await settle();

    // One ArrowDown highlights the first row (the search row, since "kittens"
    // is not URL-like). Enter must submit the RESOLVED url, not the raw text.
    await userEvent.keyboard('{ArrowDown}');
    await userEvent.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalledWith('https://duckduckgo.com/?q=kittens');
    // The field shows what actually loaded, and the list is dismissed.
    expect(input).toHaveValue('https://duckduckgo.com/?q=kittens');
    expect(input).toHaveAttribute('aria-expanded', 'false');
  });

  it('navigates straight to a typed host when the "Go to" row is active', async () => {
    const onSubmit = vi.fn();
    render(<AddressBar url="about:blank" omnibox={stores} onSubmit={onSubmit} />);
    const input = screen.getByRole('combobox', { name: /address/i });
    await userEvent.click(input);
    await userEvent.type(input, 'example.org');
    await settle();

    // "example.org" is URL-like, so the first row is the Go-to row.
    await userEvent.keyboard('{ArrowDown}');
    expect(input).toHaveAttribute(
      'aria-activedescendant',
      expect.stringContaining('-opt-0') as unknown as string,
    );
    await userEvent.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalledWith('https://example.org');
  });

  it('picks a suggestion with the mouse and keeps focus in the field', async () => {
    const onSubmit = vi.fn();
    search.mockResolvedValue([
      entry({ id: 1, url: 'https://example.com/docs', title: 'The docs' }),
    ]);
    render(<AddressBar url="about:blank" omnibox={stores} onSubmit={onSubmit} />);
    const input = screen.getByRole('combobox', { name: /address/i });
    await userEvent.click(input);
    await userEvent.type(input, 'docs');
    await settle();

    const row = (await screen.findAllByRole('option')).find((o) =>
      (o.textContent ?? '').includes('The docs'),
    );
    expect(row).toBeTruthy();
    await userEvent.click(row!);
    expect(onSubmit).toHaveBeenCalledWith('https://example.com/docs');
    // preventDefault on mousedown is what keeps focus here — without it the blur
    // would revert the field to the live URL and the click would never land.
    expect(input).toHaveFocus();
  });

  it('Escape closes the list but keeps the typed text, and the next keystroke reopens it', async () => {
    search.mockResolvedValue([
      entry({ id: 1, url: 'https://example.com/docs', title: 'The docs' }),
    ]);
    render(<AddressBar url="https://a.example/" omnibox={stores} onSubmit={vi.fn()} />);
    const input = screen.getByRole('combobox', { name: /address/i });
    await userEvent.click(input);
    await userEvent.clear(input);
    await userEvent.type(input, 'docs');
    await settle();
    expect(screen.getByRole('listbox')).toBeTruthy();

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(input).toHaveValue('docs');
    expect(input).toHaveFocus();

    await userEvent.type(input, 'x');
    await waitFor(() => expect(screen.getByRole('listbox')).toBeTruthy());
  });

  it('blur closes the list and reverts the field to the live URL', async () => {
    list.mockResolvedValue([entry({ id: 1, url: 'https://example.com/docs', title: 'The docs' })]);
    render(<AddressBar url="https://a.example/" omnibox={stores} onSubmit={vi.fn()} />);
    const input = screen.getByRole('combobox', { name: /address/i });
    await userEvent.click(input);
    await waitFor(() => expect(screen.getByRole('listbox')).toBeTruthy());

    await userEvent.tab();
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(input).toHaveValue('https://a.example/');
  });

  it('reports overlay open/close to the host shell', async () => {
    list.mockResolvedValue([entry({ id: 1, url: 'https://example.com/docs', title: 'The docs' })]);
    const onDropdownOpenChange = vi.fn();
    render(
      <AddressBar
        url="https://a.example/"
        omnibox={stores}
        onDropdownOpenChange={onDropdownOpenChange}
        onSubmit={vi.fn()}
      />,
    );
    expect(onDropdownOpenChange).toHaveBeenLastCalledWith(false);

    const input = screen.getByRole('combobox', { name: /address/i });
    await userEvent.click(input);
    await waitFor(() => expect(onDropdownOpenChange).toHaveBeenLastCalledWith(true));

    await userEvent.tab();
    await waitFor(() => expect(onDropdownOpenChange).toHaveBeenLastCalledWith(false));
  });

  it('never opens without an omnibox prop, and still submits normally', async () => {
    const onSubmit = vi.fn();
    render(<AddressBar url="https://a.example/" onSubmit={onSubmit} />);
    const input = screen.getByRole('combobox', { name: /address/i });
    await userEvent.click(input);
    await userEvent.clear(input);
    await userEvent.type(input, 'cats{Enter}');
    // No stores ⇒ no rows ⇒ nothing to show, and Enter is a plain form submit.
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onSubmit).toHaveBeenCalledWith('cats');
  });
});

describe('AddressBar status label and Enter hint', () => {
  it('hides the "Search" label on a blank page so the placeholder is not said twice', () => {
    render(<AddressBar url="about:blank" onSubmit={vi.fn()} />);
    expect(screen.queryByText('Search')).toBeNull();
    expect(screen.getByPlaceholderText('Search or enter a website')).toBeInTheDocument();
  });

  it('shows the label once it carries information', () => {
    render(<AddressBar url="https://example.com/" onSubmit={vi.fn()} />);
    expect(screen.getByText('Secure')).toBeInTheDocument();
  });

  it('warns for a plain-http page', () => {
    render(<AddressBar url="http://example.com/" onSubmit={vi.fn()} />);
    expect(screen.getByText('Not secure')).toBeInTheDocument();
  });

  it('shows the Enter hint only while the field is focused', async () => {
    render(<AddressBar url="about:blank" onSubmit={vi.fn()} />);
    expect(screen.queryByText('Enter')).toBeNull();
    await userEvent.click(screen.getByRole('combobox', { name: /address/i }));
    expect(screen.getByText('Enter')).toBeInTheDocument();
    await userEvent.tab();
    expect(screen.queryByText('Enter')).toBeNull();
  });
});

describe('AddressBar — site-info popover vs the omnibox', () => {
  function renderWithSite() {
    render(
      <AddressBar
        url="https://a.example/"
        onSubmit={vi.fn()}
        omnibox={{ favorites: [], saved: [], searchTemplate: SEARCH }}
        siteInfo={{
          origin: 'https://a.example',
          host: 'a.example',
          permissions: [],
          protection,
          onForgetSitePermissions: vi.fn(),
          onClearRememberedSiteData: vi.fn(),
          onOpenPrivacySettings: vi.fn(),
        }}
      />,
    );
    return {
      input: screen.getByRole('combobox', { name: /address/i }),
      padlock: screen.getByRole('button', { name: /site information/i }),
    };
  }

  it('still offers suggestions while the site-info popover is open', async () => {
    // Regression: `active` was `focused && !siteOpen`, so opening the popover made the
    // omnibox permanently unresponsive — typing produced zero suggestions and Escape could
    // not recover, because the popover's own Escape listener is bound to the popover subtree.
    const { input, padlock } = renderWithSite();
    await userEvent.click(padlock);
    expect(document.querySelector('.site-identity')).not.toBeNull();

    await userEvent.click(input);
    await userEvent.clear(input);
    await userEvent.type(input, 'kittens');
    await waitFor(() => expect(document.querySelector('[role="listbox"]')).not.toBeNull());
    expect(document.querySelectorAll('[role="option"]').length).toBeGreaterThan(0);
  });

  it('closes the popover on an outside pointerdown', async () => {
    const { padlock } = renderWithSite();
    await userEvent.click(padlock);
    expect(document.querySelector('.site-identity')).not.toBeNull();

    await userEvent.click(document.body);
    await waitFor(() => expect(document.querySelector('.site-identity')).toBeNull());
  });
});

describe('AddressBar — the omnibox on the popover surface', () => {
  let search: MockInstance<typeof aegis.history.search>;
  let rectSpy: MockInstance<typeof Element.prototype.getBoundingClientRect>;
  let invokeSpy: MockInstance<typeof invoke>;

  /** Every `popover.set` the chrome sent, as `(payload)`, read off the real transport.
   *
   *  Spying `invoke` rather than `aegis.popover.set` asserts the CHANNEL NAME as well, and it
   *  is the only layer that sees the payload after the client has spread it — so a renamed
   *  field or a typo'd channel fails here instead of in the running app. */
  function popoverSets(): Array<Record<string, unknown>> {
    return invokeSpy.mock.calls
      .map(([, arg]) => arg as { channel?: string; payload?: Record<string, unknown> })
      .filter((a) => a.channel === 'popover.set')
      .map((a) => a.payload ?? {});
  }
  function lastPopoverSet(): Record<string, unknown> | undefined {
    return popoverSets().at(-1);
  }

  beforeEach(() => {
    search = vi
      .spyOn(aegis.history, 'search')
      .mockResolvedValue([
        entry({ id: 1, title: 'Alpha', url: 'https://alpha.example/' }),
        entry({ id: 2, title: 'Beta', url: 'https://beta.example/' }),
      ]);
    // jsdom has NO LAYOUT, so every rect is 0x0 — which makes `usePopoverSurface` treat the
    // dropdown as unmeasurable and send nothing at all. Without this stub the whole surface
    // wiring below would be exercised by ZERO tests while the suite stayed green, which is
    // precisely how the Phase-2 contract mismatch survived 1 916 green tests.
    rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 12,
      y: 44,
      width: 600,
      height: 210,
      top: 44,
      left: 12,
      right: 612,
      bottom: 254,
      toJSON: () => ({}),
    } as DOMRect);
    // `invoke` is already a `vi.fn` (vitest.setup.ts mocks the whole module), so it only needs
    // clearing — spying on it would try to replace a property that is not there.
    invokeSpy = vi.mocked(invoke);
    vi.mocked(invoke).mockClear();
    vi.mocked(listen).mockClear();
  });

  afterEach(() => {
    search.mockRestore();
    rectSpy.mockRestore();
  });

  /** Deliver `popover.picked` the way the backend would.
   *
   *  `aegis` here is the REAL client (this file spies rather than module-mocks it, on
   *  purpose), so the handler is the one the real `onPicked` handed to `listen`. Reaching for
   *  it through the transport — rather than through a mocked hook — is what makes this a test
   *  of the wiring and not of a stub. */
  function emitPick(pick: unknown): void {
    const hit = vi.mocked(listen).mock.calls.find(([name]) => name === 'popover:picked');
    expect(hit, 'the chrome must subscribe to popover.picked').toBeTruthy();
    hit![1]({ payload: pick } as never);
  }

  async function renderOpen(onSubmit = vi.fn()) {
    const view = render(<AddressBar url="about:blank" omnibox={stores} onSubmit={onSubmit} />);
    const input = screen.getByRole('combobox', { name: /address/i });
    await userEvent.click(input);
    await userEvent.type(input, 'al');
    await settle();
    await waitFor(() => expect(document.querySelector('[role="option"]')).not.toBeNull());
    return { ...view, input, onSubmit };
  }

  it('sends the surface its rect, its rows and its declared item count', async () => {
    await renderOpen();
    await waitFor(() => expect(popoverSets().length).toBeGreaterThan(0));
    const args = lastPopoverSet();
    expect(args?.id).toBe('address-omnibox');
    expect(args?.rect).toEqual({ x: 12, y: 44, width: 600, height: 210 });
    // itemCount is what Rust bounds-checks a reported index against, so it must be the real
    // row count — including the trailing "Search for …" row the ranker always adds.
    expect(args?.itemCount).toBe(document.querySelectorAll('[role="option"]').length);
    expect(args?.actions).toEqual(['pick', 'hover']);
    const suggestions = (args?.payload as { suggestions?: unknown[] })?.suggestions ?? [];
    expect(suggestions).toHaveLength(args?.itemCount as number);
  });

  // THE gate: the page must not move. The dropdown used to register its height as a
  // content-top inset, and that measurement fed the chrome's layout, which re-measured the
  // dropdown — a limit cycle that ran ~57 times a second while typing.
  //
  // This used to assert the registry reported 0. It cannot any more, and that is the POINT:
  // the whole inset mechanism is deleted, so there is nothing to report. What is asserted here
  // is that opening the dropdown sends ONLY geometry to the surface — `popover.set` and nothing
  // else. `view.setContentInset` is the channel that moved the page, so a popover that never
  // touches it cannot move the page.
  it('sends geometry ONLY to the surface, and never touches the content inset', async () => {
    await renderOpen();
    await waitFor(() => expect(popoverSets().length).toBeGreaterThan(0));
    const channels = invokeSpy.mock.calls
      .map(([, arg]) => (arg as { channel?: string }).channel)
      .filter((c): c is string => typeof c === 'string');
    expect(
      new Set(channels),
      `channels used while the dropdown was open: ${channels.join(', ')}`,
    ).toEqual(new Set(['popover.set']));
  });

  it('closes the surface when the dropdown closes', async () => {
    const { input } = await renderOpen();
    await waitFor(() => expect(popoverSets().length).toBeGreaterThan(0));
    await userEvent.clear(input);
    await userEvent.type(input, 'zzzz');
    // A query that matches nothing still yields the "Search for …" row, so the list stays
    // open; dismissing it is what closes the surface.
    await userEvent.tab();
    await waitFor(() => {
      expect(lastPopoverSet()?.payload).toBeNull();
    });
  });

  it("opens what the surface reports, from the chrome's own suggestion", async () => {
    const { onSubmit } = await renderOpen();
    await waitFor(() => expect(popoverSets().length).toBeGreaterThan(0));
    emitPick({ id: 'address-omnibox', index: 0 });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    // The chrome navigates from its own array, so this is the chrome's own resolved target.
    expect(onSubmit.mock.calls[0][0]).toBe('https://alpha.example/');
  });

  it('leaves the address field alone when the hover moves the cursor', async () => {
    const { onSubmit } = await renderOpen();
    emitPick({ id: 'address-omnibox', action: 'hover', index: 1 });
    expect(onSubmit).not.toHaveBeenCalled();
    // …and the hover is visible in the chrome's own copy, which is what Enter will act on.
    await waitFor(() => {
      const active = document.querySelector('.omnibox__row--active');
      expect(active?.textContent).toContain('Beta');
    });
  });

  it('unsubscribes from picks on unmount', async () => {
    const { unmount } = await renderOpen();
    const before = vi.mocked(listen).mock.calls.filter(([n]) => n === 'popover:picked').length;
    expect(before).toBeGreaterThan(0);
    unmount();
    // The real `on` resolves a synchronous unsubscribe; a hook that dropped it would leave a
    // live backend listener nothing can remove, so the count of listeners must not grow.
    expect(vi.mocked(listen).mock.calls.length).toBeGreaterThanOrEqual(before);
    emitPick({ id: 'address-omnibox', index: 0 });
  });

  // The CSS rule exists (pinned in platformContract.drift.test.ts); nothing pinned that the
  // chrome actually PUTS IT ON. Without this class the chrome's copy is invisible only because
  // the page happens to cover it — which is the arrangement that made the dropdown displace the
  // page in the first place, and it would come back the moment the content webview were hidden.
  it("marks the chrome's copy as the invisible one, so it cannot be seen even when the page is not covering it", async () => {
    await renderOpen();
    const root = document.querySelector('.omnibox');
    expect(root).not.toBeNull();
    expect(root!.className).toContain('address-bar__omnibox-source');
  });

  it('keeps the address input pointing at a listbox in ITS OWN document', async () => {
    await renderOpen();
    const input = screen.getByRole('combobox', { name: /address/i });
    const listId = input.getAttribute('aria-controls');
    expect(listId).toBeTruthy();
    // An id cannot cross a document boundary, so this element must exist HERE — in the chrome —
    // or the input's `aria-controls`/`aria-activedescendant` dangle and a screen reader
    // announces no list at all.
    expect(document.getElementById(listId!)).not.toBeNull();
    expect(document.getElementById(listId!)!.getAttribute('role')).toBe('listbox');
  });
});

describe('AddressBar — site-info picks reported by the popover surface', () => {
  /** Deliver `popover.picked` to EVERY subscriber, the way the backend does.
   *
   *  Not `find`: `AddressBar` mounts both `useOmnibox`'s subscription and the site popover's,
   *  and a helper that delivered to only the first would silently exercise the wrong one —
   *  which is exactly what it did until this test failed. */
  function emitPick(pick: unknown): void {
    const hits = vi.mocked(listen).mock.calls.filter(([n]) => n === 'popover:picked');
    expect(hits.length, 'the chrome must subscribe to popover.picked').toBeGreaterThan(0);
    for (const [, cb] of hits) cb({ payload: pick } as never);
  }

  beforeEach(() => {
    vi.mocked(listen).mockClear();
    vi.mocked(invoke).mockClear();
  });

  function renderSite(over: Record<string, unknown> = {}) {
    const onForgetSitePermissions = vi.fn();
    const onClearRememberedSiteData = vi.fn();
    const onOpenPrivacySettings = vi.fn();
    render(
      <AddressBar
        url="https://a.example/"
        onSubmit={vi.fn()}
        omnibox={{ favorites: [], saved: [], searchTemplate: SEARCH }}
        siteInfo={{
          origin: 'https://a.example',
          host: 'a.example',
          permissions: [
            { origin: 'https://a.example', permission: 'geolocation', decision: 'deny' },
          ],
          protection,
          onForgetSitePermissions,
          onClearRememberedSiteData,
          onOpenPrivacySettings,
          ...over,
        }}
      />,
    );
    return { onForgetSitePermissions, onClearRememberedSiteData, onOpenPrivacySettings };
  }

  it('runs its OWN handlers with its OWN origin, never an origin from the payload', async () => {
    const rect = vi
      .spyOn(Element.prototype, 'getBoundingClientRect')
      .mockReturnValue({ x: 8, y: 40, width: 300, height: 320 } as DOMRect);
    try {
      const h = renderSite();
      await userEvent.click(screen.getByRole('button', { name: /site information/i }));
      emitPick({ id: 'address-site', action: 'clear-data' });
      emitPick({ id: 'address-site', action: 'forget-permissions' });
      emitPick({ id: 'address-site', action: 'privacy-settings' });
      expect(h.onClearRememberedSiteData).toHaveBeenCalledWith('https://a.example');
      expect(h.onForgetSitePermissions).toHaveBeenCalledWith('https://a.example');
      expect(h.onOpenPrivacySettings).toHaveBeenCalledTimes(1);
    } finally {
      rect.mockRestore();
    }
  });

  it('refuses every action when there is no origin, so a payload cannot conjure one', async () => {
    const rect = vi
      .spyOn(Element.prototype, 'getBoundingClientRect')
      .mockReturnValue({ x: 8, y: 40, width: 300, height: 320 } as DOMRect);
    try {
      const h = renderSite({ origin: null, host: null });
      await userEvent.click(screen.getByRole('button', { name: /site information/i }));
      // `privacy-settings` is the one action that does not need an origin.
      emitPick({ id: 'address-site', action: 'clear-data' });
      emitPick({ id: 'address-site', action: 'forget-permissions' });
      emitPick({ id: 'address-site', action: 'privacy-settings' });
      expect(h.onClearRememberedSiteData).not.toHaveBeenCalled();
      expect(h.onForgetSitePermissions).not.toHaveBeenCalled();
      expect(h.onOpenPrivacySettings).toHaveBeenCalledTimes(1);
    } finally {
      rect.mockRestore();
    }
  });

  it('ignores a pick addressed to a different popover', async () => {
    const rect = vi
      .spyOn(Element.prototype, 'getBoundingClientRect')
      .mockReturnValue({ x: 8, y: 40, width: 300, height: 320 } as DOMRect);
    try {
      const h = renderSite();
      await userEvent.click(screen.getByRole('button', { name: /site information/i }));
      emitPick({ id: 'address-omnibox', action: 'clear-data' });
      expect(h.onClearRememberedSiteData).not.toHaveBeenCalled();
    } finally {
      rect.mockRestore();
    }
  });

  it('sends only this origin’s permissions and only the actions it declared', async () => {
    const rect = vi
      .spyOn(Element.prototype, 'getBoundingClientRect')
      .mockReturnValue({ x: 8, y: 40, width: 300, height: 320 } as DOMRect);
    try {
      renderSite({
        permissions: [
          { origin: 'https://a.example', permission: 'geolocation', decision: 'deny' },
          { origin: 'https://other.example', permission: 'camera', decision: 'allow' },
        ],
      });
      await userEvent.click(screen.getByRole('button', { name: /site information/i }));
      const envelope = vi
        .mocked(invoke)
        .mock.calls.map(([, a]) => a as { channel?: string; payload?: Record<string, unknown> })
        .filter((a) => a.channel === 'popover.set')
        .at(-1)?.payload;
      const payload = (envelope?.payload ?? {}) as {
        permissions?: unknown[];
        canForget?: boolean;
      };
      // The other origin's permission must NOT cross the boundary: the surface has no business
      // knowing what the user granted somewhere else.
      expect(payload.permissions).toEqual([{ permission: 'geolocation', decision: 'deny' }]);
      expect(payload.canForget).toBe(true);
      expect(envelope?.actions).toEqual(['clear-data', 'forget-permissions', 'privacy-settings']);
    } finally {
      rect.mockRestore();
    }
  });
});
