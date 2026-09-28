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

  it('does NOT toast success when export is canceled', async () => {
    const p = props({ onExport: vi.fn(async () => ({ ok: false })) });
    render(<DataTab {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /^export$/i }));
    await waitFor(() => expect(p.onExport).toHaveBeenCalled());
    expect(toast.success).not.toHaveBeenCalled();
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

  it('imports pasted JSON (no native file picker) when the paste field is filled', async () => {
    const p = props();
    render(<DataTab {...p} />);
    fireEvent.change(screen.getByRole('textbox', { name: /backup json to import/i }), {
      target: { value: '{"version":1}' },
    });
    await userEvent.click(screen.getByRole('button', { name: /^import$/i }));
    expect(p.onImport).toHaveBeenCalledWith('merge', { text: '{"version":1}' });
  });
});
