// src/components/ProxySettingsTab.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProxySettingsTab } from './ProxySettingsTab';
import type { ProxyState } from '../../shared/types';

const offState: ProxyState = {
  mode: 'off',
  scheme: 'http',
  host: '',
  port: 8080,
  bypassHosts: [],
  active: false,
  uri: null,
};

const onState: ProxyState = {
  mode: 'proxy',
  scheme: 'http',
  host: '127.0.0.1',
  port: 8080,
  bypassHosts: [],
  active: true,
  uri: 'http://127.0.0.1:8080',
};

const baseProxyState = offState;

describe('ProxySettingsTab', () => {
  it('changes the proxy mode via setConfig', async () => {
    const setConfig = vi.fn().mockResolvedValue(baseProxyState);
    render(<ProxySettingsTab state={offState} setConfig={setConfig} test={vi.fn()} />);
    const mode = screen.getByRole('combobox', { name: /proxy mode/i });
    expect(mode).toHaveValue('off');
    await userEvent.selectOptions(mode, 'proxy');
    expect(setConfig).toHaveBeenCalledWith(expect.objectContaining({ mode: 'proxy' }));
  });

  it('Off/Turn off button calls setConfig with mode off', async () => {
    const setConfig = vi.fn().mockResolvedValue(offState);
    render(<ProxySettingsTab state={onState} setConfig={setConfig} test={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /turn off/i }));
    expect(setConfig).toHaveBeenCalledWith(expect.objectContaining({ mode: 'off' }));
  });

  it('shows scheme, host, port, bypass fields when mode is proxy', async () => {
    const setConfig = vi.fn().mockResolvedValue(onState);
    render(<ProxySettingsTab state={onState} setConfig={setConfig} test={vi.fn()} />);
    expect(screen.getByRole('combobox', { name: /proxy scheme/i })).toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: /proxy port/i })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /proxy host/i })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /proxy bypass hosts/i })).toBeInTheDocument();
  });

  it('hides proxy fields when mode is off', () => {
    render(<ProxySettingsTab state={offState} setConfig={vi.fn()} test={vi.fn()} />);
    expect(screen.queryByRole('combobox', { name: /proxy scheme/i })).not.toBeInTheDocument();
  });

  it('Test connection calls test() and shows result', async () => {
    const testFn = vi.fn().mockResolvedValue({ ok: true, latencyMs: 42 });
    render(<ProxySettingsTab state={onState} setConfig={vi.fn()} test={testFn} />);
    await userEvent.click(screen.getByRole('button', { name: /test proxy connection/i }));
    expect(testFn).toHaveBeenCalledWith(expect.objectContaining({ mode: 'proxy' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Connected — 42 ms');
  });

  it('Test connection shows failure message', async () => {
    const testFn = vi.fn().mockResolvedValue({ ok: false, error: 'timeout' });
    render(<ProxySettingsTab state={onState} setConfig={vi.fn()} test={testFn} />);
    await userEvent.click(screen.getByRole('button', { name: /test proxy connection/i }));
    expect(await screen.findByRole('status')).toHaveTextContent('Failed: timeout');
  });

  it('Apply button calls setConfig with current values', async () => {
    const setConfig = vi.fn().mockResolvedValue(onState);
    render(<ProxySettingsTab state={onState} setConfig={setConfig} test={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /apply proxy settings/i }));
    expect(setConfig).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'proxy', host: '127.0.0.1', port: 8080 }),
    );
  });

  it('renders honest "Proxy not VPN" notice', () => {
    render(<ProxySettingsTab state={offState} setConfig={vi.fn()} test={vi.fn()} />);
    expect(screen.getByRole('note', { name: /proxy honest limits/i })).toBeInTheDocument();
    expect(screen.getByText(/this is not a vpn/i)).toBeInTheDocument();
  });

  it('renders macOS no-proxy note', () => {
    render(<ProxySettingsTab state={offState} setConfig={vi.fn()} test={vi.fn()} />);
    expect(screen.getAllByText(/macos/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/no proxy support yet/i)).toBeInTheDocument();
  });

  it('never uses the word VPN as a label/description (only in denial copy)', () => {
    const { container } = render(
      <ProxySettingsTab state={offState} setConfig={vi.fn()} test={vi.fn()} />,
    );
    // The tab title and labels must not call it a VPN
    const heading = container.querySelector('h3');
    expect(heading?.textContent?.toLowerCase()).not.toContain('vpn');
    // No aria-label should say VPN
    const vpnLabels = container.querySelectorAll('[aria-label*="VPN"],[aria-label*="vpn"]');
    expect(vpnLabels).toHaveLength(0);
  });

  it('sets scheme via select', async () => {
    const setConfig = vi.fn().mockResolvedValue(onState);
    render(<ProxySettingsTab state={onState} setConfig={setConfig} test={vi.fn()} />);
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: /proxy scheme/i }),
      'socks5',
    );
    await userEvent.click(screen.getByRole('button', { name: /apply proxy settings/i }));
    expect(setConfig).toHaveBeenCalledWith(expect.objectContaining({ scheme: 'socks5' }));
  });
});
