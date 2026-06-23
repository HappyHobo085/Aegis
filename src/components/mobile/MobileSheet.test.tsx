import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MobileSheet } from './MobileSheet';

describe('MobileSheet', () => {
  it('renders the title + body and closes via the back button', () => {
    const onClose = vi.fn();
    render(
      <MobileSheet title="History" onClose={onClose}>
        <p>body</p>
      </MobileSheet>,
    );
    expect(screen.getByRole('dialog', { name: 'History' })).toBeInTheDocument();
    expect(screen.getByText('body')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(onClose).toHaveBeenCalled();
  });
});
