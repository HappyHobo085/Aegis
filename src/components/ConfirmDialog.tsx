// src/components/ConfirmDialog.tsx
import { useEffect, useState, useId, useCallback, useRef } from 'react';
import { registerConfirmHandler } from '../lib/toast';
import { useDialog } from '../hooks/useDialog';
import { useChromeSurface } from '../hooks/useChromeSurfaces';

interface PendingConfirm {
  message: string;
  resolve: (value: boolean) => void;
  resolved: boolean;
}

function Dialog({
  pending,
  onResolve,
}: {
  pending: PendingConfirm;
  onResolve: (value: boolean) => void;
}) {
  const msgId = useId();
  const dialogRef = useDialog<HTMLDivElement>(() => onResolve(false));

  return (
    <div className="confirm-dialog__scrim">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-describedby={msgId}
        className="confirm-dialog"
      >
        <p id={msgId} className="confirm-dialog__message">
          {pending.message}
        </p>
        <div className="confirm-dialog__actions">
          <button type="button" onClick={() => onResolve(true)}>
            OK
          </button>
          <button type="button" onClick={() => onResolve(false)}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

export function ConfirmDialog() {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  useChromeSurface('confirmDialog', pending !== null);
  // Track the active item in a ref so resolution side effects happen OUTSIDE the
  // state updater. The updater must stay pure: React StrictMode (dev) double-invokes
  // updaters, and an impure one that returns a different value on the second pass
  // would leave the dialog stuck open. setPending(null) is unconditional + pure.
  const pendingRef = useRef<PendingConfirm | null>(null);

  const handleResolve = useCallback((value: boolean) => {
    const current = pendingRef.current;
    if (current && !current.resolved) {
      current.resolved = true;
      current.resolve(value);
    }
    pendingRef.current = null;
    setPending(null);
  }, []);

  useEffect(() => {
    registerConfirmHandler((message: string): Promise<boolean> => {
      return new Promise<boolean>((resolve) => {
        const pendingItem: PendingConfirm = { message, resolve, resolved: false };
        pendingRef.current = pendingItem;
        setPending(pendingItem);
      });
    });

    return () => {
      registerConfirmHandler(null);
    };
  }, []);

  if (!pending) return null;

  return <Dialog pending={pending} onResolve={handleResolve} />;
}
