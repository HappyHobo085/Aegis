// src/components/AdblockShield.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AdblockState } from '../../shared/types';
import { AdblockShield } from './AdblockShield';

const baseState: AdblockState = {
  enabled: true,
  allowlistedHosts: [],
  sessionBlocked: 487,
};

const props = (over: Partial<React.ComponentProps<typeof AdblockShield>> = {}) => ({
  state: baseState,
  page: 12,
  host: 'example.com',
  setEnabled: vi.fn(),
  toggleAllowlist: vi.fn(),
  ...over,
});

describe('AdblockShield', () => {
  it('renders the shield button showing the per-page blocked count', () => {
    render(<AdblockShield {...props()} />);
    const btn = screen.getByRole('button', { name: /ad blocking/i });
    expect(btn).toHaveTextContent('12');
  });

  it('folds the page count into the button accessible name when > 0', () => {
    render(<AdblockShield {...props({ page: 12 })} />);
    expect(
      screen.getByRole('button', { name: /ad blocking, 12 blocked on this page/i }),
    ).toBeInTheDocument();
  });

  it('marks the visual badge aria-hidden so it is not double-announced', () => {
    const { container } = render(<AdblockShield {...props({ page: 12 })} />);
    const badge = container.querySelector('.adblock-shield__badge');
    expect(badge).not.toBeNull();
    expect(badge).toHaveTextContent('12');
    expect(badge).toHaveAttribute('aria-hidden', 'true');
  });

  it('hides the page-count badge entirely when the count is 0', () => {
    const { container } = render(<AdblockShield {...props({ page: 0 })} />);
    expect(container.querySelector('.adblock-shield__badge')).toBeNull();
    // The accessible name is the bare label — no count suffix.
    const btn = screen.getByRole('button', { name: 'Ad blocking' });
    expect(btn).not.toHaveTextContent('0');
  });

  it('does not render a Reload-to-apply button when onReload is omitted', async () => {
    render(<AdblockShield {...props()} />);
    await userEvent.click(screen.getByRole('button', { name: /ad blocking/i }));
    expect(screen.queryByRole('button', { name: /reload to apply/i })).not.toBeInTheDocument();
  });

  it('renders a Reload-to-apply button that calls onReload when provided', async () => {
    const onReload = vi.fn();
    render(<AdblockShield {...props({ onReload })} />);
    await userEvent.click(screen.getByRole('button', { name: /ad blocking/i }));
    const reloadBtn = within(screen.getByRole('dialog')).getByRole('button', {
      name: /reload to apply/i,
    });
    await userEvent.click(reloadBtn);
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('the popover is closed until the shield button is clicked', () => {
    render(<AdblockShield {...props()} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens the popover on click and exposes aria-expanded', async () => {
    render(<AdblockShield {...props()} />);
    const btn = screen.getByRole('button', { name: /ad blocking/i });
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(btn);
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('shows page and session counts in the popover', async () => {
    render(<AdblockShield {...props()} />);
    await userEvent.click(screen.getByRole('button', { name: /ad blocking/i }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/blocked here/i)).toHaveTextContent('12');
    expect(within(dialog).getByText(/this session/i)).toHaveTextContent('487');
  });

  it('the global toggle reflects enabled and calls setEnabled(false) when on', async () => {
    const p = props();
    render(<AdblockShield {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /ad blocking/i }));
    const toggle = screen.getByRole('switch', { name: /ad blocking/i });
    expect(toggle).toBeChecked();
    await userEvent.click(toggle);
    expect(p.setEnabled).toHaveBeenCalledWith(false);
  });

  it('the global toggle calls setEnabled(true) when currently off', async () => {
    const p = props({ state: { ...baseState, enabled: false } });
    render(<AdblockShield {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /ad blocking/i }));
    const toggle = screen.getByRole('switch', { name: /ad blocking/i });
    expect(toggle).not.toBeChecked();
    await userEvent.click(toggle);
    expect(p.setEnabled).toHaveBeenCalledWith(true);
  });

  it('the allow-this-site checkbox reflects allowlist membership and calls toggleAllowlist', async () => {
    const p = props({ state: { ...baseState, allowlistedHosts: ['example.com'] } });
    render(<AdblockShield {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /ad blocking/i }));
    const checkbox = screen.getByRole('checkbox', { name: /allow ads on example\.com/i });
    expect(checkbox).toBeChecked();
    await userEvent.click(checkbox);
    expect(p.toggleAllowlist).toHaveBeenCalledTimes(1);
  });

  it('the allow-this-site checkbox is unchecked when the host is not allowlisted', async () => {
    render(<AdblockShield {...props()} />);
    await userEvent.click(screen.getByRole('button', { name: /ad blocking/i }));
    expect(screen.getByRole('checkbox', { name: /allow ads on example\.com/i })).not.toBeChecked();
  });

  it('surfaces an "applies on reload" affordance for next-nav semantics', async () => {
    render(<AdblockShield {...props()} />);
    await userEvent.click(screen.getByRole('button', { name: /ad blocking/i }));
    expect(within(screen.getByRole('dialog')).getByText(/applies on reload/i)).toBeInTheDocument();
  });

  it('closes the popover on Escape and restores focus to the shield button', async () => {
    render(<AdblockShield {...props()} />);
    const btn = screen.getByRole('button', { name: /ad blocking/i });
    await userEvent.click(btn);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(btn).toHaveFocus();
  });

  it('disables the allow-this-site checkbox when there is no host', async () => {
    render(<AdblockShield {...props({ host: null })} />);
    await userEvent.click(screen.getByRole('button', { name: /ad blocking/i }));
    expect(screen.getByRole('checkbox', { name: /allow ads on this site/i })).toBeDisabled();
  });
});
