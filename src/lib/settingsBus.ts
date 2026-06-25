// A tiny in-renderer pub/sub for settings changes, so hooks that cache a derived
// piece of settings (e.g. useNav's search-engine template) refresh the moment the
// user edits settings — without each one independently subscribing to IPC. useSettings
// publishes on BOTH a local edit and a sync-merged change; subscribers re-derive.
// Complements syncBus (which only fires on post-merge sync changes, never local edits).
import type { Settings } from '../../shared/types';

type Listener = (settings: Settings) => void;

const listeners = new Set<Listener>();

/** Subscribe to settings changes (local or synced). Returns an unsubscribe fn. */
export function onSettingsChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Publish the new full settings to every subscriber. */
export function publishSettings(settings: Settings): void {
  listeners.forEach((fn) => {
    try {
      fn(settings);
    } catch {
      /* a listener error must not break the others */
    }
  });
}
