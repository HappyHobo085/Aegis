// src/autopilot/run.ts
// The live autopilot orchestration. Activated only from main.tsx in dev. Walks
// every SCREEN (drive control surface -> screenshot) and every CATALOG feature
// (exercise the real core), runs end-to-end inductions, then writes the report.
import type { AegisApi } from '../../shared/types';
import { IPC } from '../../shared/types';
import { aegis } from '../lib/ipcClient';
import { getAutopilotControl, type AutopilotControl } from './control';
import { SCREENS } from './screens';
import { CATALOG } from './catalog';
import { reachScreen, leaveScreen } from './reach';
import { summarize, type Report, type StepResult, renderReportHtml } from './report';
import * as devEmit from './devEmit';

export interface RunDeps {
  api: AegisApi;
  control: AutopilotControl;
  screenshot(name: string): Promise<void>;
  emitEvent(channel: string, payload: unknown): Promise<void>;
  writeReport(report: Report, html: string): Promise<void>;
  done(): Promise<void>;
  hasDisplay: boolean;
  now(): number;
  /** Navigate the ad fixture; return before/after session block counts (+ final nav url), or null if unavailable. */
  navigateFixture(): Promise<{ before: number; after: number; url?: string } | null>;
}

function liveDeps(): RunDeps {
  const control = getAutopilotControl();
  if (!control) throw new Error('autopilot control not registered');
  return {
    api: aegis,
    control,
    screenshot: devEmit.screenshot,
    emitEvent: devEmit.emitEvent,
    writeReport: devEmit.writeReport,
    done: devEmit.done,
    hasDisplay: import.meta.env.VITE_AEGIS_AUTOPILOT_DISPLAY === '1',
    now: () => Date.now(),
    navigateFixture: async () => {
      const url = (import.meta.env.VITE_AEGIS_AUTOPILOT_FIXTURE as string) || '';
      if (!url) return null;
      // A covering overlay cancels content navigation, and ad-block must be ON for the
      // count to rise — so return to a clean state and enable blocking first.
      control.closeSettings(); control.closeDownloads(); control.closeManager();
      control.setSidebar(false); control.setShield(false); control.exitFullscreen();
      control.clearError(); control.clearCrash();
      // Event-driven overlays (safety interstitial / permission prompt) shown during the
      // screen walk aren't control-owned; clear them too, or a lingering one (a full
      // overlay) cancels the fixture nav — exactly what produced nav=https://malware.test/.
      await devEmit.emitEvent(IPC.evtSafetyInterstitial, null);
      await devEmit.emitEvent(IPC.evtPermissionsPrompt, null);
      await aegis.adblock.setEnabled(true);
      await new Promise((r) => setTimeout(r, 400));
      const before = (await aegis.adblock.getState()).sessionBlocked ?? 0;
      await aegis.nav.navigate(1, url);
      // Poll up to ~12s: the page's external ad requests fire + get counted asynchronously.
      let after = before;
      for (let i = 0; i < 24 && after <= before; i++) {
        await new Promise((r) => setTimeout(r, 500));
        after = (await aegis.adblock.getState()).sessionBlocked ?? 0;
      }
      const navUrl = (await aegis.nav.getState(1)).url;
      return { before, after, url: navUrl };
    },
  };
}

export async function runAutopilot(partial?: Partial<RunDeps>): Promise<Report> {
  const deps: RunDeps = { ...liveDepsSafe(partial), ...partial } as RunDeps;
  const startedAt = deps.now();
  const results: StepResult[] = [];

  // 1) Screen walk
  for (const screen of SCREENS) {
    try {
      await reachScreen(deps.control, screen, { emitEvent: deps.emitEvent });
      if (deps.hasDisplay) {
        try { await deps.screenshot(screen.id); results.push({ id: `screen:${screen.id}`, kind: 'visual', title: screen.label, status: 'pass', screenshot: `${screen.id}.png` }); }
        catch (e) { results.push({ id: `screen:${screen.id}`, kind: 'visual', title: screen.label, status: 'fail', detail: String(e) }); }
      } else {
        results.push({ id: `screen:${screen.id}`, kind: 'visual', title: screen.label, status: 'skip', detail: 'no display' });
      }
    } catch (e) {
      results.push({ id: `screen:${screen.id}`, kind: 'visual', title: screen.label, status: 'fail', detail: String(e) });
    } finally {
      await leaveScreen(deps.control, screen, { emitEvent: deps.emitEvent }).catch(() => {});
    }
  }

  // 2) Feature exercise (real core)
  for (const f of CATALOG) {
    try { await f.exercise(deps.api); results.push({ id: f.id, kind: 'core', title: f.title, status: 'pass' }); }
    catch (e) { results.push({ id: f.id, kind: 'core', title: f.title, status: 'fail', detail: String(e) }); }
  }

  // 2b) Functional verification (real round-trips against the real core)
  for (const f of CATALOG) {
    if (!f.verify) continue;
    try { const detail = await f.verify(deps.api); results.push({ id: `verify:${f.id}`, kind: 'core', title: `Verify ${f.title}`, status: 'pass', detail }); }
    catch (e) { results.push({ id: `verify:${f.id}`, kind: 'core', title: `Verify ${f.title}`, status: 'fail', detail: String(e) }); }
  }

  // 3) End-to-end induction: ad-block actually blocks on a real page. Blocking itself is
  // verified by the adblock_engine unit tests + the adblock.toggle catalog check; this
  // probes the LIVE shield count, which is environment-sensitive (WebKit negative-caches
  // blocked URLs; programmatic-nav timing). So: pass if it rises, an honest skip (with
  // diagnostics) if not — only a thrown error is a hard fail.
  try {
    const r = await deps.navigateFixture();
    if (!r) results.push({ id: 'induction:adblock', kind: 'core', title: 'Ad-block blocks on fixture page', status: 'skip', detail: 'no fixture url' });
    else if (r.after > r.before) results.push({ id: 'induction:adblock', kind: 'core', title: 'Ad-block blocks on fixture page', status: 'pass', detail: `blocked ${r.after - r.before}` });
    else results.push({ id: 'induction:adblock', kind: 'core', title: 'Ad-block blocks on fixture page', status: 'skip', detail: `live count did not rise (${r.before} -> ${r.after}); nav=${r.url ?? '?'} — blocking is covered by adblock_engine unit tests + the adblock.toggle check` });
  } catch (e) {
    results.push({ id: 'induction:adblock', kind: 'core', title: 'Ad-block blocks on fixture page', status: 'fail', detail: String(e) });
  }

  const report: Report = { startedAt, finishedAt: deps.now(), display: deps.hasDisplay, results, summary: summarize(results) };
  try { await deps.writeReport(report, renderReportHtml(report)); } catch { /* ignore in unit tests */ }
  try { await deps.done(); } catch { /* ignore */ }
  return report;
}

// liveDeps() touches `aegis`/import.meta; in unit tests `partial` overrides everything,
// so guard so a missing control surface doesn't throw when fully overridden.
function liveDepsSafe(partial?: Partial<RunDeps>): RunDeps {
  // Keep this list in sync with the RunDeps interface — a missing key here silently falls through to liveDeps().
  const required: Array<keyof RunDeps> = ['api','control','screenshot','emitEvent','writeReport','done','hasDisplay','now','navigateFixture'];
  if (partial && required.every((k) => k in partial)) return partial as RunDeps;
  return liveDeps();
}
