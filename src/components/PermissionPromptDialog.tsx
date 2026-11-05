// src/components/PermissionPromptDialog.tsx
import { useId, useRef } from 'react';
import type { PermissionDecision, PermissionPrompt, TabMeta, ViewId } from '../../shared/types';
import { useDialog } from '../hooks/useDialog';
import { useChromeSurface } from '../hooks/useChromeSurfaces';

export interface PermissionPromptDialogProps {
  prompt: PermissionPrompt;
  /** The requesting tab is private (judged on the REQUESTER, not the active tab). */
  isPrivate?: boolean;
  /** Set when the requester is NOT the visible tab: its title, so the user knows who asks. */
  backgroundTabTitle?: string;
  onOpenSitePermissions?(): void;
  onResolve(requestId: number, decision: PermissionDecision): void;
}

/**
 * The dialog's tab-dependent props, judged on the REQUESTING tab (audit 5.6): a background
 * private tab's request must say "private", and a request from any non-visible tab names it.
 * An id no longer in the list (the tab closed meanwhile) is treated as a normal background tab.
 */
export function promptTabProps(
  prompt: PermissionPrompt,
  tabs: readonly TabMeta[],
  activeId: ViewId,
): { isPrivate: boolean; backgroundTabTitle?: string } {
  const tab = tabs.find((t) => t.id === prompt.viewId);
  const isPrivate = tab?.private === true;
  if (prompt.viewId === activeId) return { isPrivate };
  return { isPrivate, backgroundTabTitle: tab ? tab.title || tab.url : prompt.origin };
}

export function PermissionPromptDialog({
  prompt,
  isPrivate = false,
  backgroundTabTitle,
  onOpenSitePermissions,
  onResolve,
}: PermissionPromptDialogProps) {
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
        <div id={msgId} className="permission-prompt__message">
          <span className="permission-prompt__origin">{prompt.origin}</span>
          <span>
            wants to use <strong>{prompt.permission}</strong>.
          </span>
          {isPrivate && (
            <span className="permission-prompt__private">This request is from a private tab.</span>
          )}
          {backgroundTabTitle !== undefined && (
            <span className="permission-prompt__background">
              This request is from a background tab: {backgroundTabTitle}
            </span>
          )}
        </div>
        <div className="permission-prompt__actions">
          <button type="button" ref={blockRef} onClick={deny}>
            Block
          </button>
          {onOpenSitePermissions && (
            <button type="button" onClick={onOpenSitePermissions}>
              Site settings
            </button>
          )}
          <button type="button" onClick={() => onResolve(prompt.requestId, 'allow-once')}>
            Allow once
          </button>
          <button type="button" onClick={() => onResolve(prompt.requestId, 'allow')}>
            Always allow
          </button>
        </div>
      </div>
    </div>
  );
}
