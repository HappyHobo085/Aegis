// src/components/AppearanceTab.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { Settings } from '../../shared/types';
import { AppearanceTab } from './AppearanceTab';

const settings = (over: Partial<Settings> = {}): Settings => ({
  homeUrl: 'https://duckduckgo.com/',
  primaryColor: '#7c5cff',
  defaultSearchTemplate: 'https://duckduckgo.com/?q=%s',
  searchEngines: [],
  hideChromeByDefault: false,
  downloadDir: '',
  httpsOnly: true,
  tabIdleTimeout: 30,
  webrtcPolicy: 'public-only',
  themeMode: 'system',
  syncServerUrl: '',
  antiFingerprint: 'off',
  ...over,
});

describe('AppearanceTab — accent color', () => {
  it('shows the current accent color in the color input', () => {
    render(
      <AppearanceTab
        settings={settings({ primaryColor: '#112233' })}
        update={vi.fn(async () => {})}
      />,
    );
    expect(screen.getByLabelText(/accent color/i)).toHaveValue('#112233');
  });

  it('updates primaryColor when the color input changes', () => {
    const update = vi.fn(async () => {});
    render(<AppearanceTab settings={settings()} update={update} />);
    fireEvent.change(screen.getByLabelText(/accent color/i), { target: { value: '#00ff00' } });
    expect(update).toHaveBeenLastCalledWith({ primaryColor: '#00ff00' });
  });
});

describe('AppearanceTab — theme mode', () => {
  it('renders a Theme radiogroup with System/Dark/Light', () => {
    render(<AppearanceTab settings={settings()} update={vi.fn(async () => {})} />);
    const group = screen.getByRole('radiogroup', { name: /theme/i });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /system/i })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /dark/i })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /light/i })).toBeInTheDocument();
  });

  it('marks the current themeMode radio as checked', () => {
    render(
      <AppearanceTab settings={settings({ themeMode: 'light' })} update={vi.fn(async () => {})} />,
    );
    expect(screen.getByRole('radio', { name: /light/i })).toBeChecked();
    expect(screen.getByRole('radio', { name: /system/i })).not.toBeChecked();
  });

  it('calls update with the chosen themeMode', () => {
    const update = vi.fn(async () => {});
    render(<AppearanceTab settings={settings({ themeMode: 'system' })} update={update} />);
    fireEvent.click(screen.getByRole('radio', { name: /dark/i }));
    expect(update).toHaveBeenLastCalledWith({ themeMode: 'dark' });
    fireEvent.click(screen.getByRole('radio', { name: /light/i }));
    expect(update).toHaveBeenLastCalledWith({ themeMode: 'light' });
  });
});
