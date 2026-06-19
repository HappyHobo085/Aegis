// src/main.tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import './index.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root container #root not found');
}

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);

// Dev-only: when launched by the autopilot harness, drive the app autonomously.
// Vite dead-code-eliminates this whole branch in production (`import.meta.env.DEV`
// is the literal `false`), so the autopilot never ships in a release build.
if (import.meta.env.DEV && import.meta.env.VITE_AEGIS_AUTOPILOT) {
  // Give the app a moment to mount + register its control surface, then run.
  setTimeout(() => {
    void import('./autopilot/run').then((m) => m.runAutopilot());
  }, 1500);
}
