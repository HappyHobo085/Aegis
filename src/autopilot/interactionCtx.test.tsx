// src/autopilot/interactionCtx.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { makeVitestCtx } from './interactionCtx';

describe('makeVitestCtx', () => {
  it('click fires the handler; type sets the value; CallLog records + resets', async () => {
    const onClick = vi.fn();
    const fakeAegis = { favorites: { add: vi.fn(async () => []) } } as never;
    const { container } = render(
      <div>
        <button aria-label="Add" onClick={onClick}>+</button>
        <input aria-label="URL" defaultValue="" />
      </div>,
    );
    const ctx = makeVitestCtx(container, fakeAegis, async () => {});
    await ctx.click(ctx.byLabel('Add')!);
    expect(onClick).toHaveBeenCalledTimes(1);
    await ctx.type(ctx.byLabel('URL')!, 'example.com');
    expect((ctx.byLabel('URL') as HTMLInputElement).value).toBe('example.com');
    await (fakeAegis as { favorites: { add: () => Promise<unknown> } }).favorites.add();
    expect(ctx.calls.of('favorites.add').length).toBe(1);
    ctx.calls.reset();
    expect(ctx.calls.of('favorites.add').length).toBe(0);
  });
});
