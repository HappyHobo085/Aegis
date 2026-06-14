// src/components/UpdateIndicator.tsx
import { RefreshCw } from 'lucide-react';
import type { UpdateState } from '../../shared/types';

export interface UpdateIndicatorProps {
  state: UpdateState;
  /** Quit and install the downloaded update. */
  onRestart(): void;
}

export function UpdateIndicator({ state, onRestart }: UpdateIndicatorProps) {
  // Show once an update is ready to act on: "available" (click to install — on
  // desktop downloads+restarts, on Android opens the releases page) or "downloaded"
  // (desktop, click to restart into it).
  if (state.status !== 'available' && state.status !== 'downloaded') {
    return null;
  }
  const ver = state.version ? ` ${state.version}` : '';
  const label =
    state.status === 'downloaded' ? `Restart to update${ver}` : `Update available${ver} — install`;
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
