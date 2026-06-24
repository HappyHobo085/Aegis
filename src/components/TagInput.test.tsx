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
    const input = screen.getByRole('textbox', { name: /add tag/i });
    await userEvent.type(input, 'dev{Enter}');
    expect(p.onChange).toHaveBeenCalledWith(['news', 'dev']);
  });

  it('does not add a duplicate tag', async () => {
    const p = props();
    render(<TagInput {...p} />);
    const input = screen.getByRole('textbox', { name: /add tag/i });
    await userEvent.type(input, 'news{Enter}');
    expect(p.onChange).not.toHaveBeenCalled();
  });

  it('trims whitespace and ignores an empty entry', async () => {
    const p = props();
    render(<TagInput {...p} />);
    const input = screen.getByRole('textbox', { name: /add tag/i });
    await userEvent.type(input, '   {Enter}');
    expect(p.onChange).not.toHaveBeenCalled();
    await userEvent.type(input, '  design  {Enter}');
    expect(p.onChange).toHaveBeenCalledWith(['news', 'design']);
  });

  it('commits a typed-but-not-Entered tag when the input loses focus', async () => {
    const p = props();
    render(<TagInput {...p} />);
    const input = screen.getByRole('textbox', { name: /add tag/i });
    await userEvent.type(input, 'dev');
    expect(p.onChange).not.toHaveBeenCalled();
    // Blur (e.g. user clicks Save) — the pending tag must not be lost.
    input.blur();
    expect(p.onChange).toHaveBeenCalledWith(['news', 'dev']);
  });

  it('does not commit empty/whitespace on blur', async () => {
    const p = props();
    render(<TagInput {...p} />);
    const input = screen.getByRole('textbox', { name: /add tag/i });
    await userEvent.type(input, '   ');
    input.blur();
    expect(p.onChange).not.toHaveBeenCalled();
  });

  it('does not commit a duplicate tag on blur', async () => {
    const p = props();
    render(<TagInput {...p} />);
    const input = screen.getByRole('textbox', { name: /add tag/i });
    await userEvent.type(input, 'news');
    input.blur();
    expect(p.onChange).not.toHaveBeenCalled();
  });

  it('removing a chip calls onChange without that tag', async () => {
    const p = props({ tags: ['news', 'dev'] });
    render(<TagInput {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /remove tag dev/i }));
    expect(p.onChange).toHaveBeenCalledWith(['news']);
  });

  it('offers in-DOM suggestion buttons, excluding already-added tags', () => {
    render(<TagInput {...props()} />);
    const group = screen.getByRole('group', { name: /tag suggestions/i });
    const labels = within(group)
      .getAllByRole('button')
      .map((b) => b.textContent);
    expect(labels).toEqual(['dev', 'design']);
  });

  it('clicking a suggestion adds that tag via onChange', async () => {
    const p = props();
    render(<TagInput {...p} />);
    const group = screen.getByRole('group', { name: /tag suggestions/i });
    await userEvent.click(within(group).getByRole('button', { name: 'design' }));
    expect(p.onChange).toHaveBeenCalledWith(['news', 'design']);
  });

  it('narrows suggestions by what has been typed', async () => {
    render(<TagInput {...props({ tags: [] })} />);
    const input = screen.getByRole('textbox', { name: /add tag/i });
    await userEvent.type(input, 'de');
    const group = screen.getByRole('group', { name: /tag suggestions/i });
    const labels = within(group)
      .getAllByRole('button')
      .map((b) => b.textContent);
    expect(labels).toEqual(['dev', 'design']);
  });

  it('hides the suggestion group when nothing matches', async () => {
    render(<TagInput {...props({ tags: [] })} />);
    const input = screen.getByRole('textbox', { name: /add tag/i });
    await userEvent.type(input, 'zzz');
    expect(screen.queryByRole('group', { name: /tag suggestions/i })).not.toBeInTheDocument();
  });
});
