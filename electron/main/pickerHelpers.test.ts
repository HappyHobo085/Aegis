// @vitest-environment jsdom
// electron/main/pickerHelpers.test.ts
import { describe, it, expect } from 'vitest';
import { appendCosmeticRule, computeSelector, isSafeSelector, PICKER_IIFE } from './pickerHelpers';

describe('appendCosmeticRule', () => {
  it('builds host##selector and appends on a fresh blob', () => {
    expect(appendCosmeticRule('', 'example.com', '.ad')).toBe('example.com##.ad');
  });

  it('joins with a newline when the blob is non-empty', () => {
    expect(appendCosmeticRule('||a.test^', 'example.com', '#banner')).toBe(
      '||a.test^\nexample.com###banner',
    );
  });

  it('does not add an extra blank line when the existing blob already ends with one', () => {
    expect(appendCosmeticRule('||a.test^\n', 'x.com', '.b')).toBe('||a.test^\nx.com##.b');
  });
});

describe('isSafeSelector (main-side trust boundary)', () => {
  it('accepts a normal #id selector', () => {
    expect(isSafeSelector('#hero')).toBe(true);
  });

  it('accepts a normal .class selector', () => {
    expect(isSafeSelector('.promo')).toBe(true);
  });

  it('accepts a normal nth-of-type parent-path selector', () => {
    expect(isSafeSelector('div:nth-of-type(2) > ul > li:nth-of-type(2)')).toBe(true);
  });

  it('rejects a selector containing a newline (filter-rule injection)', () => {
    expect(isSafeSelector('#x\n@@||evil^$document')).toBe(false);
  });

  it('rejects a selector containing a carriage return', () => {
    expect(isSafeSelector('#x\r@@||evil^$document')).toBe(false);
  });

  it('rejects a selector containing a tab', () => {
    expect(isSafeSelector('#x\t.y')).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(isSafeSelector('')).toBe(false);
  });
});

describe('PICKER_IIFE', () => {
  it('is a non-empty self-invoking expression string returning a Promise', () => {
    expect(typeof PICKER_IIFE).toBe('string');
    expect(PICKER_IIFE.trim().startsWith('(')).toBe(true);
    expect(PICKER_IIFE).toContain('Promise');
  });
});

describe('computeSelector (reference impl, jsdom)', () => {
  it('prefers a #id', () => {
    document.body.innerHTML = '<div id="hero"><span>x</span></div>';
    const el = document.getElementById('hero')!;
    expect(computeSelector(el)).toBe('#hero');
  });

  it('uses a unique class when there is no id', () => {
    document.body.innerHTML = '<div class="promo"></div><p class="other"></p>';
    const el = document.querySelector('.promo')! as HTMLElement;
    expect(computeSelector(el)).toBe('.promo');
  });

  it('falls back to an nth-of-type path when neither id nor a unique class exists', () => {
    document.body.innerHTML = '<ul><li>a</li><li id="t">b</li></ul>';
    const el = document.getElementById('t')!;
    // id present → returns the id
    expect(computeSelector(el)).toBe('#t');

    document.body.innerHTML = '<ul><li>a</li><li>b</li></ul>';
    const second = document.querySelectorAll('li')[1] as HTMLElement;
    expect(computeSelector(second)).toBe('ul > li:nth-of-type(2)');
  });
});
