import { describe, it, expect } from 'vitest';
import { MOBILE_ADDRESS_H, MOBILE_FAV_H, MOBILE_BOTTOMBAR_H } from './layout';

describe('mobile layout constants', () => {
  it('match the native MainActivity margins (address 48 + fav 24 top; 56 bottom)', () => {
    expect(MOBILE_ADDRESS_H).toBe(48);
    expect(MOBILE_FAV_H).toBe(24);
    expect(MOBILE_BOTTOMBAR_H).toBe(56);
  });
});
