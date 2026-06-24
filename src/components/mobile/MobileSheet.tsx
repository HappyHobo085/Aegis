import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { useDialog } from '../../hooks/useDialog';

interface MobileSheetProps {
  title: string;
  onClose(): void;
  children: ReactNode;
}

export function MobileSheet({ title, onClose, children }: MobileSheetProps) {
  // Focus-trap + Esc + focus-restore, matching the desktop dialogs (the mobile
  // sheets previously declared role="dialog" but managed no focus at all).
  const ref = useDialog<HTMLDivElement>(onClose);
  return (
    <div ref={ref} className="mobile-sheet" role="dialog" aria-modal="true" aria-label={title}>
      <header className="mobile-sheet__bar">
        {/* Close (X) — the icon now matches the action. "Back" was ambiguous next to the
            Menu sheet's browser-Back item. */}
        <button type="button" className="mobile-sheet__back" aria-label="Close" onClick={onClose}>
          <X size={22} aria-hidden="true" />
        </button>
        <h2 className="mobile-sheet__title">{title}</h2>
      </header>
      <div className="mobile-sheet__body">{children}</div>
    </div>
  );
}
