import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { TabStrip } from './TabStrip';
import type { TabMeta } from '../../shared/types';

const tabs: TabMeta[] = [
  {
    id: 1,
    pinned: false,
    live: true,
    title: 'Alpha',
    url: 'https://alpha.test/',
    private: false,
    workspaceId: 'default',
  },
  {
    id: 2,
    pinned: false,
    live: false,
    title: 'Beta',
    url: 'https://beta.test/',
    private: false,
    workspaceId: 'default',
  },
];

/** The callback props the helpers assert on, as spies rather than plain functions. */
type TabStripSpies = Record<
  'onActivate' | 'onClose' | 'onCreate' | 'onCreatePrivate' | 'onReorder' | 'onSetPinned',
  ReturnType<typeof vi.fn>
>;

function setup(over: Partial<React.ComponentProps<typeof TabStrip>> = {}) {
  const props = {
    tabs,
    activeId: 1,
    onActivate: vi.fn(),
    onClose: vi.fn(),
    onCreate: vi.fn(),
    onCreatePrivate: vi.fn(),
    onReorder: vi.fn(),
    onSetPinned: vi.fn(),
    ...over,
    // The `...over` spread widens each spy into `Mock | ((id) => void)`, which hides
    // `mockClear`/`mockReset` behind the plain-function half of the union — a test that
    // clears a spy between two events then fails to COMPILE rather than to assert.
    // Every member of `props` is built here as a spy, so say so.
  } as React.ComponentProps<typeof TabStrip> & TabStripSpies;
  render(<TabStrip {...props} />);
  return props;
}

describe('TabStrip', () => {
  it('renders a tab per entry with its title', () => {
    setup();
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
  });

  it('marks the active tab and dims an asleep (discarded) tab', () => {
    setup();
    expect(screen.getByRole('tab', { name: /Alpha/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /Beta/ })).toHaveClass('tab--asleep');
  });

  it('activates on click and closes on the close button', () => {
    const p = setup();
    fireEvent.click(screen.getByRole('tab', { name: /Beta/ }));
    expect(p.onActivate).toHaveBeenCalledWith(2);
    fireEvent.click(screen.getByRole('button', { name: /close Beta/i }));
    expect(p.onClose).toHaveBeenCalledWith(2);
  });

  it('creates a tab via the new-tab button', () => {
    const p = setup();
    fireEvent.click(screen.getByRole('button', { name: /^new tab$/i }));
    expect(p.onCreate).toHaveBeenCalled();
  });

  it('calls onCreatePrivate via the new-private-tab button', () => {
    const p = setup();
    fireEvent.click(screen.getByRole('button', { name: /new private tab/i }));
    expect(p.onCreatePrivate).toHaveBeenCalled();
  });

  it('applies tab--private class and EyeOff icon for private tabs', () => {
    const privateTabs: TabMeta[] = [
      {
        id: 1,
        pinned: false,
        live: true,
        title: 'Secret',
        url: 'https://secret.test/',
        private: true,
        workspaceId: 'default',
      },
    ];
    setup({ tabs: privateTabs });
    expect(screen.getByRole('tab', { name: /Secret/ })).toHaveClass('tab--private');
    // The EyeOff icon renders instead of Globe; it has aria-hidden so query by its container class
    expect(screen.getByRole('tab', { name: /Secret/ }).querySelector('svg')).toBeTruthy();
  });

  it('does not apply tab--private class for normal tabs', () => {
    setup();
    expect(screen.getByRole('tab', { name: /Alpha/ })).not.toHaveClass('tab--private');
  });

  it('activates with Enter/Space and closes with Delete (keyboard)', () => {
    const p = setup();
    const beta = screen.getByRole('tab', { name: /Beta/ });
    fireEvent.keyDown(beta, { key: 'Enter' });
    expect(p.onActivate).toHaveBeenCalledWith(2);
    fireEvent.keyDown(beta, { key: ' ' });
    expect(p.onActivate).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(beta, { key: 'Delete' });
    expect(p.onClose).toHaveBeenCalledWith(2);
  });

  it('moves focus between tabs with Arrow keys (roving tabindex)', () => {
    setup();
    const alpha = screen.getByRole('tab', { name: /Alpha/ });
    alpha.focus();
    fireEvent.keyDown(alpha, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: /Beta/ })).toHaveFocus();
  });

  it('does not close a pinned tab via Delete', () => {
    const pinned: TabMeta[] = [
      {
        id: 1,
        pinned: true,
        live: true,
        title: 'Pin',
        url: 'https://pin.test/',
        private: false,
        workspaceId: 'default',
      },
    ];
    const p = setup({ tabs: pinned, activeId: 1 });
    fireEvent.keyDown(screen.getByRole('tab', { name: /Pin/ }), { key: 'Delete' });
    expect(p.onClose).not.toHaveBeenCalled();
  });
});

