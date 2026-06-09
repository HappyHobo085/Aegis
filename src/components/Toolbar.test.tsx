// src/components/Toolbar.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PRIMARY_VIEW_ID } from '../../shared/types';
import type { NavState } from '../../shared/types';
import { Toolbar } from './Toolbar';

const state: NavState = {
  viewId: PRIMARY_VIEW_ID,
  url: 'https://example.com/',
  title: 'Example',
  canGoBack: true,
  canGoForward: false,
  isLoading: false,
  crashed: false,
};

const handlers = () => ({
  navigate: vi.fn(),
  back: vi.fn(),
  forward: vi.fn(),
  reloadOrStop: vi.fn(),
  home: vi.fn(),
});

describe('Toolbar', () => {
  it('shows the current URL in the address input', () => {
    render(<Toolbar state={state} {...handlers()} />);
    expect(screen.getByRole('textbox', { name: /address/i })).toHaveValue('https://example.com/');
  });

  it('enables Back when canGoBack and disables Forward when !canGoForward', () => {
    render(<Toolbar state={state} {...handlers()} />);
    expect(screen.getByRole('button', { name: /back/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /forward/i })).toBeDisabled();
  });

  it('calls back/forward/reloadOrStop/home on button clicks', async () => {
    const h = handlers();
    render(<Toolbar state={state} {...h} />);
    await userEvent.click(screen.getByRole('button', { name: /back/i }));
    await userEvent.click(screen.getByRole('button', { name: /home/i }));
    await userEvent.click(screen.getByRole('button', { name: /reload|stop/i }));
    expect(h.back).toHaveBeenCalledOnce();
    expect(h.home).toHaveBeenCalledOnce();
    expect(h.reloadOrStop).toHaveBeenCalledOnce();
  });

  it('submitting the address bar calls navigate with the typed value', async () => {
    const h = handlers();
    render(<Toolbar state={state} {...h} />);
    const input = screen.getByRole('textbox', { name: /address/i });
    await userEvent.clear(input);
    await userEvent.type(input, 'https://typed.example.org/{Enter}');
    expect(h.navigate).toHaveBeenCalledWith('https://typed.example.org/');
  });

  it('shows a Stop affordance while loading', () => {
    render(<Toolbar state={{ ...state, isLoading: true }} {...handlers()} />);
    expect(screen.getByRole('button', { name: /stop/i })).toBeInTheDocument();
  });
});
