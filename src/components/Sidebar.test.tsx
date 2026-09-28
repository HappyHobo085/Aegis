// src/components/Sidebar.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Sidebar } from './Sidebar';

beforeEach(() => {
  // The width is persisted to localStorage; isolate each test.
  localStorage.clear();
});

function props(overrides: Partial<React.ComponentProps<typeof Sidebar>> = {}) {
  return {
    open: true,
    onClose: vi.fn(),
    history: <div data-testid="history-slot">history</div>,
    saved: <div data-testid="saved-slot">saved</div>,
    ...overrides,
  };
}

describe('Sidebar', () => {
  it('renders nothing when closed (no panel, no scrim, no tabs)', () => {
    const { container } = render(<Sidebar {...props({ open: false })} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId('history-slot')).not.toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
  });

  it('renders the scrim and the right panel when open', () => {
    const { container } = render(<Sidebar {...props()} />);
    expect(container.querySelector('.sidebar__scrim')).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: /sidebar/i })).toHaveClass('sidebar__panel');
  });

  it('clicking the scrim calls onClose', async () => {
    const p = props();
    const { container } = render(<Sidebar {...p} />);
    const scrim = container.querySelector('.sidebar__scrim') as HTMLElement;
    await userEvent.click(scrim);
    expect(p.onClose).toHaveBeenCalledTimes(1);
  });

  it('clicking the close button calls onClose', async () => {
    const p = props();
    render(<Sidebar {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /close sidebar/i }));
    expect(p.onClose).toHaveBeenCalledTimes(1);
  });

  it('pressing Escape while open calls onClose', async () => {
    const p = props();
    render(<Sidebar {...p} />);
    await userEvent.keyboard('{Escape}');
    expect(p.onClose).toHaveBeenCalledTimes(1);
  });

  it('pressing Escape while closed does nothing (no listener attached)', async () => {
    const p = props({ open: false });
    render(<Sidebar {...p} />);
    await userEvent.keyboard('{Escape}');
    expect(p.onClose).not.toHaveBeenCalled();
  });

  it('does NOT render an internal toggle button', () => {
    render(<Sidebar {...props()} />);
    expect(screen.queryByRole('button', { name: /toggle sidebar/i })).not.toBeInTheDocument();
  });

  it('shows the Saved tab panel by default when open', () => {
    render(<Sidebar {...props()} />);
    expect(screen.getByTestId('saved-slot')).toBeInTheDocument();
    expect(screen.queryByTestId('history-slot')).not.toBeInTheDocument();
  });

  it('exposes Saved/History as tabs with correct aria-selected', () => {
    render(<Sidebar {...props()} />);
    expect(screen.getByRole('tab', { name: /saved/i })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /history/i })).toHaveAttribute('aria-selected', 'false');
  });

  it('clicking the Saved tab switches to the saved panel', async () => {
    render(<Sidebar {...props()} />);
    await userEvent.click(screen.getByRole('tab', { name: /saved/i }));
    expect(screen.getByTestId('saved-slot')).toBeInTheDocument();
    expect(screen.queryByTestId('history-slot')).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /saved/i })).toHaveAttribute('aria-selected', 'true');
  });

  it('the open sidebar region is labelled for assistive tech', () => {
    render(<Sidebar {...props()} />);
    expect(screen.getByRole('complementary', { name: /sidebar/i })).toBeInTheDocument();
  });

  it('exposes exactly two tabs (History, Saved) and no Downloads tab', () => {
    render(<Sidebar {...props()} />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(2);
    expect(screen.getByRole('tab', { name: /history/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /saved/i })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /downloads/i })).not.toBeInTheDocument();
  });

  describe('resize', () => {
    const panel = () => screen.getByRole('complementary', { name: /sidebar/i });
    const handle = () => screen.getByRole('separator', { name: /resize sidebar/i });

    it('renders a vertical resize separator and opens at the default width', () => {
      render(<Sidebar {...props()} />);
      expect(handle()).toHaveAttribute('aria-orientation', 'vertical');
      expect(panel()).toHaveStyle({ width: '320px' });
      expect(handle()).toHaveAttribute('aria-valuenow', '320');
    });

    it('ArrowLeft widens and ArrowRight narrows the sidebar', async () => {
      render(<Sidebar {...props()} />);
      handle().focus();
      await userEvent.keyboard('{ArrowLeft}');
      expect(panel()).toHaveStyle({ width: '344px' });
      await userEvent.keyboard('{ArrowRight}{ArrowRight}');
      expect(panel()).toHaveStyle({ width: '296px' });
    });

    it('clamps to the minimum width when narrowed past it', async () => {
      render(<Sidebar {...props()} />);
      handle().focus();
      for (let i = 0; i < 10; i++) await userEvent.keyboard('{ArrowRight}');
      expect(panel()).toHaveStyle({ width: '240px' });
    });

    it('remembers the width across re-opens via localStorage', () => {
      localStorage.setItem('aegis.sidebarWidth', '420');
      render(<Sidebar {...props()} />);
      expect(panel()).toHaveStyle({ width: '420px' });
    });

    it('persists a resized width to localStorage', async () => {
      render(<Sidebar {...props()} />);
      handle().focus();
      await userEvent.keyboard('{ArrowLeft}');
      expect(localStorage.getItem('aegis.sidebarWidth')).toBe('344');
    });

    it('End snaps to the minimum and Home to the widest the window allows', async () => {
      render(<Sidebar {...props()} />);
      handle().focus();
      await userEvent.keyboard('{End}');
      expect(panel()).toHaveStyle({ width: '240px' });
      await userEvent.keyboard('{Home}');
      // Read the bound off the separator rather than hard-coding it: `maxWidth()` is
      // derived from `window.innerWidth`, so the number is the window's, not ours.
      const widest = Number(handle().getAttribute('aria-valuemax'));
      expect(widest).toBeGreaterThan(240);
      expect(panel()).toHaveStyle({ width: `${widest}px` });
      expect(handle()).toHaveAttribute('aria-valuenow', String(widest));
    });

    it('falls back to the default width when localStorage is unavailable', () => {
      // Real, not exotic: storage is denied in some private-browsing modes and when
      // cookies are blocked, and `readStoredWidth` has a `catch` for exactly that. The
      // write path has its own `try`, so a throwing read must not break the panel.
      const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new DOMException('denied', 'SecurityError');
      });
      try {
        render(<Sidebar {...props()} />);
        expect(panel()).toHaveStyle({ width: '320px' });
        expect(handle()).toHaveAttribute('aria-valuenow', '320');
      } finally {
        getItem.mockRestore();
      }
    });
  });
});

