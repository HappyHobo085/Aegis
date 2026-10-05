// src/components/AdblockShield.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { render, screen, within, fireEvent } from '@testing-library/react';
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

  it('reports blocking as OFF for a subdomain of an allowlisted host, not just the exact host', async () => {
    // The core's allowlist scope is exact-OR-subdomain (`adblock::host_covered`), so
    // `example.com` on the list exempts `www.example.com` from EVERY blocking tier. The
    // toolbar button and the popover must therefore agree, in the same render. They used to
    // disagree: the popover said "allowlisted here" while the button's title said "Ad
    // blocking is active" and drew a filled shield over a page nothing was blocking on.
    const p = props({
      state: { ...baseState, allowlistedHosts: ['example.com'] },
      host: 'www.example.com',
    });
    render(<AdblockShield {...p} />);
    const btn = screen.getByRole('button', { name: /ad blocking/i });
    expect(btn).toHaveAttribute('title', 'Ad blocking is off or allowlisted');
    expect(btn.className).toContain('adblock-shield__button--inactive');
    expect(btn.className).not.toContain('adblock-shield__button--active');
    await userEvent.click(btn);
    expect(within(screen.getByRole('dialog')).getByText(/allowlisted here/i)).toBeInTheDocument();
    // The page count is the core's, untouched: this is a scope question, not a counter one.
    expect(btn).toHaveTextContent('12');
  });

  it('still reports blocking as active for hosts the entry only looks like it covers', () => {
    // The controls around the fix. `example.com.evil.test` has the entry as a PREFIX and
    // `notexample.com` has it as a raw suffix; neither is a subdomain of it, so both must
    // still report blocking as active. Without these, widening the check to a suffix match
    // (or a bare `endsWith`) would pass the test above while exempting real third parties.
    for (const host of ['example.com.evil.test', 'notexample.com']) {
      const { unmount } = render(
        <AdblockShield
          {...props({ state: { ...baseState, allowlistedHosts: ['example.com'] }, host })}
        />,
      );
      const btn = screen.getByRole('button', { name: /ad blocking/i });
      expect(btn, host).toHaveAttribute('title', 'Ad blocking is active');
      expect(btn.className, host).toContain('adblock-shield__button--active');
      unmount();
    }
  });

  it('reports blocking as off for the exact allowlisted host too', () => {
    render(
      <AdblockShield
        {...props({
          state: { ...baseState, allowlistedHosts: ['example.com'] },
          host: 'example.com',
        })}
      />,
    );
    expect(screen.getByRole('button', { name: /ad blocking/i })).toHaveAttribute(
      'title',
      'Ad blocking is off or allowlisted',
    );
  });

  it('refuses to un-allow a subdomain whose PARENT entry is what allows it, and says why', async () => {
    // The core WRITES the allowlist by EXACT equality — `adblock::dispatch`'s toggleAllowlist
    // arm asks `load_allowlist_hosts(app).iter().any(|h| h == &host)` — while this popover
    // READS it with subdomain scope. So un-checking here used to send `www.example.com`, the
    // core saw "not listed" and ADDED it, the store ended up holding both entries,
    // `hostCovered` stayed true, and the checkbox snapped straight back on. `allowlist` is
    // SYNCABLE, so the redundant entry spread to every paired device as well. Un-checking
    // genuinely cannot work from here, so the control says so rather than pretending.
    const p = props({
      state: { ...baseState, allowlistedHosts: ['example.com'] },
      host: 'www.example.com',
    });
    render(<AdblockShield {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /ad blocking/i }));
    const dialog = within(screen.getByRole('dialog'));
    const checkbox = screen.getByRole('checkbox', { name: /allow ads on www\.example\.com/i });
    // It reads as ON, because it IS on — the parent entry is what is doing it.
    expect(checkbox).toBeChecked();
    expect(checkbox).toBeDisabled();
    expect(
      dialog.getByText(/because example\.com is in the allowlist\. Remove it to block/i),
    ).toBeInTheDocument();
    // The STORE is what matters, not the DOM: no write happened, so there is no redundant
    // entry left behind for the next sync pass to spread.
    expect(p.toggleAllowlist).not.toHaveBeenCalled();
    expect(p.state.allowlistedHosts).toEqual(['example.com']);
  });

  it('still allows un-checking when the host is not allowlisted at all', async () => {
    const p = props({
      state: { ...baseState, allowlistedHosts: ['example.com'] },
      host: 'other.test',
    });
    render(<AdblockShield {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /ad blocking/i }));
    const dialog = within(screen.getByRole('dialog'));
    const checkbox = screen.getByRole('checkbox', { name: /allow ads on other\.test/i });
    expect(checkbox).not.toBeChecked();
    expect(checkbox).toBeEnabled();
    expect(dialog.queryByText(/in the allowlist\. Remove/i)).toBeNull();
    await userEvent.click(checkbox);
    expect(p.toggleAllowlist).toHaveBeenCalledTimes(1);
  });

  it('still allows un-checking the exact entry when it is the only one covering the host', async () => {
    // The control for the control: disabling every checked box would be a worse bug than the
    // one being fixed. The exact host, listed exactly once, is the case removal CAN handle.
    const p = props({
      state: { ...baseState, allowlistedHosts: ['www.example.com'] },
      host: 'www.example.com',
    });
    render(<AdblockShield {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /ad blocking/i }));
    const dialog = within(screen.getByRole('dialog'));
    const checkbox = screen.getByRole('checkbox', { name: /allow ads on www\.example\.com/i });
    expect(checkbox).toBeChecked();
    expect(checkbox).toBeEnabled();
    expect(dialog.queryByText(/in the allowlist\. Remove/i)).toBeNull();
    await userEvent.click(checkbox);
    expect(p.toggleAllowlist).toHaveBeenCalledTimes(1);
  });

  it('refuses and names BOTH entries when the host and its parent are both listed', async () => {
    // A store that already holds both — grown by a peer under the old behaviour, or restored
    // from a backup. Removing the exact entry would leave the parent still covering the host,
    // so un-checking still could not work; and naming only ONE entry would send the user to
    // remove the wrong one and watch nothing change.
    const p = props({
      state: { ...baseState, allowlistedHosts: ['example.com', 'www.example.com'] },
      host: 'www.example.com',
    });
    render(<AdblockShield {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /ad blocking/i }));
    const checkbox = screen.getByRole('checkbox', { name: /allow ads on www\.example\.com/i });
    expect(checkbox).toBeDisabled();
    expect(
      within(screen.getByRole('dialog')).getByText(
        /example\.com and www\.example\.com are in the allowlist\. Remove them to block/i,
      ),
    ).toBeInTheDocument();
    expect(p.toggleAllowlist).not.toHaveBeenCalled();
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

describe('AdblockShield — picks reported by the popover surface', () => {
  function emitPick(pick: unknown): void {
    const hit = vi.mocked(listen).mock.calls.find(([n]) => n === 'popover:picked');
    expect(hit, 'the chrome must subscribe to popover.picked').toBeTruthy();
    hit![1]({ payload: pick } as never);
  }

  beforeEach(() => {
    vi.mocked(listen).mockClear();
    vi.mocked(invoke).mockClear();
  });

  it('runs its OWN handlers for the actions the surface reports', () => {
    const setEnabled = vi.fn();
    const toggleAllowlist = vi.fn();
    const onReload = vi.fn();
    render(
      <AdblockShield
        {...props()}
        setEnabled={setEnabled}
        toggleAllowlist={toggleAllowlist}
        onReload={onReload}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /ad blocking/i }));
    emitPick({ id: 'adblock-shield', action: 'toggle-enabled' });
    emitPick({ id: 'adblock-shield', action: 'toggle-allowlist' });
    emitPick({ id: 'adblock-shield', action: 'reload' });
    // The toggle is the chrome's own negation of its own state, not a level from the payload.
    expect(setEnabled).toHaveBeenCalledWith(!props().state.enabled);
    expect(toggleAllowlist).toHaveBeenCalledTimes(1);
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('ignores a pick addressed to a different popover', () => {
    const setEnabled = vi.fn();
    render(<AdblockShield {...props()} setEnabled={setEnabled} toggleAllowlist={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /ad blocking/i }));
    emitPick({ id: 'zoom-indicator', action: 'toggle-enabled' });
    expect(setEnabled).not.toHaveBeenCalled();
  });

  it('sends the allowlist asymmetry as DATA, so the surface cannot re-derive it wrongly', () => {
    // jsdom has NO LAYOUT, so every rect is 0x0 — which makes `usePopoverSurface` treat the
    // popover as unmeasurable and send NOTHING at all. Without this stub the whole payload path
    // is unexercised while the suite stays green.
    const rect = vi
      .spyOn(Element.prototype, 'getBoundingClientRect')
      .mockReturnValue({ x: 8, y: 40, width: 300, height: 380 } as DOMRect);
    try {
      // `www.example.com` is covered by a PARENT entry, so unchecking cannot be expressed
      // through the control at all. If the surface derived this itself it would offer a checkbox
      // that silently adds a redundant (syncable) entry — the bug the rule exists to prevent.
      render(
        <AdblockShield
          {...props()}
          state={{ ...baseState, allowlistedHosts: ['example.com'] }}
          host="www.example.com"
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: /ad blocking/i }));
      // Read the ENVELOPE's nested `payload`. This is exactly the shape mismatch that shipped in
      // Phase 2 (`width`/`height` read off the envelope instead of off `rect`), so a test that
      // reaches into the wrong level reads `undefined` and looks like a product failure.
      const envelope = vi
        .mocked(invoke)
        .mock.calls.map(
          ([, a]) => a as { channel?: string; payload?: { payload?: Record<string, unknown> } },
        )
        .filter((a) => a.channel === 'popover.set')
        .at(-1)?.payload;
      const payload = envelope?.payload ?? {};
      expect(payload.allowlisted).toBe(true);
      expect(payload.canUnallowHere).toBe(false);
      expect(payload.coveringEntries).toEqual(['example.com']);
    } finally {
      rect.mockRestore();
    }
  });
});
