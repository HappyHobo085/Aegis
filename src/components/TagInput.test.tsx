// src/components/TagInput.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TagInput } from './TagInput';

const props = (over: Partial<React.ComponentProps<typeof TagInput>> = {}) => ({
  tags: ['news'] as string[],
  suggestions: ['dev', 'news', 'design'],
  onChange: vi.fn(),
  ...over,
});

describe('TagInput', () => {
  it('renders the current tags as removable chips', () => {
    render(<TagInput {...props()} />);
    expect(screen.getByText('news')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /remove tag news/i })).toBeInTheDocument();
  });

  it('typing a tag and pressing Enter adds it via onChange', async () => {
    const p = props();
    render(<TagInput {...p} />);
    const input = screen.getByRole('combobox', { name: /add tag/i });
    await userEvent.type(input, 'dev{Enter}');
    expect(p.onChange).toHaveBeenCalledWith(['news', 'dev']);
  });

  it('does not add a duplicate tag', async () => {
    const p = props();
    render(<TagInput {...p} />);
    const input = screen.getByRole('combobox', { name: /add tag/i });
    await userEvent.type(input, 'news{Enter}');
    expect(p.onChange).not.toHaveBeenCalled();
  });

  it('trims whitespace and ignores an empty entry', async () => {
    const p = props();
    render(<TagInput {...p} />);
    const input = screen.getByRole('combobox', { name: /add tag/i });
    await userEvent.type(input, '   {Enter}');
    expect(p.onChange).not.toHaveBeenCalled();
    await userEvent.type(input, '  design  {Enter}');
    expect(p.onChange).toHaveBeenCalledWith(['news', 'design']);
  });

  it('removing a chip calls onChange without that tag', async () => {
    const p = props({ tags: ['news', 'dev'] });
    render(<TagInput {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /remove tag dev/i }));
    expect(p.onChange).toHaveBeenCalledWith(['news']);
  });

  it('offers autocomplete suggestions via a datalist (excluding already-added tags)', () => {
    render(<TagInput {...props()} />);
    const input = screen.getByRole('combobox', { name: /add tag/i });
    const listId = input.getAttribute('list');
    expect(listId).toBeTruthy();
    const datalist = document.getElementById(listId!) as HTMLDataListElement;
    const options = within(datalist).queryAllByRole('option', { hidden: true }).map((o) => o.getAttribute('value'));
    expect(options).toEqual(['dev', 'design']);
  });
});
