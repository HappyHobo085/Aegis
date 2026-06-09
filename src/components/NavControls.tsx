// src/components/NavControls.tsx
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
        &#8592;
      </button>
      <button
        type="button"
        aria-label="Forward"
        disabled={!state.canGoForward}
        onClick={forward}
      >
        &#8594;
      </button>
      <button
        type="button"
        aria-label={state.isLoading ? 'Stop' : 'Reload'}
        onClick={reloadOrStop}
      >
        {state.isLoading ? '✕' : '↻'}
      </button>
      <button type="button" aria-label="Home" onClick={home}>
        &#8962;
      </button>
      {state.isLoading && (
        <span className="loading-indicator" role="status" aria-label="Loading">
          &#8230;
        </span>
      )}
    </div>
  );
}
