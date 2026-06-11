// electron/main/dataPort.test.ts
import { describe, it, expect } from 'vitest';
import { validateExport, planImport } from './dataPort';
import type { ExportPayload } from './dataPort';
import type { Favorite, HistoryEntry, SavedItem, Settings } from '../../shared/types';

const settings: Settings = {
  siteName: 'Aegis', homeUrl: 'https://h/', primaryColor: '#000',
  defaultSearchTemplate: 'https://d/?q=%s', searchEngines: [], hideChromeByDefault: false,
  downloadDir: '',
};
const fav = (url: string): Favorite => ({ id: 1, name: 'n', url, tags: [], position: 0 });
const hist = (url: string, visitedAt: number): HistoryEntry => ({ id: 1, url, title: 't', visitedAt });
const saved = (url: string): SavedItem => ({ id: 1, url, title: 't', savedAt: 5 });

function payload(over: Partial<ExportPayload> = {}): ExportPayload {
  return { version: 1, favorites: [], history: [], saved: [], settings, ...over };
}

describe('validateExport', () => {
  it('accepts a well-formed payload', () => {
    expect(validateExport(payload())).toEqual({ ok: true, payload: payload() });
  });

  it('rejects a non-object', () => {
    expect(validateExport('nope').ok).toBe(false);
    expect(validateExport(null).ok).toBe(false);
  });

  it('rejects a wrong version', () => {
    expect(validateExport({ ...payload(), version: 2 }).ok).toBe(false);
  });

  it('rejects when an array field is missing', () => {
    const { favorites, ...rest } = payload();
    expect(validateExport(rest).ok).toBe(false);
  });

  it('rejects when settings is missing', () => {
    const { settings: _s, ...rest } = payload();
    expect(validateExport(rest).ok).toBe(false);
  });
});

describe('planImport', () => {
  const existing = {
    favorites: [fav('https://have.test/')],
    saved: [saved('https://have.test/')],
    historyUrls: new Set(['https://have.test/']),
  };

  it('replace mode keeps every imported row (no dedup, full replace)', () => {
    const p = payload({
      favorites: [fav('https://have.test/'), fav('https://new.test/')],
      history: [hist('https://have.test/', 1), hist('https://new.test/', 2)],
      saved: [saved('https://have.test/'), saved('https://new.test/')],
    });
    const plan = planImport(p, existing, 'replace');
    expect(plan.replace).toBe(true);
    expect(plan.favorites.map((f) => f.url)).toEqual(['https://have.test/', 'https://new.test/']);
    expect(plan.history.map((h) => h.url)).toEqual(['https://have.test/', 'https://new.test/']);
    expect(plan.saved.map((s) => s.url)).toEqual(['https://have.test/', 'https://new.test/']);
  });

  it('merge mode drops rows whose url already exists, keeps new ones', () => {
    const p = payload({
      favorites: [fav('https://have.test/'), fav('https://new.test/')],
      history: [hist('https://have.test/', 1), hist('https://new.test/', 2)],
      saved: [saved('https://have.test/'), saved('https://new.test/')],
    });
    const plan = planImport(p, existing, 'merge');
    expect(plan.replace).toBe(false);
    expect(plan.favorites.map((f) => f.url)).toEqual(['https://new.test/']);
    expect(plan.history.map((h) => h.url)).toEqual(['https://new.test/']);
    expect(plan.saved.map((s) => s.url)).toEqual(['https://new.test/']);
  });

  it('carries settings through in both modes', () => {
    expect(planImport(payload(), existing, 'merge').settings).toEqual(settings);
    expect(planImport(payload(), existing, 'replace').settings).toEqual(settings);
  });

  it('reports counts of rows that will actually be inserted', () => {
    const p = payload({
      favorites: [fav('https://have.test/'), fav('https://new.test/')],
      history: [hist('https://new.test/', 2)],
      saved: [],
    });
    expect(planImport(p, existing, 'merge').counts).toEqual({ favorites: 1, history: 1, saved: 0 });
  });

  // C5 (accepted behavior): planImport does NOT collapse adjacent same-url history
  // rows — it carries them through verbatim (replace) so the import apply path can
  // call record(entry, ()=>visitedAt) for each. The COLLAPSE is a documented,
  // accepted downstream behavior of HistoryRepo.record (it bumps the most-recent
  // row's visitedAt instead of inserting a fresh duplicate; proven in historyRepo.test).
  // So adjacent duplicate-url export rows collapse to one history row on import.
  it('replace plan carries adjacent duplicate-url history rows through verbatim (collapse is record() at insert time — C5)', () => {
    const empty = { favorites: [], saved: [], historyUrls: new Set<string>() };
    const p = payload({
      history: [
        hist('https://dup.test/', 1000),
        hist('https://dup.test/', 2000), // adjacent same url as the previous row
        hist('https://other.test/', 3000),
      ],
    });
    const plan = planImport(p, empty, 'replace');
    // The plan layer keeps both adjacent same-url rows (no dedup here)...
    expect(plan.history.map((h) => h.url)).toEqual([
      'https://dup.test/',
      'https://dup.test/',
      'https://other.test/',
    ]);
    expect(plan.counts.history).toBe(3);
    // ...the documented collapse happens when these are fed to HistoryRepo.record in
    // order: the two adjacent https://dup.test/ rows yield a single history row.
  });
});
