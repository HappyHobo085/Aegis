import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AddressBar } from './AddressBar';

describe('AddressBar', () => {
  it('shows the URL and adopts a prop change while not focused', () => {
    const { rerender } = render(<AddressBar url="https://a.example/" onSubmit={vi.fn()} />);
    const input = screen.getByRole('textbox', { name: /address/i });
    expect(input).toHaveValue('https://a.example/');
    rerender(<AddressBar url="https://b.example/" onSubmit={vi.fn()} />);
    expect(input).toHaveValue('https://b.example/');
  });

  it('does not clobber in-progress typing when the URL changes while focused', async () => {
    const { rerender } = render(<AddressBar url="https://a.example/" onSubmit={vi.fn()} />);
    const input = screen.getByRole('textbox', { name: /address/i });
    await userEvent.click(input);
    await userEvent.clear(input);
    await userEvent.type(input, 'my-search');
    // A background navigation updates the URL prop while the user is typing.
    rerender(<AddressBar url="https://background-nav.example/" onSubmit={vi.fn()} />);
    expect(input).toHaveValue('my-search');
  });

  it('reverts an unsubmitted edit to the live URL on blur', async () => {
    render(<AddressBar url="https://a.example/" onSubmit={vi.fn()} />);
    const input = screen.getByRole('textbox', { name: /address/i });
    await userEvent.click(input);
    await userEvent.clear(input);
    await userEvent.type(input, 'half-typed');
    await userEvent.tab();
    expect(input).toHaveValue('https://a.example/');
  });

  it('submits the typed value', async () => {
    const onSubmit = vi.fn();
    render(<AddressBar url="https://a.example/" onSubmit={onSubmit} />);
    const input = screen.getByRole('textbox', { name: /address/i });
    await userEvent.click(input);
    await userEvent.clear(input);
    await userEvent.type(input, 'cats{Enter}');
    expect(onSubmit).toHaveBeenCalledWith('cats');
  });
});
