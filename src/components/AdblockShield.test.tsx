// src/components/AdblockShield.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AdblockState } from '../../shared/types';
import type { ProtectionSummary } from '../lib/protectionSummary';
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
      screen.getByRole('button', { name: /ad blocking, 12 ads caught on this page/i }),
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

  it('closes the popover on an outside click', async () => {
    render(
      <div>
        <AdblockShield {...props()} />
        <button type="button">outside</button>
      </div>,
    );
    await userEvent.click(screen.getByRole('button', { name: /^ad blocking/i }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'outside' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps the popover open on a click inside it', async () => {
    render(<AdblockShield {...props()} />);
    await userEvent.click(screen.getByRole('button', { name: /^ad blocking/i }));
    const dialog = screen.getByRole('dialog');
    await userEvent.click(within(dialog).getByText(/ads caught here:/i));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
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

  // The WebRTC row used to report the page's POLICY and nothing about whether that
  // policy actually applied. For a host on the per-site WebRTC exemption list no shim
  // is injected and the native backstops are skipped, so the row showed
  // "WebRTC IP protection: Public only" in GREEN for exactly the page a script can
  // read the machine's real local IPs from. The badge is the one place the user looks
  // to answer "am I protected here?", so it has to know about the exemption.
  describe('WebRTC row', () => {
    const protection = (over: Partial<ProtectionSummary> = {}): ProtectionSummary =>
      ({
        privateMode: false,
        httpsOnly: true,
        webrtcPolicy: 'public-only',
        webrtcExempt: false,
        fingerprintLevel: 'standard',
        fingerprintAllowed: false,
        proxyActive: false,
        proxyUri: null,
        ...over,
      }) as ProtectionSummary;

    // The row is `div.adblock-shield__protection-row` holding an icon span (which
    // carries the `--good` class), a label span and a value span. So the VALUE is a
    // SIBLING of the label, not the label's own text — reading `label.textContent`
    // would only ever yield "WebRTC IP protection" and pass vacuously.
    const openWebrtcRow = async (
      p: ProtectionSummary,
    ): Promise<{ value: string; row: HTMLElement }> => {
      render(<AdblockShield {...props({ protection: p })} />);
      await userEvent.click(screen.getByRole('button', { name: /ad blocking/i }));
      const label = within(screen.getByRole('dialog')).getByText(/webrtc ip protection/i);
      const row = label.parentElement as HTMLElement;
      const value = row.querySelector('.adblock-shield__protection-value')?.textContent ?? '';
      return { value, row };
    };

    it('reports an exempt host as unprotected, not as the policy says', async () => {
      const { value } = await openWebrtcRow(protection({ webrtcExempt: true }));
      expect(value).toBe('Off here');
    });

    // The anti-over-fix halves, each in its OWN `it`: `openWebrtcRow` calls `render`,
    // so calling it twice in one test leaves two shields mounted and every
    // `getByText` after the first becomes an ambiguous match. (This is the second
    // time this session that mistake produced a failure I had to diagnose as my own
    // rather than as a defect.)
    it('still reports the real policy for a host that is NOT exempt', async () => {
      // The exemption must not swallow the policy display, or every page would read
      // "Off here".
      const { value } = await openWebrtcRow(protection({ webrtcExempt: false }));
      expect(value).toBe('Public only');
    });

    it('still reports "Blocked" for the disable policy on a non-exempt host', async () => {
      const { value } = await openWebrtcRow(
        protection({ webrtcPolicy: 'disable', webrtcExempt: false }),
      );
      expect(value).toBe('Blocked');
    });

    it('marks an exempt host as NOT good, so the shield shows no green tick', async () => {
      const { row } = await openWebrtcRow(protection({ webrtcExempt: true }));
      expect(row.querySelector('.adblock-shield__protection-icon--good')).toBeNull();
    });

    it('still marks a non-exempt protected host as good', async () => {
      // The other anti-over-fix half: without it, a blanket removal of the tick passes.
      const { row } = await openWebrtcRow(protection({ webrtcExempt: false }));
      expect(row.querySelector('.adblock-shield__protection-icon--good')).not.toBeNull();
    });
  });

  it('shows page and session counts in the popover', async () => {
    render(<AdblockShield {...props()} />);
    await userEvent.click(screen.getByRole('button', { name: /ad blocking/i }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/ads caught here:/i)).toHaveTextContent('12');
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

/**
 * The count this badge shows is NOT "requests we stopped", and on Linux it is
 * provably the opposite for the requests it does count.
 *
 * `linux_layout::block_counter_tx` is fed by a `resource-load-started` signal
 * that fires only for requests the CAPPED declarative content filter ALLOWED;
 * the thread then asks the full engine, and counts the ones it flags. So the
 * requests Linux counts got through the filter. The vast majority of real
 * blocks on Linux are filter-cancelled BEFORE that signal and are never counted
 * at all — the number is a LOWER BOUND, and on Windows/Android the same number
 * is a genuine "we stopped these". One string cannot be true for all three
 * without saying "caught" rather than "blocked".
 */
describe('AdblockShield count honesty', () => {
  it('does not claim the page count is a number of blocked requests', () => {
    render(<AdblockShield {...props({ page: 12 })} />);
    const btn = screen.getByRole('button', { name: /ad blocking/i });
    expect(btn).not.toHaveAccessibleName(/blocked/i);
    expect(btn).toHaveAccessibleName(/caught/i);
  });

  it('does not claim the session count is a number of blocked requests', async () => {
    render(<AdblockShield {...props({ page: 12 })} />);
    await userEvent.click(screen.getByRole('button', { name: /ad blocking/i }));
    const popover = within(screen.getByRole('dialog'));
    // The per-page AND per-session lines both assert "blocked" today.
    expect(popover.getByText(/^ads caught here:/i)).toBeInTheDocument();
    expect(popover.getByText(/^ads caught this session:/i)).toBeInTheDocument();
    expect(popover.queryByText(/blocked here/i)).toBeNull();
    expect(popover.queryByText(/blocked this session/i)).toBeNull();
  });

  it('explains the per-platform counting difference in the popover', async () => {
    render(<AdblockShield {...props({ page: 12 })} />);
    await userEvent.click(screen.getByRole('button', { name: /ad blocking/i }));
    const note = within(screen.getByRole('dialog')).getByText(/lower bound/i);
    expect(note).toBeInTheDocument();
  });
});
