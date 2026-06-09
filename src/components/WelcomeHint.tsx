// src/components/WelcomeHint.tsx
import { useState } from 'react';

export const WELCOME_HINT_STORAGE_KEY = 'aegis.welcomeHint.dismissed';

export function WelcomeHint() {
  const [dismissed, setDismissed] = useState<boolean>(
    () => localStorage.getItem(WELCOME_HINT_STORAGE_KEY) === '1',
  );

  if (dismissed) {
    return null;
  }

  const handleDismiss = (): void => {
    localStorage.setItem(WELCOME_HINT_STORAGE_KEY, '1');
    setDismissed(true);
  };

  return (
    <div className="welcome-hint" role="note">
      <p>Welcome to Aegis. Type a search or an address above to get started.</p>
      <button type="button" onClick={handleDismiss}>
        Got it
      </button>
    </div>
  );
}
