// electron/test/e2e/httpsOnly.e2e.ts
//
// e2e coverage for HTTPS-Only: upgrade attempt, interstitial, proceed, persistence.
//
// Harness facts (verified by reading fixtureServer.ts + nav.spec.ts + downloads.spec.ts):
//   - Electron launched via _electron.launch({ args: ['out/main/index.js'] }), AEGIS_E2E=1,
//     per-test tmpdir in AEGIS_USER_DATA, AEGIS_HOME_URL=about:blank for hermeticity.
//   - startFixtureServer() serves electron/test/fixtures/ over plain HTTP (no TLS).
//   - startCertServer()   serves electron/test/fixtures/ over self-signed HTTPS
//     (ERR_CERT_AUTHORITY_INVALID — Electron rejects it as a cert error, NOT suitable as a
//     trusted HTTPS upgrade target). See "Scenario 3 (SKIPPED)" comment below.
//   - Navigation through SafetyController MUST go via window.aegis.nav.navigate() on the
//     chrome WebContents (IPC path: nav.navigate -> safety.navigate -> upgradeUrl). Calling
//     __aegisTest.primary.navigate() directly bypasses SafetyController entirely.
//   - Chrome WebContents is accessed as:
//       app.evaluate(({ webContents }) => {
//         const id = (globalThis as any).__aegisTest.chromeWcId;
//         return webContents.fromId(id)!.executeJavaScript(...);
//       })
//   - Settings are seeded via __aegisTest.phase4.settingsRepo.set({ httpsOnly: false }).
//   - PRIMARY_VIEW_ID = 1 (nav.navigate first arg is viewId).
//
// SCENARIOS:
//   1. HTTPS-failed interstitial + proceed + persistence — IMPLEMENTED
//   2. Toggle off — IMPLEMENTED (seed httpsOnly=false, http loads directly)
//   3. Upgrade success over trusted HTTPS — SKIPPED (harness cannot serve trusted HTTPS;
//      startCertServer yields a self-signed cert that Electron rejects with
//      ERR_CERT_AUTHORITY_INVALID, which is a cert failure, not a successful upgrade.
//      Scenario 1 already proves the upgrade is attempted by observing the interstitial.)
//   4. Regression — IMPLEMENTED (a normal http navigation is unaffected after httpsOnly=false)

import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureServer, type FixtureServer } from './fixtureServer';
import type { NavState, SafetyInterstitialPayload } from '../../../shared/types';

const PRIMARY_VIEW_ID = 1;

let fixtures: FixtureServer;

test.beforeAll(async () => {
  fixtures = await startFixtureServer();
});

test.afterAll(async () => {
  await fixtures.close();
});

async function launchApp(
  userDataDir: string,
  extraEnv?: Record<string, string>,
): Promise<ElectronApplication> {
  const app = await _electron.launch({
    args: ['out/main/index.js'],
    env: { ...process.env, AEGIS_E2E: '1', AEGIS_USER_DATA: userDataDir, ...extraEnv },
  });
  await expect
    .poll(
      async () => {
        try {
          return await app.evaluate(() => {
            const reg = (globalThis as any).__aegisTest;
            return reg?.primary ? reg.primary.getState().url : '';
          });
        } catch {
          return ''; // transient startup race — let expect.poll retry
        }
      },
      { timeout: 15000 },
    )
    .not.toEqual('');
  return app;
}

function vcState(app: ElectronApplication): Promise<NavState> {
  return app.evaluate(() => (globalThis as any).__aegisTest.primary.getState());
}

/**
 * Navigate via the chrome renderer's IPC bridge (window.aegis.nav.navigate), which
 * routes through SafetyController. This is the ONLY path that triggers HTTPS-Only
 * upgrades; __aegisTest.primary.navigate() is a direct ViewController call that
 * bypasses SafetyController entirely.
 *
 * We wait for window.aegis to be available in the chrome world before invoking it,
 * since launchApp only guarantees the content view VC is started.
 */
async function navigateViaSafety(
  app: ElectronApplication,
  url: string,
): Promise<void> {
  // Wait for window.aegis to be available in the chrome renderer.
  await expect
    .poll(
      async () => {
        try {
          return await app.evaluate(({ webContents }) => {
            const id = (globalThis as any).__aegisTest.chromeWcId;
            const wc = webContents.fromId(id);
            if (!wc) return false;
            return wc.executeJavaScript("typeof window.aegis !== 'undefined'");
          });
        } catch {
          return false;
        }
      },
      { timeout: 15000 },
    )
    .toBe(true);

  await app.evaluate(
    ({ webContents }, [chromeId, viewId, navUrl]) => {
      const wc = webContents.fromId(chromeId as number)!;
      return wc.executeJavaScript(
        `window.aegis.nav.navigate(${viewId}, ${JSON.stringify(navUrl)})`,
        true,
      );
    },
    [
      await app.evaluate(() => (globalThis as any).__aegisTest.chromeWcId),
      PRIMARY_VIEW_ID,
      url,
    ],
  );
}

