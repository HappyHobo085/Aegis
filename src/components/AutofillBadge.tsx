// src/components/AutofillBadge.tsx
//
// A small badge rendered in the chrome toolbar when the active content webview
// has a login form AND the vault has matching credentials. Clicking the badge
// triggers autofill (sends credentials to vault_inject.js via the Tauri event
// bridge). When multiple credentials match, the badge shows a count and the
// content-side dropdown handles selection.
//
// This is a presentational component — all state lives in the hooks it
// consumes (useVaultDomainSuggestions). It renders nothing when there are
// no suggestions or the vault is locked.
import { useVaultDomainSuggestions } from '../hooks/useVaultDomainSuggestions';

interface AutofillBadgeProps {
  /** Whether the vault is currently unlocked. */
  vaultUnlocked: boolean;
}

export function AutofillBadge({ vaultUnlocked }: AutofillBadgeProps) {
  const { suggestions } = useVaultDomainSuggestions();

  // Don't render when: vault locked, no login form detected, or no matching creds.
  if (!vaultUnlocked || suggestions.length === 0) return null;

  const label =
    suggestions.length === 1
      ? `Autofill: ${suggestions[0].username}`
      : `Autofill (${suggestions.length})`;

  return (
    <button
      type="button"
      className="autofill-badge"
      aria-label={label}
      title={label}
      onClick={() => {
        // The badge is shown when a login form is detected; the actual fill
        // is driven by vault_inject.js in the content webview. This click
        // is a no-op placeholder for future UX (e.g. open vault picker).
      }}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        {/* Key icon */}
        <path
          d="M8 1a3 3 0 0 0-3 3c0 1.3.84 2.4 2 2.82V7H6a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1h-1V6.82A3.001 3.001 0 0 0 8 1Zm-1 3a1 1 0 1 1 2 0 1 1 0 0 1-2 0Z"
          fill="currentColor"
        />
      </svg>
      {suggestions.length > 1 && (
        <span className="autofill-badge__count">{suggestions.length}</span>
      )}
    </button>
  );
}
