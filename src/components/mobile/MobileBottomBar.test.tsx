import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MobileBottomBar } from './MobileBottomBar';

function setup(over = {}) {
  const props = {
    canGoBack: true, canGoForward: false,
    onBack: vi.fn(), onForward: vi.fn(), onHome: vi.fn(), onMenu: vi.fn(),
    shield: <div data-testid="shield" />,
    ...over,
  };
  render(<MobileBottomBar {...props} />);
  return props;
}

describe('MobileBottomBar', () => {
  it('renders the five controls + the shield slot', () => {
    setup();
    expect(screen.getByRole('button', { name: /back/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /forward/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /home/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /menu/i })).toBeInTheDocument();
    expect(screen.getByTestId('shield')).toBeInTheDocument();
  });
  it('disables back/forward per canGo flags', () => {
    setup({ canGoBack: false, canGoForward: true });
    expect(screen.getByRole('button', { name: /back/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /forward/i })).not.toBeDisabled();
  });
  it('fires callbacks on tap', () => {
    const p = setup();
    fireEvent.click(screen.getByRole('button', { name: /home/i }));
    expect(p.onHome).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /menu/i }));
    expect(p.onMenu).toHaveBeenCalled();
  });
});
