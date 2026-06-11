// src/components/DownloadsTab.tsx
import { useState } from 'react';
import type { Settings } from '../../shared/types';

export interface DownloadsTabProps {
  settings: Settings;
  update(partial: Partial<Settings>): Promise<void>;
}

export function DownloadsTab({ settings, update }: DownloadsTabProps) {
  const [dir, setDir] = useState(settings.downloadDir);

  const handleSave = (): void => {
    void update({ downloadDir: dir.trim() });
  };

  const handleUseDefault = (): void => {
    setDir('');
    void update({ downloadDir: '' });
  };

  return (
    <div className="downloads-tab">
      <label htmlFor="downloads-tab-dir">Download folder</label>
      <input
        id="downloads-tab-dir"
        type="text"
        value={dir}
        onChange={(e) => setDir(e.target.value)}
      />
      <div className="downloads-tab__actions">
        <button type="button" onClick={handleSave}>
          Save download folder
        </button>
        <button type="button" onClick={handleUseDefault}>
          Use default
        </button>
      </div>
      {settings.downloadDir.length === 0 && (
        <p className="downloads-tab__hint">
          Empty — downloads go to your system Downloads folder.
        </p>
      )}
    </div>
  );
}
