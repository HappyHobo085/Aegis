// src/components/TagFilter.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TagFilter } from './TagFilter';

const props = (over: Partial<React.ComponentProps<typeof TagFilter>> = {}) => ({
  tagUnion: ['dev', 'news'],
  activeTags: [] as string[],
  setActiveTags: vi.fn(),
  ...over,
});

describe('TagFilter', () => {
  it('renders one pressable chip per tag in the union', () => {
    render(<TagFilter {...props()} />);
    expect(screen.getByRole('button', { name: /filter by tag dev/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /filter by tag news/i })).toBeInTheDocument();
  });

  it('marks active tags with aria-pressed=true', () => {
    render(<TagFilter {...props({ activeTags: ['dev'] })} />);
    expect(screen.getByRole('button', { name: /filter by tag dev/i })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /filter by tag news/i })).toHaveAttribute('aria-pressed', 'false');
  });

  it('clicking an inactive chip adds it to activeTags', async () => {
    const p = props({ activeTags: ['news'] });
    render(<TagFilter {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /filter by tag dev/i }));
    expect(p.setActiveTags).toHaveBeenCalledWith(['news', 'dev']);
  });

  it('clicking an active chip removes it from activeTags', async () => {
    const p = props({ activeTags: ['dev', 'news'] });
    render(<TagFilter {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /filter by tag dev/i }));
    expect(p.setActiveTags).toHaveBeenCalledWith(['news']);
  });

  it('renders nothing when the tag union is empty', () => {
    const { container } = render(<TagFilter {...props({ tagUnion: [] })} />);
    expect(container).toBeEmptyDOMElement();
  });
});
