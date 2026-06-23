import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MobileMenuSheet } from './MobileMenuSheet';

function setup(over = {}) {
  const props = {
    onClose: vi.fn(),
    onBack: vi.fn(),
    onForward: vi.fn(),
    canGoBack: true,
    canGoForward: false,
    onHome: vi.fn(),
    onDownloads: vi.fn(),
    onSettings: vi.fn(),
    isCurrentSaved: false,
    canBookmark: true,
    onToggleBookmark: vi.fn(),
    onFind: vi.fn(),
    zoomPercent: '100%',
    onZoomIn: vi.fn(),
    onZoomOut: vi.fn(),
    onZoomReset: vi.fn(),
    ...over,
  };
  render(<MobileMenuSheet {...props} />);
  return props;
}

describe('MobileMenuSheet', () => {
  it('launches Home, Downloads, Settings', () => {
    const p = setup();
    fireEvent.click(screen.getByRole('button', { name: /^home$/i }));
    expect(p.onHome).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /downloads/i }));
    expect(p.onDownloads).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /settings/i }));
    expect(p.onSettings).toHaveBeenCalled();
  });
  it('has Back/Forward, disabled per the canGo flags', () => {
    const p = setup({ canGoBack: true, canGoForward: false });
    const back = screen.getByRole('button', { name: /back/i });
    const fwd = screen.getByRole('button', { name: /forward/i });
    expect(fwd).toBeDisabled();
    fireEvent.click(back);
    expect(p.onBack).toHaveBeenCalled();
  });
  it('shows the bookmark toggle and reflects saved state', () => {
    const p = setup({ isCurrentSaved: true });
    expect(screen.getByRole('button', { name: /remove bookmark/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /remove bookmark/i }));
    expect(p.onToggleBookmark).toHaveBeenCalled();
  });
  it('disables bookmarking when not bookmarkable', () => {
    setup({ canBookmark: false });
    expect(screen.getByRole('button', { name: /bookmark this page/i })).toBeDisabled();
  });
});
