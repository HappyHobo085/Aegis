// electron/main/ipc/picker.ts
import { IPC } from '../../../shared/types';
import type { ViewController } from '../viewController';
import type { CustomFiltersRepo } from '../db/customFiltersRepo';
import { appendCosmeticRule, isSafeSelector, PICKER_IIFE } from '../pickerHelpers';

/** Host of a URL (no scheme/port), or '' when there is no usable host. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

export interface PickerDeps {
  vc: ViewController;
  customFiltersRepo: CustomFiltersRepo;
  rebuildFromCache: () => void;
}

/**
 * Builds the element-picker IPC handler (channel -> handler), args WITHOUT the
 * event. start() injects PICKER_IIFE into the sandboxed content WC with a user
 * gesture; on a returned selector it appends `${host}##${selector}` to the Phase-4
 * my-filters blob (read-modify-write) and rebuilds the engine from cache so the
 * rule applies on the next navigation. Cancel/no-host returns {ok:false}.
 */
export function buildPickerHandlers(deps: PickerDeps): Record<string, (...a: any[]) => any> {
  const { vc, customFiltersRepo, rebuildFromCache } = deps;
  return {
    [IPC.pickerStart]: async (): Promise<{ ok: boolean; rule?: string }> => {
      const host = hostOf(vc.getState().url);
      if (!host) return { ok: false };
      const selector: string | null = await vc.contentWebContents.executeJavaScript(PICKER_IIFE, true);
      if (!selector) return { ok: false };
      // The selector comes from JS run in the attacker-controlled content page;
      // reject any selector with line terminators/control chars so it cannot
      // break out of the single `host##selector` line and inject extra rules.
      if (!isSafeSelector(selector)) return { ok: false };
      const rule = `${host}##${selector}`;
      customFiltersRepo.set(appendCosmeticRule(customFiltersRepo.get(), host, selector));
      rebuildFromCache();
      return { ok: true, rule };
    },
  };
}
