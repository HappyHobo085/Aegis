// src/hooks/useVaultAutofill.ts
import { useCallback } from 'react';
import type { VaultRecord } from '../../shared/types';
import { aegis } from '../lib/ipcClient';

export interface UseVaultAutofill {
  autofill: (options: { domain: string; username?: string }) => Promise<VaultRecord[]>;
  autofillSuggestions: (options: { q: string }) => Promise<VaultRecord[]>;
}

export function useVaultAutofill(): UseVaultAutofill {
  const autofill = useCallback(
    async (options: { domain: string; username?: string }) => {
      return await aegis.vault.autofill(options);
    },
    []
  );

  const autofillSuggestions = useCallback(
    async (options: { q: string }) => {
      return await aegis.vault.autofillSuggestions(options);
    },
    []
  );

  return { autofill, autofillSuggestions };
}