// The pointer drag and the rAF coalescing it feeds were entirely unexercised: the
// keyboard tests reach the `immediate` branch of `reportWidth` only, so the queued
// path, the pointer handlers, and the unmount cancel had zero coverage.
describe('Sidebar pointer resize', () => {
  const panel = () => screen.getByRole('complementary', { name: /sidebar/i });
  const handle = () => screen.getByRole('separator', { name: /resize sidebar/i });

  // jsdom implements NEITHER `PointerEvent` NOR the pointer-capture API. Both gaps
  // have to be filled here, and each is silent if you miss it:
  //  - `fireEvent.pointerDown(el, { pointerId })` DROPS the init, because there is no
  //    `PointerEvent` constructor for it to build, so React reads `pointerId` as
  //    `undefined`. The event is built here and the pointer fields put on it directly.
  //  - `setPointerCapture` / `hasPointerCapture` / `releasePointerCapture` are all
  //    `undefined` on a real element, and the component calls them unconditionally.
  //    `hasPointerCapture` answers true only while a capture is held, which is what
  //    `endDrag` asks before releasing it.
  function firePointer(el: HTMLElement, type: string, init: Record<string, unknown>): void {
    const ev = new Event(type, { bubbles: true, cancelable: true });
    for (const [k, v] of Object.entries(init)) {
      Object.defineProperty(ev, k, { value: v, configurable: true });
    }
    fireEvent(el, ev);
  }

  function stubPointerCapture(el: HTMLElement, log: string[]): void {
    let held: number | null = null;
    (el as unknown as Record<string, unknown>).setPointerCapture = (id: number) => {
      log.push(`capture:${id}`);
      held = id;
    };
    (el as unknown as Record<string, unknown>).hasPointerCapture = (id: number) => {
      log.push(`has:${id}`);
      return held === id;
    };
    (el as unknown as Record<string, unknown>).releasePointerCapture = (id: number) => {
      log.push(`release:${id}`);
      if (held === id) held = null;
    };
  }

  // jsdom's rAF is a real ~16 ms timer, so a drag has to actually let a frame elapse
  // for the coalesced report to fire.
  const nextFrame = (): Promise<void> =>
    act(async () => {
      await new Promise((r) => setTimeout(r, 40));
    });

  // `reportWidth` runs on mount with `immediate = true`, so the prop has already been
  // called once by the time a test body starts. Every assertion below is therefore a
  // DELTA against this baseline, never an absolute count.
  const mounted = (onWidthChange: ReturnType<typeof vi.fn>): number =>
    onWidthChange.mock.calls.length;

  it('a drag resizes the panel, coalescing the width report through a frame', async () => {
    const onWidthChange = vi.fn();
    render(<Sidebar {...props({ onWidthChange })} />);
    const log: string[] = [];
    stubPointerCapture(handle(), log);
    const base = mounted(onWidthChange);

    firePointer(handle(), 'pointerdown', { pointerId: 7 });
    // `dragging` is observable as the modifier class, which is what switches
    // `reportWidth` from the immediate branch to the queued one.
    expect(panel().className).toContain('sidebar__panel--dragging');
    expect(log).toContain('capture:7');

    // The panel is anchored to the right edge, so its width is the gap from the
    // pointer to the right edge of the window.
    firePointer(handle(), 'pointermove', {
      pointerId: 7,
      clientX: window.innerWidth - 500,
    });
    expect(panel()).toHaveStyle({ width: '500px' });
    firePointer(handle(), 'pointermove', {
      pointerId: 7,
      clientX: window.innerWidth - 520,
    });
    expect(panel()).toHaveStyle({ width: '520px' });
    // While dragging the report is COALESCED, so no per-pixel report is made.
    expect(mounted(onWidthChange)).toBe(base);

    await nextFrame();
    expect(onWidthChange).toHaveBeenCalledTimes(base + 1);
    expect(onWidthChange).toHaveBeenLastCalledWith(520);

    firePointer(handle(), 'pointerup', { pointerId: 7 });
    expect(panel().className).not.toContain('sidebar__panel--dragging');
    expect(log).toContain('release:7');
    expect(localStorage.getItem('aegis.sidebarWidth')).toBe('520');
  });

  it('the settled width is reported immediately, cancelling a frame still queued by the drag', async () => {
    const onWidthChange = vi.fn();
    render(<Sidebar {...props({ onWidthChange })} />);
    stubPointerCapture(handle(), []);
    const base = mounted(onWidthChange);
    firePointer(handle(), 'pointerdown', { pointerId: 1 });
    firePointer(handle(), 'pointermove', { pointerId: 1, clientX: window.innerWidth - 400 });
    // Ending the drag before the frame lands must still report, and must cancel the
    // frame rather than let it fire a second, stale width afterwards.
    firePointer(handle(), 'pointerup', { pointerId: 1 });
    expect(onWidthChange).toHaveBeenLastCalledWith(400);
    expect(mounted(onWidthChange)).toBe(base + 1);
    await nextFrame();
    expect(mounted(onWidthChange)).toBe(base + 1);
  });

  it('a pointer move with no drag in flight is ignored', () => {
    render(<Sidebar {...props()} />);
    firePointer(handle(), 'pointermove', { pointerId: 1, clientX: window.innerWidth - 999 });
    expect(panel()).toHaveStyle({ width: '320px' });
    expect(panel().className).not.toContain('sidebar__panel--dragging');
  });

  it('a drag in flight at unmount reports nothing, because the queued frame is cancelled', async () => {
    const onWidthChange = vi.fn();
    const { unmount } = render(<Sidebar {...props({ onWidthChange })} />);
    stubPointerCapture(handle(), []);
    const base = mounted(onWidthChange);
    firePointer(handle(), 'pointerdown', { pointerId: 1 });
    firePointer(handle(), 'pointermove', { pointerId: 1, clientX: window.innerWidth - 450 });
    expect(mounted(onWidthChange)).toBe(base);
    unmount();
    await nextFrame();
    // The frame was queued but never ran. Tearing the app down must not resurrect it:
    // it would call a callback owned by a component that no longer exists.
    expect(mounted(onWidthChange)).toBe(base);
    expect(onWidthChange).not.toHaveBeenCalledWith(450);
  });
});
