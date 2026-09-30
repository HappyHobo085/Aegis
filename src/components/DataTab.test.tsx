// src/components/DataTab.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ImportMode } from '../../shared/types';
import { DataTab } from './DataTab';

vi.mock('../lib/toast', () => ({
  confirm: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
import { confirm, toast } from '../lib/toast';

function props(over: Partial<React.ComponentProps<typeof DataTab>> = {}) {
  return {
    onExport: vi.fn(async () => ({ ok: true, path: '/tmp/aegis-export.json' })),
    onImport: vi.fn(async (_mode: ImportMode, _source?: { text?: string }) => ({
      ok: true,
      counts: {},
    })),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (confirm as ReturnType<typeof vi.fn>).mockResolvedValue(true);
});

describe('DataTab', () => {
  it('Export calls onExport and reports success with the path', async () => {
    const p = props();
    render(<DataTab {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /^export$/i }));
    expect(p.onExport).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });

  // The old version of this test asserted only that no success toast appeared, which
  // is what the bug ALSO produced -- it passed because of the defect, and it named
  // a "canceled" state the flow cannot reach (the core has no save dialog, so a
  // refusal is a failed WRITE, not a user cancellation). What the user actually
  // needs to be told is that their backup is not there.
  it('a failed export tells the user, with the reason the core gave', async () => {
    const p = props({
      onExport: vi.fn(async () => ({ ok: false, error: 'No space left on device' })),
    });
    render(<DataTab {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /^export$/i }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect(toast.success).not.toHaveBeenCalled();
    expect((toast.error as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain(
      'No space left on device',
    );
  });

  it('a failed export with no reason still says the export failed', async () => {
    // The core's reply always carries `error` today, but the UI must not depend on
    // that: a silent no-op on a missing field is exactly the bug being fixed.
    const p = props({ onExport: vi.fn(async () => ({ ok: false })) });
    render(<DataTab {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /^export$/i }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect((toast.error as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatch(/export/i);
  });

  it('defaults the import mode to merge and imports without a confirm', async () => {
    const p = props();
    render(<DataTab {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /^import$/i }));
    expect(confirm).not.toHaveBeenCalled();
    expect(p.onImport).toHaveBeenCalledWith('merge');
  });

  it('selecting replace requires a confirm before importing', async () => {
    const p = props();
    render(<DataTab {...p} />);
    await userEvent.click(screen.getByRole('radio', { name: /replace/i }));
    await userEvent.click(screen.getByRole('button', { name: /^import$/i }));
    expect(confirm).toHaveBeenCalled();
    expect(p.onImport).toHaveBeenCalledWith('replace');
  });

  it('does NOT import in replace mode when the confirm is declined', async () => {
    (confirm as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const p = props();
    render(<DataTab {...p} />);
    await userEvent.click(screen.getByRole('radio', { name: /replace/i }));
    await userEvent.click(screen.getByRole('button', { name: /^import$/i }));
    expect(p.onImport).not.toHaveBeenCalled();
  });

  // A bundle that never parsed names no store (nothing was written, so nothing is named), and
  // the copy must NOT claim a partial import happened.
  it('reports the generic failure when the import names no failed store', async () => {
    const p = props({
      onImport: vi.fn(async () => ({ ok: false, counts: {}, failed: [] })),
    });
    render(<DataTab {...p} />);
    fireEvent.change(screen.getByRole('textbox', { name: /backup json to import/i }), {
      target: { value: 'not json' },
    });
    await userEvent.click(screen.getByRole('button', { name: /^import$/i }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    const msg = (toast.error as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(msg).toMatch(/check the pasted JSON/i);
    expect(msg).not.toMatch(/incomplete/i);
  });

  it('reports a success toast after a completed import', async () => {
    const p = props();
    render(<DataTab {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /^import$/i }));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });

  // A restore whose store could not be written must NAME it. The core used to discard every
  // save error and return `ok: true`, so the user was told "Import complete." for a backup
  // whose history was silently lost. The draft is asserted too: it is the user's only copy,
  // and clearing it on a failure strands them with nothing to retry from.
  it('names the stores a partial import could not save, and keeps the pasted draft', async () => {
    const p = props({
      onImport: vi.fn(async () => ({ ok: false, counts: { favorites: 1 }, failed: ['history'] })),
    });
    render(<DataTab {...p} />);
    const draft = screen.getByRole('textbox', { name: /backup json to import/i });
    fireEvent.change(draft, { target: { value: '{"history":[]}' } });
    await userEvent.click(screen.getByRole('button', { name: /^import$/i }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    const msg = (toast.error as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(msg).toMatch(/incomplete/i);
    expect(msg).toContain('history');
    expect(toast.success).not.toHaveBeenCalled();
    expect((draft as HTMLTextAreaElement).value).toBe('{"history":[]}');
  });

  it('imports pasted JSON through the same path a picked file takes', async () => {
    const p = props();
    render(<DataTab {...p} />);
    fireEvent.change(screen.getByRole('textbox', { name: /backup json to import/i }), {
      target: { value: '{"version":1}' },
    });
    await userEvent.click(screen.getByRole('button', { name: /^import$/i }));
    expect(p.onImport).toHaveBeenCalledWith('merge', { text: '{"version":1}' });
  });

  // The picker FILLS the paste box rather than importing at once. That is the point: the
  // box is where a restore can be read before it runs, and `replace` is destructive.
  it('fills the paste box from a chosen file instead of importing it immediately', async () => {
    const p = props();
    render(<DataTab {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /choose a backup file/i }));
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(
      input,
      new File(['{"favorites":[]}'], 'aegis-export.json', { type: 'application/json' }),
    );
    // The name is surfaced, and the draft is the file's contents...
    expect(await screen.findByTestId('data-tab-picked')).toHaveTextContent('aegis-export.json');
    expect(
      (screen.getByRole('textbox', { name: /backup json to import/i }) as HTMLTextAreaElement)
        .value,
    ).toBe('{"favorites":[]}');
    // ...but nothing has been imported yet.
    expect(p.onImport).not.toHaveBeenCalled();
    // And the existing, already-tested button is what actually imports it.
    await userEvent.click(screen.getByRole('button', { name: /^import$/i }));
    expect(p.onImport).toHaveBeenCalledWith('merge', { text: '{"favorites":[]}' });
  });

  // `change` only fires when the value actually changes, so the input's value is cleared
  // on every pick. Without that, choosing the SAME file twice silently does nothing the
  // second time — which is exactly what a user retrying a bad backup does.
  it('lets the same file be chosen twice', async () => {
    const p = props();
    render(<DataTab {...p} />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['{"a":1}'], 'backup.json', { type: 'application/json' });
    await userEvent.upload(input, file);
    await userEvent.upload(input, file);
    const box = screen.getByRole('textbox', {
      name: /backup json to import/i,
    }) as HTMLTextAreaElement;
    expect(box.value).toBe('{"a":1}');
    expect(input.value).toBe('');
  });

  // The BUTTON is the control the user clicks; the input is only its hand-off point.
  // `userEvent.upload` sets `files` on the input directly, so every other test here
  // would still pass if the button did nothing at all — this is the only thing that
  // pins the button to it, and it also pins the input out of the tab order, since a
  // visually hidden but focusable input would be a second stop nobody can see.
  it('opens the chooser from the button, and keeps the input out of the tab order', async () => {
    const p = props();
    render(<DataTab {...p} />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const click = vi.spyOn(input, 'click');
    await userEvent.click(screen.getByRole('button', { name: /choose a backup file/i }));
    expect(click).toHaveBeenCalledTimes(1);
    expect(input.getAttribute('tabindex')).toBe('-1');
  });

  it('reports a file it could not read and leaves the box alone', async () => {
    const p = props();
    render(<DataTab {...p} />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const bad = new File(['x'], 'broken.json', { type: 'application/json' });
    // jsdom's File.text() is not wired to a body we can break, so stub the reader itself.
    vi.spyOn(bad, 'text').mockRejectedValue(new Error('disk gone'));
    await userEvent.upload(input, bad);
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect((toast.error as ReturnType<typeof vi.fn>).mock.calls[0][0] as string).toMatch(
      /broken\.json/,
    );
    expect(
      (screen.getByRole('textbox', { name: /backup json to import/i }) as HTMLTextAreaElement)
        .value,
    ).toBe('');
  });
});
