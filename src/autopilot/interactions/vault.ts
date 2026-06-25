// src/autopilot/interactions/vault.ts
// Interaction specs for the Passwords (vault) Settings tab — every user-facing
// gesture that drives a vault.* IPC call.  All specs use `layers: ['vitest']` because
// the live tour drives only IPC + screens; the DOM gestures live in vitest.
//
// Key caveats (from Task-5 report):
// - The <details> "Add entry" form must be clicked open before targeting its inputs.
// - Use ANCHORED regex (e.g. /^Username$/i) to avoid collisions with row buttons
//   like "Copy username for {site}" or "Delete entry for {site}".
// - The mock starts with { exists: false, unlocked: false, count: 0 } so the
//   component renders the "Create vault" form by default on settings:vault.
// - For unlock/unlocked-state specs, push state via ctx.emitVaultState() (same
//   pattern as emitNavState) so VaultSettingsTab re-renders without remounting.
import { waitFor } from '@testing-library/react';
import type { InteractionSpec, InteractionCtx, InteractionLayer } from './types';
import type { VaultRecord } from '../../../shared/types';

// ---------------------------------------------------------------------------
// Mock-state helpers (vitest-only: cast through unknown to avoid TS complaining
// about vi.fn methods on the typed AegisApi surface).
// ---------------------------------------------------------------------------

type MockFn<T> = { mockResolvedValue(v: T): void };

function mockList(ctx: InteractionCtx, records: VaultRecord[]): void {
  (ctx.aegis.vault.list as unknown as MockFn<VaultRecord[]>).mockResolvedValue(records);
}

