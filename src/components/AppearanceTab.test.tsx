// src/components/AppearanceTab.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Settings } from '../../shared/types';
import { AppearanceTab } from './AppearanceTab';

const settings = (over: Partial<Settings> = {}): Settings => ({
  siteName: 'Aegis',
  homeUrl: 'https://duckduckgo.com/',
  primaryColor: '#7c5cff',
  defaultSearchTemplate: 'https://duckduckgo.com/?q=%s',
  searchEngines: [],
  hideChromeByDefault: false,
  ...over,
});

describe('AppearanceTab', () => {
  it('shows the current accent color in the color input', () => {
    render(<AppearanceTab settings={settings({ primaryColor: '#112233' })} update={vi.fn(async () => {})} />);
    expect(screen.getByLabelText(/accent color/i)).toHaveValue('#112233');
  });

  it('updates primaryColor when the color input changes', () => {
    const update = vi.fn(async () => {});
    render(<AppearanceTab settings={settings()} update={update} />);
    fireEvent.change(screen.getByLabelText(/accent color/i), { target: { value: '#00ff00' } });
    expect(update).toHaveBeenLastCalledWith({ primaryColor: '#00ff00' });
  });

  it('shows the current site name and saves an edited value', async () => {
    const update = vi.fn(async () => {});
    render(<AppearanceTab settings={settings({ siteName: 'Aegis' })} update={update} />);
    const field = screen.getByRole('textbox', { name: /site name/i });
    expect(field).toHaveValue('Aegis');
    await userEvent.clear(field);
    await userEvent.type(field, 'My Browser');
    await userEvent.click(screen.getByRole('button', { name: /save site name/i }));
    expect(update).toHaveBeenCalledWith({ siteName: 'My Browser' });
  });
});
