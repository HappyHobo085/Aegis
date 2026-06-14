// src/components/AppearanceTab.tsx
import type { Settings } from '../../shared/types';

export interface AppearanceTabProps {
  settings: Settings;
  update(partial: Partial<Settings>): Promise<void>;
}

export function AppearanceTab({ settings, update }: AppearanceTabProps) {
  return (
    <div className="appearance-tab">
      <label className="appearance-tab__field">
        <span>Accent color</span>
        <input
          type="color"
          aria-label="Accent color"
          value={settings.primaryColor}
          onChange={(e) => void update({ primaryColor: e.target.value })}
        />
      </label>
    </div>
  );
}
