# Content Visibility Shim Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Inject a document-start shim that makes content pages always report themselves visible, so an in-app overlay (Settings/Downloads/sidebar) hiding the content webview no longer fires `visibilitychange`→hidden and arms malvertising pop-under/redirect scripts.

**Architecture:** Single-source the shim JS to `src-tauri/src/visibility_shim.js` (so the shipped bytes are the tested bytes, mirroring `webrtc_shim.*.js`), `include_str!` it into `adblock_inject.rs` as `VISIBILITY_GUARD`, and concatenate it next to `POPUP_GUARD` in both `compose()` (Linux/Win/macOS) and the Android `documentStartScript` JNI builder. A vitest jsdom test exercises the shipped JS; a Rust test confirms it's composed in.

**Tech Stack:** plain JS (document-start IIFE), Rust (`include_str!`, `format!`), vitest jsdom, cargo test.

**Spec:** `docs/superpowers/specs/2026-06-18-visibility-shim-design.md`

**Test gates:** `npm test` (vitest) and `cargo test --manifest-path src-tauri/Cargo.toml`; Android parity via `cargo check --target aarch64-linux-android`.

---

## Reference: current `adblock_inject.rs` shape

- `const POPUP_GUARD: &str = r#"(function(){ … })();"#;` (an always-shipped document-start IIFE).
- `fn compose(webrtc: &str) -> String` — Linux: `format!("{webrtc}\n{POPUP_GUARD}")`; non-Linux: `format!("{webrtc}\n{POPUP_GUARD}\n{}", BUILT.get_or_init(build))`.
- Android: `Java_com_aegis_browser_NativeInject_documentStartScript` does `let s = format!("{POPUP_GUARD}\n{}", build());`.
- Existing test `popup_guard_overrides_window_open_and_ships_everywhere` asserts `compose("").contains("__aegisBlocked")` (runnable on the Linux host).

---

## Task 1: the shim JS + vitest test

**Files:**
- Create: `src-tauri/src/visibility_shim.js`
- Test: `src/lib/visibilityShim.test.ts`

- [ ] **Step 1: Create `src-tauri/src/visibility_shim.js`**

```javascript
/* aegis-visibility-shim: keep content pages reporting themselves foreground-visible.
   An in-app overlay (Settings/Downloads/sidebar) hides the content webview, which would
   otherwise fire visibilitychange->hidden and arm malvertising pop-under/redirect scripts.
   Keeping the page "visible" defuses that trigger. Tradeoff: pages also believe they are
   visible when genuinely backgrounded (e.g. video won't auto-pause) — a conscious choice. */
(function () {
  try {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: function () { return 'visible'; },
    });
  } catch (e) {}
  try {
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: function () { return false; },
    });
  } catch (e) {}
  try {
    Object.defineProperty(document, 'onvisibilitychange', {
      configurable: true,
      get: function () { return null; },
      set: function () {},
    });
  } catch (e) {}
  try {
    var realAdd = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, listener, opts) {
      if (type === 'visibilitychange' && (this === document || this === window)) return;
      return realAdd.call(this, type, listener, opts);
    };
  } catch (e) {}
})();
```

- [ ] **Step 2: Write the failing vitest test (`src/lib/visibilityShim.test.ts`)**

```ts
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, it, expect, vi } from 'vitest';

const shimSrc = readFileSync(
  resolve(__dirname, '../../src-tauri/src/visibility_shim.js'),
  'utf8',
);

function runShim() {
  // Execute the SHIPPED shim bytes against the jsdom globals (authoritative).
  new Function(shimSrc)();
}

describe('visibility shim', () => {
  it('forces document.visibilityState=visible and hidden=false', () => {
    runShim();
    expect(document.visibilityState).toBe('visible');
    expect(document.hidden).toBe(false);
  });

  it('swallows visibilitychange listeners so page handlers never fire', () => {
    runShim();
    const handler = vi.fn();
    document.addEventListener('visibilitychange', handler);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(handler).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run the test to verify it passes**

Run: `npm test -- visibilityShim`
Expected: PASS (2 tests). (The test reads the real `.js` created in Step 1, so it passes immediately once the file exists and is correct — this is a JS file with no failing-first compile stage; if either assertion fails, fix `visibility_shim.js` until both pass.)
Sanity that it's a real check: temporarily breaking the shim (e.g. returning `'hidden'`) must make test 1 fail — confirm mentally, then ensure the shipped shim passes.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/visibility_shim.js src/lib/visibilityShim.test.ts
git commit -m "feat(adblock): visibility shim JS — keep content pages reporting visible"
```

