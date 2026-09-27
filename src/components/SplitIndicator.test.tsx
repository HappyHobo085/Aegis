// src/components/SplitIndicator.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SplitLayout } from '../../shared/types';
import { SplitIndicator } from './SplitIndicator';

const layout = (panes: number): SplitLayout => ({
  panes: Array.from({ length: panes }, (_, i) => ({
    tabId: i + 1,
    x: 0,
    y: 0,
    width: 400,
    height: 600,
  })) as SplitLayout['panes'],
  focusedPaneId: 1,
});

const renderIndicator = (panes: number, onExit = vi.fn()) => {
  render(<SplitIndicator layout={layout(panes)} onExit={onExit} />);
  return onExit;
};

describe('SplitIndicator', () => {
  describe('the pane-count label', () => {
    it.each([2, 3, 4])('renders the short label for %i panes', (n) => {
      renderIndicator(n);
      expect(screen.getByText(`${n}-pane split`)).toBeInTheDocument();
    });

    // Past 4 there is no short form, so the count must still be shown rather than
    // silently reporting a wrong number.
    it.each([1, 5, 8])('falls back to a plain count for %i panes', (n) => {
      renderIndicator(n);
      expect(screen.getByText(`${n}-pane split`)).toBeInTheDocument();
    });

    it('is exposed as the status’s accessible name, not just visible text', () => {
      renderIndicator(3);
      expect(screen.getByRole('status', { name: '3-pane split' })).toBeInTheDocument();
    });

    it('does not report a stale count when the layout changes', () => {
      const { rerender } = render(<SplitIndicator layout={layout(2)} onExit={vi.fn()} />);
      expect(screen.getByRole('status', { name: '2-pane split' })).toBeInTheDocument();
      rerender(<SplitIndicator layout={layout(3)} onExit={vi.fn()} />);
      expect(screen.getByRole('status', { name: '3-pane split' })).toBeInTheDocument();
      expect(screen.queryByRole('status', { name: '2-pane split' })).not.toBeInTheDocument();
    });
  });

  describe('the exit control', () => {
    it('calls onExit when clicked', async () => {
      const onExit = renderIndicator(2);
      await userEvent.click(screen.getByRole('button', { name: 'Exit split view' }));
      expect(onExit).toHaveBeenCalledTimes(1);
    });

    it('advertises the keyboard shortcut in its title', () => {
      renderIndicator(2);
      expect(screen.getByRole('button', { name: 'Exit split view' })).toHaveAttribute(
        'title',
        expect.stringContaining('Ctrl+Shift+S'),
      );
    });

    it('is a real button, so it is reachable and activatable by keyboard', async () => {
      const onExit = renderIndicator(2);
      const btn = screen.getByRole('button', { name: 'Exit split view' });
      expect(btn.tagName).toBe('BUTTON');
      btn.focus();
      expect(btn).toHaveFocus();
      await userEvent.keyboard('{Enter}');
      expect(onExit).toHaveBeenCalledTimes(1);
    });

    it('is the only focusable element, so the toolbar has no stray tab stop', () => {
      renderIndicator(2);
      expect(screen.getAllByRole('button')).toHaveLength(1);
    });
  });

  it('hides the icon from assistive tech (the label already says it)', () => {
    const { container } = render(<SplitIndicator layout={layout(2)} onExit={vi.fn()} />);
    expect(container.querySelector('.split-indicator__icon')).toHaveAttribute(
      'aria-hidden',
      'true',
    );
  });
});
