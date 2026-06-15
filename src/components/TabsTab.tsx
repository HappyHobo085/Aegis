// src/components/TabsTab.tsx
import type { Settings } from '../../shared/types';

export interface TabsTabProps {
  settings: Settings;
  update(partial: Partial<Settings>): Promise<void>;
}

export function TabsTab({ settings, update }: TabsTabProps) {
  return (
    <div className="tabs-tab">
      <label className="tabs-tab__field">
        <span>Discard inactive tabs after (minutes, 0 = never)</span>
        <input
          type="number"
          min={0}
          aria-label="Discard inactive tabs after (minutes)"
          value={settings.tabIdleTimeout}
          onChange={(e) => void update({ tabIdleTimeout: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
        />
      </label>
      <p className="tabs-tab__hint">
        Inactive background tabs are unloaded to free memory and reloaded when you return to them. Active and pinned tabs are never discarded.
      </p>
    </div>
  );
}
