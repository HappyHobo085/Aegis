// src/components/ConfirmDialog.tsx
import { useEffect, useState, useId, useCallback } from 'react';
import { registerConfirmHandler } from '../lib/toast';
import { useDialog } from '../hooks/useDialog';

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
  );
}

export function ConfirmDialog() {
  const [pending, setPending] = useState<PendingConfirm | null>(null);

  const handleResolve = useCallback((value: boolean) => {
    setPending((current) => {
      if (!current || current.resolved) return current;
      current.resolved = true;
      current.resolve(value);
      return null;
    });
  }, []);

  useEffect(() => {
    registerConfirmHandler((message: string): Promise<boolean> => {
      return new Promise<boolean>((resolve) => {
        const pendingItem: PendingConfirm = { message, resolve, resolved: false };
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
