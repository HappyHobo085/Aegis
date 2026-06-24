// src/components/PermissionPromptDialog.tsx
import { useId, useRef } from 'react';
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
  // Closing the dialog (Escape / focus-trap dismiss / scrim click) is treated as a Block.
  const deny = (): void => onResolve(prompt.requestId, 'deny');
  // Land initial focus on the SAFE choice (Block) so a stray Enter can't grant access.
  const blockRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useDialog<HTMLDivElement>(deny, { initialFocus: blockRef });

  return (
    <div className="permission-prompt__scrim" onClick={deny}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-describedby={msgId}
        className="permission-prompt"
        // Clicks inside the card must not bubble to the scrim (which would deny).
        onClick={(e) => e.stopPropagation()}
      >
        <p id={msgId} className="permission-prompt__message">
          {prompt.origin} wants to use {prompt.permission}.
        </p>
        <div className="permission-prompt__actions">
          <button type="button" onClick={() => onResolve(prompt.requestId, 'allow')}>
            Allow
          </button>
          <button type="button" ref={blockRef} onClick={deny}>
            Block
          </button>
        </div>
      </div>
    </div>
  );
}
