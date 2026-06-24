// src/components/DownloadsTab.tsx
import { useState } from 'react';
import type { Settings } from '../../shared/types';
import { toast } from '../lib/toast';

export interface DownloadsTabProps {
  settings: Settings;
  update(partial: Partial<Settings>): Promise<void>;
}

export function DownloadsTab({ settings, update }: DownloadsTabProps) {
  const [dir, setDir] = useState(settings.downloadDir);

  const handleSave = (): void => {
    void (async () => {
      await update({ downloadDir: dir.trim() });
      toast.success('Saved');
    })();
  };

  const handleUseDefault = (): void => {
    setDir('');
    void (async () => {
      await update({ downloadDir: '' });
      toast.success('Saved');
    })();
  };

  return (
    <form
      className="downloads-tab"
      onSubmit={(e) => {
        e.preventDefault();
        handleSave();
      }}
    >
      <label htmlFor="downloads-tab-dir">Download folder</label>
      <input
        id="downloads-tab-dir"
        type="text"
        placeholder="e.g. /home/you/Downloads"
        value={dir}
        onChange={(e) => setDir(e.target.value)}
      />
      <div className="downloads-tab__actions">
        <button type="submit">Save download folder</button>
        <button type="button" onClick={handleUseDefault}>
          Use default
        </button>
      </div>
      {settings.downloadDir.length === 0 && (
        <p className="downloads-tab__hint">Empty — downloads go to your system Downloads folder.</p>
      )}
    </form>
  );
}
