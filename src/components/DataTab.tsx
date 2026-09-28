// src/components/DataTab.tsx
import { useState } from 'react';
import type { ImportMode } from '../../shared/types';
import { confirm, toast } from '../lib/toast';

export interface DataTabProps {
  onExport(): Promise<{ ok: boolean; path?: string }>;
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

  const handleExport = async (): Promise<void> => {
    setBusy(true);
    try {
      const res = await onExport();
      if (res.ok) {
        toast.success(`Exported to ${res.path ?? 'file'}.`);
      }
    } finally {
      setBusy(false);
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
          Leave empty to restore the last export from your Downloads folder.
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
