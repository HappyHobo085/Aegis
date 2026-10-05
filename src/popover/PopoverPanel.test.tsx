// src/popover/PopoverPanel.test.ts
//
// The surface's only rendering path. Two things are pinned here that nothing else can see:
//
//   1. A payload's `kind` picks the panel — so adding a popover cannot forget to register
//      it, and a payload with an unregistered kind renders NOTHING instead of throwing (a
//      webview that dies takes its rect with it, leaving a hole where the popover was).
//   2. Every interaction goes out through `picked()`, which is the surface's only capability.
//      A panel that called `aegis.*` would be invoking commands the surface has no permission
//      for, and the failure would be a silently dead popover rather than a visible error.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../lib/surfaceApi', () => ({ picked: vi.fn().mockResolvedValue(undefined) }));

import { picked } from '../lib/surfaceApi';
import { PopoverPanel } from './PopoverPanel';
import type { PopoverSurfacePayload } from '../../shared/types';

const mockPicked = picked as ReturnType<typeof vi.fn>;

/**
 * `kind` and `id` are cast rather than typed as `PopoverKind`/`PopoverId` ON PURPOSE: this
 * test feeds the surface values the type system would reject (an unknown kind, an object) to
 * prove the router degrades to "renders nothing" instead of throwing. A payload crossing the
 * IPC boundary really can carry those — Rust forwards `payload` verbatim without interpreting
 * it, so `kind` is attacker-influenceable text, not a checked enum.
 */
function payload(kind: string, extra: Record<string, unknown> = {}): PopoverSurfacePayload {
  return {
    id: 'test' as PopoverSurfacePayload['id'],
    rect: { x: 10, y: 20, width: 300, height: 200 },
    payload: { kind: kind as PopoverSurfacePayload['payload']['kind'], ...extra },
  };
}

beforeEach(() => {
  mockPicked.mockClear();
  mockPicked.mockResolvedValue(undefined);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('the popover surface panel router', () => {
  it('renders the payload it was given', () => {
    render(<PopoverPanel shown={payload('test', { note: 'hello' })} />);
    expect(screen.getByText(/popover surface: test/)).toBeTruthy();
    // The payload itself must be visible: this is the Phase-2 gate, "the surface renders a
    // test payload", so a panel that rendered an empty div would pass a naive smoke test.
    expect(screen.getByText(/"note": "hello"/)).toBeTruthy();
  });

  it('reports a row through picked(), never through ipc', async () => {
    const user = userEvent.setup();
    render(<PopoverPanel shown={payload('test')} />);
    await user.click(screen.getByRole('button', { name: /pick index 0/ }));
    expect(mockPicked).toHaveBeenCalledWith({ id: 'test', index: 0 });
  });

  it('routes the omnibox kind to the real dropdown, not to the gate panel', () => {
    // The gate panel renders ANY payload as text, so a router that registered `test` for
    // everything would pass the test above and silently ship a popover that shows JSON.
    render(
      <PopoverPanel
        shown={payload('address-omnibox', {
          suggestions: [
            {
              id: 'h1',
              kind: 'history',
              title: 'A page',
              url: 'https://example.com/',
              target: 'https://example.com/',
              titleMatches: [],
              urlMatches: [],
            },
          ],
          activeIndex: -1,
        })}
      />,
    );
    expect(screen.getByRole('listbox')).toBeTruthy();
    expect(screen.getAllByRole('option')).toHaveLength(1);
  });

  it('renders nothing for a kind it has no panel for, and says so', () => {
    // Silent blankness is the failure mode worth guarding: the chrome would be waiting for a
    // panel that never appears, with no error anywhere in the app.
    //
    // An INVENTED kind, because all four real ones are registered now. This test previously
    // used `address-omnibox` and then `zoom-indicator` — each was correct when it had no panel
    // and became a lie the moment that popover landed, which is twice the same mistake. A
    // registry with no gaps needs a kind that is not in it, not one that has not arrived yet.
    const { container } = render(<PopoverPanel shown={payload('not-a-popover')} />);
    expect(container.querySelector('.popover')).toBeNull();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('no panel for kind not-a-popover'),
    );
  });

  it('renders every popover that has moved onto the surface, from a minimal valid payload', () => {
    // One entry per registered kind, each with the SMALLEST payload its panel accepts. That is
    // the assertion worth having: a panel registered but unable to render is a blank popover
    // over the page with no error anywhere, and a shared fixture would hide it.
    const SUGGESTION = {
      id: 'h1',
      kind: 'history',
      title: 'A page',
      url: 'https://example.com/',
      target: 'https://example.com/',
      titleMatches: [],
      urlMatches: [],
    };
    const minimal: Record<string, Record<string, unknown>> = {
      'address-omnibox': { suggestions: [SUGGESTION], activeIndex: -1 },
      'address-site': {
        host: 'example.com',
        origin: 'https://example.com',
        httpsOnly: true,
        privateMode: false,
        permissions: [],
        canClear: true,
        canForget: false,
      },
      'adblock-shield': { enabled: true, host: 'example.com' },
      'zoom-indicator': { factor: 1.5 },
    };

    for (const kind of Object.keys(minimal)) {
      const { container } = render(
        <PopoverPanel
          shown={{
            id: kind as PopoverSurfacePayload['id'],
            rect: { x: 0, y: 0, width: 300, height: 200 },
            payload: { kind: kind as PopoverSurfacePayload['payload']['kind'], ...minimal[kind] },
          }}
        />,
      );
      expect(
        container.querySelector(
          '.omnibox, .site-identity, .adblock-shield__popover, .zoom-indicator__popover',
        ),
        `${kind} is registered but rendered nothing from its minimal payload`,
      ).not.toBeNull();
    }
  });

  it('does not throw on a payload whose kind is not even a string', () => {
    const shown = payload('test');
    // A `kind` off the wire cannot be trusted to be a known string.
    (shown.payload as { kind: unknown }).kind = { evil: true };
    expect(() => render(<PopoverPanel shown={shown} />)).not.toThrow();
  });
});
