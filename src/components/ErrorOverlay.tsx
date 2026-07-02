// src/components/ErrorOverlay.tsx
import type { NavCrashed, NavFailed } from '../../shared/types';
import { useChromeSurface } from '../hooks/useChromeSurfaces';
import { toast } from '../lib/toast';

export interface ErrorOverlayProps {
  failed: NavFailed | null;
  crashed: NavCrashed | null;
  onRetry(): void;
  onHome(): void;
}

export function ErrorOverlay({ failed, crashed, onRetry, onHome }: ErrorOverlayProps) {
  useChromeSurface('errorOverlay', failed !== null || crashed !== null);
  if (!failed && !crashed) {
    return null;
  }

  let heading: string;
  let body: string;
  let detail: string | null;

  if (crashed) {
    heading = 'This page crashed';
    body = 'The page stopped responding and was closed.';
    detail = crashed.reason;
  } else if (failed && failed.kind === 'cert') {
    heading = 'This site is not secure';
    body =
      'The security certificate for this site could not be verified, so the connection was blocked.';
    detail = `${failed.errorDescription} (${failed.errorCode})`;
  } else {
    heading = 'This page could not be loaded';
    body = 'Check the address and your network connection, then try again.';
    detail = failed ? `${failed.errorDescription} (${failed.errorCode})` : null;
  }

  const copyDetail = (): void => {
    const text = [heading, body, detail].filter(Boolean).join('\n');
    if (!navigator.clipboard?.writeText) {
      toast.error('Could not copy diagnostics');
      return;
    }
    void navigator.clipboard.writeText(text).then(
      () => toast.success('Copied diagnostics'),
      () => toast.error('Could not copy diagnostics'),
    );
  };

  return (
    <div className="error-overlay" role="alert">
      <div className="error-overlay__panel">
        <div className="error-overlay__eyebrow">
          {crashed
            ? 'Renderer stopped'
            : failed?.kind === 'cert'
              ? 'Connection blocked'
              : 'Navigation failed'}
        </div>
        <h1 className="error-overlay__heading">{heading}</h1>
        <p className="error-overlay__body">{body}</p>
        {detail && (
          <details className="error-overlay__details">
            <summary>Technical details</summary>
            <pre className="error-overlay__detail">{detail}</pre>
          </details>
        )}
        <div className="error-overlay__actions">
          <button type="button" onClick={onRetry}>
            Retry
          </button>
          <button type="button" onClick={onHome}>
            Home
          </button>
          {detail && (
            <button type="button" className="error-overlay__secondary" onClick={copyDetail}>
              Copy details
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
