// src/components/DownloadsPanel.tsx
import { FileText, Folder, Inbox, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import type { DownloadEntry } from '../../shared/types';
import { confirm, toast } from '../lib/toast';

export interface DownloadsPanelProps {
  downloads: DownloadEntry[];
  remove(id: number): Promise<void> | void;
  clear(): Promise<void> | void;
  openFile(id: number): Promise<void> | void;
  showInFolder(id: number): Promise<void> | void;
  cancel(id: number): Promise<void> | void;
}

/** Whole-percent received/total, clamped 0..100; 0 when total is unknown. */
function percentOf(received: number, total: number): number {
  if (total <= 0) return 0;
  const pct = Math.round((received / total) * 100);
  return Math.max(0, Math.min(100, pct));
}

const STATE_LABELS: Record<DownloadEntry['state'], string> = {
  progressing: 'Downloading',
  completed: 'Completed',
  interrupted: 'Failed',
  cancelled: 'Cancelled',
};

/** Friendly label for a raw download state. */
function stateLabel(state: DownloadEntry['state']): string {
  return STATE_LABELS[state] ?? state;
}

/** True for states that should get the error styling treatment. */
function isErrorState(state: DownloadEntry['state']): boolean {
  return state === 'interrupted' || state === 'cancelled';
}

export function DownloadsPanel({
  downloads,
  remove,
  clear,
  openFile,
  showInFolder,
  cancel,
}: DownloadsPanelProps) {
  const [filter, setFilter] = useState<'active' | 'recent' | 'failed' | 'all'>('all');
  const activeCount = downloads.filter((d) => d.state === 'progressing').length;
  const failedCount = downloads.filter((d) => isErrorState(d.state)).length;
  const completedCount = downloads.filter((d) => d.state === 'completed').length;
  const visibleDownloads = downloads.filter((d) => {
    if (filter === 'active') return d.state === 'progressing';
    if (filter === 'failed') return isErrorState(d.state);
    if (filter === 'recent') return d.state !== 'progressing';
    return true;
  });

  const handleClear = async (): Promise<void> => {
    const ok = await confirm('Clear the downloads list? This does not delete the files.');
    if (ok) void clear();
  };

  const handleCancel = async (id: number, filename: string): Promise<void> => {
    const ok = await confirm(`Cancel the download of “${filename}”?`);
    if (ok) void cancel(id);
  };

  const handleOpenFile = async (id: number): Promise<void> => {
    try {
      await openFile(id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not open that download.');
    }
  };

  const handleShowInFolder = async (id: number): Promise<void> => {
    try {
      await showInFolder(id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not show that download.');
    }
  };

  return (
    <div className="downloads-panel" role="group" aria-label="Downloads">
      <div className="downloads-panel__summary" aria-label="Download activity summary">
        <span>
          <strong>{activeCount}</strong>
          Active
        </span>
        <span>
          <strong>{completedCount}</strong>
          Complete
        </span>
        <span>
          <strong>{failedCount}</strong>
          Need attention
        </span>
      </div>
      <div className="downloads-panel__filters" role="group" aria-label="Filter download list">
        {(['all', 'active', 'recent', 'failed'] as const).map((next) => (
          <button
            key={next}
            type="button"
            aria-pressed={filter === next}
            onClick={() => setFilter(next)}
          >
            {next === 'all'
              ? 'All'
              : next === 'active'
                ? 'Active'
                : next === 'recent'
                  ? 'Recent'
                  : 'Problems'}
          </button>
        ))}
      </div>
      <button
        type="button"
        className="downloads-panel__clear"
        aria-label="Clear all downloads"
        disabled={downloads.length === 0}
        onClick={() => void handleClear()}
      >
        <Trash2 size={14} aria-hidden="true" />
        Clear all
      </button>
      {downloads.length === 0 ? (
        <div className="downloads-panel__empty">
          <Inbox size={32} aria-hidden="true" />
          <span>No downloads yet.</span>
          <span className="downloads-panel__empty-hint">
            Regular downloads show up here. Private-tab downloads are not recorded.
          </span>
        </div>
      ) : visibleDownloads.length === 0 ? (
        <div className="downloads-panel__empty downloads-panel__empty--compact">
          <Inbox size={28} aria-hidden="true" />
          <span>No downloads match this filter.</span>
        </div>
      ) : (
        <ul className="downloads-panel__list">
          {visibleDownloads.map((d) => {
            const pct = percentOf(d.receivedBytes, d.totalBytes);
            return (
              <li key={d.id} className="downloads-panel__row">
                <span className="downloads-panel__filename">{d.filename}</span>
                <span className="downloads-panel__url">{d.url}</span>
                <span
                  className={`downloads-panel__state${
                    isErrorState(d.state) ? ' downloads-panel__state--error' : ''
                  }`}
                >
                  {stateLabel(d.state)}
                </span>
                {d.state === 'progressing' && (
                  <div
                    role="progressbar"
                    aria-label={`${d.filename} download progress`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={pct}
                    className="downloads-panel__progress"
                  >
                    <span className="downloads-panel__progress-fill" style={{ width: `${pct}%` }} />
                  </div>
                )}
                <div className="downloads-panel__actions">
                  {d.state === 'completed' && (
                    <>
                      <button
                        type="button"
                        aria-label={`Open file ${d.filename}`}
                        onClick={() => void handleOpenFile(d.id)}
                      >
                        <FileText size={14} aria-hidden="true" />
                        Open file
                      </button>
                      <button
                        type="button"
                        aria-label={`Show ${d.filename} in folder`}
                        onClick={() => void handleShowInFolder(d.id)}
                      >
                        <Folder size={14} aria-hidden="true" />
                        Show in folder
                      </button>
                    </>
                  )}
                  {d.state === 'progressing' && (
                    <button
                      type="button"
                      className="downloads-panel__cancel"
                      aria-label={`Cancel ${d.filename}`}
                      onClick={() => void handleCancel(d.id, d.filename)}
                    >
                      <X size={14} aria-hidden="true" />
                      Cancel
                    </button>
                  )}
                  <button
                    type="button"
                    className="downloads-panel__remove"
                    aria-label={`Remove ${d.filename}`}
                    onClick={() => void remove(d.id)}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