---

## Task 2: wire `VISIBILITY_GUARD` into the injection (all platforms)

**Files:**
- Modify: `src-tauri/src/adblock_inject.rs`

- [ ] **Step 1: Write the failing Rust test**

Add inside `adblock_inject.rs`'s `#[cfg(test)] mod tests`:

```rust
#[test]
fn visibility_shim_ships_in_the_composed_script() {
    // The shim is concatenated on every platform; compose("") is the Linux-host case.
    assert!(super::compose("").contains("aegis-visibility-shim"));
    assert!(super::compose("").contains("visibilityState"));
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml visibility_shim_ships`
Expected: FAIL — `compose("")` does not yet contain the marker.

- [ ] **Step 3: Add the `VISIBILITY_GUARD` const**

Immediately after the `POPUP_GUARD` const definition (after its closing `})();"#;`), add:

```rust
/// Document-start shim that keeps content pages reporting themselves visible, so an in-app
/// overlay hiding the content webview can't fire visibilitychange-hidden and arm a
/// malvertising redirect/pop-under. Shipped on EVERY platform alongside POPUP_GUARD.
const VISIBILITY_GUARD: &str = include_str!("visibility_shim.js");
```

- [ ] **Step 4: Concatenate it in `compose()` (both branches)**

Change the Linux branch from `format!("{webrtc}\n{POPUP_GUARD}")` to:

```rust
        format!("{webrtc}\n{POPUP_GUARD}\n{VISIBILITY_GUARD}")
```

Change the non-Linux branch from `format!("{webrtc}\n{POPUP_GUARD}\n{}", BUILT.get_or_init(build))` to:

```rust
        format!("{webrtc}\n{POPUP_GUARD}\n{VISIBILITY_GUARD}\n{}", BUILT.get_or_init(build))
```

- [ ] **Step 5: Concatenate it in the Android builder**

In `Java_com_aegis_browser_NativeInject_documentStartScript`, change `let s = format!("{POPUP_GUARD}\n{}", build());` to:

```rust
    let s = format!("{POPUP_GUARD}\n{VISIBILITY_GUARD}\n{}", build());
```

- [ ] **Step 6: Run to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml visibility_shim_ships`
Expected: PASS.
Run: `cargo test --manifest-path src-tauri/Cargo.toml` (full crate) — all green, including the existing `popup_guard_overrides_window_open_and_ships_everywhere`.
Run: `cargo check --manifest-path src-tauri/Cargo.toml` — clean.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/adblock_inject.rs
git commit -m "feat(adblock): ship the visibility shim on all platforms (compose + Android)"
```

---

## Final verification (controller)

- [ ] `npm test` — all green (the 2 new vitest tests included).
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` — all green.
- [ ] **Android parity:** `cargo check --target aarch64-linux-android` (NDK env: `ANDROID_NDK_HOME` + `CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER`/`CC_aarch64_linux_android` = `…/aarch64-linux-android24-clang`) — the Android builder concatenation compiles.
- [ ] **Confirm the real fix (the whole point):** build the AppImage (`npm run tauri:build`), load streamex, open+close Settings, and confirm the tab no longer redirects to `https://www.google.com/`. If it STILL redirects, the trigger was window `blur`/`focus` rather than the Visibility API — report that (do NOT claim success); the shim is then a no-op for this case and we revisit per the spec.
- [ ] Update memory: visibility shim shipped (and whether the streamex repro confirmed it).
```
