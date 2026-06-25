// src/hooks/useNav.ts
import { useCallback, useEffect, useRef, useState } from 'react';
import type { NavState, ViewId } from '../../shared/types';
import { PRIMARY_VIEW_ID } from '../../shared/types';
import { aegis } from '../lib/ipcClient';
import { addressParse } from '../lib/addressParse';
import { toast } from '../lib/toast';
import { onSettingsChange } from '../lib/settingsBus';

const emptyState = (viewId: ViewId): NavState => ({
  viewId,
  url: '',
  title: '',
  canGoBack: false,
  canGoForward: false,
  isLoading: false,
  crashed: false,
});

export function useNav(viewId: ViewId): {
  state: NavState;
  navigate(raw: string): void;
  back(): void;
  forward(): void;
  reloadOrStop(): void;
  home(): void;
} {
  const [state, setState] = useState<NavState>(() => emptyState(viewId));
  const [searchTemplate, setSearchTemplate] = useState<string>('https://duckduckgo.com/?q=%s');
  const stateRef = useRef<NavState>(state);
  stateRef.current = state;

  useEffect(() => {
    let active = true;
    void aegis.nav.getState(viewId).then((s) => {
      if (active) setState(s);
    });
    void aegis.settings.get().then((s) => {
      if (active) setSearchTemplate(s.defaultSearchTemplate);
    });
    // Keep the address-bar search template current when the user changes their default
    // search engine (or it syncs from another device) — without waiting for a reload.
    const offSettings = onSettingsChange((s) => {
      if (active) setSearchTemplate(s.defaultSearchTemplate);
    });
    const unsubscribe = aegis.nav.onState((s) => {
      if (s.viewId === viewId) setState(s);
    });
    return () => {
      active = false;
      offSettings();
      unsubscribe();
    };
  }, [viewId]);

  const navigate = useCallback(
    (raw: string) => {
      const result = addressParse(raw, {
        currentUrl: stateRef.current.url,
        searchTemplate,
      });
      if (result.kind === 'reload') {
        void aegis.nav.reloadOrStop(viewId);
      } else if (result.kind === 'navigate') {
        void aegis.nav.navigate(viewId, result.url);
      } else {
        // result.kind === 'rejected': do not navigate (main also rejects the scheme
        // defensively in nav.navigate). Surface the reason to the user so the address
        // bar isn't a silent dead-end, and log it for diagnostics.
        console.warn('Address rejected:', result.reason);
        toast.error(result.reason || "That address can't be opened.");
      }
    },
    [viewId, searchTemplate],
  );

  const back = useCallback(() => {
    void aegis.nav.back(viewId);
  }, [viewId]);
  const forward = useCallback(() => {
    void aegis.nav.forward(viewId);
  }, [viewId]);
  const reloadOrStop = useCallback(() => {
    void aegis.nav.reloadOrStop(viewId);
  }, [viewId]);
  const home = useCallback(() => {
    void aegis.nav.home(viewId);
  }, [viewId]);

  return { state, navigate, back, forward, reloadOrStop, home };
}

export const DEFAULT_VIEW_ID = PRIMARY_VIEW_ID;
