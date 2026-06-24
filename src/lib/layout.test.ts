import { describe, it, expect } from 'vitest';
import { MOBILE_ADDRESS_H, MOBILE_FAV_H, MOBILE_BOTTOMBAR_H } from './layout';

describe('mobile layout constants', () => {
  it('match the native MainActivity margins (address 48 + fav 36 top = 84; 56 bottom)', () => {
    expect(MOBILE_ADDRESS_H).toBe(48);
    expect(MOBILE_FAV_H).toBe(36);
    expect(MOBILE_BOTTOMBAR_H).toBe(56);
    // The native MainActivity top chrome is the sum (84dp) — keep this assertion as the
    // canary if either constant changes without updating MainActivity.kt.
    expect(MOBILE_ADDRESS_H + MOBILE_FAV_H).toBe(84);
  });
});
