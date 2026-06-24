// src/components/SitePermissionsTab.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
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
});
