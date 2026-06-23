// src/autopilot/interactions/overlays.ts
import type { InteractionSpec, InteractionCtx, InteractionLayer } from './types';
import type {
  NavFailed,
  NavCrashed,
  SafetyInterstitialPayload,
  PermissionPrompt,
  RedirectBlocked,
} from '../../../shared/types';

export const OVERLAY_INTERACTIONS: InteractionSpec[] = [
  // ─── Task 8: overlays ───────────────────────────────────────────────────

  (() => {
    // Seed a fake completed download so the "Clear all downloads" button is enabled.
    const SEED_DOWNLOAD: import('../../../shared/types').DownloadEntry = {
      id: 9001,
      url: 'https://example.com/file.pdf',
      filename: 'file.pdf',
      state: 'completed',
      receivedBytes: 1024,
      totalBytes: 1024,
      savePath: '/tmp/file.pdf',
      startedAt: 0,
    };
    return {
      id: 'downloads.clear',
      domain: 'downloads',
      description: 'Open downloads modal → click Clear all → confirm → downloads.clear called',
      screen: 'downloads',
      // vitest-only: seeding a real download entry requires an actual in-progress download
      // which the live autopilot cannot trigger on demand.
      layers: ['vitest'] as InteractionLayer[],
      run: async (ctx: InteractionCtx) => {
        // The "Clear all downloads" button is disabled when downloads.length === 0.
        // Seed the list via the control-surface seam (same as emitHistory for history panel).
        await ctx.emitDownloadsChanged?.([SEED_DOWNLOAD]);
        const clearBtn = ctx.byRole('button', /^Clear all downloads$/);
        if (!clearBtn)
          throw new Error(
            '"Clear all downloads" button not found in DownloadsPanel (button may still be disabled)',
          );
        // Clicking the button calls handleClear() → confirm() → setPending (async React update).
        // userEvent.click in the vitest ctx wraps in act(), which flushes the state update.
        await ctx.click(clearBtn);
        // ConfirmDialog renders the OK/Cancel buttons in response to confirm().
        // If OK is present (ConfirmDialog is fully rendered), click it.
        // If not present, window.confirm is stubbed to return true in the vitest tour,
        // so downloads.clear() will still be called via the fallback path.
        const okBtn = ctx.byRole('button', /^OK$/);
        if (okBtn) await ctx.click(okBtn);
        // Give the async confirm → clear chain a tick to settle.
        await new Promise((r) => setTimeout(r, 100));
      },
      assert: async (ctx: InteractionCtx) => {
        if (!ctx.calls.called('downloads.clear'))
          throw new Error('downloads.clear not called after clicking Clear + OK');
        return 'downloads Clear all → downloads.clear()';
      },
    } satisfies InteractionSpec;
  })(),

  {
    id: 'confirm.confirm',
    domain: 'confirm',
    description: 'Open ConfirmDialog → click OK → the confirm resolver runs and dialog closes',
    screen: 'confirmDialog',
    // vitest-only: synthesizing an in-app confirm() call in the live run has no safe
    // observable side-effect and is not needed (the ConfirmDialog is already exercised
    // transitively by sidebar.history.clear and downloads.clear live interactions).
    layers: ['vitest'],
    run: async (ctx) => {
      // reachScreen already opened the confirm dialog via control.openConfirm.
      const okBtn = ctx.byRole('button', /^OK$/);
      if (!okBtn) throw new Error('"OK" button not found in ConfirmDialog');
      await ctx.click(okBtn);
      // Give React a tick to update after the dialog closes.
      await new Promise((r) => setTimeout(r, 50));
    },
    assert: async (ctx) => {
      // After clicking OK the dialog should have disappeared from the DOM.
      const dialog = ctx.byRole('dialog');
      if (dialog) throw new Error('ConfirmDialog is still in the DOM after clicking OK');
      return 'ConfirmDialog OK → dialog dismissed';
    },
  },

  {
    id: 'confirm.cancel',
    domain: 'confirm',
    description: 'Open ConfirmDialog → click Cancel → dialog closes with no action',
    screen: 'confirmDialog',
    // vitest-only: same reasoning as confirm.confirm.
    layers: ['vitest'],
    run: async (ctx) => {
      // reachScreen already opened the confirm dialog via control.openConfirm.
      const cancelBtn = ctx.byRole('button', /^Cancel$/);
      if (!cancelBtn) throw new Error('"Cancel" button not found in ConfirmDialog');
      await ctx.click(cancelBtn);
      // Give React a tick to update after the dialog closes.
      await new Promise((r) => setTimeout(r, 50));
    },
    assert: async (ctx) => {
      // After clicking Cancel the dialog should have disappeared from the DOM.
      const dialog = ctx.byRole('dialog');
      if (dialog) throw new Error('ConfirmDialog is still in the DOM after clicking Cancel');
      return 'ConfirmDialog Cancel → dialog dismissed without action';
    },
  },

  {
    id: 'errorOverlay.retry',
    domain: 'errorOverlay',
    description: 'Emit nav.failed → click Retry → nav.reloadOrStop called',
    screen: 'home',
    // vitest-only: the live core emits nav.failed only on real network errors; synthesizing
    // this deterministically would require a real server setup.  nav.reloadOrStop is already
    // tested live via the toolbar.reload interaction.
    layers: ['vitest'],
    run: async (ctx) => {
      // Render the error overlay by invoking the nav.onFailed callback App registered.
      const FAILED: NavFailed = {
        viewId: 1,
        errorCode: -105,
        errorDescription: 'NAME_NOT_RESOLVED',
        validatedURL: 'https://invalid.invalid/',
        kind: 'load',
      };
      await ctx.emitNavFailed?.(FAILED);
      const retryBtn = ctx.byRole('button', /^Retry$/);
      if (!retryBtn) throw new Error('"Retry" button not found in ErrorOverlay');
      await ctx.click(retryBtn);
      // Clear the overlay via the control surface (same as leaveScreen's clearError).
      // nav.reloadOrStop triggers isLoading=true which clears failed/crashed in App,
      // but in vitest the nav mock is a no-op; use the control surface directly.
      if (ctx.layer === 'vitest') {
        const { getAutopilotControl } = await import('../control');
        const { flushSync } = await import('react-dom');
        const control = getAutopilotControl();
        if (control) flushSync(() => control.clearError());
      }
    },
    assert: async (ctx) => {
      if (!ctx.calls.called('nav.reloadOrStop'))
        throw new Error('nav.reloadOrStop not called after clicking Retry');
      return 'errorOverlay Retry → nav.reloadOrStop()';
    },
  },

  {
    id: 'crashOverlay.reload',
    domain: 'crashOverlay',
    description: 'Emit nav.crashed → click Reload → nav.reloadOrStop called',
    screen: 'home',
    // vitest-only: the live core emits nav.crashed only on actual renderer crashes,
    // which cannot be triggered deterministically in an autopilot run.
    layers: ['vitest'],
    run: async (ctx) => {
      // Render the crash overlay by invoking the nav.onCrashed callback App registered.
      const CRASHED: NavCrashed = { viewId: 1, reason: 'crashed' };
      await ctx.emitNavCrashed?.(CRASHED);
      // The crash view shows the heading "This page crashed" and a Retry button
      // (ErrorOverlay reuses the same Retry/Home layout for both failed and crashed states).
      const retryBtn = ctx.byRole('button', /^Retry$/);
      if (!retryBtn) throw new Error('"Retry" button not found in ErrorOverlay (crash view)');
      await ctx.click(retryBtn);
      // Clear the crash overlay via the control surface so it doesn't linger.
      if (ctx.layer === 'vitest') {
        const { getAutopilotControl } = await import('../control');
        const { flushSync } = await import('react-dom');
        const control = getAutopilotControl();
        if (control) flushSync(() => control.clearCrash());
      }
    },
    assert: async (ctx) => {
      if (!ctx.calls.called('nav.reloadOrStop'))
        throw new Error('nav.reloadOrStop not called after clicking Retry (crash overlay)');
      return 'crashOverlay Retry → nav.reloadOrStop()';
    },
  },

  {
    id: 'safety.proceed',
    domain: 'safety',
    description: 'Emit safety interstitial → click "Continue anyway" → safety.proceed called',
    screen: 'home',
    // vitest-only: the safety interstitial is triggered only when MalwareGuard blocks a
    // real URL; the live autopilot cannot navigate to a real malware URL safely.
    layers: ['vitest'],
    run: async (ctx) => {
      const PAYLOAD: SafetyInterstitialPayload = {
        url: 'https://malware.test/',
        reason: 'malware',
      };
      // Render the interstitial by invoking the onInterstitial callback useSafety registered.
      await ctx.emitSafetyInterstitial?.(PAYLOAD);
      // The continue button text for malware is "Continue anyway (not recommended)".
      const continueBtn = ctx.byRole('button', /continue anyway/i);
      if (!continueBtn) throw new Error('"Continue anyway" button not found in SafetyInterstitial');
      await ctx.click(continueBtn);
      // Clear the interstitial so it doesn't linger.
      await ctx.emitSafetyInterstitial?.(null);
    },
    assert: async (ctx) => {
      if (!ctx.calls.called('safety.proceed'))
        throw new Error('safety.proceed not called after clicking "Continue anyway"');
      return 'safetyInterstitial "Continue anyway" → safety.proceed()';
    },
  },

  {
    id: 'safety.back',
    domain: 'safety',
    description: 'Emit safety interstitial → click "Go back" → nav.back called',
    screen: 'home',
    // vitest-only: same reasoning as safety.proceed.
    layers: ['vitest'],
    run: async (ctx) => {
      const PAYLOAD: SafetyInterstitialPayload = {
        url: 'https://malware.test/',
        reason: 'malware',
      };
      // Render the interstitial by invoking the onInterstitial callback useSafety registered.
      await ctx.emitSafetyInterstitial?.(PAYLOAD);
      // The "Go back" button is provided by SafetyInterstitial when onBack is passed.
      const backBtn = ctx.byRole('button', /^Go back$/);
      if (!backBtn) throw new Error('"Go back" button not found in SafetyInterstitial');
      await ctx.click(backBtn);
      // Clear the interstitial so it doesn't linger.
      await ctx.emitSafetyInterstitial?.(null);
    },
    assert: async (ctx) => {
      if (!ctx.calls.called('nav.back'))
        throw new Error('nav.back not called after clicking "Go back" in SafetyInterstitial');
      return 'safetyInterstitial "Go back" → nav.back()';
    },
  },

  {
    id: 'permission.allow',
    domain: 'permission',
    description: 'Emit permission prompt → click Allow → permissions.resolve(allow) called',
    screen: 'home',
    // vitest-only: the permission prompt is triggered by the real OS permission request in
    // a content webview; the live autopilot cannot safely trigger a geolocation prompt.
    layers: ['vitest'],
    run: async (ctx) => {
      const PROMPT: PermissionPrompt = {
        requestId: 1,
        origin: 'https://example.com',
        permission: 'geolocation',
      };
      // Render the permission dialog by invoking the onPrompt callback usePermissions registered.
      await ctx.emitPermissionPrompt?.(PROMPT);
      const allowBtn = ctx.byRole('button', /^Allow$/);
      if (!allowBtn) throw new Error('"Allow" button not found in PermissionPromptDialog');
      await ctx.click(allowBtn);
      // Dismiss the prompt so it doesn't linger (usePermissions clears it on resolve).
      await new Promise((r) => setTimeout(r, 50));
    },
    assert: async (ctx) => {
      // permissions.resolve is called with (requestId, 'allow') — check the second arg.
      if (!ctx.calls.called('permissions.resolve', (a) => a[1] === 'allow'))
        throw new Error('permissions.resolve not called with "allow"');
      return 'permissionPrompt Allow → permissions.resolve(requestId, "allow")';
    },
  },

  {
    id: 'permission.deny',
    domain: 'permission',
    description: 'Emit permission prompt → click Block → permissions.resolve(deny) called',
    screen: 'home',
    // vitest-only: same reasoning as permission.allow.
    layers: ['vitest'],
    run: async (ctx) => {
      const PROMPT: PermissionPrompt = {
        requestId: 2,
        origin: 'https://example.com',
        permission: 'microphone',
      };
      // Render the permission dialog by invoking the onPrompt callback usePermissions registered.
      await ctx.emitPermissionPrompt?.(PROMPT);
      // The deny button is labelled "Block" in PermissionPromptDialog.
      const blockBtn = ctx.byRole('button', /^Block$/);
      if (!blockBtn) throw new Error('"Block" button not found in PermissionPromptDialog');
      await ctx.click(blockBtn);
      // Dismiss the prompt so it doesn't linger.
      await new Promise((r) => setTimeout(r, 50));
    },
    assert: async (ctx) => {
      // permissions.resolve is called with (requestId, 'deny') — check the second arg.
      if (!ctx.calls.called('permissions.resolve', (a) => a[1] === 'deny'))
        throw new Error('permissions.resolve not called with "deny"');
      return 'permissionPrompt Block → permissions.resolve(requestId, "deny")';
    },
  },

  {
    id: 'redirectBar.openAnyway',
    domain: 'redirectBar',
    description: 'Emit redirect.blocked → click "Open anyway" → tabs.create(to) called',
    screen: 'home',
    // vitest-only: the redirect guard fires only when the native nav policy blocks a
    // real scripted redirect; not reproducible on demand in the live autopilot.
    layers: ['vitest'],
    run: async (ctx) => {
      const REDIRECT: RedirectBlocked = {
        viewId: 1,
        from: 'https://publisher.test/',
        to: 'https://malvertising.test/landing',
      };
      // Render the RedirectBar by invoking the onBlocked callback App registered.
      await ctx.emitRedirectBlocked?.(REDIRECT);
      const openBtn = ctx.byRole('button', /^Open anyway$/);
      if (!openBtn) throw new Error('"Open anyway" button not found in RedirectBar');
      await ctx.click(openBtn);
      // The bar dismisses itself after "Open anyway" (setBlockedRedirect(null) in App).
    },
    assert: async (ctx) => {
      // App calls tabs.create(to, false) when "Open anyway" is clicked.
      if (!ctx.calls.called('tabs.create', (a) => String(a[0]).includes('malvertising.test')))
        throw new Error('tabs.create not called with the blocked redirect destination URL');
      return 'redirectBar "Open anyway" → tabs.create(malvertising.test/landing)';
    },
  },

  {
    id: 'redirectBar.dismiss',
    domain: 'redirectBar',
    description: 'Emit redirect.blocked → click Dismiss (X) → bar removed from DOM',
    screen: 'home',
    // vitest-only: same reasoning as redirectBar.openAnyway.
    layers: ['vitest'],
    run: async (ctx) => {
      const REDIRECT: RedirectBlocked = {
        viewId: 1,
        from: 'https://publisher.test/',
        to: 'https://malvertising.test/landing',
      };
      // Render the RedirectBar by invoking the onBlocked callback App registered.
      await ctx.emitRedirectBlocked?.(REDIRECT);
      // The dismiss button has aria-label="Dismiss" (set in RedirectBar).
      const dismissBtn = ctx.byLabel(/^Dismiss$/);
      if (!dismissBtn) throw new Error('"Dismiss" button not found in RedirectBar');
      await ctx.click(dismissBtn);
      // Give React a tick to remove the bar from the DOM.
      await new Promise((r) => setTimeout(r, 50));
    },
    assert: async (ctx) => {
      // After clicking Dismiss the bar should no longer be in the DOM.
      const bar = ctx.bySelector('.redirect-bar');
      if (bar) throw new Error('RedirectBar still in DOM after clicking Dismiss');
      return 'redirectBar Dismiss → bar removed from DOM';
    },
  },

  {
    id: 'redirectBar.dismissSticky',
    domain: 'redirectBar',
    description:
      'After dismiss, the SAME destination stays suppressed (a malicious page re-fires it on a ' +
      'timer + on the bar-resize → the bar must be closable); a DIFFERENT destination still shows',
    screen: 'home',
    // vitest-only: same reasoning as redirectBar.dismiss.
    layers: ['vitest'],
    run: async (ctx) => {
      const A: RedirectBlocked = {
        viewId: 1,
        from: 'https://streamex.test/',
        to: 'https://malvertising.test/landing',
      };
      await ctx.emitRedirectBlocked?.(A);
      const dismissBtn = ctx.byLabel(/^Dismiss$/);
      if (!dismissBtn) throw new Error('"Dismiss" button not found in RedirectBar');
      await ctx.click(dismissBtn);
      await new Promise((r) => setTimeout(r, 30));
      // The page re-fires the SAME blocked redirect (timer / the bar's own resize) — the bar
      // must NOT reappear, or it would be impossible to close.
      await ctx.emitRedirectBlocked?.(A);
      await new Promise((r) => setTimeout(r, 30));
      if (ctx.bySelector('.redirect-bar'))
        throw new Error(
          'RedirectBar reappeared after dismissing the SAME destination (unclosable loop)',
        );
      // A genuinely different destination SHOULD still surface a fresh bar.
      const B: RedirectBlocked = {
        viewId: 1,
        from: 'https://streamex.test/',
        to: 'https://other-threat.test/x',
      };
      await ctx.emitRedirectBlocked?.(B);
      await new Promise((r) => setTimeout(r, 30));
    },
    assert: async (ctx) => {
      const bar = ctx.bySelector('.redirect-bar');
      if (!bar)
        throw new Error(
          'RedirectBar did not surface for a NEW destination after a prior dismissal',
        );
      if (!bar.textContent?.includes('other-threat.test'))
        throw new Error('RedirectBar shows the wrong destination after a new block');
      return 'redirectBar dismiss is sticky per-destination (same suppressed, new shown)';
    },
  },
];
