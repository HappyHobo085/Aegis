// src/hooks/useDialog.ts
import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

interface DialogOpts {
  /** Focus this element on open instead of the first focusable. Use it to land focus
      on the SAFE choice (Cancel/Block/Go-back) so a stray Enter can't fire a
      destructive/affirmative default. */
  initialFocus?: RefObject<HTMLElement | null>;
}

export function useDialog<T extends HTMLElement>(
  onClose: () => void,
  opts: DialogOpts = {},
  /** Whether the dialog is currently rendered. Pass this for a dialog that stays MOUNTED but
      renders `null` while closed — otherwise the effect below runs once against a missing node
      and never re-runs, silently leaving the dialog with no focus trap, no Escape and no focus
      restore. Omit it for a dialog that unmounts entirely when closed. */
  open: boolean = true,
): RefObject<T | null> {
  const ref = useRef<T | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const initialFocusRef = useRef(opts.initialFocus);
  initialFocusRef.current = opts.initialFocus;

  useEffect(() => {
    if (!open) return;
    const node = ref.current;
    if (!node) return;

    // BUG(F3): this used to be a `useRef(document.activeElement)` initialised once during
    // the FIRST render, so it only ever held whatever was focused when the component
    // mounted. That is right for a dialog that unmounts when closed, but WRONG for the
    // always-mounted `open`-prop dialogs this third argument exists for (CommandPalette,
    // Onboarding, SafetyInterstitial): after one Ctrl+K→Enter, the stored element is gone
    // and the restore focused <body>, so the next Tab restarted from the document top.
    // Capture inside the effect instead, so each open→close cycle records the element that
    // is actually focused at the moment this dialog opens. `useEffect` runs after the
    // commit, so nothing has been unfocused or removed yet — the element is still live.
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const getFocusable = (): HTMLElement[] =>
      Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));

    const preferred = initialFocusRef.current?.current ?? null;
    const focusable = getFocusable();
    if (preferred && node.contains(preferred)) {
      preferred.focus();
    } else if (focusable.length > 0) {
      focusable[0].focus();
    } else {
      node.focus();
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;

      const items = getFocusable();
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;

      if (event.shiftKey) {
        if (active === first || !node.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last || !node.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    };

    node.addEventListener('keydown', handleKeyDown);
    return () => {
      node.removeEventListener('keydown', handleKeyDown);
      if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
        previouslyFocused.focus();
      }
    };
  }, [open]);

  return ref;
}
