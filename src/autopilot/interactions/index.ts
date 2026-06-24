// src/autopilot/interactions/index.ts
// Barrel for the interaction-layer catalog.  The per-domain spec arrays are
// concatenated here into INTERACTIONS; the drift-guard registry of every
// interactive control id lives in controls.ts.  Public types are re-exported
// so existing importers of './interactions' keep resolving unchanged.
import type { InteractionSpec } from './types';
import { TOOLBAR_INTERACTIONS } from './toolbar';
import { TABS_INTERACTIONS } from './tabs';
import { FAVORITES_INTERACTIONS } from './favorites';
import { SIDEBAR_INTERACTIONS } from './sidebar';
import { SETTINGS_INTERACTIONS } from './settings';
import { OVERLAY_INTERACTIONS } from './overlays';
import { EDGE_INTERACTIONS } from './edge';
import { COMBO_INTERACTIONS } from './combo';
import { MOBILE_INTERACTIONS } from './mobile';
import { FIND_INTERACTIONS } from './find';
import { VAULT_INTERACTIONS } from './vault';

export type { InteractionLayer, CallLog, InteractionCtx, InteractionSpec } from './types';
export { INTERACTIVE_CONTROLS } from './controls';

export const INTERACTIONS: InteractionSpec[] = [
  ...TOOLBAR_INTERACTIONS,
  ...TABS_INTERACTIONS,
  ...FAVORITES_INTERACTIONS,
  ...SIDEBAR_INTERACTIONS,
  ...SETTINGS_INTERACTIONS,
  ...OVERLAY_INTERACTIONS,
  ...EDGE_INTERACTIONS,
  ...COMBO_INTERACTIONS,
  ...MOBILE_INTERACTIONS,
  ...FIND_INTERACTIONS,
  ...VAULT_INTERACTIONS,
];
