// src/hooks/useTabTitleSync.ts
import { useEffect, useRef } from 'react';
import type { ViewId } from '../../shared/types';
import { aegis } from '../lib/ipcClient';

/**
 * Keep a tab's TITLE current when the page renames itself after load.
 *
 * A tab's title is normally recorded by `tabs.recordNav` at navigation time. That
 * covers the ordinary case, but a page that changes its own `document.title` with
 * NO navigation — an SPA route change, a Gmail unread count, a YouTube video
 * title — never reaches it, so the tab strip showed the title from page load and
 * never corrected itself. `tabs.setTitle` is the channel for exactly this: it sets
 * the title without pushing nav history and without re-validating an unchanged URL,
 * which `tabs.recordNav` would have to do.
 *
 * Both platforms deliver the same `nav.state` event for this:
 *
 * - Desktop, from Rust's `on_document_title_changed` on the content webview
 *   (`nav.rs`), which re-emits `nav.state` through the existing `emit_state`.
 * - Android, from `WebChromeClient.onReceivedTitle` in `MainActivity.kt`, which
 *   re-uses the existing `pushNavState` (its payload already carried `title`).
 *
 * So there is one handler for both, and no platform branch here.
 *
 * `useNav` cannot do this: it is mounted per view and filters every event to the
 * ACTIVE tab, because the address bar only tracks the active tab. The tab strip
 * needs every tab's title, so the subscriber lives here and neither subscribes to
 * nor mutates address-bar state.
 *
 * Only a title that DIFFERS from the last one seen is sent. A `nav.state` also
 * fires at page load and on progress, and re-sending an unchanged title would be
 * an IPC round trip and an `emit_and_persist` for nothing — and on a tab that
 * navigates often that is a write per navigation. A repeated identical push is
 * also how this loop would get silly: `setTitle` emits `tabs.changed`, which
 * re-renders the chrome, and a tab that renames itself on a timer would drive a
 * write each time.
 */
export function useTabTitleSync(): void {
  // Survives re-renders without re-subscribing. A ref, not state: this is a
  // de-duplication cache, not something anything renders.
  const last = useRef(new Map<ViewId, string>());

  useEffect(() => {
    const seen = last.current;
    const unsubscribe = aegis.nav.onState((s) => {
      const title = s.title?.trim() ?? '';
      // An empty title is not information: a page mid-load reports one, and
      // clearing the tab's title would make the strip fall back to the URL.
      if (!title || seen.get(s.viewId) === title) return;
      seen.set(s.viewId, title);
      void aegis.tabs.setTitle(s.viewId, title);
    });
    return () => {
      seen.clear();
      unsubscribe();
    };
  }, []);
}
