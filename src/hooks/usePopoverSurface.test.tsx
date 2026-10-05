// src/hooks/usePopoverSurface.test.tsx
//
// The chrome half of the surface contract. The behaviours that matter, and why each is
// pinned:
//
//   - an open popover sends its rect, payload, item count AND action allowlist, because Rust
//     validates every pick against exactly those three declarations;
//   - a closed popover sends `payload: null` (the close signal) rather than a second hide
//     channel, so a popover cannot get stuck open over the page;
//   - an open-but-UNMEASURED popover sends NOTHING, because a 0x0 rect is not a no-op on
//     every toolkit and would park a sizeless webview in the middle of the window;
//   - a fresh `actions` ARRAY identity does not re-send, because every component in this
//     codebase writes `actions={['a']}` inline and identity churn would re-send every render.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const setPopover = vi.fn().mockResolvedValue(undefined);
vi.mock('../lib/ipcClient', () => ({
  aegis: { popover: { set: (args: unknown) => setPopover(args) } },
}));

import { usePopoverSurface } from './usePopoverSurface';
import { EMPTY_RECT } from './useMeasuredRect';

const RECT = { x: 120, y: 44, width: 640, height: 312 };
const PAYLOAD = { items: [{ title: 'a' }, { title: 'b' }] };

beforeEach(() => {
  setPopover.mockClear();
  setPopover.mockResolvedValue(undefined);
});

describe('usePopoverSurface', () => {
  it('sends the rect, the payload, the item count and the action allowlist when open', () => {
    renderHook(() =>
      usePopoverSurface({
        id: 'address-omnibox',
        active: true,
        rect: RECT,
        itemCount: 2,
        actions: ['pick', 'remove'],
        payload: PAYLOAD,
      }),
    );
    expect(setPopover).toHaveBeenCalledTimes(1);
    expect(setPopover).toHaveBeenCalledWith({
      id: 'address-omnibox',
      rect: RECT,
      // `kind` is derived from the id, so a panel is selected by identity and a payload
      // cannot claim to be a different popover than the one that owns the rect.
      payload: { kind: 'address-omnibox', items: PAYLOAD.items },
      itemCount: 2,
      actions: ['pick', 'remove'],
    });
  });

  it('closes with a null payload instead of a separate hide channel', () => {
    renderHook(() =>
      usePopoverSurface({
        id: 'address-omnibox',
        active: false,
        rect: EMPTY_RECT,
        itemCount: 0,
        actions: [],
        payload: null,
      }),
    );
    expect(setPopover).toHaveBeenCalledTimes(1);
    const arg = setPopover.mock.calls[0][0];
    expect(arg.payload).toBeNull();
    expect(arg.itemCount).toBe(0);
    expect(arg.actions).toStrictEqual([]);
  });

  it('sends nothing while open but not yet measured', () => {
    // The element has mounted but `getBoundingClientRect` has not been read yet, or reports
    // zero. A 0x0 surface is a webview of no size parked in the middle of the window.
    renderHook(() =>
      usePopoverSurface({
        id: 'address-omnibox',
        active: true,
        rect: { x: 0, y: 0, width: 0, height: 0 },
        itemCount: 2,
        actions: ['pick'],
        payload: PAYLOAD,
      }),
    );
    expect(setPopover).not.toHaveBeenCalled();
  });

  it('treats a null payload as closed even when active is true', () => {
    // "Open with nothing to show" must not paint an empty box over the page.
    renderHook(() =>
      usePopoverSurface({
        id: 'zoom-indicator',
        active: true,
        rect: RECT,
        itemCount: 0,
        actions: [],
        payload: null,
      }),
    );
    expect(setPopover).toHaveBeenCalledTimes(1);
    expect(setPopover.mock.calls[0][0].payload).toBeNull();
  });

  it('re-sends when the rect MOVES, with the same size', () => {
    // The omnibox dropdown follows the selected row, so the popover moves without resizing.
    // A guard on identity or on size alone would leave the surface a row behind.
    const { rerender } = renderHook(
      (props: { rect: typeof RECT }) =>
        usePopoverSurface({
          id: 'address-omnibox',
          active: true,
          rect: props.rect,
          itemCount: 2,
          actions: ['pick'],
          payload: PAYLOAD,
        }),
      { initialProps: { rect: RECT } },
    );
    expect(setPopover).toHaveBeenCalledTimes(1);
    rerender({ rect: { x: 120, y: 200, width: 640, height: 312 } });
    expect(setPopover).toHaveBeenCalledTimes(2);
    expect(setPopover.mock.calls[1][0].rect).toStrictEqual({
      x: 120,
      y: 200,
      width: 640,
      height: 312,
    });
  });

  it('re-sends when the payload CONTENT changes, not just when its identity does', () => {
    // The omnibox payload is a fresh array on every keystroke. If the guard were on identity
    // this would still pass; the point is that a content change must produce a send, because
    // the surface has no incremental patching and renders only from what it last received.
    const { rerender } = renderHook(
      (props: { payload: Record<string, unknown> }) =>
        usePopoverSurface({
          id: 'address-omnibox',
          active: true,
          rect: RECT,
          itemCount: 1,
          actions: ['pick'],
          payload: props.payload,
        }),
      { initialProps: { payload: { items: [{ title: 'a' }] } } },
    );
    expect(setPopover).toHaveBeenCalledTimes(1);
    rerender({ payload: { items: [{ title: 'a' }, { title: 'b' }] } });
    expect(setPopover).toHaveBeenCalledTimes(2);
    expect(setPopover.mock.calls[1][0].payload.items).toHaveLength(2);
  });

  it('does NOT re-send when only the actions ARRAY identity changes', () => {
    // Every component writes `actions={['pick']}` inline, so identity churns on every render.
    // Identity churn here would mean one `popover.set` per render, per popover.
    const { rerender } = renderHook(
      (props: { actions: string[] }) =>
        usePopoverSurface({
          id: 'address-omnibox',
          active: true,
          rect: RECT,
          itemCount: 1,
          actions: props.actions,
          payload: PAYLOAD,
        }),
      { initialProps: { actions: ['pick'] } },
    );
    expect(setPopover).toHaveBeenCalledTimes(1);
    rerender({ actions: ['pick'] });
    rerender({ actions: ['pick'] });
    expect(setPopover).toHaveBeenCalledTimes(1);
  });

  it('re-sends when the allowlist CONTENT changes', () => {
    const { rerender } = renderHook(
      (props: { actions: string[] }) =>
        usePopoverSurface({
          id: 'adblock-shield',
          active: true,
          rect: RECT,
          itemCount: 1,
          actions: props.actions,
          payload: PAYLOAD,
        }),
      { initialProps: { actions: ['toggle-site'] } },
    );
    rerender({ actions: ['toggle-site', 'on-this-site'] });
    expect(setPopover).toHaveBeenCalledTimes(2);
    expect(setPopover.mock.calls[1][0].actions).toStrictEqual(['toggle-site', 'on-this-site']);
  });

  it('sends the close signal when a popover that was open closes', () => {
    const { rerender } = renderHook(
      (props: { active: boolean }) =>
        usePopoverSurface({
          id: 'address-omnibox',
          active: props.active,
          rect: RECT,
          itemCount: 2,
          actions: ['pick'],
          payload: PAYLOAD,
        }),
      { initialProps: { active: true } },
    );
    expect(setPopover).toHaveBeenCalledTimes(1);
    rerender({ active: false });
    expect(setPopover).toHaveBeenCalledTimes(2);
    expect(setPopover.mock.calls[1][0].payload).toBeNull();
  });
});
