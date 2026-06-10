// src/components/SearchTab.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Settings, SearchEngine } from '../../shared/types';
import { SearchTab } from './SearchTab';

const engines: SearchEngine[] = [
  { id: 'ddg', name: 'DuckDuckGo', template: 'https://duckduckgo.com/?q=%s' },
  { id: 'google', name: 'Google', template: 'https://www.google.com/search?q=%s' },
];

const settings = (over: Partial<Settings> = {}): Settings => ({
  siteName: 'Aegis',
  homeUrl: 'https://duckduckgo.com/',
  primaryColor: '#7c5cff',
  defaultSearchTemplate: 'https://duckduckgo.com/?q=%s',
  searchEngines: engines,
  hideChromeByDefault: false,
  ...over,
});

describe('SearchTab', () => {
  it('lists the configured search engines by name', () => {
    render(<SearchTab settings={settings()} update={vi.fn(async () => {})} />);
    expect(screen.getByText('DuckDuckGo')).toBeInTheDocument();
    expect(screen.getByText('Google')).toBeInTheDocument();
  });

  it('marks the engine whose template matches defaultSearchTemplate as default', () => {
    render(<SearchTab settings={settings()} update={vi.fn(async () => {})} />);
    expect(screen.getByRole('radio', { name: /default search engine duckduckgo/i })).toBeChecked();
    expect(screen.getByRole('radio', { name: /default search engine google/i })).not.toBeChecked();
  });

  it('setting a new default writes searchEngines + defaultSearchTemplate', async () => {
    const update = vi.fn(async () => {});
    render(<SearchTab settings={settings()} update={update} />);
    await userEvent.click(screen.getByRole('radio', { name: /default search engine google/i }));
    expect(update).toHaveBeenCalledWith({
      searchEngines: engines,
      defaultSearchTemplate: 'https://www.google.com/search?q=%s',
    });
  });

  it('adds a new engine from the add form', async () => {
    const update = vi.fn(async () => {});
    render(<SearchTab settings={settings()} update={update} />);
    const form = screen.getByRole('group', { name: /add search engine/i });
    await userEvent.type(within(form).getByRole('textbox', { name: /engine id/i }), 'bing');
    await userEvent.type(within(form).getByRole('textbox', { name: /engine name/i }), 'Bing');
    await userEvent.type(
      within(form).getByRole('textbox', { name: /engine template/i }),
      'https://www.bing.com/search?q=%s',
    );
    await userEvent.click(within(form).getByRole('button', { name: /^add engine$/i }));
    expect(update).toHaveBeenCalledWith({
      searchEngines: [
        ...engines,
        { id: 'bing', name: 'Bing', template: 'https://www.bing.com/search?q=%s' },
      ],
    });
  });

  it('removes an engine via its row Remove button', async () => {
    const update = vi.fn(async () => {});
    render(<SearchTab settings={settings()} update={update} />);
    await userEvent.click(screen.getByRole('button', { name: /remove engine google/i }));
    expect(update).toHaveBeenCalledWith({ searchEngines: [engines[0]] });
  });
});
