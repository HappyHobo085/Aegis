// src/components/AppearanceTab.tsx
import type { Settings } from '../../shared/types';

export interface AppearanceTabProps {
  settings: Settings;
  update(partial: Partial<Settings>): Promise<void>;
}

const THEME_OPTIONS: { value: Settings['themeMode']; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
];

export function AppearanceTab({ settings, update }: AppearanceTabProps) {
  return (
    <div className="appearance-tab">
      <fieldset
        className="appearance-tab__field appearance-tab__theme"
        role="radiogroup"
        aria-label="Theme"
      >
        <span className="appearance-tab__legend">Theme</span>
        <div className="appearance-tab__segments">
          {THEME_OPTIONS.map((opt) => (
            <label key={opt.value} className="appearance-tab__segment">
              <input
                type="radio"
                name="themeMode"
                value={opt.value}
                checked={settings.themeMode === opt.value}
                onChange={() => void update({ themeMode: opt.value })}
              />
              <span>{opt.label}</span>
            </label>
          ))}
        </div>
      </fieldset>

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
