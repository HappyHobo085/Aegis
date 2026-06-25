// src/components/MyFiltersTab.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
import { toast } from '../lib/toast';

import { MyFiltersTab } from './MyFiltersTab';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('MyFiltersTab', () => {
  it('shows the current custom-filter text in the textarea', () => {
    render(
      <MyFiltersTab text={'||ads.example^\n example.com##.banner'} save={vi.fn(async () => {})} />,
    );
    expect(screen.getByRole('textbox', { name: /custom filters/i })).toHaveValue(
      '||ads.example^\n example.com##.banner',
    );
  });

  it('counts non-empty, non-comment lines as rules', () => {
    render(
      <MyFiltersTab
        text={'! a comment\n||ads.example^\n\n example.com##.banner\n   \n! another'}
        save={vi.fn(async () => {})}
      />,
    );
    expect(screen.getByText(/2 rules/i)).toBeInTheDocument();
  });

  it('adopts externally-changed filter text when the textarea is not edited', () => {
    const { rerender } = render(<MyFiltersTab text="||a.example^" save={vi.fn(async () => {})} />);
    const area = screen.getByRole('textbox', { name: /custom filters/i });
    expect(area).toHaveValue('||a.example^');
    rerender(<MyFiltersTab text="||b.example^" save={vi.fn(async () => {})} />);
    expect(area).toHaveValue('||b.example^');
  });

  it('keeps an in-progress edit when the prop changes externally', async () => {
    const { rerender } = render(<MyFiltersTab text="||a.example^" save={vi.fn(async () => {})} />);
    const area = screen.getByRole('textbox', { name: /custom filters/i });
    await userEvent.clear(area);
    await userEvent.type(area, '||my-edit^');
    rerender(<MyFiltersTab text="||b.example^" save={vi.fn(async () => {})} />);
    expect(area).toHaveValue('||my-edit^');
  });

  it('recomputes the rule count as the textarea is edited', async () => {
    render(<MyFiltersTab text="" save={vi.fn(async () => {})} />);
    expect(screen.getByText(/0 rules/i)).toBeInTheDocument();
    await userEvent.type(
      screen.getByRole('textbox', { name: /custom filters/i }),
      '||a.example^\n||b.example^',
    );
    expect(screen.getByText(/2 rules/i)).toBeInTheDocument();
  });

  it('saves the edited text on Save', async () => {
    const save = vi.fn(async () => {});
    render(<MyFiltersTab text="" save={save} />);
    await userEvent.type(
      screen.getByRole('textbox', { name: /custom filters/i }),
      '||ads.example^',
    );
    await userEvent.click(screen.getByRole('button', { name: /save filters/i }));
    expect(save).toHaveBeenCalledWith('||ads.example^');
  });

  it('toasts "Saved" after a successful save', async () => {
    const save = vi.fn(async () => {});
    render(<MyFiltersTab text="||x^" save={save} />);
    await userEvent.click(screen.getByRole('button', { name: /save filters/i }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Saved'));
  });
});
