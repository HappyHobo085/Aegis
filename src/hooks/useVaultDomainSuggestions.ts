// src/hooks/useVaultDomainSuggestions.ts
import { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import type { VaultRecord } from '../../shared/types';
import { useVaultAutofill } from './useVaultAutofill';
import { useNav, PRIMARY_VIEW_ID } from './useNav';
import { useLoginFormDetector } from './useLoginFormDetector';

interface UseVaultDomainSuggestions {
  suggestions: VaultRecord[];
  loading: boolean;
  error: string | null;
  // Trigger a refetch for the current domain (useful when the domain changes)
  refetch: () => Promise<void>;
}

export function useVaultDomainSuggestions(): UseVaultDomainSuggestions {
  const { state: navState } = useNav(PRIMARY_VIEW_ID);
  const [suggestions, setSuggestions] = useState<VaultRecord[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [hasLoginForm, setHasLoginForm] = useState<boolean>(false);
  const loginFormDetector = useLoginFormDetector();

  // Use useMemo to stabilize the autofill reference across renders
  const vaultAutofill = useVaultAutofill();
  const vaultAutofillRef = useRef(vaultAutofill);
  vaultAutofillRef.current = vaultAutofill;

  // We use a ref for vaultAutofill to avoid stale closures while keeping stable deps
  const fetchSuggestions = useCallback(async (domain: string) => {
    if (!domain) {
      setSuggestions([]);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      // We use autofill with empty username to get credentials for the domain
      const result = await vaultAutofillRef.current.autofill({ domain, username: '' });
      setSuggestions(result);
    } catch (err) {
      setSuggestions([]);
      // Ensure we always set a string error or null
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  // Run the fetch when we detect a login form or when URL changes significantly
  useEffect(() => {
    // Update login form state from detector
    setHasLoginForm(loginFormDetector.hasLoginForm);

    // If we have a login form, check for credentials
    if (loginFormDetector.hasLoginForm && loginFormDetector.loginFormDomain) {
      void fetchSuggestions(loginFormDetector.loginFormDomain);
    } else if (!loginFormDetector.hasLoginForm) {
      // Clear suggestions when no login form is detected
      setSuggestions([]);
      setError(null);
      setLoading(false);
    }
  }, [loginFormDetector.hasLoginForm, loginFormDetector.loginFormDomain, fetchSuggestions]);

  // Also check when URL changes to a potentially login-related path
  useEffect(() => {
    const url = navState.url;
    if (url) {
      try {
        const urlObj = new URL(url);
        const path = urlObj.pathname.toLowerCase();
        // Check if URL path looks like a login page
        const isLikelyLoginPath =
          path.includes('/login') ||
          path.includes('/signin') ||
          path.includes('/auth') ||
          path.includes('/account') ||
          path === '/' ||
          path === '/index.html';

        // If it looks like a login page, trigger a check
        if (isLikelyLoginPath) {
          // Small delay to let page load
          const timer = setTimeout(() => {
            if (loginFormDetector.hasLoginForm && loginFormDetector.loginFormDomain) {
              void fetchSuggestions(loginFormDetector.loginFormDomain);
            }
          }, 500);
          return () => clearTimeout(timer);
        }
      } catch {
        // Invalid URL, ignore
      }
    }
    return undefined;
  }, [
    navState.url,
    loginFormDetector.hasLoginForm,
    loginFormDetector.loginFormDomain,
    fetchSuggestions,
  ]);

  const refetch = useCallback(async () => {
    const url = navState.url;
    let origin: string | null = null;
    try {
      if (url) {
        const urlObj = new URL(url);
        origin = urlObj.origin;
      }
    } catch {
      origin = null;
    }
    if (origin) {
      // Get current autofill reference via ref
      const { autofill } = vaultAutofillRef.current;
      return autofill({ domain: origin, username: '' }).then(
        (result) => {
          setSuggestions(result);
          setLoading(false);
          setError(null);
        },
        (error) => {
          setSuggestions([]);
          setError(error instanceof Error ? error.message : String(error));
          setLoading(false);
        },
      );
    }
    // If no origin, just reset
    setSuggestions([]);
    setError(null);
    setLoading(false);
    return Promise.resolve();
  }, []); // Empty deps - we get current values inside the function

  return { suggestions, loading, error, refetch };
}
