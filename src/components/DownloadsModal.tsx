// src/components/DownloadsModal.tsx
import { useId } from 'react';
import { X } from 'lucide-react';
import { useDialog } from '../hooks/useDialog';
import { DownloadsPanel } from './DownloadsPanel';
import type { DownloadsPanelProps } from './DownloadsPanel';

export interface DownloadsModalProps extends DownloadsPanelProps {
  onClose(): void;
}

export function DownloadsModal({ onClose, ...panel }: DownloadsModalProps) {
  const titleId = useId();
  const dialogRef = useDialog<HTMLDivElement>(onClose);

  return (
    <div className="downloads-modal__scrim">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="downloads-modal"
      >
        <div className="downloads-modal__header">
          <h2 id={titleId} className="downloads-modal__title">
            Downloads
          </h2>
          <button
            type="button"
            className="downloads-modal__close"
            aria-label="Close"
            title="Close"
            onClick={onClose}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <div className="downloads-modal__body">
          <DownloadsPanel {...panel} />
        </div>
      </div>
    </div>
  );
}
