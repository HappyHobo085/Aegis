// src/components/DataTab.tsx
import { useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import type { DataExportResult, ImportMode } from '../../shared/types';
import { confirm, toast } from '../lib/toast';

export interface DataTabProps {
  onExport(): Promise<DataExportResult>;
  onImport(mode: ImportMode, source?: { text?: string }): Promise<ImportResult>;
}

/**
 * The core's `data.import` reply.
 *
 * `failed` names the stores whose file could NOT be written. It is empty on success, and
 * also empty on the refusals where the bundle never parsed (nothing was written, so nothing
 * is named) — so a non-empty `failed` means "some of this restore did not land" and the
 * counts beside it belong to the stores that did.
 */
export interface ImportResult {
  ok: boolean;
  counts?: unknown;
  failed?: string[];
}

export function DataTab({ onExport, onImport }: DataTabProps) {
  const [mode, setMode] = useState<ImportMode>('merge');
  const [pasteText, setPasteText] = useState('');
  const [busy, setBusy] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const handleExport = async (): Promise<void> => {
    setBusy(true);
    try {
      const res = await onExport();
      if (res.ok) {
        toast.success(`Exported to ${res.path ?? 'file'}.`);
      } else {
        // A refusal here is a failed WRITE, not a cancellation: there is no save
        // dialog (the core picks the path), so `ok: false` means the bundle is NOT
        // on disk. Saying nothing was the worst option available — the user is left
        // believing they have a backup they do not have, and a restore later finds
        // nothing. The core's reason is shown when there is one, because "no space
        // left" and "the folder is not writable" need different things from the
        // reader; the fallback still says plainly that the export failed.
        toast.error(
          res.error ? `Export failed: ${res.error}` : 'Export failed — no backup was written.',
        );
      }
    } finally {
      setBusy(false);
    }
  };

  /**
   * Read the chosen file into the paste box rather than importing it straight away.
   *
   * Two reasons, both about not taking a choice away from the user:
   *
   * - The paste box is where a restore can be READ before it is run, and `replace`
   *   mode is destructive. Importing on `change` would restore a file nobody looked
   *   at, and would do it behind the user instead of behind the Import button.
   * - It reuses the one already-tested path. `onImport(mode, { text })` and the
   *   `replace`-mode confirm above are untouched, and the failure message that
   *   promises "your pasted backup has been kept" stays literally true.
   */
  const handleFile = async (e: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0];
    // Reset the value FIRST. `change` only fires when the value actually changes, so
    // picking the same file twice in a row would otherwise silently do nothing the
    // second time. The `File` is already in hand, so clearing cannot lose it.
    e.target.value = '';
    if (!file) return;
    try {
      setPasteText(await file.text());
      setFileName(file.name);
    } catch (err) {
      setFileName(null);
      toast.error(`Could not read ${file.name}: ${String(err)}`);
    }
  };

  const handleImport = async (): Promise<void> => {
    if (mode === 'replace') {
      const ok = await confirm(
        'Replace all favorites, history, saved items and settings with the imported data? This cannot be undone.',
        { destructive: true },
      );
      if (!ok) return;
    }
    setBusy(true);
    try {
      const text = pasteText.trim();
      const res = text ? await onImport(mode, { text }) : await onImport(mode);
      if (res.ok) {
        toast.success('Import complete.');
        setPasteText('');
        setFileName(null);
      } else {
        // The draft is deliberately NOT cleared on a failure: it is the user's only copy of
        // the backup, and discarding it would strand them with a restore that did not finish.
        const failed = res.failed ?? [];
        toast.error(
          failed.length > 0
            ? `Import incomplete — could not save: ${failed.join(', ')}. Everything else was imported; your pasted backup has been kept.`
            : 'Import failed — check the pasted JSON or the backup in Downloads.',
        );
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="data-tab" role="group" aria-label="Data export and import">
      <div className="data-tab__export">
        <button type="button" disabled={busy} onClick={() => void handleExport()}>
          Export
        </button>
        <p className="data-tab__hint">Saves a backup to your Downloads folder.</p>
      </div>

      <fieldset className="data-tab__mode">
        <legend>Import mode</legend>
        <label>
          <input
            type="radio"
            name="data-tab-mode"
            value="merge"
            checked={mode === 'merge'}
            onChange={() => setMode('merge')}
          />
          Merge
        </label>
        <label>
          <input
            type="radio"
            name="data-tab-mode"
            value="replace"
            checked={mode === 'replace'}
            onChange={() => setMode('replace')}
          />
          Replace
        </label>
      </fieldset>

      {/* The input is the real control; the button above it is what a user clicks.
          `tabIndex={-1}` keeps the hidden input out of the tab order so it is not a
          second, invisible stop between the mode radios and the Import button. */}
      <div className="data-tab__pick">
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          onChange={(e) => void handleFile(e)}
          className="sr-only"
          tabIndex={-1}
          aria-label="Backup file to import"
        />
        <button type="button" disabled={busy} onClick={() => fileRef.current?.click()}>
          Choose a backup file…
        </button>
        {fileName && (
          <span className="data-tab__hint" data-testid="data-tab-picked">
            Loaded {fileName} into the box below.
          </span>
        )}
      </div>

      <label className="data-tab__paste">
        <span>Paste backup JSON</span>
        <textarea
          value={pasteText}
          onChange={(e) => setPasteText(e.target.value)}
          disabled={busy}
          rows={5}
          spellCheck={false}
          placeholder="Paste the contents of an aegis-export.json backup here…"
          aria-label="Backup JSON to import"
        />
        <span className="data-tab__hint">
          Leave empty to restore the last export from your Downloads folder, or pick a file above to
          fill this box.
        </span>
      </label>

      <div className="data-tab__import">
        <button type="button" disabled={busy} onClick={() => void handleImport()}>
          Import
        </button>
      </div>
    </div>
  );
}
