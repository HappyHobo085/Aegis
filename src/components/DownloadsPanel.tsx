// src/components/DownloadsPanel.tsx
import type { DownloadEntry } from '../../shared/types';
import { confirm } from '../lib/toast';

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

export function DownloadsPanel({
  downloads,
  remove,
  clear,
  openFile,
  showInFolder,
  cancel,
}: DownloadsPanelProps) {
  const handleClear = async (): Promise<void> => {
    const ok = await confirm('Clear the downloads list? This does not delete the files.');
    if (ok) void clear();
  };

  return (
    <div className="downloads-panel" role="group" aria-label="Downloads">
      <button
        type="button"
        className="downloads-panel__clear"
        aria-label="Clear all downloads"
        disabled={downloads.length === 0}
        onClick={() => void handleClear()}
      >
        Clear all
      </button>
      {downloads.length === 0 ? (
        <p className="downloads-panel__empty">No downloads yet.</p>
      ) : (
        <ul className="downloads-panel__list">
          {downloads.map((d) => {
            const pct = percentOf(d.receivedBytes, d.totalBytes);
            return (
              <li key={d.id} className="downloads-panel__row">
                <span className="downloads-panel__filename">{d.filename}</span>
                <span className="downloads-panel__url">{d.url}</span>
                <span className="downloads-panel__state">{d.state}</span>
                {d.state === 'progressing' && (
                  <div
                    role="progressbar"
                    aria-label={`${d.filename} download progress`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={pct}
                    className="downloads-panel__progress"
                  >
                    <span
                      className="downloads-panel__progress-fill"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                )}
                <div className="downloads-panel__actions">
                  {d.state === 'completed' && (
                    <>
                      <button
                        type="button"
                        aria-label={`Open file ${d.filename}`}
                        onClick={() => void openFile(d.id)}
                      >
                        Open file
                      </button>
                      <button
                        type="button"
                        aria-label={`Show ${d.filename} in folder`}
                        onClick={() => void showInFolder(d.id)}
                      >
                        Show in folder
                      </button>
                    </>
                  )}
                  {d.state === 'progressing' && (
                    <button
                      type="button"
                      className="downloads-panel__cancel"
                      aria-label={`Cancel ${d.filename}`}
                      onClick={() => void cancel(d.id)}
                    >
                      Cancel
                    </button>
                  )}
                  <button
                    type="button"
                    className="downloads-panel__remove"
                    aria-label={`Remove ${d.filename}`}
                    onClick={() => void remove(d.id)}
                  >
                    &times;
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
