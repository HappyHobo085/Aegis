import { describe, expect, it } from 'vitest';
import { parseOmniboxPayload } from './omniboxPayload';

const ROW = {
  id: 'h1',
  kind: 'history',
  title: 'A page',
  url: 'https://example.com/',
  target: 'https://example.com/',
  titleMatches: [2],
  urlMatches: [],
} as const;

describe('parseOmniboxPayload', () => {
  it('accepts a well-formed payload and carries the rows through', () => {
    const got = parseOmniboxPayload({ suggestions: [ROW], activeIndex: 0 });
    expect(got).toEqual({ suggestions: [ROW], activeIndex: 0 });
  });

  it('treats an absent activeIndex as nothing highlighted', () => {
    const got = parseOmniboxPayload({ suggestions: [ROW] });
    expect(got?.activeIndex).toBe(-1);
  });

  // THE defect this validator exists for. The payload arrives as
  // `{ [key: string]: unknown }` over the wire, so nothing has checked its shape, and the
  // panel would otherwise index straight into it: `matches.filter` on a non-array is a
  // TypeError, and a TypeError in the surface webview takes the whole popover down.
  it('drops a row whose match indices are not an array rather than rendering it', () => {
    const got = parseOmniboxPayload({
      suggestions: [ROW, { ...ROW, id: 'bad', titleMatches: 3 }],
      activeIndex: 0,
    });
    expect(got?.suggestions.map((s) => s.id)).toEqual(['h1']);
  });

  it('drops a row whose kind is not one the dropdown can render', () => {
    const got = parseOmniboxPayload({
      suggestions: [ROW, { ...ROW, id: 'bad', kind: 'not-a-kind' }],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(got?.suggestions.map((s: any) => s.id)).toEqual(['h1']);
  });

  it('drops a row whose text fields are not strings', () => {
    const got = parseOmniboxPayload({
      suggestions: [{ ...ROW, id: 'bad', title: { nested: true } }],
    });
    expect(got?.suggestions).toEqual([]);
  });

  it('drops a match index that is not a non-negative integer', () => {
    const got = parseOmniboxPayload({
      suggestions: [ROW, { ...ROW, id: 'bad', titleMatches: [1.5, -2, '3'] }],
    });
    expect(got?.suggestions.map((s) => s.id)).toEqual(['h1']);
  });

  it('refuses a payload whose suggestions are not an array at all', () => {
    expect(parseOmniboxPayload({ suggestions: 'nope' })).toBeNull();
    expect(parseOmniboxPayload({})).toBeNull();
    expect(parseOmniboxPayload(null)).toBeNull();
  });

  it('refuses a non-integer activeIndex instead of rendering a nonsense highlight', () => {
    const got = parseOmniboxPayload({ suggestions: [ROW], activeIndex: 0.5 });
    expect(got?.activeIndex).toBe(-1);
  });

  // A payload is not trusted, and a surface that renders thousands of rows because something
  // put them there is a denial of service on the popover surface.
  it('refuses more rows than any popover could plausibly declare', () => {
    const many = Array.from({ length: 5000 }, (_, i) => ({ ...ROW, id: `r${i}` }));
    expect(parseOmniboxPayload({ suggestions: many })).toBeNull();
  });

  it('accepts a full-length payload at the cap', () => {
    const atCap = Array.from({ length: 64 }, (_, i) => ({ ...ROW, id: `r${i}` }));
    expect(parseOmniboxPayload({ suggestions: atCap })?.suggestions).toHaveLength(64);
  });
});
