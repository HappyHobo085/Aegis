// src/components/VaultSettingsTab.test.tsx
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VaultSettingsTab } from './VaultSettingsTab';
import type { UseVault } from '../hooks/useVault';
import type { VaultState, VaultRecord } from '../../shared/types';

vi.mock('../lib/toast', () => ({
  confirm: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));
import { confirm, toast } from '../lib/toast';

// ---- fake vault record ----
function makeRecord(over: Partial<VaultRecord> = {}): VaultRecord {
  return {
    uuid: 'uuid-1',
    updatedAt: 0,
    site: 'https://example.com',
    username: 'alice',
    password: 'secret123',
    notes: '',
    ...over,
  };
}

// ---- state presets ----
const noVault: VaultState = {
  exists: false,
  unlocked: false,
  count: 0,
  undecryptable: 0,
  syncEnabled: false,
};
const locked: VaultState = {
  exists: true,
  unlocked: false,
  count: 2,
  undecryptable: 0,
  syncEnabled: false,
};
const unlocked: VaultState = {
  exists: true,
  unlocked: true,
  count: 1,
  undecryptable: 0,
  syncEnabled: false,
};

// ---- fake hook factory ----
function fakeVault(over: Partial<UseVault> = {}): UseVault {
  return {
    state: noVault,
    create: vi.fn(async () => {}),
    unlock: vi.fn(async () => {}),
    lock: vi.fn(async () => {}),
    list: vi.fn(async () => []),
    add: vi.fn(async () => []),
    update: vi.fn(async () => []),
    remove: vi.fn(async () => []),
    search: vi.fn(async () => []),
    ...over,
  } as unknown as UseVault;
}

// ---- mock clipboard + confirm ----
beforeEach(() => {
  vi.clearAllMocks();
  (confirm as ReturnType<typeof vi.fn>).mockResolvedValue(true);
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn(async () => {}) },
  });
});

