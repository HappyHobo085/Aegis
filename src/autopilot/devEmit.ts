// src/autopilot/devEmit.ts
// Live-only wrappers over the dev-only Rust commands. Screenshot failures are
// swallowed (best-effort); callers decide skip vs fail based on hasDisplay.
import { invoke } from '@tauri-apps/api/core';
import type { Report } from './report';

export async function screenshot(name: string): Promise<void> {
  await invoke('autopilot_screenshot', { name });
}
export async function writeReport(report: Report, html: string): Promise<void> {
  await invoke('autopilot_write_report', { reportJson: JSON.stringify(report, null, 2), html });
}
export async function done(): Promise<void> {
  await invoke('autopilot_done');
}
export async function emitEvent(channel: string, payload: unknown): Promise<void> {
  await invoke('autopilot_emit_event', { name: channel, payload });
}
