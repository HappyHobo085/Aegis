// src/components/WorkspaceSwitcher.test.tsx
//
// The workspace bar. It is 339 lines of local UI state (create form, inline rename,
// two colour pickers, a context menu, and HTML5 drag reordering) and had no test at
// all. The behaviours worth pinning:
//
//   - every mutation is TRIMMED, and a blank name is rejected rather than creating a
//     nameless workspace;
//   - `default` is NOT deletable (the menu hides Delete for it) — deleting it would
//     leave the core with no workspace to fall back to;
//   - reordering is a real splice (remove-from, insert-at) driven by the ids the
//     dragged pill put on the dataTransfer, and it no-ops for a self-drop or an
//     unknown id rather than corrupting the order.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Workspace } from '../../shared/types';
import { WorkspaceSwitcher, type WorkspaceSwitcherProps } from './WorkspaceSwitcher';

const ws = (id: string, over: Partial<Workspace> = {}): Workspace => ({
  id,
  name: id === 'default' ? 'Default' : id.toUpperCase(),
  color: '#3b82f6',
  tabIndex: 0,
  ...over,
});

const WORKSPACES = [ws('default'), ws('work'), ws('proj')];

function renderSwitcher(over: Partial<WorkspaceSwitcherProps> = {}) {
  const handlers = {
    onSwitch: vi.fn(),
    onCreate: vi.fn(),
    onRename: vi.fn(),
    onSetColor: vi.fn(),
    onRemove: vi.fn(),
    onReorder: vi.fn(),
  };
  const props: WorkspaceSwitcherProps = {
    workspaces: WORKSPACES,
    activeWorkspaceId: 'work',
    ...handlers,
    ...over,
  };
  render(<WorkspaceSwitcher {...props} />);
  return handlers;
}

const pill = (name: string | RegExp) => screen.getByRole('button', { name });

