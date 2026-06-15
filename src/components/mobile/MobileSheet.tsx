import type { ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';

interface MobileSheetProps {
  title: string;
  onClose(): void;
  children: ReactNode;
}

export function MobileSheet({ title, onClose, children }: MobileSheetProps) {
  return (
    <div className="mobile-sheet" role="dialog" aria-modal="true" aria-label={title}>
      <header className="mobile-sheet__bar">
        <button type="button" className="mobile-sheet__back" aria-label="Back" onClick={onClose}>
          <ArrowLeft size={22} aria-hidden="true" />
        </button>
        <h2 className="mobile-sheet__title">{title}</h2>
      </header>
      <div className="mobile-sheet__body">{children}</div>
    </div>
  );
}
