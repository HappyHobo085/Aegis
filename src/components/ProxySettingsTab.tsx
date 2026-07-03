// src/components/ProxySettingsTab.tsx
//
// The "Proxy" Settings tab.  Configures the content-webview proxy.
// IMPORTANT: This is NOT a VPN.  Honest limits are surfaced in-UI.
import { useEffect, useRef, useState } from 'react';
import type { ProxyConfig, ProxyState } from '../../shared/types';

export interface ProxySettingsTabProps {
  state: ProxyState;
  setConfig(cfg: ProxyConfig): Promise<ProxyState>;
  test(cfg: ProxyConfig): Promise<{ ok: boolean; latencyMs?: number; error?: string }>;
}

export function ProxySettingsTab({ state, setConfig, test }: ProxySettingsTabProps) {
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
    <div className="proxy-tab">
      <h3>Proxy</h3>

      <label className="proxy-tab__field">
        <span>Mode</span>
        <select
          aria-label="Proxy mode"
          value={mode}
          onChange={(e) => void handleModeChange(e.target.value as 'off' | 'proxy')}
        >
          <option value="off">Off — direct connection</option>
          <option value="proxy">Use a proxy</option>
        </select>
      </label>

      {mode === 'proxy' && (
        <>
          <label className="proxy-tab__field">
            <span>Protocol</span>
            <select
              aria-label="Proxy scheme"
              value={scheme}
              onChange={(e) => setScheme(e.target.value as 'http' | 'socks5')}
            >
              <option value="http">HTTP</option>
              <option value="socks5">SOCKS5</option>
            </select>
          </label>

          <label className="proxy-tab__field">
            <span>Host</span>
            <input
              type="text"
              aria-label="Proxy host"
              value={host}
              placeholder="e.g. 127.0.0.1"
              onChange={(e) => setHost(e.target.value)}
            />
          </label>

          <label className="proxy-tab__field">
            <span>Port</span>
            <input
              type="number"
              aria-label="Proxy port"
              value={port}
              min={1}
              max={65535}
              onChange={(e) => setPort(Number(e.target.value))}
            />
          </label>

          <label className="proxy-tab__field">
            <span>Bypass hosts</span>
            <input
              type="text"
              aria-label="Proxy bypass hosts"
              value={bypassRaw}
              placeholder="e.g. localhost, 192.168.0.0/24"
              onChange={(e) => setBypassRaw(e.target.value)}
            />
            <small>Comma-separated hostnames or CIDRs that bypass the proxy.</small>
          </label>

          <div className="proxy-tab__actions">
            <button
              type="button"
              aria-label="Apply proxy settings"
              onClick={() => void handleApply()}
            >
              Apply
            </button>
            <button
              type="button"
              aria-label="Turn off proxy"
              onClick={() => void handleModeChange('off')}
            >
              Turn off
            </button>
            <button
              type="button"
              aria-label="Test proxy connection"
              disabled={busy || host.trim().length === 0}
              onClick={() => void handleTest()}
            >
              Test connection
            </button>
          </div>

          {dirty && (
            <p className="proxy-tab__dirty" role="status">
              Unsaved changes — Apply to use.
            </p>
          )}

          {testStatus && (
            <p className="proxy-tab__status" role="status">
              {testStatus}
            </p>
          )}

          <div className="proxy-tab__status-row">
            <small>
              {state.active
                ? // The chrome can't reliably tell desktop OSes apart because the browser UA is
                  // intentionally normalized. Give a conservative platform-parity hint.
                  typeof window !== 'undefined' && 'AegisAndroid' in window
                  ? 'Applies to all tabs (and the app).'
                  : 'Active. Linux applies live; Windows needs a tab reload; macOS saves this for future proxy support.'
                : 'Not active yet — click Apply.'}
            </small>
          </div>
        </>
      )}

      {/* ── Honest limits copy (Global Constraint 1) ── */}
      <div className="proxy-tab__notice" role="note" aria-label="Proxy honest limits notice">
        <p>
          <strong>Proxy, not VPN.</strong> This proxy routes browsed pages only — not other apps,
          the OS, or Aegis&apos;s own updates and filter-list fetches. It does not stop WebRTC, DNS,
          or QUIC leaks — to hide your local IP, set WebRTC IP protection to &ldquo;Public
          only&rdquo; in the Security tab. <strong>This is not a VPN.</strong>
        </p>
        <p>
          <strong>macOS:</strong> No proxy support yet — the macOS content-webview back-end does not
          expose a proxy API in this version. Settings saved here will apply when macOS support
          lands.
        </p>
        <p>
          <strong>Windows:</strong> Existing tabs must be reloaded after changing the proxy. Newly
          opened tabs use the latest applied setting.
        </p>
      </div>
    </div>
  );
}
