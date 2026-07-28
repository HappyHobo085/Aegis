// src/hooks/useLoginFormDetector.ts
import { useCallback, useEffect, useRef, useState } from 'react';
import { aegis } from '../lib/ipcClient';
import type { FormLoginDetectedResult } from '../../shared/types';

interface UseLoginFormDetector {
  isChecking: boolean;
  hasLoginForm: boolean;
  loginFormDomain: string | null;
  checkForLoginForm: () => Promise<void>;
}

export function useLoginFormDetector(): UseLoginFormDetector {
  const [isChecking, setIsChecking] = useState<boolean>(false);
  const isCheckingRef = useRef(false);
  const [hasLoginForm, setHasLoginForm] = useState<boolean>(false);
  const [loginFormDomain, setLoginFormDomain] = useState<string | null>(null);
  const checkTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const checkForLoginForm = useCallback(async () => {
    if (isCheckingRef.current) return;

    isCheckingRef.current = true;
    setIsChecking(true);
    try {
      const result: FormLoginDetectedResult = await aegis.form.detectLoginForm();
      setHasLoginForm(result.hasLoginForm);
      setLoginFormDomain(result.domain || null);
    } catch (error) {
      console.warn('Failed to check for login form:', error);
      setHasLoginForm(false);
      setLoginFormDomain(null);
    } finally {
      isCheckingRef.current = false;
      setIsChecking(false);
    }
  }, []);

  // Set up periodic checking (every 2 seconds when potentially on a login page)
  useEffect(() => {
    // Check immediately on mount
    void checkForLoginForm();

    // Set up interval for periodic checks
    const interval = setInterval(() => {
      void checkForLoginForm();
    }, 2000);

    return () => {
      if (checkTimeoutRef.current) {
        clearTimeout(checkTimeoutRef.current);
      }
      clearInterval(interval);
    };
  }, [checkForLoginForm]);

  return { isChecking, hasLoginForm, loginFormDomain, checkForLoginForm };
}