// The virtualization window and the drag-and-drop block below were entirely uncovered:
// no test ever opened more than VIRTUALIZATION_THRESHOLD (50) tabs, so the whole
// `isVirtualized` branch and its padding spacers had never executed.
describe('TabStrip virtualization and drag-and-drop', () => {
  function manyTabs(n: number): TabMeta[] {
    return Array.from({ length: n }, (_, i) => ({
      id: i + 1,
      pinned: false,
      live: true,
      title: `T${i + 1}`,
      url: `https://t${i + 1}.test/`,
      private: false,
      workspaceId: 'default',
    }));
  }

  const renderedTabIds = () => screen.getAllByRole('tab').map((el) => el.textContent ?? '');

  it('renders only a window of tabs once past the virtualization threshold', () => {
    // PRECONDITION: the fixture is genuinely over the threshold, and the strip is
    // really the virtualizing branch — otherwise "tab 60 is absent" would be
    // vacuously true because it was never in the fixture.
    const many = manyTabs(60);
    expect(many.length).toBeGreaterThan(50);
    setup({ tabs: many, activeId: 1 });

    // The first tabs are in the initial window...
    expect(screen.getByRole('tab', { name: /T1\b/ })).toBeInTheDocument();
    // ...and a tab far past the 800px fallback viewport is NOT in the DOM at all.
    expect(screen.queryByRole('tab', { name: /T60\b/ })).toBeNull();
    // 6 visible (800px / 142px) + 3 overscan on the trailing side = 9 of 60.
    expect(screen.getAllByRole('tab')).toHaveLength(9);
  });

  it('the window follows the strip scroll position', async () => {
    const many = manyTabs(60);
    setup({ tabs: many, activeId: 1 });
    // The window is derived from scrollLeft through a rAF-debounced handler, so
    // without advancing a frame the strip must NOT have moved yet.
    const strip = screen.getByRole('tablist');
    const before = renderedTabIds();
    // TWO jsdom facts force both stubs, and both are worth recording:
    //  1. jsdom has no layout, so `clientWidth` is 0. The component's `?? 800`
    //     fallback therefore only fires on the FIRST render, when the ref is still
    //     null — `0 ?? 800` is 0. Stub a real viewport so the window is derived
    //     from a known width rather than from a layout accident.
    //  2. fireEvent's `target` does not write `Element.scrollLeft`, so set it on
    //     the node, then fire the event the component actually listens for.
    await act(async () => {
      Object.defineProperty(strip, 'clientWidth', { value: 800, configurable: true });
      Object.defineProperty(strip, 'scrollLeft', { value: 142 * 30, configurable: true });
      fireEvent.scroll(strip);
      await new Promise((r) => setTimeout(r, 50));
    });
    // Assert the PROPERTY — the window MOVED — rather than a hand-derived index
    // range, which is what made the first version of this test wrong: the first
    // VISIBLE index is 30, not 29 (tabRight must exceed scrollLeft strictly), so
    // the overscanned window starts at 28.
    const now = renderedTabIds();
    expect(now.length).toBeGreaterThan(0);
    expect(now).not.toEqual(before);
    // The first window is gone and a genuinely later tab is now in the DOM.
    expect(screen.queryByRole('tab', { name: /T1\b/ })).toBeNull();
    const lateIds = now.map((t) => Number(/^T(\d+)$/.exec(t)?.[1] ?? 0));
    expect(Math.max(...lateIds)).toBeGreaterThan(20);
    // Still a window, not the whole strip: virtualization did not switch off.
    expect(now.length).toBeLessThan(60);
  });

  it('a drop moves the dragged tab to just before the drop target', () => {
    const four: TabMeta[] = [1, 2, 3, 4].map((id) => ({
      id,
      pinned: false,
      live: true,
      title: `Tab ${id}`,
      url: `https://t${id}.test/`,
      private: false,
      workspaceId: 'default',
    }));
    const p = setup({ tabs: four, activeId: 1 });
    const src = screen.getByRole('tab', { name: /Tab 1\b/ });
    const target = screen.getByRole('tab', { name: /Tab 3\b/ });

    const dt = {
      setData: vi.fn(),
      getData: vi.fn(() => '1'),
      effectAllowed: '',
      dropEffect: '',
    } as unknown as DataTransfer;
    fireEvent.dragStart(src, { dataTransfer: dt });
    fireEvent.dragOver(target, { dataTransfer: dt });
    fireEvent.drop(target, { dataTransfer: dt });

    // Tab 1 lands immediately before tab 3: [2, 1, 3, 4].
    expect(p.onReorder).toHaveBeenCalledWith([2, 1, 3, 4]);
  });

  it('a drop onto itself is a no-op, not a reorder', () => {
    const four: TabMeta[] = [1, 2].map((id) => ({
      id,
      pinned: false,
      live: true,
      title: `Tab ${id}`,
      url: `https://t${id}.test/`,
      private: false,
      workspaceId: 'default',
    }));
    const p = setup({ tabs: four, activeId: 1 });
    const src = screen.getByRole('tab', { name: /Tab 1\b/ });
    const dt = {
      setData: vi.fn(),
      getData: vi.fn(() => '1'),
      effectAllowed: '',
      dropEffect: '',
    } as unknown as DataTransfer;
    fireEvent.dragStart(src, { dataTransfer: dt });
    fireEvent.drop(src, { dataTransfer: dt });
    expect(p.onReorder).not.toHaveBeenCalled();
  });

  it('a middle click closes the tab and a right click toggles pinned', () => {
    const p = setup();
    // This @testing-library build has no `fireEvent.auxClick` (verified: the key is
    // absent), so dispatch the raw bubbling `auxclick` React's delegated
    // onAuxClick listener actually receives.
    const aux = (button: number) =>
      fireEvent(
        screen.getByRole('tab', { name: /Beta/ }),
        new MouseEvent('auxclick', { bubbles: true, cancelable: true, button }),
      );
    aux(1);
    expect(p.onClose).toHaveBeenCalledWith(2);
    // A left-button aux click must NOT close — the handler is middle-click only.
    p.onClose.mockClear();
    aux(0);
    expect(p.onClose).not.toHaveBeenCalled();
    fireEvent.contextMenu(screen.getByRole('tab', { name: /Beta/ }));
    expect(p.onSetPinned).toHaveBeenCalledWith(2, true);
  });
});
