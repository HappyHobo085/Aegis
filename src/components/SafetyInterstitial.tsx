// src/components/SafetyInterstitial.tsx
import type { SafetyInterstitialPayload } from '../../shared/types';

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export function SafetyInterstitial({
  interstitial,
  onProceed,
}: {
  interstitial: SafetyInterstitialPayload | null;
  onProceed: (url: string) => void;
}) {
  if (interstitial === null) return null;
  const host = safeHost(interstitial.url);
  return (
    <div className="interstitial" role="alertdialog" aria-modal="true" aria-labelledby="interstitial-title">
      <div className="interstitial__panel">
        <h1 id="interstitial-title" className="interstitial__title">
          This site isn't available over a secure connection
        </h1>
        <p className="interstitial__body">
          Aegis tried to load <strong>{host}</strong> securely over HTTPS, but the secure connection
          failed. Continuing will load this site over an unencrypted <strong>HTTP</strong> connection,
          which others on your network may be able to read or modify.
        </p>
        <div className="interstitial__actions">
          <button
            type="button"
            className="interstitial__continue"
            onClick={() => onProceed(interstitial.url)}
          >
            Continue to HTTP for this site
          </button>
        </div>
      </div>
    </div>
  );
}
