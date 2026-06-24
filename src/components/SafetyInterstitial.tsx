// src/components/SafetyInterstitial.tsx
import { useRef } from 'react';
import type { SafetyInterstitialPayload } from '../../shared/types';
import { useChromeSurface } from '../hooks/useChromeSurfaces';
import { useDialog } from '../hooks/useDialog';
import { confirm } from '../lib/toast';

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

const noop = (): void => {};

export function SafetyInterstitial({
  interstitial,
  onProceed,
  onBack,
}: {
  interstitial: SafetyInterstitialPayload | null;
  onProceed: (url: string) => void;
  onBack?: () => void;
}) {
  useChromeSurface('safetyInterstitial', interstitial !== null);
  // Land focus on the SAFE action (Go back). Esc closes to the safe action too;
  // when onBack is undefined there is no safe action, so Esc/close is a no-op.
  const backRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useDialog<HTMLDivElement>(onBack ?? noop, { initialFocus: backRef });

  if (interstitial === null) return null;
  const host = safeHost(interstitial.url);
  const malware = interstitial.reason === 'malware';

  const handleContinue = async (): Promise<void> => {
    if (malware) {
      // Require an explicit confirm before proceeding to a flagged-dangerous site.
      const ok = await confirm('This site is flagged as dangerous. Continue anyway?', {
        destructive: true,
      });
      if (!ok) return;
    }
    onProceed(interstitial.url);
  };

  return (
    <div
      ref={dialogRef}
      className={`interstitial${malware ? ' interstitial--malware' : ''}`}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="interstitial-title"
    >
      <div className="interstitial__panel">
        <h1 id="interstitial-title" className="interstitial__title">
          {malware
            ? 'Dangerous site blocked'
            : 'This site isn’t available over a secure connection'}
        </h1>
        <p className="interstitial__body">
          {malware ? (
            <>
              <strong>{host}</strong> is on a malware/phishing blocklist and may try to steal your
              information or harm your device. We strongly recommend you go back.
            </>
          ) : (
            <>
              Aegis tried to load <strong>{host}</strong> securely over HTTPS, but the secure
              connection failed. Continuing will load this site over an unencrypted{' '}
              <strong>HTTP</strong> connection, which others on your network may be able to read or
              modify.
            </>
          )}
        </p>
        <div className="interstitial__actions">
          {onBack && (
            <button
              type="button"
              ref={backRef}
              className="interstitial__back"
              aria-label="Go back"
              onClick={onBack}
            >
              Go back
            </button>
          )}
          <button
            type="button"
            className="interstitial__continue"
            onClick={() => void handleContinue()}
          >
            {malware ? 'Continue anyway (not recommended)' : 'Continue to HTTP for this site'}
          </button>
        </div>
      </div>
    </div>
  );
}
