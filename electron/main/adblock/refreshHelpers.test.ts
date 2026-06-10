// electron/main/adblock/refreshHelpers.test.ts
import { describe, it, expect } from 'vitest';
import type { Subscription } from '../../../shared/types';
import { resolveRefreshSubs, assembleEngineTexts } from './refreshHelpers';

function sub(partial: Partial<Subscription> & { listId: string; url: string }): Subscription {
  return {
    enabled: true,
    lastUpdated: null,
    etag: null,
    hash: null,
    ...partial,
  };
}

describe('resolveRefreshSubs', () => {
  it('keeps only enabled rows, mapped to {listId, url}', () => {
    const rows: Subscription[] = [
      sub({ listId: 'easylist', url: 'https://e.test/easylist.txt', enabled: true }),
      sub({ listId: 'easyprivacy', url: 'https://e.test/easyprivacy.txt', enabled: false }),
      sub({ listId: 'peter-lowe', url: 'https://e.test/peter-lowe.txt', enabled: true }),
    ];
    expect(resolveRefreshSubs(rows, undefined)).toEqual([
      { listId: 'easylist', url: 'https://e.test/easylist.txt' },
      { listId: 'peter-lowe', url: 'https://e.test/peter-lowe.txt' },
    ]);
  });

  it('rewrites each enabled row url to `${listBase}/${listId}.txt` when listBase is set', () => {
    const rows: Subscription[] = [
      sub({ listId: 'easylist', url: 'https://real.example/easylist.txt', enabled: true }),
      sub({ listId: 'off', url: 'https://real.example/off.txt', enabled: false }),
    ];
    expect(resolveRefreshSubs(rows, 'http://127.0.0.1:5055/lists')).toEqual([
      { listId: 'easylist', url: 'http://127.0.0.1:5055/lists/easylist.txt' },
    ]);
  });

  it('returns an empty array when no rows are enabled', () => {
    const rows: Subscription[] = [
      sub({ listId: 'a', url: 'https://e.test/a.txt', enabled: false }),
    ];
    expect(resolveRefreshSubs(rows, undefined)).toEqual([]);
  });
});

describe('assembleEngineTexts', () => {
  it('appends the custom-filters blob after the list texts', () => {
    expect(assembleEngineTexts(['||a.test^', '||b.test^'], 'x.com##.ad')).toEqual([
      '||a.test^',
      '||b.test^',
      'x.com##.ad',
    ]);
  });

  it('omits the custom-filters element when the blob is empty or whitespace-only', () => {
    expect(assembleEngineTexts(['||a.test^'], '')).toEqual(['||a.test^']);
    expect(assembleEngineTexts(['||a.test^'], '   \n  ')).toEqual(['||a.test^']);
  });

  it('includes a non-empty custom blob even when there are no list texts', () => {
    expect(assembleEngineTexts([], 'x.com##.ad')).toEqual(['x.com##.ad']);
  });
});
