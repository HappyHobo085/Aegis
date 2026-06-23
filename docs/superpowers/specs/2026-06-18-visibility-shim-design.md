# Content visibility shim — design

**Date:** 2026-06-18
**Status:** Approved (brainstorming), pending implementation plan
**Topic:** Stop malvertising sites from firing visibility-triggered top-frame redirects when an in-app overlay (Settings/Downloads/sidebar) hides the content webview

## Problem

On a malvertising streaming site (streamex), opening then closing **Settings** caused the _same tab_ to redirect to `https://www.google.com/`. Confirmed: Aegis does NOT navigate the content webview on overlay open/close — `view.rs` only toggles visibility (`set_content_visible`), no `navigate`/`load`. The redirect comes from the **page**: hiding the content webview for an overlay fires the page's `visibilitychange`→hidden, which arms an ad script's pop-under; Aegis's `POPUP_GUARD` blocks the cross-origin `window.open`, so the script falls back to a top-frame `location` redirect (bare `www.google.com/` = the classic blocked-popup bounce). A top-frame self-redirect to a non-ad domain can't be blocked without breaking legitimate navigation.

## Decision

Inject a document-start **visibility shim** that makes content pages always report themselves **visible**, so the in-app overlay no longer produces a "hidden" transition the ad script can trigger on. (Chosen over reproduce-and-block-the-chain and over leaving it as-is.)

## Behavior

The shim, running before any page script:

- `document.visibilityState` getter → always `'visible'`
- `document.hidden` getter → always `false`
- `visibilitychange` events are swallowed so page/ad handlers never observe a hidden transition

## Why always-on (not overlay-scoped)

The redirect arms at the instant the overlay hides the webview, so the spoof must already be active at document-start — there is no "enable on overlay open" variant that defuses that first transition. Hence a permanent shim.

**Accepted tradeoff:** pages also believe they're visible when the user switches apps/tabs/minimizes, so e.g. a video won't auto-pause on background. Acceptable (often preferred) for this browser's threat model; documented as a conscious choice.

## Scope of effectiveness (honest)

This covers the **Page Visibility API** — the dominant pop-under/redirect trigger and low-risk to spoof. It deliberately does **NOT** spoof window `blur`/`focus` (that would break legitimate focus/form behavior). If the live repro shows streamex keys off `blur` instead of `visibilitychange`, the shim is a no-op for that vector and we revisit — we do not ship it as a confirmed fix until the streamex redirect is observed to stop.

## Where it lives (cross-platform)

- New `src-tauri/src/visibility_shim.js`, `include_str!`'d into `adblock_inject.rs` as a `VISIBILITY_GUARD` const (single-sourced JS so the shipped bytes are the tested bytes — mirrors `webrtc_shim.*.js`).
- Concatenated next to `POPUP_GUARD`:
  - `adblock_inject::compose()` → ships on Linux + Windows + macOS.
  - the Android `Java_..._NativeInject_documentStartScript` builder → ships on Android.
- Always injected (like `POPUP_GUARD`), not allowlist-gated.

## Testing

- **vitest** (`src/lib/visibilityShim.test.ts`, authoritative on the shipped `.js`): after running the shim in jsdom, `document.visibilityState === 'visible'` and `document.hidden === false` even after dispatching a `visibilitychange`; a page-registered `visibilitychange` listener never observes `document.hidden === true`.
- **Rust** (`adblock_inject.rs` tests): `compose()` output and the Android builder both contain the shim marker.
- **Live verification:** load streamex in the new build, open+close Settings, confirm the tab no longer redirects to Google. If it still redirects, report back (trigger was not the Visibility API) rather than claim success.

## Out of scope

Window `blur`/`focus` spoofing; blocking the redirect destination; any change to `POPUP_GUARD` or the WebRTC shim.
