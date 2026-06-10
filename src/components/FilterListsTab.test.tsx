// src/components/FilterListsTab.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Subscription, ListUpdateResult } from '../../shared/types';
import { FilterListsTab } from './FilterListsTab';

const sub = (over: Partial<Subscription> = {}): Subscription => ({
  listId: 'easylist',
  url: 'https://lists.example/easylist.txt',
  enabled: true,
  lastUpdated: 1700000000000,
  etag: null,
  hash: null,
  ...over,
});

const props = (over: Partial<React.ComponentProps<typeof FilterListsTab>> = {}) => ({
  subs: [
    sub({ listId: 'easylist', url: 'https://lists.example/easylist.txt', enabled: true }),
    sub({ listId: 'easyprivacy', url: 'https://lists.example/easyprivacy.txt', enabled: false }),
  ],
  setEnabled: vi.fn(async () => {}),
  add: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
  updateNow: vi.fn<[], Promise<ListUpdateResult>>(async () => ({ perSource: [], lastUpdated: 0 })),
  ...over,
});

describe('FilterListsTab', () => {
  it('lists each subscription by listId and url', () => {
    render(<FilterListsTab {...props()} />);
    expect(screen.getByText('easylist')).toBeInTheDocument();
    expect(screen.getByText('https://lists.example/easylist.txt')).toBeInTheDocument();
    expect(screen.getByText('easyprivacy')).toBeInTheDocument();
  });

  it('reflects the enabled state of each list in its switch', () => {
    render(<FilterListsTab {...props()} />);
    expect(screen.getByRole('switch', { name: /enable list easylist/i })).toBeChecked();
    expect(screen.getByRole('switch', { name: /enable list easyprivacy/i })).not.toBeChecked();
  });

  it('toggling a list calls setEnabled with the inverted value', async () => {
    const p = props();
    render(<FilterListsTab {...p} />);
    await userEvent.click(screen.getByRole('switch', { name: /enable list easylist/i }));
    expect(p.setEnabled).toHaveBeenCalledWith('easylist', false);
  });

  it('adds a custom list URL from the add form', async () => {
    const p = props();
    render(<FilterListsTab {...p} />);
    const form = screen.getByRole('group', { name: /add filter list/i });
    await userEvent.type(within(form).getByRole('textbox', { name: /list url/i }), 'https://lists.example/custom.txt');
    await userEvent.click(within(form).getByRole('button', { name: /^add list$/i }));
    expect(p.add).toHaveBeenCalledWith('https://lists.example/custom.txt');
  });

  it('removes a list via its row Remove button', async () => {
    const p = props();
    render(<FilterListsTab {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /remove list easyprivacy/i }));
    expect(p.remove).toHaveBeenCalledWith('easyprivacy');
  });

  it('force-update-all calls updateNow and renders the per-source results', async () => {
    const updateNow = vi.fn<[], Promise<ListUpdateResult>>(async () => ({
      perSource: [
        { listId: 'easylist', ok: true },
        { listId: 'easyprivacy', ok: false, error: 'timeout' },
      ],
      lastUpdated: 1700000001000,
    }));
    render(<FilterListsTab {...props({ updateNow })} />);
    await userEvent.click(screen.getByRole('button', { name: /update all/i }));
    expect(updateNow).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/easyprivacy.*timeout/i)).toBeInTheDocument();
  });
});
