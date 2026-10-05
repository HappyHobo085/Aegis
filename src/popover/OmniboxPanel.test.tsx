import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { OmniboxPanel } from './OmniboxPanel';
import type { PopoverSurfacePayload } from '../../shared/types';

const picked = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../lib/surfaceApi', () => ({ picked }));

const ROW = {
  id: 'h1',
  kind: 'history',
  title: 'A page',
  url: 'https://example.com/',
  target: 'https://example.com/',
  titleMatches: [],
  urlMatches: [],
} as const;

const ROW2 = { ...ROW, id: 'h2', title: 'Another page' };

function shown(payload: Record<string, unknown>): PopoverSurfacePayload {
  return {
    id: 'address-omnibox',
    rect: { x: 0, y: 40, width: 600, height: 200 },
    payload: { kind: 'address-omnibox', ...payload },
  };
}

beforeEach(() => {
  picked.mockClear();
});

describe('OmniboxPanel', () => {
  it('renders the rows the chrome sent', () => {
    render(<OmniboxPanel shown={shown({ suggestions: [ROW, ROW2], activeIndex: -1 })} />);
    expect(screen.getAllByRole('option')).toHaveLength(2);
    expect(screen.getByText('A page')).toBeTruthy();
  });

  it('renders the chrome cursor, because the keyboard never crosses into this webview', () => {
    render(<OmniboxPanel shown={shown({ suggestions: [ROW, ROW2], activeIndex: 1 })} />);
    const options = screen.getAllByRole('option');
    expect(options[0].getAttribute('aria-selected')).toBe('false');
    expect(options[1].getAttribute('aria-selected')).toBe('true');
  });

  // The surface may only report an INDEX. Rust bounds-checks it against the itemCount the
  // chrome declared, and the chrome then picks from its OWN array — so a surface that
  // reported a suggestion object would be reporting data it does not own.
  it('reports the INDEX of the row the user pressed, never the row itself', () => {
    render(<OmniboxPanel shown={shown({ suggestions: [ROW, ROW2], activeIndex: -1 })} />);
    screen.getAllByRole('option')[1].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(picked).toHaveBeenCalledTimes(1);
    expect(picked).toHaveBeenCalledWith({ id: 'address-omnibox', index: 1 });
  });

  it('reports a hover as an index plus the hover action', () => {
    render(<OmniboxPanel shown={shown({ suggestions: [ROW, ROW2], activeIndex: -1 })} />);
    screen.getAllByRole('option')[0].dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    // `onMouseEnter` is what React binds; a raw `mouseover` bubbles into it for this tree.
    expect(picked).toHaveBeenCalledWith({ id: 'address-omnibox', action: 'hover', index: 0 });
  });

  it('renders nothing when the payload is not renderable, rather than half a list', () => {
    const { container } = render(<OmniboxPanel shown={shown({ suggestions: 'nope' })} />);
    expect(container.textContent).toBe('');
  });

  it('renders the rows it could validate when one row is malformed', () => {
    const { container } = render(
      <OmniboxPanel shown={shown({ suggestions: [ROW, { ...ROW2, titleMatches: 3 }] })} />,
    );
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(container.textContent).toContain('A page');
  });
});
