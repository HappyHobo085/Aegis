// src/components/SearchTab.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Settings, SearchEngine } from '../../shared/types';
import { SearchTab, uniqueEngineId } from './SearchTab';

const engines: SearchEngine[] = [
  { id: 'ddg', name: 'DuckDuckGo', template: 'https://duckduckgo.com/?q=%s' },
  { id: 'google', name: 'Google', template: 'https://www.google.com/search?q=%s' },
];

const settings = (over: Partial<Settings> = {}): Settings => ({
  homeUrl: 'https://duckduckgo.com/',
  primaryColor: '#7c5cff',
  defaultSearchTemplate: 'https://duckduckgo.com/?q=%s',
  searchEngines: engines,
  hideChromeByDefault: false,
  downloadDir: '',
  httpsOnly: false,
  tabIdleTimeout: 0,
  webrtcPolicy: 'public-only',
  themeMode: 'dark',
  antiFingerprint: 'off',
  ...over,
});

describe('uniqueEngineId', () => {
  it('slugifies the name (lowercase, non-alnum runs → single dash, trimmed)', () => {
    expect(uniqueEngineId('  DuckDuck Go!! ', [])).toBe('duckduck-go');
    expect(uniqueEngineId('Brave Search', [])).toBe('brave-search');
  });

  it('disambiguates a colliding id with -2, -3, …', () => {
    expect(uniqueEngineId('Bing', ['bing'])).toBe('bing-2');
    expect(uniqueEngineId('Bing', ['bing', 'bing-2'])).toBe('bing-3');
  });

  it('falls back to "engine" when the name has no slug characters', () => {
    expect(uniqueEngineId('!!!', [])).toBe('engine');
  });
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

  it('has no Engine id input (id is auto-generated from the name)', () => {
    render(<SearchTab settings={settings()} update={vi.fn(async () => {})} />);
    expect(screen.queryByRole('textbox', { name: /engine id/i })).not.toBeInTheDocument();
  });

  it('adds a new engine with a slugified id auto-generated from the name', async () => {
    const update = vi.fn(async () => {});
    render(<SearchTab settings={settings()} update={update} />);
    const form = screen.getByRole('group', { name: /add search engine/i });
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

  it('appends -2 when the slugified id collides with an existing engine', async () => {
    const update = vi.fn(async () => {});
    const withGoogleId: SearchEngine[] = [{ id: 'google', name: 'g', template: 'x?q=%s' }];
    render(<SearchTab settings={settings({ searchEngines: withGoogleId })} update={update} />);
    const form = screen.getByRole('group', { name: /add search engine/i });
    await userEvent.type(within(form).getByRole('textbox', { name: /engine name/i }), 'Google');
    await userEvent.type(
      within(form).getByRole('textbox', { name: /engine template/i }),
      'https://www.google.com/search?q=%s',
    );
    await userEvent.click(within(form).getByRole('button', { name: /^add engine$/i }));
    expect(update).toHaveBeenCalledWith({
      searchEngines: [
        ...withGoogleId,
        { id: 'google-2', name: 'Google', template: 'https://www.google.com/search?q=%s' },
      ],
    });
  });

  it('shows an inline error and does NOT add when the name is empty', async () => {
    const update = vi.fn(async () => {});
    render(<SearchTab settings={settings()} update={update} />);
    const form = screen.getByRole('group', { name: /add search engine/i });
    await userEvent.type(
      within(form).getByRole('textbox', { name: /engine template/i }),
      'https://x.example/?q=%s',
    );
    await userEvent.click(within(form).getByRole('button', { name: /^add engine$/i }));
    expect(within(form).getByRole('alert')).toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
  });

  it('shows an inline error and does NOT add when the template lacks %s', async () => {
    const update = vi.fn(async () => {});
    render(<SearchTab settings={settings()} update={update} />);
    const form = screen.getByRole('group', { name: /add search engine/i });
    await userEvent.type(within(form).getByRole('textbox', { name: /engine name/i }), 'NoQuery');
    await userEvent.type(
      within(form).getByRole('textbox', { name: /engine template/i }),
      'https://noquery.example/',
    );
    await userEvent.click(within(form).getByRole('button', { name: /^add engine$/i }));
    expect(within(form).getByRole('alert')).toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
  });

  it('clears the inline error once the user edits a field', async () => {
    const update = vi.fn(async () => {});
    render(<SearchTab settings={settings()} update={update} />);
    const form = screen.getByRole('group', { name: /add search engine/i });
    await userEvent.click(within(form).getByRole('button', { name: /^add engine$/i }));
    expect(within(form).getByRole('alert')).toBeInTheDocument();
    await userEvent.type(within(form).getByRole('textbox', { name: /engine name/i }), 'A');
    expect(within(form).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('submits a valid engine on Enter in a field', async () => {
    const update = vi.fn(async () => {});
    render(<SearchTab settings={settings()} update={update} />);
    const form = screen.getByRole('group', { name: /add search engine/i });
    await userEvent.type(within(form).getByRole('textbox', { name: /engine name/i }), 'Bing');
    await userEvent.type(
      within(form).getByRole('textbox', { name: /engine template/i }),
      'https://www.bing.com/search?q=%s{Enter}',
    );
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
