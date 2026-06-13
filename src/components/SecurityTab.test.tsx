import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SecurityTab } from './SecurityTab';

const baseSettings = { httpsOnly: true } as never;

describe('SecurityTab', () => {
  it('reflects httpsOnly and toggles it via update', async () => {
    const update = vi.fn();
    render(
      <SecurityTab
        settings={baseSettings}
        update={update}
        listExceptions={async () => []}
        removeException={vi.fn()}
      />,
    );
    const toggle = screen.getByRole('checkbox', { name: /https-only/i });
    expect(toggle).toBeChecked();
    await userEvent.click(toggle);
    expect(update).toHaveBeenCalledWith({ httpsOnly: false });
  });

  it('shows malicious-site protection as on (always)', () => {
    render(
      <SecurityTab settings={baseSettings} update={vi.fn()} listExceptions={async () => []} removeException={vi.fn()} />,
    );
    expect(screen.getByText(/malicious-site protection/i)).toBeInTheDocument();
    expect(screen.getByText(/\bon\b/i)).toBeInTheDocument();
  });

  it('lists exceptions and removes one', async () => {
    const removeException = vi.fn();
    render(
      <SecurityTab
        settings={baseSettings}
        update={vi.fn()}
        listExceptions={async () => ['neverssl.com']}
        removeException={removeException}
      />,
    );
    expect(await screen.findByText('neverssl.com')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /remove/i }));
    expect(removeException).toHaveBeenCalledWith('neverssl.com');
  });
});
