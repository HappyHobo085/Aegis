// src/lib/recentActions.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { getRecent, addRecent, clearRecent } from './recentActions';

const STORAGE_KEY = 'aegis-recent-actions';

beforeEach(() => {
  localStorage.clear();
});

describe('getRecent', () => {
  it('returns empty array when nothing stored', () => {
    expect(getRecent()).toEqual([]);
  });

  it('returns empty array on corrupt JSON', () => {
    localStorage.setItem(STORAGE_KEY, 'not-json');
    expect(getRecent()).toEqual([]);
  });

  it('returns empty array on non-array value', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify('string'));
    expect(getRecent()).toEqual([]);
  });

  it('filters out non-string entries', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([1, 'valid', null, 'also-valid']));
    expect(getRecent()).toEqual(['valid', 'also-valid']);
  });
});

describe('addRecent', () => {
  it('adds an id to the front', () => {
    addRecent('action.newTab');
    expect(getRecent()).toEqual(['action.newTab']);
  });

  it('prepends and deduplicates', () => {
    addRecent('a');
    addRecent('b');
    addRecent('a');
    expect(getRecent()).toEqual(['a', 'b']);
  });

  it('caps at 5 entries', () => {
    for (let i = 0; i < 8; i++) {
      addRecent(`id-${i}`);
    }
    const recent = getRecent();
    expect(recent.length).toBe(5);
    expect(recent[0]).toBe('id-7');
    expect(recent[4]).toBe('id-3');
  });

  it('works with mixed existing localStorage data', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(['existing']));
    addRecent('new');
    expect(getRecent()).toEqual(['new', 'existing']);
  });
});

describe('clearRecent', () => {
  it('empties the list', () => {
    addRecent('a');
    addRecent('b');
    clearRecent();
    expect(getRecent()).toEqual([]);
  });

  it('is idempotent', () => {
    clearRecent();
    clearRecent();
    expect(getRecent()).toEqual([]);
  });
});
