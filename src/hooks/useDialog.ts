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
): RefObject<T | null> {
  const ref = useRef<T | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const initialFocusRef = useRef(opts.initialFocus);
  initialFocusRef.current = opts.initialFocus;

  // Capture the previously-focused element during the render phase, before React
  // commits DOM mutations. At render time the old focused element is still in the
  // DOM, which lets us restore focus correctly even when the element is removed
  // as part of the same rerender that mounts this dialog.
  const previouslyFocusedRef = useRef<HTMLElement | null>(
    document.activeElement as HTMLElement | null,
  );

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

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
      const prev = previouslyFocusedRef.current;
      if (prev && typeof prev.focus === 'function') {
        prev.focus();
      }
    };
  }, []);

  return ref;
}
