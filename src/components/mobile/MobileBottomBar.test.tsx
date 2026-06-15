import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MobileBottomBar } from './MobileBottomBar';

function setup(over = {}) {
  const props = {
    onSaved: vi.fn(), onHistory: vi.fn(), onTabs: vi.fn(), onMenu: vi.fn(),
    tabCount: 3, shield: <div data-testid="shield" />,
    ...over,
  };
  render(<MobileBottomBar {...props} />);
  return props;
}

describe('MobileBottomBar', () => {
  it('renders Saved, History, Tabs, Menu + the shield slot', () => {
    setup();
    expect(screen.getByRole('button', { name: /saved/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /history/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /tabs/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /menu/i })).toBeInTheDocument();
    expect(screen.getByTestId('shield')).toBeInTheDocument();
  });
  it('shows the open-tab count on the Tabs button', () => {
    setup({ tabCount: 5 });
    expect(screen.getByRole('button', { name: /tabs \(5 open\)/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /tabs/i })).toHaveTextContent('5');
  });
  it('fires callbacks on tap', () => {
    const p = setup();
    fireEvent.click(screen.getByRole('button', { name: /saved/i }));
    expect(p.onSaved).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /history/i }));
    expect(p.onHistory).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /tabs/i }));
    expect(p.onTabs).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /menu/i }));
    expect(p.onMenu).toHaveBeenCalled();
  });
});
