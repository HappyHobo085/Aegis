// src/components/TabsTab.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { Settings } from '../../shared/types';
import { TabsTab } from './TabsTab';

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
  themeMode: 'dark',
  antiFingerprint: 'off',
  ...over,
});

describe('TabsTab', () => {
  it('shows the current tabIdleTimeout value in the number input', () => {
    render(<TabsTab settings={settings({ tabIdleTimeout: 30 })} update={vi.fn(async () => {})} />);
    expect(screen.getByLabelText(/discard inactive tabs after/i)).toHaveValue(30);
  });

  it('calls update with the new tabIdleTimeout when the input changes', () => {
    const update = vi.fn(async () => {});
    render(<TabsTab settings={settings()} update={update} />);
    fireEvent.change(screen.getByLabelText(/discard inactive tabs after/i), {
      target: { value: '60' },
    });
    expect(update).toHaveBeenLastCalledWith({ tabIdleTimeout: 60 });
  });

  it('floors to 0 when the input is set to 0 (never discard)', () => {
    const update = vi.fn(async () => {});
    render(<TabsTab settings={settings()} update={update} />);
    fireEvent.change(screen.getByLabelText(/discard inactive tabs after/i), {
      target: { value: '0' },
    });
    expect(update).toHaveBeenLastCalledWith({ tabIdleTimeout: 0 });
  });

  it('renders the hint text', () => {
    render(<TabsTab settings={settings()} update={vi.fn(async () => {})} />);
    expect(screen.getByText(/inactive background tabs are unloaded/i)).toBeInTheDocument();
  });
});
