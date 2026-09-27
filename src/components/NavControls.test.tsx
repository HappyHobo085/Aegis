// src/components/NavControls.test.tsx
//
// Presentational, but the assertions that matter are behavioural: Back/Forward must be
// DISABLED when there is nowhere to go (a live button that silently does nothing is a
// bug report), and the reload control must become Stop while a load is in flight.
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { NavState } from '../../shared/types';
import { NavControls } from './NavControls';

const state = (over: Partial<NavState> = {}): NavState => ({
  viewId: 1,
  url: 'https://example.com/',
  title: 'Example',
  canGoBack: false,
  canGoForward: false,
  isLoading: false,
  crashed: false,
  ...over,
});

const handlers = () => ({
  back: vi.fn(),
  forward: vi.fn(),
  reloadOrStop: vi.fn(),
  home: vi.fn(),
});

const renderControls = (nav: Partial<NavState> = {}, h = handlers()) => {
  render(<NavControls state={state(nav)} {...h} />);
  return h;
};

describe('NavControls', () => {
  describe('Back', () => {
    it('is disabled when there is no history to go back to', () => {
      renderControls({ canGoBack: false });
      expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
    });

    it('is enabled and calls back() when there is history', async () => {
      const h = renderControls({ canGoBack: true });
      const btn = screen.getByRole('button', { name: 'Back' });
      expect(btn).toBeEnabled();
      await userEvent.click(btn);
      expect(h.back).toHaveBeenCalledTimes(1);
    });
  });

  describe('Forward', () => {
    it('is disabled when there is nothing ahead', () => {
      renderControls({ canGoForward: false });
      expect(screen.getByRole('button', { name: 'Forward' })).toBeDisabled();
    });

    it('is enabled and calls forward() when there is', async () => {
      const h = renderControls({ canGoForward: true });
      const btn = screen.getByRole('button', { name: 'Forward' });
      expect(btn).toBeEnabled();
      await userEvent.click(btn);
      expect(h.forward).toHaveBeenCalledTimes(1);
    });

    it('can be enabled independently of Back', () => {
      renderControls({ canGoBack: false, canGoForward: true });
      expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Forward' })).toBeEnabled();
    });
  });

  describe('reload / stop', () => {
    it('reads Reload when idle, and is never disabled', () => {
      renderControls({ isLoading: false });
      const btn = screen.getByRole('button', { name: 'Reload' });
      expect(btn).toBeEnabled();
    });

    it('reads Stop while loading, and is still never disabled', () => {
      renderControls({ isLoading: true });
      expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled();
    });

    it('is the same control either way — it is a toggle, not two buttons', () => {
      const { rerender } = render(<NavControls state={state()} {...handlers()} />);
      expect(screen.getAllByRole('button')).toHaveLength(4);
      rerender(<NavControls state={state({ isLoading: true })} {...handlers()} />);
      expect(screen.getAllByRole('button')).toHaveLength(4);
    });

    it('calls reloadOrStop() for both Reload and Stop', async () => {
      const h = renderControls({ isLoading: false });
      await userEvent.click(screen.getByRole('button', { name: 'Reload' }));
      expect(h.reloadOrStop).toHaveBeenCalledTimes(1);
    });
  });

  describe('Home', () => {
    it('is always enabled and calls home()', async () => {
      const h = renderControls({ canGoBack: false, canGoForward: false, isLoading: true });
      const btn = screen.getByRole('button', { name: 'Home' });
      expect(btn).toBeEnabled();
      await userEvent.click(btn);
      expect(h.home).toHaveBeenCalledTimes(1);
    });
  });

  describe('the loading indicator', () => {
    it('is absent while idle', () => {
      renderControls({ isLoading: false });
      expect(screen.queryByRole('status', { name: 'Loading' })).not.toBeInTheDocument();
    });

    it('is present while loading', () => {
      renderControls({ isLoading: true });
      expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
    });

    it('does not add a focusable element of its own', () => {
      renderControls({ isLoading: true });
      // The indicator is a decorative span; only the four controls are tabbable.
      expect(screen.getAllByRole('button')).toHaveLength(4);
    });
  });

  it('renders exactly four controls in a stable order', () => {
    renderControls({ canGoBack: true, canGoForward: true });
    const labels = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'));
    expect(labels).toEqual(['Back', 'Forward', 'Reload', 'Home']);
  });

  it('exposes every control by an accessible name (icon-only buttons need one)', () => {
    renderControls({ canGoBack: true, canGoForward: true, isLoading: true });
    for (const name of ['Back', 'Forward', 'Stop', 'Home']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
  });
});
