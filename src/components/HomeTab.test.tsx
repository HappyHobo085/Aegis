// src/components/HomeTab.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Settings } from '../../shared/types';
import { HomeTab } from './HomeTab';

const settings = (over: Partial<Settings> = {}): Settings => ({
  siteName: 'Aegis',
  homeUrl: 'https://duckduckgo.com/',
  primaryColor: '#7c5cff',
  defaultSearchTemplate: 'https://duckduckgo.com/?q=%s',
  searchEngines: [],
  hideChromeByDefault: false,
  ...over,
});

describe('HomeTab', () => {
  it('shows the current home URL', () => {
    render(<HomeTab settings={settings({ homeUrl: 'https://example.com/' })} update={vi.fn(async () => {})} />);
    expect(screen.getByRole('textbox', { name: /home url/i })).toHaveValue('https://example.com/');
  });

  it('saves an edited home URL', async () => {
    const update = vi.fn(async () => {});
    render(<HomeTab settings={settings()} update={update} />);
    const field = screen.getByRole('textbox', { name: /home url/i });
    await userEvent.clear(field);
    await userEvent.type(field, 'https://start.example/');
    await userEvent.click(screen.getByRole('button', { name: /save home url/i }));
    expect(update).toHaveBeenCalledWith({ homeUrl: 'https://start.example/' });
  });
});
