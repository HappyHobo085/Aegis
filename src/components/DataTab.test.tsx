// src/components/DataTab.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
    onImport: vi.fn(async (_mode: ImportMode) => ({ ok: true, counts: {} })),
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

  it('reports a success toast after a completed import', async () => {
    const p = props();
    render(<DataTab {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /^import$/i }));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });
});
