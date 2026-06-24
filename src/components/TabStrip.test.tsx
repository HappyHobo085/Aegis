import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { TabStrip } from './TabStrip';
import type { TabMeta } from '../../shared/types';

const tabs: TabMeta[] = [
  { id: 1, pinned: false, live: true, title: 'Alpha', url: 'https://alpha.test/', private: false },
  { id: 2, pinned: false, live: false, title: 'Beta', url: 'https://beta.test/', private: false },
];

function setup(over: Partial<React.ComponentProps<typeof TabStrip>> = {}) {
  const props = {
    tabs,
    activeId: 1,
    onActivate: vi.fn(),
    onClose: vi.fn(),
    onCreate: vi.fn(),
    onReorder: vi.fn(),
    onSetPinned: vi.fn(),
    ...over,
  };
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
    fireEvent.click(screen.getByRole('button', { name: /new tab/i }));
    expect(p.onCreate).toHaveBeenCalled();
  });
});
