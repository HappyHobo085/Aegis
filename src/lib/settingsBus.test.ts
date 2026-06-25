import { describe, it, expect, vi } from 'vitest';
import type { Settings } from '../../shared/types';
import { onSettingsChange, publishSettings } from './settingsBus';

const sample = { defaultSearchTemplate: 'https://example.com/?q=%s' } as unknown as Settings;

describe('settingsBus', () => {
  it('delivers a published settings object to a subscriber', () => {
    const fn = vi.fn();
    const off = onSettingsChange(fn);
    publishSettings(sample);
    expect(fn).toHaveBeenCalledWith(sample);
    off();
  });

  it('stops delivering after unsubscribe', () => {
    const fn = vi.fn();
    const off = onSettingsChange(fn);
    off();
    publishSettings(sample);
    expect(fn).not.toHaveBeenCalled();
  });

  it('isolates a throwing listener from the others', () => {
    const bad = vi.fn(() => {
      throw new Error('boom');
    });
    const good = vi.fn();
    const offBad = onSettingsChange(bad);
    const offGood = onSettingsChange(good);
    expect(() => publishSettings(sample)).not.toThrow();
    expect(good).toHaveBeenCalledWith(sample);
    offBad();
    offGood();
  });
});
