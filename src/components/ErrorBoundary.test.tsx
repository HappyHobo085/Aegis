// src/components/ErrorBoundary.test.tsx
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { ErrorBoundary } from './ErrorBoundary';

function Boom(): React.ReactNode {
  throw new Error('kaboom');
}

describe('ErrorBoundary', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    errSpy.mockRestore();
  });

  it('renders children when no error is thrown', () => {
    render(
      <ErrorBoundary>
        <div>healthy</div>
      </ErrorBoundary>,
    );
    expect(screen.getByText('healthy')).toBeInTheDocument();
  });

  it('renders a fallback instead of a blank screen when a child throws', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
  });

  // BUG(F28): the button used to call `setState({error: null})`, which re-renders the very
  // same children and re-throws the very same error. A real `location.reload()` is the only
  // thing that can clear a crashed chrome.
  describe('"Reload interface"', () => {
    let reload: ReturnType<typeof vi.fn>;
    let originalLocation: Location;

    beforeEach(() => {
      reload = vi.fn();
      // `location.reload` is non-writable on the real `window.location`, so swap the whole
      // object out for a stub that keeps the href/assign/replace surface.
      originalLocation = window.location;
      Object.defineProperty(window, 'location', {
        configurable: true,
        writable: true,
        value: {
          href: originalLocation.href,
          origin: originalLocation.origin,
          reload,
          assign: vi.fn(),
          replace: vi.fn(),
        } as unknown as Location,
      });
    });

    afterEach(() => {
      Object.defineProperty(window, 'location', {
        configurable: true,
        writable: true,
        value: originalLocation,
      });
    });

    it('performs a REAL document reload, not just a state reset', () => {
      render(
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>,
      );
      fireEvent.click(screen.getByRole('button', { name: /reload interface/i }));
      expect(reload).toHaveBeenCalledTimes(1);
    });
  });
});
