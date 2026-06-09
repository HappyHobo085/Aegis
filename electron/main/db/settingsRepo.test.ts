// electron/main/db/settingsRepo.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb, runMigrations } from './sqlite';
import { DEFAULT_SETTINGS, SettingsRepo } from './settingsRepo';

describe('settingsRepo', () => {
  let db: Database.Database;
  let repo: SettingsRepo;

  beforeEach(() => {
    db = openDb(':memory:');
    runMigrations(db);
    repo = new SettingsRepo(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('DEFAULT_SETTINGS', () => {
    it('has the Phase-0 default shape', () => {
      expect(DEFAULT_SETTINGS.siteName).toBe('Aegis');
      expect(DEFAULT_SETTINGS.homeUrl).toMatch(/^https:\/\//);
      expect(DEFAULT_SETTINGS.primaryColor).toMatch(/^#/);
      expect(DEFAULT_SETTINGS.defaultSearchTemplate).toContain('%s');
      expect(DEFAULT_SETTINGS.hideChromeByDefault).toBe(false);
      expect(Array.isArray(DEFAULT_SETTINGS.searchEngines)).toBe(true);
      expect(DEFAULT_SETTINGS.searchEngines.length).toBeGreaterThan(0);
      for (const eng of DEFAULT_SETTINGS.searchEngines) {
        expect(eng.template).toContain('%s');
      }
    });
  });

  describe('get', () => {
    it('returns DEFAULT_SETTINGS when nothing is stored', () => {
      expect(repo.get()).toEqual(DEFAULT_SETTINGS);
    });

    it('merges stored values over the defaults', () => {
      repo.set({ siteName: 'MyBrowser' });
      const got = repo.get();
      expect(got.siteName).toBe('MyBrowser');
      // unset fields fall back to defaults
      expect(got.homeUrl).toBe(DEFAULT_SETTINGS.homeUrl);
      expect(got.primaryColor).toBe(DEFAULT_SETTINGS.primaryColor);
    });
  });

  describe('set', () => {
    it('persists a partial update and returns the merged result', () => {
      const result = repo.set({ primaryColor: '#ff0000', homeUrl: 'https://example.com' });
      expect(result.primaryColor).toBe('#ff0000');
      expect(result.homeUrl).toBe('https://example.com');
      expect(result.siteName).toBe(DEFAULT_SETTINGS.siteName);
    });

    it('persists across repo instances on the same db', () => {
      repo.set({ siteName: 'Persisted' });
      const repo2 = new SettingsRepo(db);
      expect(repo2.get().siteName).toBe('Persisted');
    });

    it('successive partial updates accumulate', () => {
      repo.set({ siteName: 'One' });
      repo.set({ primaryColor: '#00ff00' });
      const got = repo.get();
      expect(got.siteName).toBe('One');
      expect(got.primaryColor).toBe('#00ff00');
    });

    it('round-trips complex values (searchEngines array)', () => {
      const engines = [{ id: 'g', name: 'Google', template: 'https://google.com/search?q=%s' }];
      repo.set({ searchEngines: engines });
      expect(repo.get().searchEngines).toEqual(engines);
    });
  });
});
