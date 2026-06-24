// src/components/ConfirmDialog.tsx
import { useEffect, useState, useId, useCallback, useRef } from 'react';
import { registerConfirmHandler } from '../lib/toast';
import { useDialog } from '../hooks/useDialog';
import { useChromeSurface } from '../hooks/useChromeSurfaces';

interface PendingConfirm {
  message: string;
  resolve: (value: boolean) => void;
  resolved: boolean;
  /** When true, the affirmative (OK) action is styled as destructive. */
  destructive?: boolean;
}

function Dialog({
  pending,
  onResolve,
}: {
  pending: PendingConfirm;
  onResolve: (value: boolean) => void;
}) {
  const msgId = useId();
  // Land initial focus on the SAFE choice (Cancel) so a stray Enter can't fire the
  // affirmative default.
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useDialog<HTMLDivElement>(() => onResolve(false), {
    initialFocus: cancelRef,
  });

  return (
    // Backdrop/scrim click cancels (treated as a dismiss).
    <div className="confirm-dialog__scrim" onClick={() => onResolve(false)}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-describedby={msgId}
        className="confirm-dialog"
        // Don't let clicks inside the card bubble up to the scrim (which would cancel).
        onClick={(e) => e.stopPropagation()}
      >
        <p id={msgId} className="confirm-dialog__message">
          {pending.message}
        </p>
        <div className="confirm-dialog__actions">
          <button
            type="button"
            className={pending.destructive ? 'confirm-dialog__confirm--danger' : undefined}
            onClick={() => onResolve(true)}
          >
            OK
          </button>
          <button type="button" ref={cancelRef} onClick={() => onResolve(false)}>
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
    // The registered handler accepts the message and an optional `destructive` flag.
    // `confirm(message)` in lib/toast supplies only the message today (default
    // non-destructive); the second parameter lets a future destructive-confirm caller
    // flag the affirmative action without changing this component.
    registerConfirmHandler((message: string, destructive?: boolean): Promise<boolean> => {
      return new Promise<boolean>((resolve) => {
        const pendingItem: PendingConfirm = {
          message,
          resolve,
          resolved: false,
          destructive: destructive ?? false,
        };
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
