// src/components/ZoomIndicator.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ZoomIndicator } from './ZoomIndicator';

const props = (factor = 1.25) => ({
  factor,
  zoomIn: vi.fn(),
  zoomOut: vi.fn(),
  reset: vi.fn(),
});

describe('ZoomIndicator', () => {
  it('renders the label button with the formatted zoom percent', () => {
    render(<ZoomIndicator {...props(1.25)} />);
    expect(screen.getByRole('button', { name: /page zoom/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /page zoom/i })).toHaveTextContent('125%');
  });

  it('is always visible — renders even at 100% (factor=1.0)', () => {
    render(<ZoomIndicator {...props(1.0)} />);
    expect(screen.getByRole('button', { name: /page zoom/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /page zoom/i })).toHaveTextContent('100%');
  });

  it('formats 0.5 as 50%', () => {
    render(<ZoomIndicator {...props(0.5)} />);
    expect(screen.getByRole('button', { name: /page zoom/i })).toHaveTextContent('50%');
  });

  it('formats 2.0 as 200%', () => {
    render(<ZoomIndicator {...props(2.0)} />);
    expect(screen.getByRole('button', { name: /page zoom/i })).toHaveTextContent('200%');
  });

  it('popover is closed by default (aria-expanded=false)', () => {
    render(<ZoomIndicator {...props()} />);
    expect(screen.getByRole('button', { name: /page zoom/i })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens the popover when the label button is clicked', async () => {
    render(<ZoomIndicator {...props()} />);
    await userEvent.click(screen.getByRole('button', { name: /page zoom/i }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /page zoom/i })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('shows zoom-out, zoom-in and reset-zoom buttons inside the popover', async () => {
    render(<ZoomIndicator {...props()} />);
    await userEvent.click(screen.getByRole('button', { name: /page zoom/i }));
    expect(screen.getByRole('button', { name: /zoom out/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /zoom in/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reset zoom/i })).toBeInTheDocument();
  });

  it('shows the current zoom percent inside the popover', async () => {
    render(<ZoomIndicator {...props(1.5)} />);
    await userEvent.click(screen.getByRole('button', { name: /page zoom/i }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('150%');
  });

  it('calls zoomOut when the zoom-out button is clicked', async () => {
    const p = props();
    render(<ZoomIndicator {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /page zoom/i }));
    await userEvent.click(screen.getByRole('button', { name: /zoom out/i }));
    expect(p.zoomOut).toHaveBeenCalledTimes(1);
  });

  it('calls zoomIn when the zoom-in button is clicked', async () => {
    const p = props();
    render(<ZoomIndicator {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /page zoom/i }));
    await userEvent.click(screen.getByRole('button', { name: /zoom in/i }));
    expect(p.zoomIn).toHaveBeenCalledTimes(1);
  });

  it('calls reset when the reset-zoom button is clicked', async () => {
    const p = props();
    render(<ZoomIndicator {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /page zoom/i }));
    await userEvent.click(screen.getByRole('button', { name: /reset zoom/i }));
    expect(p.reset).toHaveBeenCalledTimes(1);
  });

  it('toggles the popover closed when the label button is clicked again', async () => {
    render(<ZoomIndicator {...props()} />);
    const btn = screen.getByRole('button', { name: /page zoom/i });
    await userEvent.click(btn);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await userEvent.click(btn);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes the popover when Escape is pressed', async () => {
    render(<ZoomIndicator {...props()} />);
    await userEvent.click(screen.getByRole('button', { name: /page zoom/i }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes the popover on outside pointer-down (pointerdown on document.body)', async () => {
    render(<ZoomIndicator {...props()} />);
    await userEvent.click(screen.getByRole('button', { name: /page zoom/i }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('ZoomIndicator — picks reported by the popover surface', () => {
  /** Deliver `popover.picked` the way the backend would.
   *
   *  `aegis` here is the REAL client (this file never module-mocks it), so the handler is the
   *  one the real `onPicked` handed to `listen`. Going through the transport rather than through
   *  a mocked hook is what makes this a test of the wiring. */
  function emitPick(pick: unknown): void {
    const hit = vi.mocked(listen).mock.calls.find(([n]) => n === 'popover:picked');
    expect(hit, 'the chrome must subscribe to popover.picked').toBeTruthy();
    hit![1]({ payload: pick } as never);
  }

  beforeEach(() => {
    vi.mocked(listen).mockClear();
  });

  it('steps the zoom from the chrome’s OWN factor, never from anything on the payload', async () => {
    const p = props(1.5);
    render(<ZoomIndicator {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /page zoom/i }));
    emitPick({ id: 'zoom-indicator', action: 'zoom-in' });
    emitPick({ id: 'zoom-indicator', action: 'zoom-out' });
    emitPick({ id: 'zoom-indicator', action: 'reset' });
    expect(p.zoomIn).toHaveBeenCalledTimes(1);
    expect(p.zoomOut).toHaveBeenCalledTimes(1);
    expect(p.reset).toHaveBeenCalledTimes(1);
  });

  // One surface serves all four popovers, so the id filter is load-bearing: without it a zoom
  // pick would fire while the shield popover is open.
  it('ignores a pick addressed to a DIFFERENT popover', async () => {
    const p = props(1.5);
    render(<ZoomIndicator {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /page zoom/i }));
    emitPick({ id: 'adblock-shield', action: 'reset' });
    expect(p.reset).not.toHaveBeenCalled();
  });

  it('ignores an action name it does not know', async () => {
    const p = props(1.5);
    render(<ZoomIndicator {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /page zoom/i }));
    emitPick({ id: 'zoom-indicator', action: 'obliterate' });
    expect(p.zoomIn).not.toHaveBeenCalled();
    expect(p.reset).not.toHaveBeenCalled();
  });

  it('places itself on the surface instead of insetting the page', async () => {
    render(<ZoomIndicator {...props(1.5)} />);
    await userEvent.click(screen.getByRole('button', { name: /page zoom/i }));
    const sets = vi
      .mocked(invoke)
      .mock.calls.map(([, a]) => a as { channel?: string; payload?: { id?: string } })
      .filter((a) => a.channel === 'popover.set');
    expect(sets.at(-1)?.payload?.id).toBe('zoom-indicator');
    // …and never touches the channel that moved the page.
    expect(
      vi.mocked(invoke).mock.calls.map(([, a]) => (a as { channel?: string }).channel),
    ).not.toContain('view.setContentInset');
  });
});
