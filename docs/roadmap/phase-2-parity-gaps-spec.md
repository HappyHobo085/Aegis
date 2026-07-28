# Phase 2 — Platform Parity Gaps: Spec Summary

Aegis targets Linux, Windows, macOS, and Android. Most features are implemented
across all four platforms, but several have gaps — either missing implementations,
degraded behavior, or features that work on one platform but not others. This
document catalogs every known parity gap, its current state, target state, and
what is required to close it.

**Success criteria:** Each platform has identical feature coverage where
technically possible. Where a platform's native API genuinely cannot support the
feature (e.g. macOS `WKFindResult` only exposing a boolean), the gap is
documented with the technical limitation and a shim/fallback path is provided
where feasible.

---

## Gap 1: macOS Proxy Support

| Field                   | Detail                                                                                                                                                                                                                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Current state**       | `proxy.rs` `apply_to_tab` is a `cfg(target_os="macos")` no-op (line 188). macOS builds and runs; proxy is simply absent. Direct connection only.                                                                                                                       |
| **Target state**        | macOS content webviews route through a user-configured HTTP or SOCKS5 proxy, matching Linux (live per-webview) and Windows (spawn-time).                                                                                                                               |
| **Platform constraint** | Requires `WKWebsiteDataStore.proxyConfigurations` (macOS 14+) with hand-rolled `nw_proxy_config_*` / `NWEndpoint` Network.framework bindings via objc2. These bindings **cannot be compiled or verified from Linux** — objc2's build script needs a macOS C toolchain. |
| **Can fix from Linux?** | **No.** Requires a Mac developer with Xcode and a macOS 14+ build environment.                                                                                                                                                                                         |
| **Files**               | `src-tauri/src/proxy.rs` (no-op arm at line 188), `src-tauri/src/nav.rs` (spawn-time injection on macOS — TBD).                                                                                                                                                        |
| **Reference**           | `docs/superpowers/plans/2026-06-23-proxy.md` Task 6 (deferred binding spec).                                                                                                                                                                                           |

## Gap 2: Android Fingerprinting Allowlist

| Field                   | Detail                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Current state**       | `NativeFarble.farbleScript()` JNI getter (in `farble.rs` line 192) hardcodes `host_allowlisted = false`. The JNI getter has no `AppHandle` and therefore no access to `FarbleState` managed state. Farbling applies to ALL hosts on Android regardless of the fp-allowlist.                                                                              |
| **Target state**        | Android respects the fp-allowlist: farbling is skipped for allowlisted hosts, matching desktop behavior.                                                                                                                                                                                                                                                 |
| **Platform constraint** | The JNI getter runs on a non-Tauri thread with no `AppHandle`. The allowlist data is in `FarbleState` (Tauri managed state).                                                                                                                                                                                                                             |
| **Can fix from Linux?** | **Yes** — the Rust `farble.rs` and Kotlin `NativeFarble.kt` changes can be written and cross-compiled from Linux. Android JNI can be verified via `cargo check --target aarch64-linux-android` and Kotlin `compileUniversalDebugKotlin`.                                                                                                                 |
| **Files**               | `src-tauri/src/farble.rs` (add `ANDROID_FP_ALLOWLIST` global + `note_fp_allowlist` + updated JNI getter signature), `src-tauri/gen/android/app/src/main/java/com/aegis/browser/NativeFarble.kt` (add `host` param to `farbleScript`), `src-tauri/gen/android/app/src/main/java/com/aegis/browser/MainActivity.kt` (pass current host to `farbleScript`). |

## Gap 3: macOS Find-in-Page (Degraded)

| Field                   | Detail                                                                                                                                                                                                                                                                                    |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Current state**       | `find_mac.rs` uses `WKWebView::findString:withConfiguration:completionHandler:`. `WKFindResult` exposes only `matchFound` (bool). FindBar shows "1 match" / "0 matches". No real count, no highlight-all, no active index. `next`/`prev` re-issue `findString:` with `backwards` toggled. |
| **Target state**        | Real match count, highlight-all, and active index — matching Linux (WebKitFindController: real count + highlight) and Windows (`ICoreWebView2Find`: real count + real active index + highlight-all).                                                                                      |
| **Platform constraint** | The native WKWebView API does not expose match count. A JS-shim tier (inject JS that calls `window.find()` or traverses `TreeWalker` nodes and counts) would provide real count + highlight-all, but cannot be compiled or tested from Linux.                                             |
| **Can fix from Linux?** | **Partially** — the JS shim string and the Rust injection wiring can be written from Linux. The actual macOS runtime verification requires a Mac. The shim can be validated structurally (correct JS, correct injection path) but not functionally from Linux.                            |
| **Files**               | `src-tauri/src/find_mac.rs` (replace native `findString:` with JS shim injection via `adblock_inject`-style `evaluate_javascript`), potentially a new `find_shim_mac.js` bundled file.                                                                                                    |
| **Reference**           | `src-tauri/src/find_mac.rs` line 9-11 documents the degradation and the JS-shim follow-up.                                                                                                                                                                                                |