/** A single probe record used by unlocked-state specs. */
const PROBE_RECORD: VaultRecord = {
  uuid: 'test-uuid-1',
  site: 'https://example.com',
  username: 'testuser',
  password: 'secret123',
  notes: '',
  updatedAt: 1751000000,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Seed the unlocked state via emitVaultState.  Transitions through locked to ensure
 * the useEffect([state.unlocked]) dependency change fires.
 * Waits for the "Lock vault" button to appear before returning.
 */
async function seedUnlockedState(ctx: InteractionCtx, count = 0): Promise<void> {
  // Step 1: force to locked so the useEffect dependency changes on step 2.
  await ctx.emitVaultState?.({ exists: true, unlocked: false, count, undecryptable: 0 });
  await new Promise<void>((r) => setTimeout(r, 0));
  // Step 2: transition to unlocked — triggers the useEffect which loads records.
  await ctx.emitVaultState?.({ exists: true, unlocked: true, count, undecryptable: 0 });
  await new Promise<void>((r) => setTimeout(r, 0));
  // Wait for the unlocked UI to appear.
  await waitFor(
    () => {
      const lockBtn = document.querySelector('[aria-label="Lock vault"]');
      if (!lockBtn) throw new Error('vault: Lock vault button not visible yet');
    },
    { timeout: 2000, interval: 50 },
  );
}

/** Open the Add entry <details> summary and wait for the form to render.
 *  The VaultSettingsTab uses a <details><summary> element; the summary text
 *  is "Add entry" but it's not a button role — find by text content. */
async function openAddEntryDetails(ctx: InteractionCtx): Promise<void> {
  // Try byRole first (in case jsdom treats <summary> as a button).
  let summaryEl: HTMLElement | null = ctx.byRole('button', /^Add entry$/);
  if (!summaryEl) {
    summaryEl = ctx.byText(/^Add entry$/);
  }
  if (!summaryEl) throw new Error('"Add entry" summary element not found');
  await ctx.click(summaryEl);
  // Give React a tick to render the form fields.
  await new Promise((r) => setTimeout(r, 50));
}

// Module-level clipboard capture (shared across the copyPassword spec's run + assert).
let vi_writeText = '';

// ---------------------------------------------------------------------------
// Specs
// ---------------------------------------------------------------------------

export const VAULT_INTERACTIONS: InteractionSpec[] = [
  // ── Create vault ─────────────────────────────────────────────────────────

  {
    id: 'vault.create.submit',
    domain: 'vault',
    description:
      'Fill Master password + Confirm password → click "Create vault" → vault.create called',
    screen: 'settings:vault',
    layers: ['vitest'] as InteractionLayer[],
    run: async (ctx: InteractionCtx) => {
      // Default mock state: { exists: false } — "Create vault" form renders on first reach.
      // Seed "no vault" state to ensure we're in the create form regardless of prior specs.
      await ctx.emitVaultState?.({ exists: false, unlocked: false, count: 0, undecryptable: 0 });
      const masterInput = ctx.byLabel(/^Master password$/);
      if (!masterInput) throw new Error('"Master password" input not found on vault create form');
      const confirmInput = ctx.byLabel(/^Confirm password$/);
      if (!confirmInput) throw new Error('"Confirm password" input not found on vault create form');
      await ctx.type(masterInput, 'test-master-pw-1');
      await ctx.type(confirmInput, 'test-master-pw-1');
      const createBtn = ctx.byRole('button', /^Create vault$/);
      if (!createBtn) throw new Error('"Create vault" button not found');
      await ctx.click(createBtn);
      await new Promise((r) => setTimeout(r, 100));
    },
    assert: async (ctx: InteractionCtx) => {
      if (!ctx.calls.called('vault.create'))
        throw new Error('vault.create not called after clicking "Create vault"');
      return 'Create vault → vault.create(master)';
    },
  },

  // ── Unlock vault ─────────────────────────────────────────────────────────

  {
    id: 'vault.unlock.submit',
    domain: 'vault',
    description:
      'Fill Master password on locked vault → click "Unlock" → vault.unlock + vault.list called',
    screen: 'settings:vault',
    layers: ['vitest'] as InteractionLayer[],
    run: async (ctx: InteractionCtx) => {
      // Push the "locked" state so the Unlock form renders.
      await ctx.emitVaultState?.({ exists: true, unlocked: false, count: 2, undecryptable: 0 });
      const masterInput = ctx.byLabel(/^Master password$/);
      if (!masterInput) throw new Error('"Master password" input not found on vault unlock form');
      await ctx.type(masterInput, 'test-master-pw-1');
      const unlockBtn = ctx.byRole('button', /^Unlock$/);
      if (!unlockBtn) throw new Error('"Unlock" button not found');
      await ctx.click(unlockBtn);
      await new Promise((r) => setTimeout(r, 100));
    },
    assert: async (ctx: InteractionCtx) => {
      if (!ctx.calls.called('vault.unlock'))
        throw new Error('vault.unlock not called after clicking "Unlock"');
      if (!ctx.calls.called('vault.list'))
        throw new Error('vault.list not called after successful unlock');
      return 'Unlock vault → vault.unlock(master) + vault.list()';
    },
  },

  // ── Add credential ────────────────────────────────────────────────────────

  {
    id: 'vault.add.submit',
    domain: 'vault',
    description: 'Open Add entry form, fill site/username/password/notes → vault.add called',
    screen: 'settings:vault',
    layers: ['vitest'] as InteractionLayer[],
    run: async (ctx: InteractionCtx) => {
      // Seed unlocked state and flush the vault.list() effect.
      mockList(ctx, []);
      await seedUnlockedState(ctx, 0);
      // Open the <details> "Add entry" form first (Task-5 caveat).
      await openAddEntryDetails(ctx);
      // Use ANCHORED regex to avoid collisions with row buttons (Task-5 caveat).
      const siteInput = ctx.byLabel(/^Site$/i);
      if (!siteInput) throw new Error('"Site" input not found in Add entry form');
      const usernameInput = ctx.byLabel(/^Username$/i);
      if (!usernameInput) throw new Error('"Username" input not found in Add entry form');
      const passwordInput = ctx.byLabel(/^Password$/i);
      if (!passwordInput) throw new Error('"Password" input not found in Add entry form');
      const notesInput = ctx.byLabel(/^Notes$/i);
      if (!notesInput) throw new Error('"Notes" textarea not found in Add entry form');
      await ctx.type(siteInput, 'https://ap-vault-test.example');
      await ctx.type(usernameInput, 'ap-test-user');
      await ctx.type(passwordInput, 'ap-test-pw');
      await ctx.type(notesInput, 'interaction test note');
      // Seed add() to return the new record so refreshList() can succeed.
      (ctx.aegis.vault.add as unknown as MockFn<VaultRecord[]>).mockResolvedValue([
        {
          uuid: 'test-uuid-add',
          site: 'https://ap-vault-test.example',
          username: 'ap-test-user',
          password: 'ap-test-pw',
          notes: 'interaction test note',
          updatedAt: 1751000001,
        },
      ]);
      const addBtn = ctx.byRole('button', /^Add entry$/);
      if (!addBtn) throw new Error('"Add entry" submit button not found');
      await ctx.click(addBtn);
      await new Promise((r) => setTimeout(r, 100));
    },
    assert: async (ctx: InteractionCtx) => {
      if (
        !ctx.calls.called('vault.add', (args) => {
          const input = args[0] as { site?: string; username?: string; password?: string };
          return (
            typeof input?.site === 'string' &&
            input.site.includes('ap-vault-test') &&
            typeof input?.username === 'string' &&
            typeof input?.password === 'string'
          );
        })
      )
        throw new Error('vault.add not called with the probe credential');
      return 'vault.add: Add entry → vault.add({site, username, password, notes})';
    },
  },

  // ── Search passwords ──────────────────────────────────────────────────────

  {
    id: 'vault.search.input',
    domain: 'vault',
    description: 'Type in the Search passwords box → vault.search called',
    screen: 'settings:vault',
    layers: ['vitest'] as InteractionLayer[],
    run: async (ctx: InteractionCtx) => {
      // Seed unlocked state with one record and flush the vault.list() effect.
      mockList(ctx, [PROBE_RECORD]);
      await seedUnlockedState(ctx, 1);
      const searchInput = ctx.byLabel(/^Search passwords$/i);
      if (!searchInput) throw new Error('"Search passwords" input not found');
      await ctx.type(searchInput, 'example');
      await new Promise((r) => setTimeout(r, 50));
    },
    assert: async (ctx: InteractionCtx) => {
      if (!ctx.calls.called('vault.search'))
        throw new Error('vault.search not called after typing in search box');
      return 'Search passwords → vault.search(q)';
    },
  },

  // ── Show/Hide password toggle ─────────────────────────────────────────────

  {
    id: 'vault.row.showPassword',
    domain: 'vault',
    description: 'Click "Show password for {site}" → password text revealed in the row',
    screen: 'settings:vault',
    layers: ['vitest'] as InteractionLayer[],
    run: async (ctx: InteractionCtx) => {
      // Seed the unlocked vault state first (so the unlocked UI renders).
      await seedUnlockedState(ctx, 1);
      // Then seed records directly via the control-surface seam — this bypasses the
      // async vault.list() chain and commits the row to the DOM synchronously.
      await ctx.emitVaultRecords?.([PROBE_RECORD]);
      await waitFor(
        () => {
          const rows = document.querySelectorAll('.vault-tab__row');
          if (rows.length === 0)
            throw new Error('vault: no .vault-tab__row elements after seeding');
        },
        { timeout: 2000, interval: 50 },
      );
      // Button aria-label is "Show password for {site}" when masked.
      const showBtn = ctx.byRole('button', /^Show password for /);
      if (!showBtn) throw new Error('"Show password for …" button not found');
      await ctx.click(showBtn);
    },
    assert: async (ctx: InteractionCtx) => {
      // The password text should now be visible (not ••••••••).
      const passwordText = ctx.byText(PROBE_RECORD.password);
      if (!passwordText) throw new Error('Password text not visible after clicking Show toggle');
      return 'Show password toggle → password text revealed';
    },
  },

  // ── Copy password ─────────────────────────────────────────────────────────

  {
    id: 'vault.row.copyPassword',
    domain: 'vault',
    description: 'Click "Copy password for {site}" → navigator.clipboard.writeText called',
    screen: 'settings:vault',
    layers: ['vitest'] as InteractionLayer[],
    run: async (ctx: InteractionCtx) => {
      // Seed unlocked vault state, then seed records directly via the control-surface seam.
      await seedUnlockedState(ctx, 1);
      await ctx.emitVaultRecords?.([PROBE_RECORD]);
      await waitFor(
        () => {
          const rows = document.querySelectorAll('.vault-tab__row');
          if (rows.length === 0)
            throw new Error('vault: no .vault-tab__row elements after seeding');
        },
        { timeout: 2000, interval: 50 },
      );
      // Stub clipboard.writeText so it doesn't throw in jsdom.
      vi_writeText = '';
      Object.defineProperty(navigator, 'clipboard', {
        value: {
          writeText: (text: string) => {
            vi_writeText = text;
            return Promise.resolve();
          },
        },
        writable: true,
        configurable: true,
      });
      const copyBtn = ctx.byRole('button', /^Copy password for /);
      if (!copyBtn) throw new Error('"Copy password for …" button not found');
      await ctx.click(copyBtn);
      await new Promise((r) => setTimeout(r, 50));
    },
    assert: async (ctx: InteractionCtx) => {
      if (vi_writeText !== PROBE_RECORD.password)
        throw new Error(
          `Copy password: clipboard contained "${vi_writeText}", expected "${PROBE_RECORD.password}"`,
        );
      return `Copy password → clipboard.writeText("${PROBE_RECORD.password}")`;
    },
  },

  // ── Delete row ────────────────────────────────────────────────────────────

  {
    id: 'vault.row.delete',
    domain: 'vault',
    description: 'Click "Delete entry for {site}" on a row → vault.remove called',
    screen: 'settings:vault',
    layers: ['vitest'] as InteractionLayer[],
    run: async (ctx: InteractionCtx) => {
      // Seed the unlocked vault state, then seed a record via the control-surface seam.
      await seedUnlockedState(ctx, 1);
      await ctx.emitVaultRecords?.([PROBE_RECORD]);
      await waitFor(
        () => {
          const rows = document.querySelectorAll('.vault-tab__row');
          if (rows.length === 0)
            throw new Error('vault: no .vault-tab__row elements after seeding');
        },
        { timeout: 2000, interval: 50 },
      );
      // aria-label is "Delete entry for {site}" (VaultSettingsTab.tsx).
      const deleteBtn = ctx.byRole('button', /^Delete entry for /);
      if (!deleteBtn) throw new Error('"Delete entry for …" button not found');
      await ctx.click(deleteBtn);
      // Delete now opens a ConfirmDialog ("Delete this saved password?") — click OK.
      const okBtn = ctx.byRole('button', /^OK$/);
      if (okBtn) await ctx.click(okBtn);
      await new Promise((r) => setTimeout(r, 100));
    },
    assert: async (ctx: InteractionCtx) => {
      if (
        !ctx.calls.called('vault.remove', (args) => {
          const uuid = args[0] as string;
          return uuid === PROBE_RECORD.uuid;
        })
      )
        throw new Error('vault.remove not called with probe UUID after clicking Delete');
      return `Delete row → vault.remove("${PROBE_RECORD.uuid}")`;
    },
  },

  // ── Lock vault ────────────────────────────────────────────────────────────

  {
    id: 'vault.lock',
    domain: 'vault',
    description: 'Click "Lock vault" button → vault.lock called',
    screen: 'settings:vault',
    layers: ['vitest'] as InteractionLayer[],
    run: async (ctx: InteractionCtx) => {
      // Seed unlocked state and flush the vault.list() effect.
      mockList(ctx, []);
      await seedUnlockedState(ctx, 0);
      const lockBtn = ctx.byRole('button', /^Lock vault$/);
      if (!lockBtn) throw new Error('"Lock vault" button not found');
      await ctx.click(lockBtn);
      await new Promise((r) => setTimeout(r, 100));
    },
    assert: async (ctx: InteractionCtx) => {
      if (!ctx.calls.called('vault.lock'))
        throw new Error('vault.lock not called after clicking "Lock vault"');
      return 'Lock vault → vault.lock()';
    },
  },
];
