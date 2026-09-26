// src/main.tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { AegisIpcError } from './lib/ipcClient';
import { toast } from './lib/toast';
import './index.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root container #root not found');
}

// A rejected IPC is an EXPECTED outcome, not a crash: the core returns `Err(String)` for
// ordinary conditions (vault locked, `split.enter` needing 2–4 tabs, an unreachable proxy)
// and ~58 call sites are fire-and-forget `void aegis.*` with no `.catch()`. Nothing handled
// that, so a routine rejection surfaced as an unhandled promise rejection whose only
// conceivable backstop was the ErrorBoundary above — which replaces the whole chrome.
// Now that `ipcClient` tags these, intercept them here and show a toast instead.
//
// Deliberately narrow: only `AegisIpcError` is intercepted. Anything else is a genuine
// bug and is left alone to surface loudly (console + devtools) rather than being
// laundered into a toast that disappears.
const ipcErrorCooldownMs = 5_000;
const lastIpcErrorToast = new Map<string, number>();

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  if (!(reason instanceof AegisIpcError)) return;
  // Swallow the default "unhandled rejection" console report only once we've taken
  // responsibility for surfacing it.
  event.preventDefault();
  const now = Date.now();
  const last = lastIpcErrorToast.get(reason.channel) ?? 0;
  if (now - last < ipcErrorCooldownMs) return;
  lastIpcErrorToast.set(reason.channel, now);
  console.warn(`[aegis] ${reason.channel} rejected: ${reason.message}`);
  toast.error(`${reason.channel}: ${reason.message}`);
});

performance.mark('aegis-react-start');
createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
