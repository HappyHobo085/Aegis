// src/components/Toaster.tsx
import { useEffect, useState } from 'react';
import { subscribeToasts, type ToastItem } from '../lib/toast';

export function Toaster() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  useEffect(() => subscribeToasts(setToasts), []);

  return (
    <div className="toaster" role="status" aria-live="polite" aria-atomic="false">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast--${t.kind}`}>
          <span className="toast__message">{t.message}</span>
          {t.action && (
            <button type="button" className="toast__action" onClick={() => t.action?.onClick()}>
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
