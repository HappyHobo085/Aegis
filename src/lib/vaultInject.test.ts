// Audit 2.9: `vault_inject.js` (the in-page autofill badge + form capture) was injected into
// EVERY frame — desktop via `initialization_script_for_all_frames`, Android via
// `addDocumentStartJavaScript(…, setOf("*"))` — so a third-party iframe on a login page would
// run the credential-form machinery too. It must run in the TOP frame only. The guard lives in
// the script itself, so desktop and Android get it from the same source.
//
// The real script is evaluated with a stand-in `window` (its `top` either IS itself or is not),
// because jsdom cannot give an iframe an http(s) origin and the script bails on any other.
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(
  join(import.meta.dirname, '..', '..', 'src-tauri', 'src', 'vault_inject.js'),
  'utf8',
);

function runIn(isTop: boolean): ReturnType<typeof vi.fn> {
  const addEventListener = vi.fn();
  const fakeWindow: Record<string, unknown> = {
    location: { protocol: 'https:', hostname: 'login.example' },
    addEventListener,
  };
  fakeWindow.top = isTop ? fakeWindow : {};
  fakeWindow.self = fakeWindow;
  new Function('window', 'document', SRC)(fakeWindow, document);
  return addEventListener;
}

describe('vault_inject.js runs in the top frame only', () => {
  it('installs its page listeners in the top frame (control)', () => {
    expect(runIn(true)).toHaveBeenCalled();
  });

  it('does nothing at all inside a subframe', () => {
    expect(runIn(false)).not.toHaveBeenCalled();
  });
});
