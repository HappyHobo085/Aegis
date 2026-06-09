// src/lib/theme.ts
import type { Settings } from '../../shared/types';

export function applyTheme(s: Pick<Settings, 'primaryColor'>): void {
  document.documentElement.style.setProperty('--accent-color', s.primaryColor);
}
