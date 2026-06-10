// src/components/MyFiltersTab.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MyFiltersTab } from './MyFiltersTab';

describe('MyFiltersTab', () => {
  it('shows the current custom-filter text in the textarea', () => {
    render(<MyFiltersTab text={'||ads.example^\n example.com##.banner'} save={vi.fn(async () => {})} />);
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

  it('recomputes the rule count as the textarea is edited', async () => {
    render(<MyFiltersTab text="" save={vi.fn(async () => {})} />);
    expect(screen.getByText(/0 rules/i)).toBeInTheDocument();
    await userEvent.type(screen.getByRole('textbox', { name: /custom filters/i }), '||a.example^\n||b.example^');
    expect(screen.getByText(/2 rules/i)).toBeInTheDocument();
  });

  it('saves the edited text on Save', async () => {
    const save = vi.fn(async () => {});
    render(<MyFiltersTab text="" save={save} />);
    await userEvent.type(screen.getByRole('textbox', { name: /custom filters/i }), '||ads.example^');
    await userEvent.click(screen.getByRole('button', { name: /save filters/i }));
    expect(save).toHaveBeenCalledWith('||ads.example^');
  });
});
