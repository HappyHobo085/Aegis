import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FindState } from '../../shared/types';
import { FindBar } from './FindBar';

const BASE_STATE: FindState = {
  viewId: 1,
  query: '',
  matchCount: 0,
  activeMatchIndex: 0,
};

describe('FindBar', () => {
  beforeEach(() => cleanup());

  it('renders the input with aria-label "Find in page"', () => {
    render(
      <FindBar
        state={BASE_STATE}
        onQueryChange={vi.fn()}
        onNext={vi.fn()}
        onPrev={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole('textbox', { name: 'Find in page' })).toBeTruthy();
  });

  it('input reflects the query from state', () => {
    const state: FindState = { ...BASE_STATE, query: 'hello', matchCount: 2, activeMatchIndex: 1 };
    render(
      <FindBar
        state={state}
        onQueryChange={vi.fn()}
        onNext={vi.fn()}
        onPrev={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect((screen.getByRole('textbox', { name: 'Find in page' }) as HTMLInputElement).value).toBe(
      'hello',
    );
  });

  it('typing in the input fires onQueryChange', async () => {
    const onQueryChange = vi.fn();
    render(
      <FindBar
        state={BASE_STATE}
        onQueryChange={onQueryChange}
        onNext={vi.fn()}
        onPrev={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const input = screen.getByRole('textbox', { name: 'Find in page' });
    await userEvent.type(input, 'abc');
    expect(onQueryChange).toHaveBeenCalled();
  });

  it('shows match count "2/3" when activeMatchIndex=2 matchCount=3', () => {
    const state: FindState = { ...BASE_STATE, query: 'foo', matchCount: 3, activeMatchIndex: 2 };
    render(
      <FindBar
        state={state}
        onQueryChange={vi.fn()}
        onNext={vi.fn()}
        onPrev={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const status = screen.getByRole('status');
    expect(status.textContent).toContain('2');
    expect(status.textContent).toContain('3');
  });

  it('shows 0/0 when matchCount is 0', () => {
    render(
      <FindBar
        state={BASE_STATE}
        onQueryChange={vi.fn()}
        onNext={vi.fn()}
        onPrev={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const status = screen.getByRole('status');
    expect(status.textContent).toContain('0');
  });

  it('clicking "Find next" fires onNext', async () => {
    const onNext = vi.fn();
    const state: FindState = { ...BASE_STATE, query: 'x', matchCount: 2, activeMatchIndex: 1 };
    render(
      <FindBar
        state={state}
        onQueryChange={vi.fn()}
        onNext={onNext}
        onPrev={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Find next' }));
    expect(onNext).toHaveBeenCalledOnce();
  });

  it('clicking "Find previous" fires onPrev', async () => {
    const onPrev = vi.fn();
    const state: FindState = { ...BASE_STATE, query: 'x', matchCount: 2, activeMatchIndex: 1 };
    render(
      <FindBar
        state={state}
        onQueryChange={vi.fn()}
        onNext={vi.fn()}
        onPrev={onPrev}
        onClose={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Find previous' }));
    expect(onPrev).toHaveBeenCalledOnce();
  });

  it('clicking "Close find" fires onClose', async () => {
    const onClose = vi.fn();
    render(
      <FindBar
        state={BASE_STATE}
        onQueryChange={vi.fn()}
        onNext={vi.fn()}
        onPrev={vi.fn()}
        onClose={onClose}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Close find' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('next/prev buttons are disabled when matchCount is 0', () => {
    render(
      <FindBar
        state={BASE_STATE}
        onQueryChange={vi.fn()}
        onNext={vi.fn()}
        onPrev={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect((screen.getByRole('button', { name: 'Find next' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(
      (screen.getByRole('button', { name: 'Find previous' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('next/prev buttons are enabled when matchCount > 0', () => {
    const state: FindState = { ...BASE_STATE, query: 'x', matchCount: 5, activeMatchIndex: 1 };
    render(
      <FindBar
        state={state}
        onQueryChange={vi.fn()}
        onNext={vi.fn()}
        onPrev={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect((screen.getByRole('button', { name: 'Find next' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(
      (screen.getByRole('button', { name: 'Find previous' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('pressing Escape in the input fires onClose', async () => {
    const onClose = vi.fn();
    render(
      <FindBar
        state={BASE_STATE}
        onQueryChange={vi.fn()}
        onNext={vi.fn()}
        onPrev={vi.fn()}
        onClose={onClose}
      />,
    );
    const input = screen.getByRole('textbox', { name: 'Find in page' });
    await userEvent.type(input, '{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('pressing Enter in the input fires onNext', async () => {
    const onNext = vi.fn();
    const state: FindState = { ...BASE_STATE, query: 'x', matchCount: 3, activeMatchIndex: 1 };
    render(
      <FindBar
        state={state}
        onQueryChange={vi.fn()}
        onNext={onNext}
        onPrev={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const input = screen.getByRole('textbox', { name: 'Find in page' });
    await userEvent.type(input, '{Enter}');
    expect(onNext).toHaveBeenCalledOnce();
  });

  it('pressing Shift+Enter in the input fires onPrev', async () => {
    const onPrev = vi.fn();
    const state: FindState = { ...BASE_STATE, query: 'x', matchCount: 3, activeMatchIndex: 2 };
    render(
      <FindBar
        state={state}
        onQueryChange={vi.fn()}
        onNext={vi.fn()}
        onPrev={onPrev}
        onClose={vi.fn()}
      />,
    );
    const input = screen.getByRole('textbox', { name: 'Find in page' });
    await userEvent.keyboard('{Shift>}{Enter}{/Shift}');
    expect(onPrev).toHaveBeenCalledOnce();
  });
});
