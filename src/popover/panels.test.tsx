import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { SitePanel } from './SitePanel';
import { ShieldPanel } from './ShieldPanel';
import { ZoomPanel } from './ZoomPanel';
import type { PopoverSurfacePayload } from '../../shared/types';

// Typed with its argument so `mock.calls[0][0]` is the reported pick rather than a tuple of
// length 0 — the mock models the real signature of `surfaceApi.picked`.
const picked = vi.hoisted(() => vi.fn(async (_pick: unknown) => {}));
vi.mock('../lib/surfaceApi', () => ({ picked }));

function shown(payload: Record<string, unknown>): PopoverSurfacePayload {
  return {
    id: 'address-site' as PopoverSurfacePayload['id'],
    rect: { x: 0, y: 40, width: 600, height: 200 },
    payload: { kind: 'address-site', ...payload },
  };
}

beforeEach(() => {
  picked.mockClear();
});

describe('SitePanel', () => {
  const SITE = {
    host: 'example.com',
    origin: 'https://example.com',
    httpsOnly: true,
    privateMode: false,
    permissions: [{ permission: 'geolocation', decision: 'deny' }],
    canClear: true,
    canForget: true,
  };

  it('renders the site the chrome described', () => {
    render(<SitePanel shown={shown(SITE)} />);
    expect(screen.getByText('example.com')).toBeTruthy();
    expect(screen.getByText('HTTPS upgrades on')).toBeTruthy();
    expect(screen.getByText('geolocation')).toBeTruthy();
  });

  it('renders the blank-home-page copy when there is no host or origin', () => {
    render(<SitePanel shown={shown({ ...SITE, host: null, origin: null })} />);
    expect(screen.getByText('This page')).toBeTruthy();
    expect(screen.getByText('No web origin')).toBeTruthy();
  });

  // The third button is the easy one to forget, and it is the only one with no `disabled`
  // state — so a payload that omits `privacy-settings` from its allowlist leaves a button
  // that does nothing when pressed.
  it('reports each action by NAME, never the origin it would act on', async () => {
    render(<SitePanel shown={shown(SITE)} />);
    screen.getByRole('button', { name: /Clear remembered data/ }).click();
    screen.getByRole('button', { name: /Forget permissions/ }).click();
    screen.getByRole('button', { name: /Privacy settings/ }).click();
    expect(picked.mock.calls.map((c) => c[0])).toEqual([
      { id: 'address-site', action: 'clear-data', value: undefined },
      { id: 'address-site', action: 'forget-permissions', value: undefined },
      { id: 'address-site', action: 'privacy-settings', value: undefined },
    ]);
  });

  it('mirrors the chrome disabled states rather than deriving its own', () => {
    render(<SitePanel shown={shown({ ...SITE, canClear: false, canForget: false })} />);
    expect(screen.getByRole('button', { name: /Clear remembered data/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Forget permissions/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Privacy settings/ })).not.toBeDisabled();
  });

  it('renders nothing from a payload it cannot read', () => {
    const { container } = render(<SitePanel shown={shown({ host: 'x' })} />);
    expect(container.textContent).toBe('');
  });

  it('drops a malformed permission row instead of rendering half a list', () => {
    render(
      <SitePanel
        shown={shown({
          ...SITE,
          permissions: [{ permission: 7 }, { permission: 'geolocation', decision: 'deny' }],
        })}
      />,
    );
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByText('geolocation')).toBeTruthy();
  });
});

describe('ZoomPanel', () => {
  function zoom(factor: unknown): PopoverSurfacePayload {
    return {
      id: 'zoom-indicator' as PopoverSurfacePayload['id'],
      rect: { x: 0, y: 0, width: 200, height: 60 },
      payload: { kind: 'zoom-indicator', factor },
    };
  }

  it('renders the zoom level from the factor alone', () => {
    render(<ZoomPanel shown={zoom(1.5)} />);
    expect(screen.getByText('150%')).toBeTruthy();
  });

  it('reports each control by name', () => {
    render(<ZoomPanel shown={zoom(1.5)} />);
    screen.getByRole('button', { name: 'Zoom out' }).click();
    screen.getByRole('button', { name: 'Zoom in' }).click();
    screen.getByRole('button', { name: 'Reset zoom' }).click();
    expect(picked.mock.calls.map((c) => c[0])).toEqual([
      { id: 'zoom-indicator', action: 'zoom-out', value: undefined },
      { id: 'zoom-indicator', action: 'zoom-in', value: undefined },
      { id: 'zoom-indicator', action: 'reset', value: undefined },
    ]);
  });

  it('clamps an absurd factor through clampZoom rather than printing it', () => {
    // `clampZoom` owns the ladder's bounds (ZOOM_MAX = 3), and `formatZoom` applies it. The
    // panel deliberately has NO clamp of its own — two bounds is how the two documents end up
    // rendering different levels for the same factor.
    render(<ZoomPanel shown={zoom(1e9)} />);
    expect(screen.getByText('300%')).toBeTruthy();
  });

  it('renders nothing from a factor that is not a positive number', () => {
    for (const bad of [undefined, Number.NaN, Infinity, '1.5', null, {}]) {
      const { container, unmount } = render(<ZoomPanel shown={zoom(bad)} />);
      expect(container.textContent, `factor ${String(bad)} must render nothing`).toBe('');
      unmount();
    }
  });
});