## Gap 4: Element Picker (Linux-Only)

| Field                   | Detail                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Current state**       | `picker.rs` is gated with `#[cfg(target_os = "linux")]`. The `PICKER_JS` constant, `on_picked` handler, and `dispatch` body all return `{ ok: false }` on non-Linux. Uses WebKitGTK `evaluate_javascript` and the title-sentinel pattern (`AEGISPICK:{json}`) caught by `linux_layout::connect_title_label`.                                                                                                                                                              |
| **Target state**        | Element picker works on all desktop platforms (Linux, Windows, macOS). Android is out of scope (mobile UX differs).                                                                                                                                                                                                                                                                                                                                                       |
| **Platform constraint** | The JS injection itself (`PICKER_JS`) is engine-agnostic — it works in any browser engine. The challenge is the **signal path**: how does the picker's `document.title` sentinel get caught on Windows (WebView2) and macOS (WKWebView)? Linux uses WebKit's `title-changed` signal. Windows would need a `DocumentTitleChanged` event; macOS would need KVO on `title`. The cosmetic filter persistence path (`customfilters` + `adblock_refresh`) is platform-agnostic. |
| **Can fix from Linux?** | **Partially** — the JS and Rust dispatch logic can be written from Linux. Windows compile-check via `cargo check --target x86_64-pc-windows-gnu`. macOS requires a Mac for compile + runtime test.                                                                                                                                                                                                                                                                        |
| **Files**               | `src-tauri/src/picker.rs` (remove `#[cfg(target_os = "linux")]` from `PICKER_JS`, add `on_picked` call from Windows/macOS title-sentinel handlers), `src-tauri/src/nav_url_win.rs` (or new `picker_win.rs` — wire `DocumentTitleChanged` to sentinel detection), potentially `src-tauri/src/nav_url_mac.rs` (wire KVO on `title`).                                                                                                                                        |

## Gap 5: macOS GUI Runtime Verification

| Field                   | Detail                                                                                                                                                                                                                       |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Current state**       | Most macOS features compile in CI (`tauri-build-check.yml`, `macos-latest`) but have **never been GUI-tested on a real Mac**. The CI builds produce `.app` and `.dmg` artifacts but no automated GUI test runs against them. |
| **Target state**        | Every feature that compiles on macOS is manually verified on a real Mac desktop (browse, ad-block, find-in-page, zoom, proxy if implemented, tab management, settings).                                                      |
| **Platform constraint** | Requires physical macOS hardware or a macOS VM with display access. Cannot be done from Linux.                                                                                                                               |
| **Can fix from Linux?** | **No.** This is a testing/documentation task that requires a Mac.                                                                                                                                                            |

---

## Summary: What Can Be Done From Linux

| Gap                     | Linux-fixable? | Scope from Linux                                 |
| ----------------------- | -------------- | ------------------------------------------------ |
| 1. macOS proxy          | **No**         | —                                                |
| 2. Android fp-allowlist | **Yes**        | Full implementation + cross-compile check        |
| 3. macOS find-in-page   | **Partial**    | JS shim + Rust wiring (no runtime verify)        |
| 4. Element picker       | **Partial**    | JS + Rust dispatch (macOS signal path needs Mac) |
| 5. macOS GUI verify     | **No**         | —                                                |

## Priority Order

1. **Android fp-allowlist** (Gap 2) — fully fixable from Linux, high impact (parity across desktop + Android)
2. **Element picker cross-platform** (Gap 4) — partially fixable, moderate complexity
3. **macOS find-in-page JS shim** (Gap 3) — partially fixable, high value but needs Mac for verify
4. **macOS proxy** (Gap 1) — requires Mac developer, blocks proxy parity
5. **macOS GUI runtime verify** (Gap 5) — requires Mac, gates confidence in all macOS features
