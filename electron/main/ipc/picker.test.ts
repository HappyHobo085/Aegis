// electron/main/ipc/picker.test.ts
import { describe, it, expect, vi } from 'vitest';
import { IPC } from '../../../shared/types';
import { buildPickerHandlers } from './picker';
import { PICKER_IIFE } from '../pickerHelpers';

function makeVc(url: string, selectorResult: string | null) {
  return {
    getState: vi.fn(() => ({ url })),
    contentWebContents: {
      executeJavaScript: vi.fn(async (_code: string, _gesture?: boolean) => selectorResult),
    },
  };
}

function makeCustomFiltersRepo(initial = '') {
  let text = initial;
  return {
    get: vi.fn(() => text),
    set: vi.fn((t: string) => {
      text = t;
    }),
  };
}

describe('buildPickerHandlers', () => {
  it('registers exactly the picker.start channel', () => {
    const handlers = buildPickerHandlers({
      vc: makeVc('https://x/', null) as any,
      customFiltersRepo: makeCustomFiltersRepo() as any,
      rebuildFromCache: vi.fn(),
    });
    expect(Object.keys(handlers)).toEqual([IPC.pickerStart]);
  });

  it('injects PICKER_IIFE with a user gesture into the content WC', async () => {
    const vc = makeVc('https://shop.test/cart', '.banner-ad');
    const handlers = buildPickerHandlers({
      vc: vc as any, customFiltersRepo: makeCustomFiltersRepo() as any, rebuildFromCache: vi.fn(),
    });
    await handlers[IPC.pickerStart]();
    expect(vc.contentWebContents.executeJavaScript).toHaveBeenCalledWith(PICKER_IIFE, true);
  });

  it('on a selector, appends `${host}##${selector}` to my-filters, rebuilds, and returns {ok,rule}', async () => {
    const vc = makeVc('https://shop.test/cart?x=1', '.banner-ad');
    const repo = makeCustomFiltersRepo('||a.test^');
    const rebuildFromCache = vi.fn();
    const handlers = buildPickerHandlers({ vc: vc as any, customFiltersRepo: repo as any, rebuildFromCache });
    const res = await handlers[IPC.pickerStart]();
    expect(repo.set).toHaveBeenCalledWith('||a.test^\nshop.test##.banner-ad');
    expect(rebuildFromCache).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ ok: true, rule: 'shop.test##.banner-ad' });
  });

  it('appends with no leading blank line when my-filters is empty', async () => {
    const vc = makeVc('https://shop.test/', '#ad');
    const repo = makeCustomFiltersRepo('');
    const handlers = buildPickerHandlers({ vc: vc as any, customFiltersRepo: repo as any, rebuildFromCache: vi.fn() });
    await handlers[IPC.pickerStart]();
    expect(repo.set).toHaveBeenCalledWith('shop.test###ad');
  });

  it('on cancel (null selector) returns {ok:false} without touching my-filters', async () => {
    const vc = makeVc('https://shop.test/', null);
    const repo = makeCustomFiltersRepo('keep');
    const rebuildFromCache = vi.fn();
    const handlers = buildPickerHandlers({ vc: vc as any, customFiltersRepo: repo as any, rebuildFromCache });
    const res = await handlers[IPC.pickerStart]();
    expect(repo.set).not.toHaveBeenCalled();
    expect(rebuildFromCache).not.toHaveBeenCalled();
    expect(res).toEqual({ ok: false });
  });

  it('returns {ok:false} when the current URL has no usable host', async () => {
    const vc = makeVc('about:blank', '.x');
    const repo = makeCustomFiltersRepo();
    const handlers = buildPickerHandlers({ vc: vc as any, customFiltersRepo: repo as any, rebuildFromCache: vi.fn() });
    const res = await handlers[IPC.pickerStart]();
    expect(repo.set).not.toHaveBeenCalled();
    expect(res).toEqual({ ok: false });
  });
});