// ---------------------------------------------------------------------------
// 1. No vault yet
// ---------------------------------------------------------------------------
describe('VaultSettingsTab — no vault (exists:false)', () => {
  it('renders a Create vault form with master password and confirm fields', () => {
    render(<VaultSettingsTab vault={fakeVault()} />);
    expect(screen.getByRole('heading', { name: /create vault/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/master password/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/confirm password/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create vault/i })).toBeInTheDocument();
  });

  it('both password fields are type="password"', () => {
    render(<VaultSettingsTab vault={fakeVault()} />);
    expect(screen.getByLabelText(/master password/i)).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText(/confirm password/i)).toHaveAttribute('type', 'password');
  });

  it('submit is blocked when the passwords do not match', async () => {
    const create = vi.fn(async () => {});
    render(<VaultSettingsTab vault={fakeVault({ create })} />);
    await userEvent.type(screen.getByLabelText(/master password/i), 'pw1');
    await userEvent.type(screen.getByLabelText(/confirm password/i), 'pw2');
    await userEvent.click(screen.getByRole('button', { name: /create vault/i }));
    expect(create).not.toHaveBeenCalled();
    expect(screen.getByText(/passwords do not match/i)).toBeInTheDocument();
  });

  it('calls create(pw) when passwords match and shows no error', async () => {
    const create = vi.fn(async () => {});
    render(<VaultSettingsTab vault={fakeVault({ create })} />);
    await userEvent.type(screen.getByLabelText(/master password/i), 'StrongPass1!');
    await userEvent.type(screen.getByLabelText(/confirm password/i), 'StrongPass1!');
    await userEvent.click(screen.getByRole('button', { name: /create vault/i }));
    expect(create).toHaveBeenCalledWith('StrongPass1!');
    expect(screen.queryByText(/passwords do not match/i)).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 2. Locked vault
// ---------------------------------------------------------------------------
describe('VaultSettingsTab — locked (exists:true, unlocked:false)', () => {
  it('renders an Unlock form showing the saved-password count', () => {
    render(<VaultSettingsTab vault={fakeVault({ state: locked })} />);
    expect(screen.getByRole('heading', { name: /unlock vault/i })).toBeInTheDocument();
    expect(screen.getByText(/2 saved password/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/master password/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /unlock/i })).toBeInTheDocument();
  });

  it('the unlock input is type="password"', () => {
    render(<VaultSettingsTab vault={fakeVault({ state: locked })} />);
    expect(screen.getByLabelText(/master password/i)).toHaveAttribute('type', 'password');
  });

  it('does NOT claim autofill it cannot do, in the locked view either', () => {
    render(<VaultSettingsTab vault={fakeVault({ state: locked })} />);
    expect(screen.queryByText(/can autofill/i)).not.toBeInTheDocument();
    expect(screen.getByText(/does not fill login forms for you yet/i)).toBeInTheDocument();
  });

  it('calls unlock(pw) then list() on submit', async () => {
    const unlock = vi.fn(async () => {});
    const list = vi.fn(async () => []);
    render(<VaultSettingsTab vault={fakeVault({ state: locked, unlock, list })} />);
    await userEvent.type(screen.getByLabelText(/master password/i), 'correctpw');
    await userEvent.click(screen.getByRole('button', { name: /unlock/i }));
    expect(unlock).toHaveBeenCalledWith('correctpw');
    expect(list).toHaveBeenCalled();
  });

  it('shows "wrong password" error when unlock rejects', async () => {
    const unlock = vi.fn(async () => {
      throw new Error('wrong master password');
    });
    render(<VaultSettingsTab vault={fakeVault({ state: locked, unlock })} />);
    await userEvent.type(screen.getByLabelText(/master password/i), 'badpw');
    await userEvent.click(screen.getByRole('button', { name: /unlock/i }));
    expect(await screen.findByText(/wrong password/i)).toBeInTheDocument();
  });

  it('does NOT call list() when unlock rejects', async () => {
    const unlock = vi.fn(async () => {
      throw new Error('wrong master password');
    });
    const list = vi.fn(async () => []);
    render(<VaultSettingsTab vault={fakeVault({ state: locked, unlock, list })} />);
    await userEvent.type(screen.getByLabelText(/master password/i), 'badpw');
    await userEvent.click(screen.getByRole('button', { name: /unlock/i }));
    await screen.findByText(/wrong password/i);
    expect(list).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3. Unlocked vault
// ---------------------------------------------------------------------------
describe('VaultSettingsTab — unlocked', () => {
  function renderUnlocked(vaultOver: Partial<UseVault> = {}) {
    return render(<VaultSettingsTab vault={fakeVault({ state: unlocked, ...vaultOver })} />);
  }

  it('does NOT claim autofill it cannot do (honest UI copy)', () => {
    renderUnlocked();
    // The notice used to say "Aegis can autofill login forms on websites", but the autofill
    // badge is not rendered anywhere in the chrome — the repo's convention is that the copy
    // never promises a capability the user cannot reach.
    expect(screen.queryByText(/can autofill/i)).not.toBeInTheDocument();
    expect(screen.getByText(/does not fill login forms for you yet/i)).toBeInTheDocument();
  });

  it('warns when some records could not be decrypted (preserved, not lost)', () => {
    renderUnlocked({
      state: { exists: true, unlocked: true, count: 1, undecryptable: 2, syncEnabled: false },
    });
    expect(screen.getByText(/could not be decrypted/i)).toBeInTheDocument();
  });

  it('shows no undecryptable warning when all records decrypt', () => {
    renderUnlocked({
      state: { exists: true, unlocked: true, count: 1, undecryptable: 0, syncEnabled: false },
    });
    expect(screen.queryByText(/could not be decrypted/i)).not.toBeInTheDocument();
  });

  it('renders the Lock button', () => {
    renderUnlocked();
    expect(screen.getByRole('button', { name: /lock vault/i })).toBeInTheDocument();
  });

  it('calls lock() when Lock button is clicked', async () => {
    const lock = vi.fn(async () => {});
    renderUnlocked({ lock });
    await userEvent.click(screen.getByRole('button', { name: /lock vault/i }));
    expect(lock).toHaveBeenCalled();
  });

  it('renders the Add entry form fields', () => {
    renderUnlocked();
    expect(screen.getByLabelText(/^site$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^username$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^password$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^notes$/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^add entry$/i })).toBeInTheDocument();
  });

  it('the add-entry password field is type="password"', () => {
    renderUnlocked();
    // Use getByLabelText with exact-match pattern to avoid collision with
    // password fields from loaded records in other states
    expect(screen.getByLabelText(/^password$/i)).toHaveAttribute('type', 'password');
  });

  it('calls add() with form values then refreshes list()', async () => {
    const record = makeRecord();
    const add = vi.fn(async () => [record]);
    const list = vi.fn(async () => [record]);
    renderUnlocked({ add, list });
    // Use anchored patterns to avoid matching aria-labels on record-row buttons
    await userEvent.type(screen.getByLabelText(/^site$/i), 'https://example.com');
    await userEvent.type(screen.getByLabelText(/^username$/i), 'alice');
    await userEvent.type(screen.getByLabelText(/^password$/i), 'secret123');
    await userEvent.click(screen.getByRole('button', { name: /^add entry$/i }));
    expect(add).toHaveBeenCalledWith({
      site: 'https://example.com',
      username: 'alice',
      password: 'secret123',
      notes: '',
    });
    expect(list).toHaveBeenCalled();
  });

  it('displays loaded records — passwords masked by default', async () => {
    const record = makeRecord();
    const list = vi.fn(async () => [record]);
    renderUnlocked({
      list,
      state: { exists: true, unlocked: true, count: 1, undecryptable: 0, syncEnabled: false },
    });
    // Trigger list load (simulate unlock done)
    await screen.findByText('https://example.com', {}, { timeout: 200 }).catch(() => {});
    // The component calls list() on mount when unlocked
    // Wait a tick for the async list() to resolve
    await vi.waitFor(() => expect(list).toHaveBeenCalled());
  });

  it('passwords are masked (shows ••••) and can be revealed via Show toggle', async () => {
    const record = makeRecord({ password: 'hunter2' });
    const list = vi.fn(async () => [record]);
    renderUnlocked({ list });
    // Wait for list to be loaded and rendered
    await vi.waitFor(() => {
      expect(screen.queryByText('alice')).toBeInTheDocument();
    });
    // By default the password should be masked, not 'hunter2'
    expect(screen.queryByText('hunter2')).not.toBeInTheDocument();
    expect(screen.getByText('••••••••')).toBeInTheDocument();
    // Click the Show toggle
    const showBtn = screen.getByRole('button', { name: /show password for/i });
    await userEvent.click(showBtn);
    expect(screen.getByText('hunter2')).toBeInTheDocument();
    expect(screen.queryByText('••••••••')).not.toBeInTheDocument();
  });

  it('copy password writes to clipboard and toasts success', async () => {
    const record = makeRecord({ password: 'hunter2' });
    const list = vi.fn(async () => [record]);
    renderUnlocked({ list });
    await vi.waitFor(() => expect(screen.queryByText('alice')).toBeInTheDocument());
    const copyBtn = screen.getByRole('button', { name: /copy password for/i });
    await userEvent.click(copyBtn);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('hunter2');
    await vi.waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Copied — clipboard clears in 60s'),
    );
  });

  it('copy username writes to clipboard and toasts success', async () => {
    const record = makeRecord({ username: 'alice' });
    const list = vi.fn(async () => [record]);
    renderUnlocked({ list });
    await vi.waitFor(() => expect(screen.queryByText('alice')).toBeInTheDocument());
    const copyBtn = screen.getByRole('button', { name: /copy username for/i });
    await userEvent.click(copyBtn);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('alice');
    await vi.waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Copied — clipboard clears in 60s'),
    );
  });

  it('copy toasts an error when the clipboard write fails', async () => {
    const record = makeRecord({ password: 'hunter2' });
    const list = vi.fn(async () => [record]);
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn(async () => {
          throw new Error('denied');
        }),
      },
    });
    renderUnlocked({ list });
    await vi.waitFor(() => expect(screen.queryByText('alice')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /copy password for/i }));
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalledWith("Couldn't copy"));
  });

  // BUG(F6): the 60s clipboard-clear timer handle was never stored, so a second Copy could
  // not cancel the first and the FIRST timer wiped whatever was copied most recently.
  describe('the 60s clipboard-clear timer', () => {
    /**
     * Render the unlocked list with REAL timers (the `list()` round-trip is awaited by a
     * `waitFor` that would deadlock against fakes), THEN switch to fake timers so the 60s
     * window is instant and deterministic.
     */
    async function renderTwoRecords() {
      const first = makeRecord({ site: 'https://a.test', password: 'secret-a' });
      const second = makeRecord({ site: 'https://b.test', password: 'secret-b' });
      const list = vi.fn(async () => [first, second]);
      const view = renderUnlocked({ list });
      await vi.waitFor(() => expect(screen.getAllByText('alice').length).toBe(2));
      vi.useFakeTimers();
      return view;
    }

    const advance = (ms: number) =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('clears the clipboard 60s after a copy', async () => {
      await renderTwoRecords();
      const writeText = navigator.clipboard.writeText as ReturnType<typeof vi.fn>;
      writeText.mockClear();
      fireEvent.click(screen.getAllByRole('button', { name: /copy password for/i })[0]);
      expect(writeText).toHaveBeenLastCalledWith('secret-a');

      await advance(60_000);
      expect(writeText).toHaveBeenLastCalledWith('');
    });

    it('a second copy RESETS the clock — the first timer must not wipe the new secret', async () => {
      await renderTwoRecords();
      const writeText = navigator.clipboard.writeText as ReturnType<typeof vi.fn>;
      writeText.mockClear();

      const buttons = screen.getAllByRole('button', { name: /copy password for/i });
      fireEvent.click(buttons[0]);
      // 59s elapse — then the user copies a DIFFERENT secret.
      await advance(59_000);
      fireEvent.click(buttons[1]);
      expect(writeText).toHaveBeenLastCalledWith('secret-b');

      // One second later the FIRST timer would have fired. It must not.
      await advance(1_000);
      expect(writeText).not.toHaveBeenCalledWith('');

      // The second secret is still on the clipboard until ITS own 60s elapse.
      await advance(58_999);
      expect(writeText).not.toHaveBeenCalledWith('');
      await advance(1);
      expect(writeText).toHaveBeenLastCalledWith('');
    });

    it('is cancelled on unmount, so closing Settings cannot blank later text', async () => {
      const { unmount } = await renderTwoRecords();
      const writeText = navigator.clipboard.writeText as ReturnType<typeof vi.fn>;
      writeText.mockClear();
      fireEvent.click(screen.getAllByRole('button', { name: /copy password for/i })[0]);

      unmount();
      await advance(120_000);
      // The user copied something unrelated after closing Settings; the stray timer must
      // not have wiped it.
      expect(writeText).not.toHaveBeenCalledWith('');
    });
  });

  it('delete confirms, then calls remove() and refreshes list()', async () => {
    const record = makeRecord();
    const remove = vi.fn(async () => []);
    const list = vi.fn(async () => [record]);
    renderUnlocked({ remove, list });
    await vi.waitFor(() => expect(screen.queryByText('alice')).toBeInTheDocument());
    // The list fn was called on mount; reset so we can assert the refresh call
    list.mockClear();
    const deleteBtn = screen.getByRole('button', { name: /delete entry for/i });
    await userEvent.click(deleteBtn);
    expect(confirm).toHaveBeenCalled();
    await vi.waitFor(() => expect(remove).toHaveBeenCalledWith('uuid-1'));
    expect(list).toHaveBeenCalled();
  });

  it('delete does NOTHING when the confirm is declined', async () => {
    (confirm as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const record = makeRecord();
    const remove = vi.fn(async () => []);
    const list = vi.fn(async () => [record]);
    renderUnlocked({ remove, list });
    await vi.waitFor(() => expect(screen.queryByText('alice')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /delete entry for/i }));
    expect(confirm).toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('search calls search(q) and updates the displayed records', async () => {
    const record = makeRecord();
    const search = vi.fn(async () => [record]);
    const list = vi.fn(async () => []);
    renderUnlocked({ list, search });
    const searchBox = screen.getByRole('searchbox', { name: /search passwords/i });
    await userEvent.type(searchBox, 'example');
    await vi.waitFor(() => expect(search).toHaveBeenCalledWith('example'));
    await vi.waitFor(() => expect(screen.queryByText('alice')).toBeInTheDocument());
  });
});
