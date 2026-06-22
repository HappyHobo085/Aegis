// src/components/PermissionPromptDialog.tsx
import { useId } from 'react';
import type { PermissionPrompt } from '../../shared/types';
import { useDialog } from '../hooks/useDialog';
import { useChromeSurface } from '../hooks/useChromeSurfaces';

export interface PermissionPromptDialogProps {
  prompt: PermissionPrompt;
  onResolve(requestId: number, decision: 'allow' | 'deny'): void;
}

export function PermissionPromptDialog({ prompt, onResolve }: PermissionPromptDialogProps) {
  useChromeSurface('permissionPrompt', true);
  const msgId = useId();
  // Closing the dialog (Escape / focus-trap dismiss) is treated as a Block.
  const dialogRef = useDialog<HTMLDivElement>(() => onResolve(prompt.requestId, 'deny'));

  return (
    <div className="permission-prompt__scrim">
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-describedby={msgId}
      className="permission-prompt"
    >
      <p id={msgId} className="permission-prompt__message">
        {prompt.origin} wants to use {prompt.permission}.
      </p>
      <div className="permission-prompt__actions">
        <button type="button" onClick={() => onResolve(prompt.requestId, 'allow')}>
          Allow
        </button>
        <button type="button" onClick={() => onResolve(prompt.requestId, 'deny')}>
          Block
        </button>
      </div>
    </div>
    </div>
  );
}
