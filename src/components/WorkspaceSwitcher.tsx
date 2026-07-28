import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Plus, Pencil, Trash2, Palette } from 'lucide-react';
import type { Workspace } from '../../shared/types';

/** Predefined workspace color palette — each maps to a CSS color. */
const WORKSPACE_COLORS: { label: string; value: string }[] = [
  { label: 'Slate', value: '#64748b' },
  { label: 'Blue', value: '#3b82f6' },
  { label: 'Violet', value: '#8b5cf6' },
  { label: 'Rose', value: '#f43f5e' },
  { label: 'Amber', value: '#f59e0b' },
  { label: 'Emerald', value: '#10b981' },
  { label: 'Cyan', value: '#06b6d4' },
  { label: 'Orange', value: '#f97316' },
];

export interface WorkspaceSwitcherProps {
  workspaces: Workspace[];
  activeWorkspaceId: string;
  onSwitch(id: string): void;
  onCreate(name: string, color?: string): void;
  onRename(id: string, name: string): void;
  onSetColor(id: string, color: string): void;
  onRemove(id: string): void;
  onReorder(ids: string[]): void;
}

/** Context-menu state for right-click on a workspace pill. */
interface CtxMenu {
  wsId: string;
  x: number;
  y: number;
}

function WorkspaceSwitcherInner({
  workspaces,
  activeWorkspaceId,
  onSwitch,
  onCreate,
  onRename,
  onSetColor,
  onRemove,
  onReorder,
}: WorkspaceSwitcherProps) {
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState(WORKSPACE_COLORS[0].value);
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [showColorPicker, setShowColorPicker] = useState<string | null>(null);
  const createInputRef = useRef<HTMLInputElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  const ctxMenuRef = useRef<HTMLDivElement>(null);

  // Focus the create input when entering creation mode
  useEffect(() => {
    if (creating) createInputRef.current?.focus();
  }, [creating]);

  // Focus the edit input when editing a name
  useEffect(() => {
    if (editingId) editInputRef.current?.focus();
  }, [editingId]);

  // Close context menu on outside click
  useEffect(() => {
    if (!ctxMenu) return;
    const handleClick = (e: MouseEvent) => {
      if (ctxMenuRef.current && !ctxMenuRef.current.contains(e.target as Node)) {
        setCtxMenu(null);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [ctxMenu]);

  // Close color picker on outside click
  useEffect(() => {
    if (!showColorPicker) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.ws-color-picker') && !target.closest('.ws-pill__dot')) {
        setShowColorPicker(null);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showColorPicker]);

  const handleCreate = useCallback(() => {
    const trimmed = newName.trim();
    if (!trimmed) {
      setCreating(false);
      return;
    }
    onCreate(trimmed, newColor);
    setNewName('');
    setNewColor(WORKSPACE_COLORS[0].value);
    setCreating(false);
  }, [newName, newColor, onCreate]);

  const handleRenameCommit = useCallback(() => {
    if (!editingId) return;
    const trimmed = editName.trim();
    if (trimmed) {
      onRename(editingId, trimmed);
    }
    setEditingId(null);
    setEditName('');
  }, [editingId, editName, onRename]);

  const handleContextMenu = useCallback((e: React.MouseEvent, ws: Workspace) => {
    e.preventDefault();
    setCtxMenu({ wsId: ws.id, x: e.clientX, y: e.clientY });
    setShowColorPicker(null);
  }, []);

  const handleDragStart = useCallback((e: React.DragEvent, wsId: string) => {
    e.dataTransfer.setData('text/workspace-id', wsId);
    e.dataTransfer.effectAllowed = 'move';
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent, targetId: string) => {
      e.preventDefault();
      const draggedId = e.dataTransfer.getData('text/workspace-id');
      if (!draggedId || draggedId === targetId) return;
      const ids = workspaces.map((w) => w.id);
      const from = ids.indexOf(draggedId);
      const to = ids.indexOf(targetId);
      if (from === -1 || to === -1) return;
      ids.splice(from, 1);
      ids.splice(to, 0, draggedId);
      onReorder(ids);
    },
    [workspaces, onReorder],
  );

  const isDefault = (id: string) => id === 'default';

  return (
    <div className="workspace-switcher" role="toolbar" aria-label="Workspaces">
      <div className="workspace-switcher__scroll">
        {workspaces.map((ws) => {
          const active = ws.id === activeWorkspaceId;
          return (
            <div
              key={ws.id}
              role="button"
              aria-pressed={active}
              aria-label={ws.name}
              className={`ws-pill${active ? ' ws-pill--active' : ''}`}
              draggable
              tabIndex={active ? 0 : -1}
              onClick={() => onSwitch(ws.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSwitch(ws.id);
                }
              }}
              onContextMenu={(e) => handleContextMenu(e, ws)}
              onDragStart={(e) => handleDragStart(e, ws.id)}
              onDragOver={handleDragOver}
              onDrop={(e) => handleDrop(e, ws.id)}
            >
              <span
                className="ws-pill__dot"
                style={{ background: ws.color || '#64748b' }}
                aria-hidden="true"
              />
              {editingId === ws.id ? (
                <input
                  ref={editInputRef}
                  type="text"
                  className="ws-pill__rename-input"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onBlur={handleRenameCommit}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleRenameCommit();
                    if (e.key === 'Escape') {
                      setEditingId(null);
                      setEditName('');
                    }
                  }}
                  onClick={(e) => e.stopPropagation()}
                  maxLength={32}
                />
              ) : (
                <span className="ws-pill__name">{ws.name}</span>
              )}
            </div>
          );
        })}

        {creating ? (
          <div className="ws-pill ws-pill--creating">
            <span
              className="ws-pill__dot ws-pill__dot--clickable"
              style={{ background: newColor }}
              onClick={() => setShowColorPicker(showColorPicker ? null : '__new__')}
              aria-label="Choose workspace color"
            />
            {showColorPicker === '__new__' && (
              <div className="ws-color-picker">
                {WORKSPACE_COLORS.map((c) => (
                  <button
                    key={c.value}
                    type="button"
                    className={`ws-color-picker__swatch${newColor === c.value ? ' ws-color-picker__swatch--active' : ''}`}
                    style={{ background: c.value }}
                    title={c.label}
                    aria-label={c.label}
                    onClick={() => {
                      setNewColor(c.value);
                      setShowColorPicker(null);
                    }}
                  />
                ))}
              </div>
            )}
            <input
              ref={createInputRef}
              type="text"
              className="ws-pill__create-input"
              placeholder="Workspace name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onBlur={() => {
                if (!newName.trim()) setCreating(false);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreate();
                if (e.key === 'Escape') {
                  setCreating(false);
                  setNewName('');
                }
              }}
              maxLength={32}
            />
          </div>
        ) : (
          <button
            type="button"
            className="ws-add"
            aria-label="Create workspace"
            title="New workspace"
            onClick={() => setCreating(true)}
          >
            <Plus size={14} aria-hidden="true" />
          </button>
        )}
      </div>

      {/* Context menu */}
      {ctxMenu && (
        <div
          ref={ctxMenuRef}
          className="ws-ctx-menu"
          style={{ top: ctxMenu.y, left: ctxMenu.x }}
          role="menu"
        >
          <button
            type="button"
            className="ws-ctx-menu__item"
            role="menuitem"
            onClick={() => {
              const ws = workspaces.find((w) => w.id === ctxMenu.wsId);
              if (ws) {
                setEditingId(ws.id);
                setEditName(ws.name);
              }
              setCtxMenu(null);
            }}
          >
            <Pencil size={13} aria-hidden="true" />
            Rename
          </button>
          <button
            type="button"
            className="ws-ctx-menu__item"
            role="menuitem"
            onClick={() => {
              setShowColorPicker(ctxMenu.wsId);
              setCtxMenu(null);
            }}
          >
            <Palette size={13} aria-hidden="true" />
            Color
          </button>
          {showColorPicker === ctxMenu.wsId && (
            <div className="ws-color-picker ws-color-picker--ctx">
              {WORKSPACE_COLORS.map((c) => {
                const ws = workspaces.find((w) => w.id === ctxMenu.wsId);
                return (
                  <button
                    key={c.value}
                    type="button"
                    className={`ws-color-picker__swatch${ws?.color === c.value ? ' ws-color-picker__swatch--active' : ''}`}
                    style={{ background: c.value }}
                    title={c.label}
                    aria-label={c.label}
                    onClick={() => {
                      onSetColor(ctxMenu.wsId, c.value);
                      setShowColorPicker(null);
                    }}
                  />
                );
              })}
            </div>
          )}
          {!isDefault(ctxMenu.wsId) && (
            <button
              type="button"
              className="ws-ctx-menu__item ws-ctx-menu__item--danger"
              role="menuitem"
              onClick={() => {
                onRemove(ctxMenu.wsId);
                setCtxMenu(null);
              }}
            >
              <Trash2 size={13} aria-hidden="true" />
              Delete
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export const WorkspaceSwitcher = memo(WorkspaceSwitcherInner);
