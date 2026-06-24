// src/components/Toolbar.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PRIMARY_VIEW_ID } from '../../shared/types';
import type { NavState, AdblockState } from '../../shared/types';
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

const adblockState: AdblockState = {
  enabled: true,
  allowlistedHosts: [],
  sessionBlocked: 0,
};

const handlers = () => ({
  navigate: vi.fn(),
  back: vi.fn(),
  forward: vi.fn(),
  reloadOrStop: vi.fn(),
  home: vi.fn(),
  adblock: {
    state: adblockState,
    page: 5,
    host: 'example.com',
    setEnabled: vi.fn(),
    toggleAllowlist: vi.fn(),
  },
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

  it('mounts the AdblockShield showing the per-page blocked count', () => {
    render(<Toolbar state={state} {...handlers()} />);
    expect(screen.getByRole('button', { name: /ad blocking/i })).toHaveTextContent('5');
  });

  it('opens the shield popover and toggles ad blocking', async () => {
    const h = handlers();
    render(<Toolbar state={state} {...h} />);
    await userEvent.click(screen.getByRole('button', { name: /ad blocking/i }));
    await userEvent.click(screen.getByRole('switch', { name: /ad blocking/i }));
    expect(h.adblock.setEnabled).toHaveBeenCalledWith(false);
  });

  it('renders the optional bookmark slot when provided', () => {
    render(
      <Toolbar state={state} {...handlers()} bookmark={<button type="button">Save page</button>} />,
    );
    expect(screen.getByRole('button', { name: /save page/i })).toBeInTheDocument();
  });

  it('renders the optional gear slot when provided', () => {
    render(
      <Toolbar state={state} {...handlers()} gear={<button type="button">Open settings</button>} />,
    );
    expect(screen.getByRole('button', { name: /open settings/i })).toBeInTheDocument();
  });

  it('renders the optional downloads slot when provided', () => {
    render(
      <Toolbar
        state={state}
        {...handlers()}
        downloads={<button type="button">Downloads</button>}
      />,
    );
    expect(screen.getByRole('button', { name: /^downloads$/i })).toBeInTheDocument();
  });

  it('renders the optional fullscreen slot when provided', () => {
    render(
      <Toolbar
        state={state}
        {...handlers()}
        fullscreen={<button type="button">Enter fullscreen</button>}
      />,
    );
    expect(screen.getByRole('button', { name: /enter fullscreen/i })).toBeInTheDocument();
  });

  it('renders the optional menu slot when provided', () => {
    render(
      <Toolbar
        state={state}
        {...handlers()}
        menu={<button type="button">Toggle sidebar</button>}
      />,
    );
    expect(screen.getByRole('button', { name: /toggle sidebar/i })).toBeInTheDocument();
  });

  it('shows secondary slots inline when not narrow', () => {
    render(
      <Toolbar
        state={state}
        {...handlers()}
        gear={<button type="button">Open settings</button>}
      />,
    );
    // No overflow trigger; the gear is directly visible.
    expect(screen.queryByRole('button', { name: /more tools/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /open settings/i })).toBeInTheDocument();
  });

  it('folds secondary slots into a "More tools" overflow menu when narrow', async () => {
    render(
      <Toolbar
        state={state}
        {...handlers()}
        isNarrow
        gear={<button type="button">Open settings</button>}
      />,
    );
    const more = screen.getByRole('button', { name: /more tools/i });
    expect(more).toBeInTheDocument();
    // The secondary slot is hidden until the overflow menu is opened.
    expect(screen.queryByRole('button', { name: /open settings/i })).not.toBeInTheDocument();
    await userEvent.click(more);
    expect(screen.getByRole('button', { name: /open settings/i })).toBeInTheDocument();
  });
});
