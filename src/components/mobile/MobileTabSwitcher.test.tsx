import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MobileTabSwitcher } from './MobileTabSwitcher';
import type { TabMeta } from '../../../shared/types';

const tabs: TabMeta[] = [
  {
    id: 1,
    pinned: false,
    live: true,
    title: 'Example',
    url: 'https://example.com/',
    private: false,
  },
  { id: 2, pinned: false, live: false, title: '', url: 'https://news.test/', private: false },
];

function setup(over = {}) {
  const props = {
    tabs,
    activeId: 1,
    onSwitch: vi.fn(),
    onCloseTab: vi.fn(),
    onNewTab: vi.fn(),
    onNewPrivateTab: vi.fn(),
    onClose: vi.fn(),
    ...over,
  };
  render(<MobileTabSwitcher {...props} />);
  return props;
}

describe('MobileTabSwitcher', () => {
  it('renders a row per tab (title, or host fallback)', () => {
    setup();
    expect(screen.getByText('Example')).toBeInTheDocument();
    expect(screen.getByText('news.test')).toBeInTheDocument(); // no title -> host
  });
  it('switches to a tab on row tap', () => {
    const p = setup();
    fireEvent.click(screen.getByRole('button', { name: /switch to news\.test/i }));
    expect(p.onSwitch).toHaveBeenCalledWith(2);
  });
  it('closes a tab via its close button', () => {
    const p = setup();
    fireEvent.click(screen.getByRole('button', { name: /close example/i }));
    expect(p.onCloseTab).toHaveBeenCalledWith(1);
  });
  it('opens a new tab', () => {
    const p = setup();
    fireEvent.click(screen.getByRole('button', { name: /^new tab$/i }));
    expect(p.onNewTab).toHaveBeenCalled();
  });

  it('calls onNewPrivateTab via the new-private-tab button', () => {
    const p = setup();
    fireEvent.click(screen.getByRole('button', { name: /new private tab/i }));
    expect(p.onNewPrivateTab).toHaveBeenCalled();
  });

  it('applies private class and EyeOff icon for private tabs', () => {
    const privateTabs: TabMeta[] = [
      {
        id: 1,
        pinned: false,
        live: true,
        title: 'Incognito',
        url: 'https://incognito.test/',
        private: true,
      },
      { id: 2, pinned: false, live: false, title: '', url: 'https://news.test/', private: false },
    ];
    setup({ tabs: privateTabs });
    // The private row has the --private class
    const rows = document.querySelectorAll('.mobile-tabs__row');
    expect(rows[0]).toHaveClass('mobile-tabs__row--private');
    expect(rows[1]).not.toHaveClass('mobile-tabs__row--private');
  });
});
