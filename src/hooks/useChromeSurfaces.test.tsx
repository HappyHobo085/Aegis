import { describe, it, expect } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import {
  ChromeSurfaceProvider,
  useChromeSurface,
  useChromeSurfaceRegistry,
} from './useChromeSurfaces';

function CountProbe() {
  const { openSurfaces } = useChromeSurfaceRegistry();
  return <span data-testid="count">{openSurfaces.size}</span>;
}

function Surface({ id, active }: { id: string; active: boolean }) {
  useChromeSurface(id, active);
  return null;
}

function wrap(ui: ReactNode) {
  return render(<ChromeSurfaceProvider>{ui}</ChromeSurfaceProvider>);
}

describe('chrome surface registry', () => {
  it('registers an active surface and unregisters when it goes inactive', () => {
    const { rerender } = wrap(
      <>
        <CountProbe />
        <Surface id="settings" active={true} />
      </>,
    );
    expect(screen.getByTestId('count').textContent).toBe('1');

    act(() => {
      rerender(
        <ChromeSurfaceProvider>
          <CountProbe />
          <Surface id="settings" active={false} />
        </ChromeSurfaceProvider>,
      );
    });
    expect(screen.getByTestId('count').textContent).toBe('0');
  });

  it('counts distinct surfaces and dedupes a repeated id', () => {
    wrap(
      <>
        <CountProbe />
        <Surface id="settings" active={true} />
        <Surface id="downloads" active={true} />
        <Surface id="settings" active={true} />
      </>,
    );
    expect(screen.getByTestId('count').textContent).toBe('2');
  });

  it('a brand-new surface participates with NO change to any central list', () => {
    // The whole point: adding a never-before-seen id just works.
    wrap(
      <>
        <CountProbe />
        <Surface id="some-future-overlay" active={true} />
      </>,
    );
    expect(screen.getByTestId('count').textContent).toBe('1');
  });

  it('useChromeSurfaceRegistry throws outside the provider', () => {
    expect(() => render(<CountProbe />)).toThrow(/ChromeSurfaceProvider/);
  });

  it('useChromeSurface is a no-op (does not throw) with no provider', () => {
    expect(() => render(<Surface id="x" active={true} />)).not.toThrow();
  });
});
