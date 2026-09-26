import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MockInstance } from 'vitest';
import type { HistoryEntry } from '../../shared/types';
import { aegis } from '../lib/ipcClient';
import { AddressBar } from './AddressBar';
import type { OmniboxStores } from './AddressBar';
import type { ProtectionSummary } from '../lib/protectionSummary';

const SEARCH = 'https://duckduckgo.com/?q=%s';

const stores: OmniboxStores = { favorites: [], saved: [], searchTemplate: SEARCH };

function entry(over: Partial<HistoryEntry> = {}): HistoryEntry {
  return { id: 1, url: 'https://a.example/', title: 'A', visitedAt: 1_700_000_000_000, ...over };
}

/** The omnibox debounces 90ms before it queries history. */
async function settle() {
  await waitFor(() => expect(aegis.history.search).toHaveBeenCalled(), { timeout: 2000 });
}

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
  const protection = {
    httpsOnly: true,
    privateMode: false,
    blockedCount: 0,
    trackerCount: 0,
    thirdPartyCookiesBlocked: false,
  } as unknown as ProtectionSummary;

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
