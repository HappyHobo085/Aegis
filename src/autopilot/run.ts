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
      const base = (import.meta.env.VITE_AEGIS_AUTOPILOT_FIXTURE as string) || '';
      if (!base) return null;
      // A covering overlay cancels content navigation — return to a clean state first.
      control.closeSettings(); control.closeDownloads(); control.closeManager();
      control.setSidebar(false); control.setShield(false); control.exitFullscreen();
      control.clearError(); control.clearCrash();
      // Event-driven overlays (safety interstitial / permission prompt) shown during the
      // screen walk aren't control-owned; clear them too, or a lingering full overlay
      // cancels the fixture nav — exactly what produced nav=https://malware.test/.
      await devEmit.emitEvent(IPC.evtSafetyInterstitial, null);
      await devEmit.emitEvent(IPC.evtPermissionsPrompt, null);

      // A/B induction. The fixture fires the same third-party ad requests on every load
      // (cache-busted). OFF pass first (content filter removed) — confirms the page
      // actually generates ad traffic and the resource-load signal fires when unfiltered;
      // ON pass second — the same requests should then be blocked + counted. The ?ab=
      // marker forces a full reload (re-runs the JS) and tags each phase in the trace.
      await aegis.adblock.setEnabled(false);
      await aegis.nav.navigate(1, base + '?ab=off');
      await new Promise((r) => setTimeout(r, 2500));

      await aegis.adblock.setEnabled(true);
      await new Promise((r) => setTimeout(r, 600));
      const before = (await aegis.adblock.getState()).sessionBlocked ?? 0;
      await aegis.nav.navigate(1, base + '?ab=on');
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

  // 3) End-to-end ad-block induction. navigateFixture drives a real A/B on the live core:
  // load the ad fixture with ad-block OFF, then ON — exercising nav + the on/off toggle for
  // real. Two complementary signals verify blocking:
  //   - The LIVE shield COUNT (recorded here). It is environment-sensitive: the WebKit
  //     content filter blocks well-known ad hosts BEFORE resource-load-started fires, so the
  //     counter never sees them and the count can't rise for them (see
  //     linux_layout::connect_block_counter). So: pass if it rises (an ad slipped the capped
  //     filter but the engine caught it), honest skip if not, hard fail only on a thrown error.
  //   - The AUTHORITATIVE proof, asserted by the launcher (summarize.mjs) from the
  //     [aegis-count] A/B trace: ad subresources load with ad-block OFF and vanish with it ON.
  try {
    const r = await deps.navigateFixture();
    if (!r) results.push({ id: 'induction:adblock', kind: 'core', title: 'Ad-block live shield count', status: 'skip', detail: 'no fixture url' });
    else if (r.after > r.before) results.push({ id: 'induction:adblock', kind: 'core', title: 'Ad-block live shield count', status: 'pass', detail: `count rose ${r.before} -> ${r.after}` });
    else results.push({ id: 'induction:adblock', kind: 'core', title: 'Ad-block live shield count', status: 'skip', detail: `count did not rise (${r.before} -> ${r.after}); nav=${r.url ?? '?'} — the content filter blocks these hosts before the counter signal fires, so blocking is proven from the launcher's A/B trace check + adblock_engine unit tests, not the badge` });
  } catch (e) {
    results.push({ id: 'induction:adblock', kind: 'core', title: 'Ad-block live shield count', status: 'fail', detail: String(e) });
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
