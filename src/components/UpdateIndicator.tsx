// src/components/UpdateIndicator.tsx
import { RefreshCw } from 'lucide-react';
import type { UpdateState } from '../../shared/types';

export interface UpdateIndicatorProps {
  state: UpdateState;
  /** Quit and install the downloaded update. */
  onRestart(): void;
}

export function UpdateIndicator({ state, onRestart }: UpdateIndicatorProps) {
  if (state.status !== 'downloaded') {
    return null;
  }
  const label = state.version ? `Restart to update to ${state.version}` : 'Restart to update';
  return (
    <button
      type="button"
      className="toolbar__update"
      aria-label={label}
      title={label}
      onClick={onRestart}
    >
      <RefreshCw size={18} aria-hidden="true" />
    </button>
  );
}
