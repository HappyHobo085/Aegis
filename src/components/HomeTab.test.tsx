// src/components/HomeTab.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Settings } from '../../shared/types';

vi.mock('../lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
import { toast } from '../lib/toast';

import { HomeTab } from './HomeTab';

const settings = (over: Partial<Settings> = {}): Settings => ({
  homeUrl: 'https://duckduckgo.com/',
  primaryColor: '#7c5cff',
  defaultSearchTemplate: 'https://duckduckgo.com/?q=%s',
  searchEngines: [],
  hideChromeByDefault: false,
  downloadDir: '',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('HomeTab', () => {
  it('shows the current home URL', () => {
    render(
      <HomeTab
        settings={settings({ homeUrl: 'https://example.com/' })}
        update={vi.fn(async () => {})}
      />,
    );
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

  it('toasts "Saved" after a successful save', async () => {
    const update = vi.fn(async () => {});
    render(<HomeTab settings={settings()} update={update} />);
    await userEvent.click(screen.getByRole('button', { name: /save home url/i }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Saved'));
  });

  it('adopts an externally-changed home URL when the field is not edited', () => {
    const { rerender } = render(
      <HomeTab
        settings={settings({ homeUrl: 'https://a.example/' })}
        update={vi.fn(async () => {})}
      />,
    );
    const field = screen.getByRole('textbox', { name: /home url/i });
    expect(field).toHaveValue('https://a.example/');
    rerender(
      <HomeTab
        settings={settings({ homeUrl: 'https://b.example/' })}
        update={vi.fn(async () => {})}
      />,
    );
    expect(field).toHaveValue('https://b.example/');
  });

  it('keeps an in-progress edit when the prop changes externally', async () => {
    const { rerender } = render(
      <HomeTab
        settings={settings({ homeUrl: 'https://a.example/' })}
        update={vi.fn(async () => {})}
      />,
    );
    const field = screen.getByRole('textbox', { name: /home url/i });
    await userEvent.clear(field);
    await userEvent.type(field, 'https://my-edit/');
    rerender(
      <HomeTab
        settings={settings({ homeUrl: 'https://b.example/' })}
        update={vi.fn(async () => {})}
      />,
    );
    expect(field).toHaveValue('https://my-edit/');
  });

  it('submits on Enter in the URL field', async () => {
    const update = vi.fn(async () => {});
    render(<HomeTab settings={settings()} update={update} />);
    const field = screen.getByRole('textbox', { name: /home url/i });
    await userEvent.clear(field);
    await userEvent.type(field, 'https://typed.example/{Enter}');
    expect(update).toHaveBeenCalledWith({ homeUrl: 'https://typed.example/' });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Saved'));
  });
});
