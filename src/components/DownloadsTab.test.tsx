// src/components/DownloadsTab.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fireEvent } from '@testing-library/react';
import type { Settings } from '../../shared/types';

vi.mock('../lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
import { toast } from '../lib/toast';

import { DownloadsTab } from './DownloadsTab';

const baseSettings: Settings = {
  homeUrl: 'https://duckduckgo.com/',
  primaryColor: '#4f8cff',
  defaultSearchTemplate: 'https://duckduckgo.com/?q=%s',
  searchEngines: [],
  hideChromeByDefault: false,
  downloadDir: '/home/u/Downloads',
  httpsOnly: false,
  tabIdleTimeout: 0,
  webrtcPolicy: 'public-only',
  themeMode: 'dark',
  antiFingerprint: 'off',
};

function props(over: Partial<React.ComponentProps<typeof DownloadsTab>> = {}) {
  return {
    settings: baseSettings,
    update: vi.fn(async () => {}),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DownloadsTab', () => {
  it('renders a labelled download folder input seeded from settings', () => {
    render(<DownloadsTab {...props()} />);
    expect(screen.getByLabelText(/download folder/i)).toHaveValue('/home/u/Downloads');
  });

  it('saves the trimmed downloadDir via update on Save', async () => {
    const p = props();
    render(<DownloadsTab {...p} />);
    const input = screen.getByLabelText(/download folder/i);
    fireEvent.change(input, { target: { value: '  /tmp/dl  ' } });
    await userEvent.click(screen.getByRole('button', { name: /save download folder/i }));
    expect(p.update).toHaveBeenCalledWith({ downloadDir: '/tmp/dl' });
  });

  it('toasts "Saved" after a successful Save', async () => {
    const p = props();
    render(<DownloadsTab {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /save download folder/i }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Saved'));
  });

  it('submits on Enter in the folder field', async () => {
    const p = props();
    render(<DownloadsTab {...p} />);
    const input = screen.getByLabelText(/download folder/i);
    await userEvent.clear(input);
    await userEvent.type(input, '/tmp/typed{Enter}');
    expect(p.update).toHaveBeenCalledWith({ downloadDir: '/tmp/typed' });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Saved'));
  });

  it('Use default clears the downloadDir to the empty string (OS Downloads)', async () => {
    const p = props();
    render(<DownloadsTab {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /use default/i }));
    expect(p.update).toHaveBeenCalledWith({ downloadDir: '' });
  });

  it('toasts "Saved" after Use default', async () => {
    const p = props();
    render(<DownloadsTab {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /use default/i }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Saved'));
  });

  it('shows the OS-default hint when downloadDir is empty', () => {
    render(<DownloadsTab {...props({ settings: { ...baseSettings, downloadDir: '' } })} />);
    expect(screen.getByText(/system downloads folder/i)).toBeInTheDocument();
  });
});
