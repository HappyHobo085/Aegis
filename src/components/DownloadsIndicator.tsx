// src/components/DownloadsIndicator.tsx
import { Download } from 'lucide-react';

export interface DownloadsIndicatorProps {
  /** Number of downloads currently in the `progressing` state. */
  activeCount: number;
  /** Open the sidebar to the Downloads tab. */
  onOpen(): void;
}

export function DownloadsIndicator({ activeCount, onOpen }: DownloadsIndicatorProps) {
  const label =
    activeCount > 0 ? `Downloads (${activeCount} active)` : 'Downloads';
  return (
    <button
      type="button"
      className="toolbar__downloads"
      aria-label={label}
      title={label}
      onClick={onOpen}
    >
      <Download size={18} aria-hidden="true" />
      {activeCount > 0 && (
        <span className="toolbar__downloads-badge" aria-hidden="true">
          {activeCount}
        </span>
      )}
    </button>
  );
}