/** A DragEvent carrying a dataTransfer that remembers what was set. */
function dragEvent(type: string, draggedId?: string) {
  const store = new Map<string, string>();
  const event = new Event(type, { bubbles: true, cancelable: true }) as Event & {
    dataTransfer: DataTransfer;
  };
  event.dataTransfer = {
    setData: (k: string, v: string) => void store.set(k, v),
    getData: (k: string) => store.get(k) ?? '',
    effectAllowed: '',
    dropEffect: '',
  } as unknown as DataTransfer;
  if (draggedId !== undefined) store.set('text/workspace-id', draggedId);
  return event;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('WorkspaceSwitcher', () => {
  describe('the pills', () => {
    it('renders one pill per workspace', () => {
      renderSwitcher();
      for (const w of WORKSPACES) expect(pill(w.name)).toBeInTheDocument();
    });

    it('marks only the active workspace as pressed', () => {
      renderSwitcher({ activeWorkspaceId: 'work' });
      expect(pill('Default')).toHaveAttribute('aria-pressed', 'false');
      expect(pill('WORK')).toHaveAttribute('aria-pressed', 'true');
      expect(pill('PROJ')).toHaveAttribute('aria-pressed', 'false');
    });

    it('applies the active modifier class', () => {
      renderSwitcher({ activeWorkspaceId: 'work' });
      expect(pill('WORK')).toHaveClass('ws-pill--active');
      expect(pill('Default')).not.toHaveClass('ws-pill--active');
    });

    it('falls back to the slate dot when a workspace has no colour', () => {
      const { container } = render(
        <WorkspaceSwitcher
          {...{
            workspaces: [ws('a', { color: '' })],
            activeWorkspaceId: 'a',
            onSwitch: vi.fn(),
            onCreate: vi.fn(),
            onRename: vi.fn(),
            onSetColor: vi.fn(),
            onRemove: vi.fn(),
            onReorder: vi.fn(),
          }}
        />,
      );
      const dot = container.querySelector('.ws-pill__dot') as HTMLElement;
      expect(dot.style.background).toBe('rgb(100, 116, 139)'); // #64748b
    });

    it('switches on click', async () => {
      const h = renderSwitcher();
      await userEvent.click(pill('PROJ'));
      expect(h.onSwitch).toHaveBeenCalledWith('proj');
    });

    it('switches on Enter', async () => {
      const h = renderSwitcher();
      pill('PROJ').focus();
      await userEvent.keyboard('{Enter}');
      expect(h.onSwitch).toHaveBeenCalledWith('proj');
    });

    it('switches on Space', async () => {
      const h = renderSwitcher();
      pill('PROJ').focus();
      await userEvent.keyboard(' ');
      expect(h.onSwitch).toHaveBeenCalledWith('proj');
    });

    it('does not switch on an unrelated key', async () => {
      const h = renderSwitcher();
      pill('PROJ').focus();
      await userEvent.keyboard('x');
      expect(h.onSwitch).not.toHaveBeenCalled();
    });

    // Roving tabindex: only the active pill is in the tab order, so Tab moves out of
    // the bar instead of walking every workspace.
    it('puts only the active pill in the tab order', () => {
      renderSwitcher({ activeWorkspaceId: 'work' });
      expect(pill('WORK')).toHaveAttribute('tabindex', '0');
      expect(pill('Default')).toHaveAttribute('tabindex', '-1');
      expect(pill('PROJ')).toHaveAttribute('tabindex', '-1');
    });

    it('is a labelled toolbar', () => {
      renderSwitcher();
      expect(screen.getByRole('toolbar', { name: 'Workspaces' })).toBeInTheDocument();
    });
  });

  describe('creating', () => {
    const openCreate = async () => {
      await userEvent.click(screen.getByRole('button', { name: 'Create workspace' }));
      return screen.getByPlaceholderText('Workspace name');
    };

    it('opens a name field when the add button is clicked', async () => {
      renderSwitcher();
      const input = await openCreate();
      expect(input).toHaveFocus();
    });

    it('hides the add button while the form is open', async () => {
      renderSwitcher();
      await openCreate();
      expect(screen.queryByRole('button', { name: 'Create workspace' })).not.toBeInTheDocument();
    });

    it('creates with the typed name and the default colour', async () => {
      const h = renderSwitcher();
      const input = await openCreate();
      await userEvent.type(input, 'Research');
      await userEvent.keyboard('{Enter}');
      expect(h.onCreate).toHaveBeenCalledWith('Research', '#64748b');
    });

    it('trims the name before creating', async () => {
      const h = renderSwitcher();
      const input = await openCreate();
      await userEvent.type(input, '  Research  ');
      await userEvent.keyboard('{Enter}');
      expect(h.onCreate).toHaveBeenCalledWith('Research', '#64748b');
    });

    it('refuses a whitespace-only name and closes the form', async () => {
      const h = renderSwitcher();
      const input = await openCreate();
      await userEvent.type(input, '   ');
      await userEvent.keyboard('{Enter}');
      expect(h.onCreate).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Create workspace' })).toBeInTheDocument();
    });

    it('closes the form on Escape without creating', async () => {
      const h = renderSwitcher();
      const input = await openCreate();
      await userEvent.type(input, 'Research');
      await userEvent.keyboard('{Escape}');
      expect(h.onCreate).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Create workspace' })).toBeInTheDocument();
    });

    it('blurring an empty form cancels it, but keeps a typed one', async () => {
      renderSwitcher();
      const input = await openCreate();
      fireEvent.blur(input);
      expect(screen.getByRole('button', { name: 'Create workspace' })).toBeInTheDocument();
    });

    it('reopens empty after a successful create', async () => {
      renderSwitcher();
      let input = await openCreate();
      await userEvent.type(input, 'Research');
      await userEvent.keyboard('{Enter}');
      input = await openCreate();
      expect(input).toHaveValue('');
    });

    it('caps the name at 32 characters', async () => {
      renderSwitcher();
      const input = await openCreate();
      expect(input).toHaveAttribute('maxlength', '32');
    });

    it('picks a colour for the new workspace', async () => {
      const h = renderSwitcher();
      await openCreate();
      await userEvent.click(screen.getByLabelText('Choose workspace color'));
      await userEvent.click(screen.getByRole('button', { name: 'Rose' }));
      const input = screen.getByPlaceholderText('Workspace name');
      await userEvent.type(input, 'Research');
      await userEvent.keyboard('{Enter}');
      expect(h.onCreate).toHaveBeenCalledWith('Research', '#f43f5e');
    });
  });

  describe('the context menu', () => {
    const openMenu = (name: string | RegExp) => {
      fireEvent.contextMenu(pill(name));
      return screen.getByRole('menu');
    };

    it('opens on right-click', () => {
      renderSwitcher();
      fireEvent.contextMenu(pill('PROJ'));
      expect(screen.getByRole('menu')).toBeInTheDocument();
    });

    it('positions itself at the pointer', () => {
      renderSwitcher();
      fireEvent.contextMenu(pill('PROJ'), { clientX: 120, clientY: 240 });
      const menu = screen.getByRole('menu');
      expect(menu.style.left).toBe('120px');
      expect(menu.style.top).toBe('240px');
    });

    it('closes on an outside mousedown', () => {
      renderSwitcher();
      openMenu('PROJ');
      fireEvent.mouseDown(document.body);
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });

    it('stays open on a mousedown inside itself', () => {
      renderSwitcher();
      const menu = openMenu('PROJ');
      fireEvent.mouseDown(menu);
      expect(screen.getByRole('menu')).toBeInTheDocument();
    });

    it('removes its document listener when it closes', () => {
      renderSwitcher();
      openMenu('PROJ');
      fireEvent.mouseDown(document.body);
      // A second outside click must not throw against a stale listener.
      expect(() => fireEvent.mouseDown(document.body)).not.toThrow();
    });

    it('offers Rename and Color', () => {
      renderSwitcher();
      const menu = openMenu('PROJ');
      expect(within(menu).getByRole('menuitem', { name: /Rename/ })).toBeInTheDocument();
      expect(within(menu).getByRole('menuitem', { name: /Color/ })).toBeInTheDocument();
    });
  });

  describe('deleting', () => {
    const openMenu = (name: string | RegExp) => {
      fireEvent.contextMenu(pill(name));
      return screen.getByRole('menu');
    };

    // `default` is the fallback workspace the core assumes exists, so the menu must
    // not offer to delete it.
    it('hides Delete for the default workspace', () => {
      renderSwitcher();
      const menu = openMenu('Default');
      expect(within(menu).queryByRole('menuitem', { name: /Delete/ })).not.toBeInTheDocument();
    });

    it('offers Delete for a non-default workspace', () => {
      renderSwitcher();
      const menu = openMenu('PROJ');
      expect(within(menu).getByRole('menuitem', { name: /Delete/ })).toBeInTheDocument();
    });

    it('removes the requested workspace', async () => {
      const h = renderSwitcher();
      const menu = openMenu('PROJ');
      await userEvent.click(within(menu).getByRole('menuitem', { name: /Delete/ }));
      expect(h.onRemove).toHaveBeenCalledWith('proj');
    });

    it('closes the menu after deleting', async () => {
      renderSwitcher();
      const menu = openMenu('PROJ');
      await userEvent.click(within(menu).getByRole('menuitem', { name: /Delete/ }));
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
  });

  describe('renaming', () => {
    const startRename = async (name: string | RegExp) => {
      fireEvent.contextMenu(pill(name));
      await userEvent.click(
        within(screen.getByRole('menu')).getByRole('menuitem', { name: /Rename/ }),
      );
      return screen.getByDisplayValue(
        name instanceof RegExp ? (pill(name).textContent ?? '') : name,
      );
    };

    it('swaps the label for a focused input', async () => {
      renderSwitcher();
      const input = await startRename('PROJ');
      expect(input).toHaveFocus();
      expect(input).toHaveClass('ws-pill__rename-input');
    });

    it('commits the new name on Enter, trimmed', async () => {
      const h = renderSwitcher();
      const input = await startRename('PROJ');
      await userEvent.clear(input);
      await userEvent.type(input, '  Projects  ');
      await userEvent.keyboard('{Enter}');
      expect(h.onRename).toHaveBeenCalledWith('proj', 'Projects');
    });

    it('commits on blur', async () => {
      const h = renderSwitcher();
      const input = await startRename('PROJ');
      await userEvent.clear(input);
      await userEvent.type(input, 'Projects');
      fireEvent.blur(input);
      expect(h.onRename).toHaveBeenCalledWith('proj', 'Projects');
    });

    it('rejects a blank rename but still closes the editor', async () => {
      const h = renderSwitcher();
      const input = await startRename('PROJ');
      await userEvent.clear(input);
      await userEvent.type(input, '   ');
      await userEvent.keyboard('{Enter}');
      expect(h.onRename).not.toHaveBeenCalled();
      expect(screen.getByText('PROJ')).toBeInTheDocument();
    });

    it('cancels on Escape without renaming', async () => {
      const h = renderSwitcher();
      const input = await startRename('PROJ');
      await userEvent.clear(input);
      await userEvent.type(input, 'Projects');
      await userEvent.keyboard('{Escape}');
      expect(h.onRename).not.toHaveBeenCalled();
      expect(screen.getByText('PROJ')).toBeInTheDocument();
    });

    it('clicking inside the input does not switch workspaces', async () => {
      const h = renderSwitcher();
      const input = await startRename('PROJ');
      await userEvent.click(input);
      expect(h.onSwitch).not.toHaveBeenCalled();
    });

    it('caps the name at 32 characters', async () => {
      renderSwitcher();
      const input = await startRename('PROJ');
      expect(input).toHaveAttribute('maxlength', '32');
    });
  });

  describe('colour', () => {
    it('opens a picker from the context menu and applies the swatch', async () => {
      const h = renderSwitcher();
      fireEvent.contextMenu(pill('PROJ'));
      await userEvent.click(
        within(screen.getByRole('menu')).getByRole('menuitem', { name: /Color/ }),
      );
      await userEvent.click(screen.getByRole('button', { name: 'Emerald' }));
      expect(h.onSetColor).toHaveBeenCalledWith('proj', '#10b981');
    });

    it('closes the picker after choosing', async () => {
      renderSwitcher();
      fireEvent.contextMenu(pill('PROJ'));
      await userEvent.click(
        within(screen.getByRole('menu')).getByRole('menuitem', { name: /Color/ }),
      );
      await userEvent.click(screen.getByRole('button', { name: 'Emerald' }));
      expect(screen.queryByRole('button', { name: 'Emerald' })).not.toBeInTheDocument();
    });

    it('an outside mousedown closes the picker', async () => {
      renderSwitcher();
      fireEvent.contextMenu(pill('PROJ'));
      await userEvent.click(
        within(screen.getByRole('menu')).getByRole('menuitem', { name: /Color/ }),
      );
      fireEvent.mouseDown(document.body);
      expect(screen.queryByRole('button', { name: 'Emerald' })).not.toBeInTheDocument();
    });

    it('a mousedown inside the picker does not close it', async () => {
      renderSwitcher();
      fireEvent.contextMenu(pill('PROJ'));
      await userEvent.click(
        within(screen.getByRole('menu')).getByRole('menuitem', { name: /Color/ }),
      );
      fireEvent.mouseDown(screen.getByRole('button', { name: 'Emerald' }));
      expect(screen.getByRole('button', { name: 'Emerald' })).toBeInTheDocument();
    });

    it('marks the workspace’s current colour as active', async () => {
      renderSwitcher({ workspaces: [ws('default'), ws('proj', { color: '#10b981' })] });
      fireEvent.contextMenu(pill('PROJ'));
      await userEvent.click(
        within(screen.getByRole('menu')).getByRole('menuitem', { name: /Color/ }),
      );
      expect(screen.getByRole('button', { name: 'Emerald' })).toHaveClass(
        'ws-color-picker__swatch--active',
      );
    });

    it('opening the menu closes a colour picker opened from the dot', async () => {
      renderSwitcher();
      fireEvent.contextMenu(pill('PROJ'));
      await userEvent.click(
        within(screen.getByRole('menu')).getByRole('menuitem', { name: /Color/ }),
      );
      expect(screen.getByRole('button', { name: 'Emerald' })).toBeInTheDocument();
      fireEvent.contextMenu(pill('WORK'));
      // The picker belonged to the previous menu's workspace, so it is gone.
      expect(screen.queryByRole('button', { name: 'Emerald' })).not.toBeInTheDocument();
    });
  });

  describe('drag reordering', () => {
    // ids start as ['default','work','proj']; dragging 'default' onto 'proj' removes
    // index 0 and re-inserts it at the target's index 2 → ['work','proj','default'].
    it('reorders by splicing the dragged id to the drop position', () => {
      const h = renderSwitcher();
      pill('Default').dispatchEvent(dragEvent('dragstart', 'default'));
      pill('PROJ').dispatchEvent(dragEvent('drop', 'default'));
      expect(h.onReorder).toHaveBeenCalledWith(['work', 'proj', 'default']);
    });

    it('moves a later workspace earlier', () => {
      const h = renderSwitcher();
      pill('PROJ').dispatchEvent(dragEvent('dragstart', 'proj'));
      pill('Default').dispatchEvent(dragEvent('drop', 'proj'));
      expect(h.onReorder).toHaveBeenCalledWith(['proj', 'default', 'work']);
    });

    it('a self-drop is a no-op', () => {
      const h = renderSwitcher();
      pill('PROJ').dispatchEvent(dragEvent('dragstart', 'proj'));
      pill('PROJ').dispatchEvent(dragEvent('drop', 'proj'));
      expect(h.onReorder).not.toHaveBeenCalled();
    });

    it('a drop with no dragged id is a no-op', () => {
      const h = renderSwitcher();
      pill('PROJ').dispatchEvent(dragEvent('drop'));
      expect(h.onReorder).not.toHaveBeenCalled();
    });

    it('a drop of an id that is not in the list is a no-op', () => {
      const h = renderSwitcher();
      pill('PROJ').dispatchEvent(dragEvent('dragstart', 'ghost'));
      pill('Default').dispatchEvent(dragEvent('drop', 'ghost'));
      expect(h.onReorder).not.toHaveBeenCalled();
    });

    it('marks the drag as a move so the cursor shows it', () => {
      renderSwitcher();
      const event = dragEvent('dragstart', 'proj');
      pill('PROJ').dispatchEvent(event);
      expect(event.dataTransfer.effectAllowed).toBe('move');
    });

    it('allows a drop on dragover (without it the browser refuses the drop)', () => {
      renderSwitcher();
      const over = dragEvent('dragover');
      pill('PROJ').dispatchEvent(over);
      expect(over.defaultPrevented).toBe(true);
      expect(over.dataTransfer.dropEffect).toBe('move');
    });

    it('the reorder is computed from the current list, not from the DOM order', () => {
      const h = renderSwitcher();
      pill('Default').dispatchEvent(dragEvent('dragstart', 'default'));
      pill('WORK').dispatchEvent(dragEvent('drop', 'default'));
      expect(h.onReorder).toHaveBeenCalledWith(['work', 'default', 'proj']);
    });
  });
});