/**
 * Read the safety interstitial state from the chrome renderer's IPC bridge.
 * Returns null when no interstitial is showing.
 */
async function safetyState(
  app: ElectronApplication,
): Promise<SafetyInterstitialPayload | null> {
  const chromeId = await app.evaluate(
    () => (globalThis as any).__aegisTest.chromeWcId,
  );
  return app.evaluate(
    ({ webContents }, id) =>
      webContents.fromId(id as number)!.executeJavaScript(
        'window.aegis.safety.getState()',
        true,
      ),
    chromeId,
  );
}

/**
 * Read the list of HTTP exceptions from the chrome renderer's IPC bridge.
 */
async function listExceptions(app: ElectronApplication): Promise<string[]> {
  const chromeId = await app.evaluate(
    () => (globalThis as any).__aegisTest.chromeWcId,
  );
  return app.evaluate(
    ({ webContents }, id) =>
      webContents.fromId(id as number)!.executeJavaScript(
        'window.aegis.safety.listExceptions()',
        true,
      ),
    chromeId,
  );
}

/**
 * Click "Continue to HTTP for this site" via the safety IPC bridge
 * (window.aegis.safety.proceed). This mirrors what the SafetyInterstitial
 * component's button does: call onProceed(interstitial.url).
 */
async function proceedToHttp(
  app: ElectronApplication,
  url: string,
): Promise<void> {
  const chromeId = await app.evaluate(
    () => (globalThis as any).__aegisTest.chromeWcId,
  );
  await app.evaluate(
    ({ webContents }, [id, proceedUrl]) =>
      webContents.fromId(id as number)!.executeJavaScript(
        `window.aegis.safety.proceed(${JSON.stringify(proceedUrl)})`,
        true,
      ),
    [chromeId, url],
  );
}

/**
 * Check whether the chrome renderer DOM currently contains the .interstitial element.
 */
async function interstitialInDom(app: ElectronApplication): Promise<boolean> {
  const chromeId = await app.evaluate(
    () => (globalThis as any).__aegisTest.chromeWcId,
  );
  return app.evaluate(
    ({ webContents }, id) =>
      webContents.fromId(id as number)!.executeJavaScript(
        "!!document.querySelector('.interstitial')",
        true,
      ),
    chromeId,
  );
}

