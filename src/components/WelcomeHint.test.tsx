// src/components/WelcomeHint.test.tsx
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WelcomeHint, WELCOME_HINT_STORAGE_KEY } from './WelcomeHint';

beforeEach(() => {
  localStorage.clear();
});

describe('WelcomeHint', () => {
  it('renders the hint when not previously dismissed', () => {
    render(<WelcomeHint />);
    expect(screen.getByText(/welcome to aegis/i)).toBeInTheDocument();
  });

  it('does not render when previously dismissed', () => {
    localStorage.setItem(WELCOME_HINT_STORAGE_KEY, '1');
    render(<WelcomeHint />);
    expect(screen.queryByText(/welcome to aegis/i)).not.toBeInTheDocument();
  });

  it('persists dismissal and hides on the dismiss button', async () => {
    render(<WelcomeHint />);
    await userEvent.click(screen.getByRole('button', { name: /dismiss|got it/i }));
    expect(screen.queryByText(/welcome to aegis/i)).not.toBeInTheDocument();
    expect(localStorage.getItem(WELCOME_HINT_STORAGE_KEY)).toBe('1');
  });
});
