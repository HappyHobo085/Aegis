// src/components/SplitIndicator.tsx
import { memo } from 'react';
import { Columns2, X } from 'lucide-react';
import type { SplitLayout } from '../../shared/types';

export interface SplitIndicatorProps {
  layout: SplitLayout;
  onExit(): void;
}

/** Maps pane count to a human-readable label. */
function paneLabel(count: number): string {
  if (count === 2) return '2-pane split';
  if (count === 3) return '3-pane split';
  if (count === 4) return '4-pane split';
  return `${count}-pane split`;
}

/**
 * A compact badge shown in the toolbar when split view is active.
 * Displays the pane count and an exit button. Glass-morphism styling
 * uses the existing theme tokens from index.css.
 */
export const SplitIndicator = memo(function SplitIndicator({
  layout,
  onExit,
}: SplitIndicatorProps) {
  return (
    <span className="split-indicator" role="status" aria-label={paneLabel(layout.panes.length)}>
      <Columns2 size={14} aria-hidden="true" className="split-indicator__icon" />
      <span className="split-indicator__label">{paneLabel(layout.panes.length)}</span>
      <button
        type="button"
        className="split-indicator__exit"
        aria-label="Exit split view"
        title="Exit split view (Ctrl+Shift+S)"
        onClick={onExit}
      >
        <X size={12} aria-hidden="true" />
      </button>
    </span>
  );
});