describe('ShieldPanel', () => {
  function shield(payload: Record<string, unknown>): PopoverSurfacePayload {
    return {
      id: 'adblock-shield' as PopoverSurfacePayload['id'],
      rect: { x: 0, y: 0, width: 300, height: 400 },
      payload: { kind: 'adblock-shield', ...payload },
    };
  }

  it('renders the chrome counts and the protection rows from the payload', () => {
    render(
      <ShieldPanel
        shown={shield({
          enabled: true,
          page: 7,
          sessionBlocked: 12,
          host: 'example.com',
          allowlisted: false,
          canUnallowHere: true,
          // Every field `protectionRows` reads. It previously listed only four and the panel
          // accepted it; the validator now requires all eight, which is what caught it.
          protection: {
            privateMode: false,
            httpsOnly: true,
            webrtcPolicy: 'default',
            webrtcExempt: false,
            fingerprintLevel: 'off',
            fingerprintAllowed: false,
            proxyActive: false,
            proxyUri: null,
          },
        })}
      />,
    );
    expect(screen.getByText('Ads caught here: 7')).toBeTruthy();
    expect(screen.getByText('Ads caught this session: 12')).toBeTruthy();
    // `protectionRows` is imported, not re-implemented — so the surface and the chrome cannot
    // disagree about which badges exist.
    expect(screen.getByText('HTTPS upgrades')).toBeTruthy();
  });

  it('reports each control by name', () => {
    render(
      <ShieldPanel
        shown={shield({
          enabled: true,
          host: 'example.com',
          allowlisted: false,
          canUnallowHere: true,
          allowLabel: 'Allow ads on example.com',
        })}
      />,
    );
    screen.getByRole('switch', { name: 'Ad blocking' }).click();
    screen.getByRole('checkbox', { name: /Allow ads on example.com/ }).click();
    expect(picked.mock.calls.map((c) => c[0])).toEqual([
      { id: 'adblock-shield', action: 'toggle-enabled', value: undefined },
      { id: 'adblock-shield', action: 'toggle-allowlist', value: undefined },
    ]);
  });

  it('says WHY unchecking cannot work here, using the entries the chrome sent', () => {
    render(
      <ShieldPanel
        shown={shield({
          enabled: false,
          host: 'www.example.com',
          allowlisted: true,
          canUnallowHere: false,
          coveringEntries: ['example.com'],
          allowLabel: 'Allow ads on www.example.com',
        })}
      />,
    );
    expect(
      screen.getByText(
        /already allowed on www.example.com because example.com is in the allowlist/,
      ),
    ).toBeTruthy();
    // …and the control is disabled, because the request cannot be expressed through it.
    expect(screen.getByRole('checkbox', { name: /Allow ads on www.example.com/ })).toBeDisabled();
  });

  it('clamps an absurd count rather than printing it', () => {
    render(<ShieldPanel shown={shield({ enabled: true, page: 1e21, sessionBlocked: -5 })} />);
    expect(screen.getByText(/Ads caught here: 1000000/)).toBeTruthy();
    expect(screen.getByText(/Ads caught this session: 0/)).toBeTruthy();
  });

  it('renders nothing when the toggle itself is unreadable', () => {
    const { container } = render(<ShieldPanel shown={shield({ enabled: 'yes' })} />);
    expect(container.textContent).toBe('');
  });
});

describe('ShieldPanel — the protection summary is checked field by field', () => {
  const GOOD = {
    privateMode: false,
    httpsOnly: true,
    webrtcPolicy: 'default',
    webrtcExempt: false,
    fingerprintLevel: 'off',
    fingerprintAllowed: false,
    proxyActive: false,
    proxyUri: null,
  } as const;

  function shield(protection: unknown): PopoverSurfacePayload {
    return {
      id: 'adblock-shield' as PopoverSurfacePayload['id'],
      rect: { x: 0, y: 0, width: 300, height: 400 },
      payload: { kind: 'adblock-shield', enabled: true, protection },
    };
  }

  it('renders the rows when every field is the right type', () => {
    render(<ShieldPanel shown={shield(GOOD)} />);
    expect(screen.getByText('HTTPS upgrades')).toBeTruthy();
  });

  // THE defect: `{}` is an object, so the old `typeof === 'object'` guard let it through and
  // `protectionRows` rendered rows from `undefined` fields — badges claiming protection the
  // page does not have. These are the rows a user reads to decide whether they are protected.
  it('drops the protection rows when a flag is missing, rather than rendering a wrong one', () => {
    for (const bad of [
      {},
      { ...GOOD, httpsOnly: undefined },
      { ...GOOD, privateMode: 'yes' },
      { ...GOOD, webrtcExempt: null },
      { ...GOOD, fingerprintAllowed: 1 },
      { ...GOOD, proxyActive: 'true' },
    ]) {
      const { container, unmount } = render(<ShieldPanel shown={shield(bad)} />);
      expect(
        screen.queryByText('HTTPS upgrades'),
        `${JSON.stringify(bad)} must render no protection rows`,
      ).toBeNull();
      // The REST of the panel still renders — degradation is "no rows", never "no popover".
      expect(container.textContent).toContain('Ads caught here');
      unmount();
    }
  });

  it('drops the rows when the enum fields are not strings', () => {
    for (const bad of [
      { ...GOOD, webrtcPolicy: 3 },
      { ...GOOD, fingerprintLevel: null },
    ]) {
      const { unmount } = render(<ShieldPanel shown={shield(bad)} />);
      expect(screen.queryByText('HTTPS upgrades')).toBeNull();
      unmount();
    }
  });

  it('accepts a non-null proxyUri, and refuses one that is not a string', () => {
    const { unmount } = render(
      <ShieldPanel shown={shield({ ...GOOD, proxyUri: 'http://p:8080' })} />,
    );
    expect(screen.getByText('HTTPS upgrades')).toBeTruthy();
    unmount();

    const { unmount: u2 } = render(<ShieldPanel shown={shield({ ...GOOD, proxyUri: 8080 })} />);
    expect(screen.queryByText('HTTPS upgrades')).toBeNull();
    u2();
  });
});
