// src/components/SavedPanel.tsx
import { useEffect, useId, useMemo, useState } from 'react';
import { Bookmark, Pencil, Plus, X } from 'lucide-react';
import type { SavedItem } from '../../shared/types';
import { normalizeSavedUrl } from '../lib/addressParse';
import { TagInput } from './TagInput';
import { TagFilter } from './TagFilter';

export interface SavedPanelProps {
  items: SavedItem[];
  tagUnion: string[];
  activeTags: string[];
  setActiveTags(tags: string[]): void;
  add(input: { url: string; title: string; tags: string[] }): void;
  remove(id: number): Promise<SavedItem[]> | void;
  update(id: number, partial: { title?: string; tags?: string[] }): void;
  renameTag(oldT: string, newT: string): void;
  deleteTag(tag: string): void;
  onOpen(url: string): void;
}

export function SavedPanel({
  items,
  tagUnion,
  activeTags,
  setActiveTags,
  add,
  remove,
  update,
  renameTag,
  deleteTag,
  onOpen,
}: SavedPanelProps) {
  const searchId = useId();
  const [query, setQuery] = useState('');

  // Inline edit (title + tags).
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftTags, setDraftTags] = useState<string[]>([]);

  // Manual add-entry form.
  const [adding, setAdding] = useState(false);
  const [urlDraft, setUrlDraft] = useState('');
  const [titleDraft, setTitleDraft] = useState('');
  const [addTags, setAddTags] = useState<string[]>([]);
  const [addError, setAddError] = useState<string | null>(null);

  // Manage-tags controls.
  const [tagToManage, setTagToManage] = useState('');
  const [renameTo, setRenameTo] = useState('');

  // Drop the managed-tag selection if it leaves tagUnion via any path (e.g. the
  // last item carrying it is edited/removed), so Rename/Delete don't stay enabled
  // for a tag that no longer exists. Pure updater — StrictMode-safe. Mirrors the
  // activeTags prune in useSaved.
  useEffect(() => {
    setTagToManage((prev) => (tagUnion.includes(prev) ? prev : ''));
  }, [tagUnion]);

  const q = query.trim().toLowerCase();
  // Memoized so the filter only recomputes when its inputs change — not on every
  // unrelated re-render (e.g. typing in the add/edit forms, which live in local state).
  const filtered = useMemo(
    () =>
      items.filter((i) => {
        const matchesSearch =
          q.length === 0 || i.title.toLowerCase().includes(q) || i.url.toLowerCase().includes(q);
        const matchesTags = activeTags.every((t) => i.tags.includes(t));
        return matchesSearch && matchesTags;
      }),
    [items, q, activeTags],
  );

  const startEdit = (item: SavedItem): void => {
    setEditingId(item.id);
    setDraftTitle(item.title);
    setDraftTags(item.tags);
  };

  const cancelEdit = (): void => {
    setEditingId(null);
  };

  const saveEdit = (id: number): void => {
    update(id, { title: draftTitle.trim(), tags: draftTags });
    setEditingId(null);
  };

  const openAdd = (): void => {
    setAdding(true);
    setUrlDraft('');
    setTitleDraft('');
    setAddTags([]);
    setAddError(null);
  };

  const cancelAdd = (): void => {
    setAdding(false);
    setAddError(null);
  };

  const submitAdd = (): void => {
    const result = normalizeSavedUrl(urlDraft);
    if (!result.ok) {
      setAddError(result.reason);
      return;
    }
    add({ url: result.url, title: titleDraft.trim(), tags: addTags });
    setAdding(false);
    setAddError(null);
  };

  return (
    <div className="saved-panel" role="group" aria-label="Saved">
      {adding ? (
        <form
          className="saved-panel__add"
          aria-label="Add a saved page"
          onSubmit={(e) => {
            e.preventDefault();
            submitAdd();
          }}
        >
          <input
            className="saved-panel__add-url"
            aria-label="URL to save"
            placeholder="example.com"
            value={urlDraft}
            autoFocus
            onChange={(e) => {
              setUrlDraft(e.target.value);
              if (addError) setAddError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                cancelAdd();
              }
            }}
          />
          <input
            className="saved-panel__add-title"
            aria-label="Title (optional)"
            placeholder="Title (optional)"
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                cancelAdd();
              }
            }}
          />
          <TagInput tags={addTags} suggestions={tagUnion} onChange={setAddTags} />
          {addError && (
            <div className="saved-panel__add-error" role="alert">
              {addError}
            </div>
          )}
          <div className="saved-panel__add-actions">
            <button type="submit" className="saved-panel__add-save">
              Save
            </button>
            <button type="button" className="saved-panel__add-cancel" onClick={cancelAdd}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button type="button" className="saved-panel__add-toggle" onClick={openAdd}>
          <Plus size={14} aria-hidden="true" />
          <span>Add a page</span>
        </button>
      )}
      {items.length > 0 && (
        <form className="saved-panel__search" role="search" onSubmit={(e) => e.preventDefault()}>
          <label htmlFor={searchId} className="saved-panel__search-label">
            Search saved
          </label>
          <input
            id={searchId}
            type="search"
            role="searchbox"
            aria-label="Search saved"
            placeholder="Search saved…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </form>
      )}
      <TagFilter
        tagUnion={tagUnion}
        activeTags={activeTags}
        setActiveTags={setActiveTags}
        label="Filter saved by tag"
      />
      {items.length === 0 ? (
        <div className="saved-panel__empty">
          <Bookmark size={32} aria-hidden="true" />
          <span>Nothing saved yet.</span>
          <span className="saved-panel__empty-hint">
            Save the current page with the bookmark button, or use Add a page above.
          </span>
        </div>
      ) : filtered.length === 0 ? (
        <div className="saved-panel__nomatch">No matches.</div>
      ) : (
        <ul className="saved-panel__list">
          {filtered.map((item) => {
            const label = item.title.length > 0 ? item.title : item.url;
            const isEditing = editingId === item.id;
            return (
              <li key={item.id} className="saved-panel__row">
                {isEditing ? (
                  <div className="saved-panel__editor">
                    <input
                      className="saved-panel__edit-input"
                      aria-label="Edit title"
                      value={draftTitle}
                      autoFocus
                      onChange={(e) => setDraftTitle(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          saveEdit(item.id);
                        } else if (e.key === 'Escape') {
                          e.preventDefault();
                          cancelEdit();
                        }
                      }}
                    />
                    <TagInput tags={draftTags} suggestions={tagUnion} onChange={setDraftTags} />
                    <div className="saved-panel__edit-actions">
                      <button
                        type="button"
                        className="saved-panel__save"
                        onClick={() => saveEdit(item.id)}
                      >
                        Save
                      </button>
                      <button type="button" className="saved-panel__cancel" onClick={cancelEdit}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <button
                      type="button"
                      className="saved-panel__open"
                      aria-label={`Open ${item.url}`}
                      onClick={() => onOpen(item.url)}
                    >
                      <span className="saved-panel__title">{label}</span>
                      <span className="saved-panel__url">{item.url}</span>
                      {item.tags.length > 0 && (
                        <span className="saved-panel__chips">
                          {item.tags.map((t) => (
                            <span key={t} className="saved-panel__chip">
                              {t}
                            </span>
                          ))}
                        </span>
                      )}
                    </button>
                    <button
                      type="button"
                      className="saved-panel__edit"
                      aria-label={`Edit ${label}`}
                      title="Edit title and tags"
                      onClick={() => startEdit(item)}
                    >
                      <Pencil size={14} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="saved-panel__remove"
                      aria-label={`Remove ${label}`}
                      onClick={() => void remove(item.id)}
                    >
                      <X size={14} aria-hidden="true" />
                    </button>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {tagUnion.length > 0 && (
        <details className="saved-panel__manage">
          <summary className="saved-panel__manage-summary">Manage tags</summary>
          <div className="saved-panel__manage-body" role="group" aria-label="Manage tags">
            <div className="saved-panel__manage-tags" role="group" aria-label="Tag to manage">
              {tagUnion.map((t) => (
                <button
                  key={t}
                  type="button"
                  className="saved-panel__manage-chip"
                  aria-pressed={tagToManage === t}
                  onClick={() => setTagToManage(tagToManage === t ? '' : t)}
                >
                  {t}
                </button>
              ))}
            </div>
            <input
              type="text"
              aria-label="Rename tag to"
              placeholder="New tag name"
              value={renameTo}
              onChange={(e) => setRenameTo(e.target.value)}
            />
            <div className="saved-panel__manage-actions">
              <button
                type="button"
                aria-label="Rename tag"
                disabled={tagToManage.length === 0 || renameTo.trim().length === 0}
                onClick={() => {
                  renameTag(tagToManage, renameTo.trim());
                  setRenameTo('');
                  setTagToManage('');
                }}
              >
                Rename tag
              </button>
              <button
                type="button"
                aria-label="Delete tag"
                disabled={tagToManage.length === 0}
                onClick={() => {
                  deleteTag(tagToManage);
                  setTagToManage('');
                }}
              >
                Delete tag
              </button>
            </div>
          </div>
        </details>
      )}
    </div>
  );
}
