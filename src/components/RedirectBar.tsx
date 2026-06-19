import { ShieldAlert, X } from 'lucide-react';
import type { RedirectBlocked } from '../../shared/types';

/**
 * Notification bar shown when the native guard cancels a scripted cross-origin top-frame
 * redirect. It renders in the chrome's always-visible top strip (the content webview is
 * opaque and on top, so a floating toast can't paint over it — see App's content-inset
 * wiring, which adds REDIRECT_BAR_H while this is shown). "Open anyway" opens the blocked
 * destination in a new tab (a fresh user-initiated nav, so it isn't re-blocked).
 */
export function RedirectBar({
  redirect,
  onOpenAnyway,
  onDismiss,
}: {
  redirect: RedirectBlocked;
  onOpenAnyway: () => void;
  onDismiss: () => void;
}): React.JSX.Element {
  let host = redirect.to;
  try {
    host = new URL(redirect.to).hostname;
  } catch {
    /* keep the raw URL if it doesn't parse */
  }
  return (
    <div className="redirect-bar" role="alert">
      <ShieldAlert size={16} className="redirect-bar__icon" aria-hidden="true" />
      <span className="redirect-bar__msg">
        Blocked a redirect to <b>{host}</b>
      </span>
      <button type="button" className="redirect-bar__open" onClick={onOpenAnyway}>
        Open anyway
      </button>
      <button
        type="button"
        className="redirect-bar__dismiss"
        aria-label="Dismiss"
        onClick={onDismiss}
      >
        <X size={16} aria-hidden="true" />
      </button>
    </div>
  );
}
