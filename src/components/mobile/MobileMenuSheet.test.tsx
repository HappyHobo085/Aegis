import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MobileMenuSheet } from './MobileMenuSheet';

function setup(over = {}) {
  const props = {
    onClose: vi.fn(), onSettings: vi.fn(), onHistory: vi.fn(), onSaved: vi.fn(), onDownloads: vi.fn(),
    isCurrentSaved: false, canBookmark: true, onToggleBookmark: vi.fn(),
    ...over,
  };
  render(<MobileMenuSheet {...props} />);
  return props;
}

describe('MobileMenuSheet', () => {
  it('launches each feature', () => {
    const p = setup();
    fireEvent.click(screen.getByRole('button', { name: /settings/i }));
    expect(p.onSettings).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /history/i }));
    expect(p.onHistory).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /downloads/i }));
    expect(p.onDownloads).toHaveBeenCalled();
  });
  it('shows the bookmark action and toggles its label', () => {
    setup({ isCurrentSaved: false });
    expect(screen.getByRole('button', { name: /bookmark this page/i })).toBeInTheDocument();
  });
  it('reflects an already-saved page', () => {
    const p = setup({ isCurrentSaved: true });
    fireEvent.click(screen.getByRole('button', { name: /remove bookmark/i }));
    expect(p.onToggleBookmark).toHaveBeenCalled();
  });
  it('disables bookmarking when the page is not bookmarkable', () => {
    setup({ canBookmark: false });
    expect(screen.getByRole('button', { name: /bookmark this page/i })).toBeDisabled();
  });
});
