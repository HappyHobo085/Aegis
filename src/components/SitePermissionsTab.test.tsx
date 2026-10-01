// src/components/SitePermissionsTab.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SitePermission } from '../../shared/types';
import { SitePermissionsTab } from './SitePermissionsTab';

vi.mock('../lib/toast', () => ({
  confirm: vi.fn(),
}));
import { confirm } from '../lib/toast';

const perm = (over: Partial<SitePermission> = {}): SitePermission => ({
  origin: 'https://example.com',
  permission: 'geolocation',
  decision: 'allow',
  ...over,
});

function props(over: Partial<React.ComponentProps<typeof SitePermissionsTab>> = {}) {
  return {
    permissions: [] as SitePermission[],
    remove: vi.fn(),
    clear: vi.fn(),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (confirm as ReturnType<typeof vi.fn>).mockResolvedValue(true);
});

describe('SitePermissionsTab', () => {
  it('shows an empty message when there are no remembered permissions', () => {
    render(<SitePermissionsTab {...props()} />);
    expect(screen.getByText(/no remembered site permissions/i)).toBeInTheDocument();
  });

  it('lists each row with FRIENDLY permission + decision labels (not the raw enum)', () => {
    render(
      <SitePermissionsTab
        {...props({
          permissions: [
            perm({ origin: 'https://a.test', permission: 'geolocation', decision: 'deny' }),
          ],
        })}
      />,
    );
    expect(screen.getByText('https://a.test')).toBeInTheDocument();
    // "geolocation" → "Location", "deny" → "Blocked"
    expect(screen.getByText('Location')).toBeInTheDocument();
    expect(screen.getByText('Blocked')).toBeInTheDocument();
    expect(screen.queryByText('geolocation')).not.toBeInTheDocument();
    expect(screen.queryByText('deny')).not.toBeInTheDocument();
  });

  it('maps common permissions and decisions to friendly labels', () => {
    render(
      <SitePermissionsTab
        {...props({
          permissions: [
            perm({ origin: 'https://cam.test', permission: 'camera', decision: 'allow' }),
            perm({ origin: 'https://mic.test', permission: 'microphone', decision: 'allow' }),
            perm({ origin: 'https://n.test', permission: 'notifications', decision: 'deny' }),
          ],
        })}
      />,
    );
    expect(screen.getByText('Camera')).toBeInTheDocument();
    expect(screen.getByText('Microphone')).toBeInTheDocument();
    expect(screen.getByText('Notifications')).toBeInTheDocument();
    expect(screen.getAllByText('Allowed')).toHaveLength(2);
    expect(screen.getByText('Blocked')).toBeInTheDocument();
  });

  it('title-cases an unmapped permission as a sensible fallback', () => {
    render(
      <SitePermissionsTab
        {...props({
          permissions: [perm({ permission: 'midi-sysex', decision: 'allow' })],
        })}
      />,
    );
    expect(screen.getByText('Midi Sysex')).toBeInTheDocument();
  });

  it('revokes a row via remove(origin, permission) — passing the RAW permission value', async () => {
    const p = props({
      permissions: [perm({ origin: 'https://b.test', permission: 'notifications' })],
    });
    render(<SitePermissionsTab {...p} />);
    // The aria-label uses the friendly label, but remove() receives the raw enum.
    await userEvent.click(
      screen.getByRole('button', { name: /revoke notifications for https:\/\/b\.test/i }),
    );
    expect(p.remove).toHaveBeenCalledWith('https://b.test', 'notifications');
  });

  it('Clear all confirms then clears', async () => {
    const p = props({ permissions: [perm()] });
    render(<SitePermissionsTab {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /clear all site permissions/i }));
    expect(confirm).toHaveBeenCalled();
    expect(p.clear).toHaveBeenCalledTimes(1);
  });

  it('does NOT clear when the confirm is declined', async () => {
    (confirm as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const p = props({ permissions: [perm()] });
    render(<SitePermissionsTab {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /clear all site permissions/i }));
    expect(p.clear).not.toHaveBeenCalled();
  });

  it('disables Clear all when empty', () => {
    render(<SitePermissionsTab {...props()} />);
    expect(screen.getByRole('button', { name: /clear all site permissions/i })).toBeDisabled();
  });

  // The core REFUSES a revoke or clear whose save did not land, and used to answer `ok`
  // anyway. These two tests are the renderer half of that fix: with the old `void remove(…)`
  // the rejection was an unhandled rejection and the row just sat there, indistinguishable
  // from a click that did nothing — so a user who revoked a camera permission on a
  // read-only store had no way to learn it was still in force.
  it('reports a REFUSED revoke with the core reason and keeps the row', async () => {
    const p = props({
      permissions: [perm({ origin: 'https://c.test', permission: 'camera' })],
      // A Rust `Err(String)` crosses the bridge as a bare string, so reject with that shape.
      remove: vi.fn().mockRejectedValue('could not write the permissions store'),
    });
    render(<SitePermissionsTab {...p} />);
    await userEvent.click(
      screen.getByRole('button', { name: /revoke camera for https:\/\/c\.test/i }),
    );
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('could not write the permissions store');
    // The list is driven by the core, and the core still holds the row — so the row must
    // still be on screen. That is what makes this honest rather than merely reported.
    expect(screen.getByText('https://c.test')).toBeInTheDocument();
  });

  it('reports a REFUSED clear with the core reason', async () => {
    const p = props({
      permissions: [perm()],
      clear: vi.fn().mockRejectedValue('no app data dir'),
    });
    render(<SitePermissionsTab {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /clear all site permissions/i }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('no app data dir');
  });

  it('clears the reported error once a later revoke succeeds', async () => {
    // The error must not be sticky: a failed revoke followed by a working one has to leave
    // the tab clean, or the tab permanently shows a stale "could not save".
    const remove = vi.fn().mockRejectedValueOnce('disk full').mockResolvedValueOnce(undefined);
    const p = props({ permissions: [perm({ origin: 'https://d.test' })], remove });
    render(<SitePermissionsTab {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /revoke location for/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('disk full');
    await userEvent.click(screen.getByRole('button', { name: /revoke location for/i }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });
});
