// src/components/ErrorBoundary.tsx
import { Component, type ErrorInfo, type ReactNode } from 'react';

export interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Aegis chrome error boundary caught:', error, info.componentStack);
  }

  // BUG(F28): this used to be `this.setState({ error: null })`, which only re-renders the
  // SAME children from the same props — the identical error therefore re-throws immediately
  // and the user is stuck on the same message. The button says "Reload interface", so it has
  // to actually reload the document. `location.reload()` cannot be stubbed on `window`
  // itself in jsdom (non-configurable), hence the indirection.
  private handleReset = (): void => {
    location.reload();
  };

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="app-error-boundary" role="alert">
          <div className="error-overlay__panel">
            <h1 className="error-overlay__heading">Something went wrong</h1>
            <p className="error-overlay__body">The browser interface hit an unexpected error.</p>
            <pre className="error-overlay__detail">{this.state.error.message}</pre>
            <div className="error-overlay__actions">
              <button type="button" onClick={this.handleReset}>
                Reload interface
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
