import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MobileTabSwitcher } from './MobileTabSwitcher';
import type { TabMeta } from '../../../shared/types';

const tabs: TabMeta[] = [
  { id: 1, pinned: false, live: true, title: 'Example', url: 'https://example.com/' },
  { id: 2, pinned: false, live: false, title: '', url: 'https://news.test/' },
];

function setup(over = {}) {
  const props = {
    tabs, activeId: 1,
    onSwitch: vi.fn(), onCloseTab: vi.fn(), onNewTab: vi.fn(), onClose: vi.fn(),
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
    fireEvent.click(screen.getByRole('button', { name: /new tab/i }));
    expect(p.onNewTab).toHaveBeenCalled();
  });
});
