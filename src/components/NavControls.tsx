// src/components/NavControls.tsx
import { ArrowLeft, ArrowRight, RotateCw, X, House } from 'lucide-react';
import type { NavState } from '../../shared/types';

export interface NavControlsProps {
  state: NavState;
  back(): void;
  forward(): void;
  reloadOrStop(): void;
  home(): void;
}

export function NavControls({ state, back, forward, reloadOrStop, home }: NavControlsProps) {
  return (
    <div className="nav-controls">
      <button type="button" aria-label="Back" disabled={!state.canGoBack} onClick={back}>
        <ArrowLeft size={18} aria-hidden="true" />
      </button>
      <button
        type="button"
        aria-label="Forward"
        disabled={!state.canGoForward}
        onClick={forward}
      >
        <ArrowRight size={18} aria-hidden="true" />
      </button>
      <button
        type="button"
        aria-label={state.isLoading ? 'Stop' : 'Reload'}
        onClick={reloadOrStop}
      >
        {state.isLoading ? (
          <X size={18} aria-hidden="true" />
        ) : (
          <RotateCw size={18} aria-hidden="true" />
        )}
      </button>
      <button type="button" aria-label="Home" onClick={home}>
        <House size={18} aria-hidden="true" />
      </button>
      {state.isLoading && (
        <span className="loading-indicator" role="status" aria-label="Loading">
          &#8230;
        </span>
      )}
    </div>
  );
}