// ---------------------------------------------------------------------------
// Scenario 1: HTTPS-failed interstitial + proceed + persistence (CORE)
//
// httpsOnly is ON (default). Navigate to an HTTP-only fixture URL. The upgrade
// to https:// fails (fixture server only speaks HTTP) → interstitial appears.
// "Continue to HTTP" is clicked → http page loads. Navigate away and back →
// exception persisted, http loads directly without interstitial.
// ---------------------------------------------------------------------------
test('Scenario 1: httpsOnly=on — interstitial appears, proceed loads http, exception persists', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-httpsonly-s1-'));
  const httpUrl = `${fixtures.baseUrl}/spa.html`;

  const app = await launchApp(dir, { AEGIS_HOME_URL: 'about:blank' });
  try {
    // Confirm httpsOnly is on (default = true).
    const settings = await app.evaluate(() =>
      (globalThis as any).__aegisTest.phase4.settingsRepo.get(),
    );
    expect(settings.httpsOnly).toBe(true);

    // Navigate to an HTTP URL. SafetyController upgrades to https://<host>/spa.html,
    // Electron tries to load it, it fails (no HTTPS listener), and the interstitial
    // is raised via IPC evtSafetyInterstitial → SafetyInterstitial component shows.
    await navigateViaSafety(app, httpUrl);

    // Wait for the safety interstitial state to report a non-null payload.
    await expect
      .poll(async () => safetyState(app), { timeout: 15000 })
      .not.toBeNull();

    const interstitial = await safetyState(app);
    expect(interstitial).not.toBeNull();
    expect(interstitial!.reason).toBe('https-failed');
    // The interstitial stores the ORIGINAL http URL the user may continue to.
    expect(interstitial!.url).toBe(httpUrl);

    // Verify the .interstitial element is present in the chrome DOM.
    await expect
      .poll(async () => interstitialInDom(app), { timeout: 10000 })
      .toBe(true);

    // The content view should NOT have committed to the (failed) https URL.
    // lastCommittedUrl remains the prior URL (about:blank from boot).
    const stateBeforeProceed = await vcState(app);
    expect(stateBeforeProceed.url).not.toContain('127.0.0.1');

    // Proceed: "Continue to HTTP for this site".
    await proceedToHttp(app, httpUrl);

    // After proceed, SafetyController calls navigateView(httpUrl) → vc.navigate(httpUrl)
    // → loadURL(httpUrl) → the plain HTTP fixture loads successfully.
    await expect
      .poll(async () => (await vcState(app)).url, { timeout: 15000 })
      .toBe(httpUrl);
    await expect
      .poll(async () => (await vcState(app)).isLoading, { timeout: 15000 })
      .toBe(false);

    // Interstitial must be gone now (dismissed on proceed).
    await expect
      .poll(async () => safetyState(app), { timeout: 10000 })
      .toBeNull();

    // Host exception must have been persisted to the DB.
    const host = new URL(httpUrl).hostname;
    const exceptions = await listExceptions(app);
    expect(exceptions).toContain(host);

    // Navigate away to a different page so the history stack has two entries.
    const anotherUrl = `${fixtures.baseUrl}/late-title.html`;
    // Use safety navigation for the second URL too — it's http://, but the host
    // is the SAME fixture server (127.0.0.1), so the exception still applies and
    // it loads directly without an interstitial.
    await navigateViaSafety(app, anotherUrl);
    await expect
      .poll(async () => (await vcState(app)).url, { timeout: 15000 })
      .toBe(anotherUrl);
    await expect
      .poll(async () => (await vcState(app)).isLoading, { timeout: 15000 })
      .toBe(false);

    // No new interstitial should have appeared for the second navigation.
    expect(await safetyState(app)).toBeNull();

    // Navigate back to the original http URL. Since the host exception was
    // persisted in the DB, SafetyController.resolveUpgrade skips the upgrade
    // and the http URL loads directly — NO interstitial.
    await navigateViaSafety(app, httpUrl);
    await expect
      .poll(async () => (await vcState(app)).url, { timeout: 15000 })
      .toBe(httpUrl);
    await expect
      .poll(async () => (await vcState(app)).isLoading, { timeout: 15000 })
      .toBe(false);

    // Confirm no interstitial on the second visit (exception was honoured).
    expect(await safetyState(app)).toBeNull();
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Scenario 2: httpsOnly=off — http URL loads directly with NO interstitial
//
// Seed httpsOnly=false before navigating to the plain HTTP fixture URL.
// SafetyController.resolveUpgrade returns null → vc.navigate(httpUrl) directly.
// ---------------------------------------------------------------------------
test('Scenario 2: httpsOnly=off — http URL loads directly, no interstitial', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-httpsonly-s2-'));
  const httpUrl = `${fixtures.baseUrl}/spa.html`;

  const app = await launchApp(dir, { AEGIS_HOME_URL: 'about:blank' });
  try {
    // Disable HTTPS-Only via the settings repo (same path as the Settings UI).
    await app.evaluate(
      (_e, partial) => (globalThis as any).__aegisTest.phase4.settingsRepo.set(partial),
      { httpsOnly: false },
    );
    expect(
      (await app.evaluate(() => (globalThis as any).__aegisTest.phase4.settingsRepo.get()))
        .httpsOnly,
    ).toBe(false);

    // Navigate to an HTTP URL: with httpsOnly off, SafetyController.resolveUpgrade
    // returns null → vc.navigate(httpUrl) → no upgrade, no interstitial.
    await navigateViaSafety(app, httpUrl);

    // The page should load directly over http (no upgrade attempt).
    await expect
      .poll(async () => (await vcState(app)).url, { timeout: 15000 })
      .toBe(httpUrl);
    await expect
      .poll(async () => (await vcState(app)).isLoading, { timeout: 15000 })
      .toBe(false);

    // No interstitial.
    expect(await safetyState(app)).toBeNull();
    expect(await interstitialInDom(app)).toBe(false);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Scenario 3 (SKIPPED — harness limitation):
//
//   Upgrade success to trusted HTTPS. The fixture server can only serve plain
//   HTTP (startFixtureServer) or self-signed HTTPS (startCertServer). Electron
//   rejects self-signed certs with ERR_CERT_AUTHORITY_INVALID (-202), which is a
//   cert error, NOT a successful TLS handshake. There is no way to serve a
//   fixture that Electron trusts over HTTPS in the current harness without
//   installing a CA cert into the Electron session or disabling cert validation.
//
//   Scenario 1 already demonstrates the upgrade is attempted (the fact that the
//   interstitial fires for 'https-failed' confirms SafetyController called
//   vc.navigate(httpsUrl) and that nav failed).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Scenario 4: Regression — a normal http navigation works unaffected after
// httpsOnly is disabled
//
// With httpsOnly=false, standard fixture pages load normally via navigateViaSafety,
// confirming HTTPS-Only changes don't break ordinary navigation.
// ---------------------------------------------------------------------------
test('Scenario 4: regression — normal http navigation is unaffected when httpsOnly=off', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-httpsonly-s4-'));
  const app = await launchApp(dir, { AEGIS_HOME_URL: 'about:blank' });
  try {
    await app.evaluate(
      (_e, p) => (globalThis as any).__aegisTest.phase4.settingsRepo.set(p),
      { httpsOnly: false },
    );

    // Navigate through the safety path to multiple fixture pages.
    for (const path of ['/spa.html', '/late-title.html']) {
      const url = `${fixtures.baseUrl}${path}`;
      await navigateViaSafety(app, url);
      await expect
        .poll(async () => (await vcState(app)).url, { timeout: 15000 })
        .toBe(url);
      await expect
        .poll(async () => (await vcState(app)).isLoading, { timeout: 15000 })
        .toBe(false);
      expect(await safetyState(app)).toBeNull();
    }
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
