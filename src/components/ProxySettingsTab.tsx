// src/components/ProxySettingsTab.tsx
//
// The "Proxy" Settings tab.  Configures the content-webview proxy.
// IMPORTANT: This is NOT a VPN.  Honest limits are surfaced in-UI.
import { useEffect, useRef, useState } from 'react';
import type { ProxyConfig, ProxyState } from '../../shared/types';

/**
 * The connection form's two fields that only make sense as a pair: a host with no
 * port, or a port with no host, is not a proxy address. They share one row so the
 * pair reads as one address.
 */
function ConnectionRow({ children }: { children: React.ReactNode }) {
  return <div className="settings-row settings-row--split">{children}</div>;
}

export interface ProxySettingsTabProps {
  state: ProxyState;
  setConfig(cfg: ProxyConfig): Promise<ProxyState>;
  test(cfg: ProxyConfig): Promise<{ ok: boolean; latencyMs?: number; error?: string }>;
  onReloadActiveTab?(): void;
}

export function ProxySettingsTab({
  state,
  setConfig,
  test,
  onReloadActiveTab,
}: ProxySettingsTabProps) {
  // Local draft — mirrors the persisted state but lets the user edit without
  // auto-saving on every keystroke.
  const [mode, setModeLocal] = useState<'off' | 'proxy'>(state.mode);
  const [scheme, setScheme] = useState<'http' | 'socks5'>(state.scheme);
  const [host, setHost] = useState(state.host);
  const [port, setPort] = useState<number>(state.port);
  const [bypassRaw, setBypassRaw] = useState(state.bypassHosts.join(', '));
  const [testStatus, setTestStatus] = useState('');
  const [busy, setBusy] = useState(false);

  // Re-sync the draft when the applied state changes externally (a `proxy.state` event, or a
  // clear() elsewhere) — but only if the user hasn't edited any field, so in-progress edits are
  // never clobbered. Without this the form (and the dirty hint) can show stale values.
  const lastStateRef = useRef(state);
  useEffect(() => {
    const prev = lastStateRef.current;
    if (state === prev) return;
    const clean =
      mode === prev.mode &&
      scheme === prev.scheme &&
      host === prev.host &&
      port === prev.port &&
      bypassRaw === prev.bypassHosts.join(', ');
    if (clean) {
      setModeLocal(state.mode);
      setScheme(state.scheme);
      setHost(state.host);
      setPort(state.port);
      setBypassRaw(state.bypassHosts.join(', '));
    }
    lastStateRef.current = state;
  }, [state, mode, scheme, host, port, bypassRaw]);

  function currentCfg(): ProxyConfig {
    return {
      mode,
      scheme,
      host: host.trim(),
      port,
      bypassHosts: bypassRaw
        .split(/[\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    };
  }

  async function handleModeChange(newMode: 'off' | 'proxy') {
    setModeLocal(newMode);
    setTestStatus('');
    if (newMode === 'off') {
      // Turning off must NOT commit unsaved host/port/bypass drafts — base the write on
      // the last-applied state (the parent's `state`), flipping only the mode.
      await setConfig({
        mode: 'off',
        scheme: state.scheme,
        host: state.host,
        port: state.port,
        bypassHosts: state.bypassHosts,
      });
      return;
    }
    const cfg = { ...currentCfg(), mode: newMode };
    await setConfig(cfg);
  }

  async function handleApply() {
    // Reject an invalid port (clearing the number field yields Number('') === 0).
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setTestStatus('Port must be between 1 and 65535.');
      return;
    }
    await setConfig(currentCfg());
    setTestStatus('');
  }

  // The draft (local edit state) differs from what is currently applied (the
  // hook's `state`). Compares the user-editable fields; the bypass list is
  // normalised both sides so cosmetic spacing/commas don't read as dirty.
  const draftBypass = bypassRaw
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const dirty =
    mode === 'proxy' &&
    (scheme !== state.scheme ||
      host.trim() !== state.host ||
      port !== state.port ||
      draftBypass.join('\n') !== state.bypassHosts.join('\n'));

  async function handleTest() {
    setBusy(true);
    setTestStatus('');
    try {
      const r = await test(currentCfg());
      setTestStatus(
        r.ok ? `Connected — ${r.latencyMs ?? '?'} ms` : `Failed: ${r.error ?? 'unreachable'}`,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings-panel proxy-tab">
      <section className="settings-section" aria-label="Proxy mode">
        <h3 className="settings-section__title">Proxy</h3>
        <label className="settings-row">
          <span className="settings-row__label">Mode</span>
          <select
            aria-label="Proxy mode"
            value={mode}
            onChange={(e) => void handleModeChange(e.target.value as 'off' | 'proxy')}
          >
            <option value="off">Off — direct connection</option>
            <option value="proxy">Use a proxy</option>
          </select>
        </label>
      </section>

      {mode === 'proxy' && (
        <>
          <section className="settings-section" aria-label="Proxy connection">
            <h3 className="settings-section__title">Connection</h3>
            <label className="settings-row">
              <span className="settings-row__label">Protocol</span>
              <select
                aria-label="Proxy scheme"
                value={scheme}
                onChange={(e) => setScheme(e.target.value as 'http' | 'socks5')}
              >
                <option value="http">HTTP</option>
                <option value="socks5">SOCKS5</option>
              </select>
            </label>

            <ConnectionRow>
              <label className="settings-row">
                <span className="settings-row__label">Host</span>
                <input
                  type="text"
                  aria-label="Proxy host"
                  value={host}
                  placeholder="e.g. 127.0.0.1"
                  onChange={(e) => setHost(e.target.value)}
                />
              </label>
              <label className="settings-row settings-row--port">
                <span className="settings-row__label">Port</span>
                <input
                  type="number"
                  aria-label="Proxy port"
                  value={port}
                  min={1}
                  max={65535}
                  onChange={(e) => setPort(Number(e.target.value))}
                />
              </label>
            </ConnectionRow>

            <div className="settings-actions settings-actions--split">
              <button
                type="button"
                className="settings-btn settings-btn--primary"
                aria-label="Apply proxy settings"
                onClick={() => void handleApply()}
              >
                Apply
              </button>
              <div className="settings-actions">
                <button
                  type="button"
                  className="settings-btn settings-btn--quiet"
                  aria-label="Turn off proxy"
                  onClick={() => void handleModeChange('off')}
                >
                  Turn off
                </button>
                <button
                  type="button"
                  className="settings-btn"
                  aria-label="Test proxy connection"
                  disabled={busy || host.trim().length === 0}
                  onClick={() => void handleTest()}
                >
                  Test connection
                </button>
              </div>
            </div>

            {dirty && (
              <p className="settings-hint" role="status">
                Unsaved changes — Apply to use.
              </p>
            )}
            {testStatus && (
              <p className="settings-hint" role="status">
                {testStatus}
              </p>
            )}

            <div className="settings-row settings-row--inline settings-row--between">
              <span className="settings-hint">
                {state.active
                  ? // The chrome can't reliably tell desktop OSes apart because the browser UA is
                    // intentionally normalized. Give a conservative platform-parity hint.
                    typeof window !== 'undefined' && 'AegisAndroid' in window
                    ? 'Applies to all tabs (and the app).'
                    : 'Active. Linux applies live; Windows needs a tab reload; macOS saves this for future proxy support.'
                  : 'Not active yet — click Apply.'}
              </span>
              {state.active && onReloadActiveTab && (
                <button
                  type="button"
                  className="settings-btn settings-btn--quiet"
                  onClick={() => onReloadActiveTab()}
                >
                  Reload active tab
                </button>
              )}
            </div>
          </section>

          <section className="settings-section" aria-label="Bypass hosts">
            <h3 className="settings-section__title">Bypass hosts</h3>
            <label className="settings-row">
              <input
                type="text"
                aria-label="Proxy bypass hosts"
                value={bypassRaw}
                placeholder="e.g. localhost, 192.168.0.0/24"
                onChange={(e) => setBypassRaw(e.target.value)}
              />
              <span className="settings-hint">
                Comma-separated hostnames or CIDRs that bypass the proxy.
              </span>
            </label>
          </section>
        </>
      )}

      {/* ── Honest limits copy ──
          `ProxySettingsTab.test.tsx` asserts the FIRST `h3` in the container is the Proxy
          heading, so the mode section's title stays the first heading in the panel. */}
      <section className="settings-section" role="note" aria-label="Proxy honest limits notice">
        <h3 className="settings-section__title">What this does not cover</h3>
        <p className="settings-hint">
          <strong>Proxy, not VPN.</strong> This proxy routes browsed pages only — not other apps,
          the OS, or Aegis&apos;s own updates and filter-list fetches. It does not stop WebRTC, DNS,
          or QUIC leaks — to hide your local IP, set WebRTC IP protection to &ldquo;Public
          only&rdquo; in the WebRTC tab. <strong>This is not a VPN.</strong>
        </p>
        <p className="settings-hint">
          <strong>macOS:</strong> No proxy support yet — the macOS content-webview back-end does not
          expose a proxy API in this version. Settings saved here will apply when macOS support
          lands.
        </p>
        <p className="settings-hint">
          <strong>Windows:</strong> Existing tabs must be reloaded after changing the proxy. Newly
          opened tabs use the latest applied setting.
        </p>
      </section>
    </div>
  );
}

export default ProxySettingsTab;
