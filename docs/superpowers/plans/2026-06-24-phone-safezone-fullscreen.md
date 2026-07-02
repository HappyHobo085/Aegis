# Phone safe-zone insets + fullscreen fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep all Android phone chrome and the browsed page inside the device safe area on all four edges when not in fullscreen; make mobile fullscreen truly immersive (hide status + nav bars); make desktop fullscreen drive the real OS window.

**Architecture:** Extend the existing `--aegis-inset-*` CSS-variable contract: Android `MainActivity.kt` captures the `systemBars() ∪ displayCutout()` insets on all four edges and pushes them as CSS vars; each full-window mobile surface pads itself with those vars. Mobile fullscreen adopts the immersive bar-hiding already used by the HTML5-video path. Desktop fullscreen adds a backend `Window::set_fullscreen` call to the existing `view.setFullscreen` handler.

**Tech Stack:** React 19 + TypeScript (renderer / chrome), CSS (`src/index.css`), Rust + Tauri 2 (`src-tauri/src`), Kotlin/Android (`MainActivity.kt`), vitest (tests).

**Spec:** `docs/superpowers/specs/2026-06-24-phone-safezone-fullscreen-design.md`

## Global Constraints

- **`--aegis-inset-*` contract:** the real OS inset in px, pushed from native to the chrome's `document.documentElement`; CSS always references it as `var(--aegis-inset-X, env(safe-area-inset-X))` so the `env()` fallback covers desktop browsers / future iOS. Four edges: `top`, `bottom`, `left`, `right`.
- **All mobile CSS changes are `.aegis-mobile`-scoped** (or use vars that are unset → `env()` → 0 on desktop) so desktop rendering is unchanged. Desktop has no system bars/cutouts.
- **Android build needs JDK 21** (not the machine default): `JAVA_HOME=~/development/android-studio/jbr`. `minSdk = 24`, `compileSdk = 36`.
- **Android compile gates both run on this Linux host:** `cargo check --target aarch64-linux-android` and Kotlin `compileUniversalDebugKotlin` (NDK 27 + JBR 21 installed).
- **Desktop fullscreen is a backend call** — no Tauri capability change (`capabilities/default.json` stays as-is).
- **Autopilot gate (required before pushing to main):** `npm test` green; for runtime behavior, `bash scripts/autopilot/run-autopilot.sh` → `RESULT: … 0 failed` and `ad-block blocking (trace): PASS`.
- **Parity rule:** every platform ends at the same level — fullscreen genuinely takes over the screen everywhere; all non-fullscreen phone UI sits in the safe area. CSS benefits all mobile; desktop unaffected.
- **Living docs:** update the relevant `CLAUDE.md` in the same commit as the change.

---

### Task 1: Mobile safe-area CSS — four-edge insets on every full-window mobile surface

Fixes the reported bug (Settings/Downloads draw under the status + nav bars) and extends every mobile surface to all four edges. TDD via a source-level drift guard over `src/index.css`.

**Files:**

- Create: `src/autopilot/safeArea.test.ts`
- Modify: `src/index.css` (selectors `.mobile-topbar` ~4158, `.mobile-bottombar` ~4214, `.mobile-sheet` ~4248, `.aegis-mobile .settings-modal__content` ~4344, `.aegis-mobile .downloads-modal` ~4355, plus two new `.aegis-mobile` rules)
- Modify: `src/CLAUDE.md` (the mobile-shell "Safe-area insets" bullet)

**Interfaces:**

- Consumes: the `--aegis-inset-top/bottom/left/right` CSS vars (pushed by Task 2; the `env()` fallback means this task is independently testable and renders correctly even before Task 2 lands).
- Produces: the safe-area padding on the listed selectors that the Task 1 drift guard asserts.

- [ ] **Step 1: Write the failing drift-guard test**

Create `src/autopilot/safeArea.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const css = readFileSync(fileURLToPath(new URL('../index.css', import.meta.url)), 'utf8');

/** Return the declaration block (between `{` and the next `}`) for an EXACT selector.
 *  The target selectors contain no nested braces, so matching to the next `}` is safe. */
function block(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = css.match(new RegExp(esc + '\\s*\\{([^}]*)\\}'));
  if (!m) throw new Error(`selector not found in src/index.css: ${selector}`);
  return m[1];
}

// Each mobile full-window surface must reference the inset var(s) for the edges it touches.
const REQUIRED: Array<[string, string[]]> = [
  ['.mobile-topbar', ['--aegis-inset-top', '--aegis-inset-left', '--aegis-inset-right']],
  ['.mobile-bottombar', ['--aegis-inset-bottom', '--aegis-inset-left', '--aegis-inset-right']],
  [
    '.mobile-sheet',
    ['--aegis-inset-top', '--aegis-inset-bottom', '--aegis-inset-left', '--aegis-inset-right'],
  ],
  [
    '.aegis-mobile .settings-modal__content',
    ['--aegis-inset-top', '--aegis-inset-bottom', '--aegis-inset-left', '--aegis-inset-right'],
  ],
  [
    '.aegis-mobile .downloads-modal',
    ['--aegis-inset-top', '--aegis-inset-bottom', '--aegis-inset-left', '--aegis-inset-right'],
  ],
  [
    '.aegis-mobile .onboarding',
    ['--aegis-inset-top', '--aegis-inset-bottom', '--aegis-inset-left', '--aegis-inset-right'],
  ],
  ['.aegis-mobile .toaster', ['--aegis-inset-bottom', '--aegis-inset-right']],
];

describe('mobile chrome stays within the safe area (all four edges)', () => {
  for (const [selector, vars] of REQUIRED) {
    it(`${selector} references ${vars.join(', ')}`, () => {
      const body = block(selector);
      for (const v of vars) expect(body, `${selector} missing ${v}`).toContain(v);
    });
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/autopilot/safeArea.test.ts`
Expected: FAIL — `.mobile-bottombar` / `.mobile-sheet` lack left/right; `.aegis-mobile .settings-modal__content` and `.downloads-modal` reference no inset vars; the `.aegis-mobile .onboarding` and `.aegis-mobile .toaster` selectors are "not found".

- [ ] **Step 3: Add left/right to `.mobile-topbar`**

In `src/index.css`, replace the `.mobile-topbar` `padding` declaration:

```css
padding: var(--aegis-inset-top, env(safe-area-inset-top)) calc(8px + env(safe-area-inset-right)) 0
  calc(8px + env(safe-area-inset-left));
```

with:

```css
padding: var(--aegis-inset-top, env(safe-area-inset-top))
  calc(8px + var(--aegis-inset-right, env(safe-area-inset-right))) 0
  calc(8px + var(--aegis-inset-left, env(safe-area-inset-left)));
```

- [ ] **Step 4: Add left/right to `.mobile-bottombar`**

Replace its single `padding-bottom` line:

```css
padding-bottom: var(--aegis-inset-bottom, env(safe-area-inset-bottom));
```

with:

```css
padding-left: var(--aegis-inset-left, env(safe-area-inset-left));
padding-right: var(--aegis-inset-right, env(safe-area-inset-right));
padding-bottom: var(--aegis-inset-bottom, env(safe-area-inset-bottom));
```

(`box-sizing: content-box` with `left:0; right:0` keeps the bar pinned to the viewport width; the horizontal padding shifts the buttons inward — correct.)

- [ ] **Step 5: Add left/right to `.mobile-sheet`**

Replace its two padding lines:

```css
padding-top: var(--aegis-inset-top, env(safe-area-inset-top));
padding-bottom: var(--aegis-inset-bottom, env(safe-area-inset-bottom));
```

with:

```css
padding-top: var(--aegis-inset-top, env(safe-area-inset-top));
padding-bottom: var(--aegis-inset-bottom, env(safe-area-inset-bottom));
padding-left: var(--aegis-inset-left, env(safe-area-inset-left));
padding-right: var(--aegis-inset-right, env(safe-area-inset-right));
```

(Covers History / Saved / Menu / Tabs — `MobileMenuSheet` and `MobileTabSwitcher` both render inside `<MobileSheet>`.)

- [ ] **Step 6: Inset the reused Settings + Downloads modals (the reported bug)**

In the `.aegis-mobile .settings-modal__content` rule, add a four-edge `padding` (it currently has `width/height:100%` and no padding):

```css
.aegis-mobile .settings-modal__content {
  width: 100%;
  height: 100%;
  max-width: none;
  max-height: none;
  border-radius: 0;
  padding: var(--aegis-inset-top, env(safe-area-inset-top))
    var(--aegis-inset-right, env(safe-area-inset-right))
    var(--aegis-inset-bottom, env(safe-area-inset-bottom))
    var(--aegis-inset-left, env(safe-area-inset-left));
}
```

Add the same `padding` to `.aegis-mobile .downloads-modal`:

```css
.aegis-mobile .downloads-modal {
  width: 100%;
  height: 100%;
  max-width: none;
  max-height: none;
  border-radius: 0;
  padding: var(--aegis-inset-top, env(safe-area-inset-top))
    var(--aegis-inset-right, env(safe-area-inset-right))
    var(--aegis-inset-bottom, env(safe-area-inset-bottom))
    var(--aegis-inset-left, env(safe-area-inset-left));
}
```

(The global `box-sizing: border-box` makes `height:100%` include the padding; the dim scrim `.settings-modal` / `.downloads-modal__scrim` stays full-bleed behind the bars.)

- [ ] **Step 7: Add the two new `.aegis-mobile` rules (onboarding + toaster)**

Immediately AFTER the `.aegis-mobile .downloads-modal { … }` rule, add:

```css
/* First-run onboarding: grow the scrim padding by the insets so the centered card
   (max-height: 88vh) never dips under the status/nav bars on a phone. */
.aegis-mobile .onboarding {
  padding: calc(24px + var(--aegis-inset-top, env(safe-area-inset-top)))
    calc(24px + var(--aegis-inset-right, env(safe-area-inset-right)))
    calc(24px + var(--aegis-inset-bottom, env(safe-area-inset-bottom)))
    calc(24px + var(--aegis-inset-left, env(safe-area-inset-left)));
}

/* Toasts (fixed bottom-right) clear the navigation bar / side inset on a phone. */
.aegis-mobile .toaster {
  bottom: calc(16px + var(--aegis-inset-bottom, env(safe-area-inset-bottom)));
  right: calc(16px + var(--aegis-inset-right, env(safe-area-inset-right)));
}
```

- [ ] **Step 8: Run the drift guard + full suite to verify green**

Run: `npx vitest run src/autopilot/safeArea.test.ts`
Expected: PASS (all 7 selectors).

Run: `npm test`
Expected: PASS — no regression in the existing suite (the mobile tour still renders Settings/Downloads without crashing).

- [ ] **Step 9: Update `src/CLAUDE.md`**

In the "Mobile shell" section, replace the existing "Safe-area insets" bullet with a four-edge version:

```markdown
- **Safe-area insets (all four edges):** `env(safe-area-inset-*)` on Android WebView is
  only the display cutout, not the system bars, so `MainActivity` pushes the real
  `systemBars() ∪ displayCutout()` insets to the chrome as `--aegis-inset-top/bottom/left/right`
  CSS vars. Every full-window mobile surface pads itself with `var(--aegis-inset-*, env(...))`:
  `.mobile-topbar`, `.mobile-bottombar` (`box-sizing: content-box`), `.mobile-sheet`
  (History/Saved/Menu/Tabs), the reused `.settings-modal__content` / `.downloads-modal`
  (`.aegis-mobile`-scoped — this is what keeps Settings/Downloads off the status/nav bars),
  `.onboarding`, and `.toaster`. The drift guard `src/autopilot/safeArea.test.ts` fails the
  build if one of these selectors drops an inset var.
```

- [ ] **Step 10: Commit**

```bash
git add src/autopilot/safeArea.test.ts src/index.css src/CLAUDE.md
git commit -m "fix(mobile): keep all phone chrome inside the safe area on all four edges

Settings/Downloads reused desktop modals went edge-to-edge on .aegis-mobile
(under the status + nav bars); the bottom bar / sheets / toaster / onboarding
ignored left/right insets. Pad every full-window mobile surface with the four
--aegis-inset-* vars; add a source-level drift guard.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Native four-edge inset capture (Android `MainActivity.kt`)

Capture the side insets + display cutout and push all four CSS vars; inset the page horizontally.

**Files:**

- Modify: `src-tauri/gen/android/app/src/main/java/com/aegis/browser/MainActivity.kt` (fields ~92, `onCreate` ~127, `applyContentMargins` ~118, insets listener ~465)
- Modify: `src-tauri/CLAUDE.md` (Android "Mobile chrome" notes)

**Interfaces:**

- Consumes: existing `gestureContainer`, `density`, `topChromePx`, `bottomBarPx`, `fullscreen`, `bottomBarHidden`, `webView` (the chrome webview).
- Produces: the `--aegis-inset-left` / `--aegis-inset-right` CSS vars consumed by Task 1; `leftMargin`/`rightMargin` on the content `GestureContainer`.

- [ ] **Step 1: Ensure imports exist**

At the top of `MainActivity.kt`, confirm (add if missing) these imports:

```kotlin
import android.os.Build
import android.view.WindowManager
```

(`androidx.core.view.WindowInsetsCompat`, `ViewCompat`, `WindowInsetsControllerCompat` are already imported.)

- [ ] **Step 2: Add the side-inset fields**

Next to the existing `statusTop` / `navBottom` fields (~`:92-93`):

```kotlin
  @Volatile private var statusTop = 0
  @Volatile private var navBottom = 0
  @Volatile private var sideLeft = 0
  @Volatile private var sideRight = 0
```

- [ ] **Step 3: Set the display-cutout layout mode in `onCreate`**

Replace the `onCreate` body (`:127-130`):

```kotlin
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // Draw into the display cutout on every edge so notches / punch-holes / curved
    // edges are reported as insets (which we push to the chrome) instead of letterboxed.
    // minSdk is 24: _ALWAYS is API 30, _SHORT_EDGES is API 28, below 28 has no cutouts.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      window.attributes = window.attributes.apply {
        layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
      }
    } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      window.attributes = window.attributes.apply {
        layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
      }
    }
  }
```

- [ ] **Step 4: Inset the page horizontally in `applyContentMargins`**

Replace `applyContentMargins` (`:118-125`):

```kotlin
  private fun applyContentMargins() {
    val gc = gestureContainer ?: return
    (gc.layoutParams as? FrameLayout.LayoutParams)?.let { p ->
      p.topMargin = (if (fullscreen) 0 else topChromePx) + statusTop
      p.bottomMargin = (if (fullscreen || bottomBarHidden) 0 else bottomBarPx) + navBottom
      p.leftMargin = if (fullscreen) 0 else sideLeft
      p.rightMargin = if (fullscreen) 0 else sideRight
      gc.layoutParams = p
    }
  }
```

- [ ] **Step 5: Capture the union insets + push four CSS vars**

Replace the `setOnApplyWindowInsetsListener` block (`:465-475`):

```kotlin
      ViewCompat.setOnApplyWindowInsetsListener(parent) { _, insets ->
        val bars = insets.getInsets(
          WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
        )
        statusTop = bars.top
        navBottom = bars.bottom
        sideLeft = bars.left
        sideRight = bars.right
        applyContentMargins()
        val js =
          "document.documentElement.style.setProperty('--aegis-inset-top','${bars.top / density}px');" +
          "document.documentElement.style.setProperty('--aegis-inset-bottom','${bars.bottom / density}px');" +
          "document.documentElement.style.setProperty('--aegis-inset-left','${bars.left / density}px');" +
          "document.documentElement.style.setProperty('--aegis-inset-right','${bars.right / density}px');"
        webView.evaluateJavascript(js, null)
        insets
      }
```

- [ ] **Step 6: Compile-gate the native change**

Run (Android Rust target — unchanged Rust, confirms the project still builds):
`cargo check --target aarch64-linux-android --manifest-path src-tauri/Cargo.toml`
Expected: success (`Finished`).

Run (Kotlin):
`JAVA_HOME=~/development/android-studio/jbr ./src-tauri/gen/android/gradlew -p src-tauri/gen/android compileUniversalDebugKotlin`
Expected: `BUILD SUCCESSFUL`. (No unit test — this is native UI code; runtime behavior is device-verified in Task 5.)

- [ ] **Step 7: Update `src-tauri/CLAUDE.md`**

In the Android "Mobile chrome" section, update the inset note to:

```markdown
- **Safe-area insets (all four edges):** the insets listener reads
  `systemBars() ∪ displayCutout()` and pushes the real status/nav/side insets to the chrome
  as `--aegis-inset-top/bottom/left/right` CSS vars (px ÷ density); `onCreate` sets
  `layoutInDisplayCutoutMode = ALWAYS` (API ≥ 30; `SHORT_EDGES` on 28–29) so cutouts are
  reported as insets. `applyContentMargins()` also applies `leftMargin`/`rightMargin`
  (= side insets, 0 in fullscreen) so the page clears side bars/cutouts in landscape.
```

- [ ] **Step 8: Commit**

```bash
git add src-tauri/gen/android/app/src/main/java/com/aegis/browser/MainActivity.kt src-tauri/CLAUDE.md
git commit -m "feat(android): capture four-edge safe-area insets (systemBars + displayCutout)

Push --aegis-inset-left/right alongside top/bottom; set LAYOUT_IN_DISPLAY_CUTOUT_MODE
so notches/curved edges report as insets; inset the content WebView horizontally.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Immersive mobile fullscreen (hide status + nav bars)

`setFullscreen` currently only zeros margins. Make it hide/show the system bars, mirroring the HTML5-video path.

**Files:**

- Modify: `src-tauri/gen/android/app/src/main/java/com/aegis/browser/MainActivity.kt` (`setFullscreen` ~814)
- Modify: `src-tauri/CLAUDE.md` (the `setFullscreen` bridge note)

**Interfaces:**

- Consumes: `window`, `applyContentMargins()`; `WindowInsetsControllerCompat` / `WindowInsetsCompat` (already imported, used by `onShowCustomView`).
- Produces: immersive fullscreen — the same observable state the video path produces, but for the chrome-hide fullscreen.

- [ ] **Step 1: Make `setFullscreen` immersive**

Replace the `setFullscreen` bridge method (`:813-817`):

```kotlin
    @JavascriptInterface
    fun setFullscreen(on: Boolean) = runOnUiThread {
      fullscreen = on
      WindowInsetsControllerCompat(window, window.decorView).apply {
        systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        if (on) hide(WindowInsetsCompat.Type.systemBars())
        else show(WindowInsetsCompat.Type.systemBars())
      }
      applyContentMargins()
    }
```

(When the bars hide, the inset listener fires with zero insets, so `applyContentMargins` zeros every margin and the page fills the whole display; a swipe reveals the bars transiently. On exit the bars return and insets restore.)

- [ ] **Step 2: Compile-gate**

Run:
`JAVA_HOME=~/development/android-studio/jbr ./src-tauri/gen/android/gradlew -p src-tauri/gen/android compileUniversalDebugKotlin`
Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 3: Update `src-tauri/CLAUDE.md`**

Update the `setFullscreen` description in the Android bridge note to:

```markdown
`setFullscreen` (desktop-parity hide-all-chrome) now ALSO goes immersive —
`WindowInsetsControllerCompat.hide(systemBars())` on enter / `show(...)` on exit, with
`BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE` — so the page truly owns the whole screen (status

- nav bars hidden), matching the HTML5-video `onShowCustomView` path. Back exits.
```

- [ ] **Step 4: Commit**

```bash
git add src-tauri/gen/android/app/src/main/java/com/aegis/browser/MainActivity.kt src-tauri/CLAUDE.md
git commit -m "feat(android): make chrome-hide fullscreen truly immersive (hide system bars)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Desktop fullscreen drives the real OS window

`view.setFullscreen` only relayouts the content webview; add a backend `Window::set_fullscreen` so the OS window actually fullscreens. Linux Esc/exit-button path also clears it directly.

**Files:**

- Modify: `src-tauri/src/view.rs` (`view.setFullscreen` handler ~281)
- Modify: `src-tauri/src/linux_layout.rs` (`exit_fullscreen` ~257)
- Modify: `src-tauri/CLAUDE.md` (note that desktop `view.setFullscreen` drives the OS window)

**Interfaces:**

- Consumes: `app.get_window("main")` (the `Manager` trait is already in scope in both files — `view.rs:107` and `linux_layout.rs:274` use `get_window`/`get_webview`); `tauri::Window::set_fullscreen(bool)`.
- Produces: OS-window fullscreen toggled in lockstep with the in-app fullscreen flag, on all desktop platforms.

- [ ] **Step 1: Drive the OS window from the `view.setFullscreen` handler**

In `src-tauri/src/view.rs`, replace the `"view.setFullscreen"` arm (`:281-285`):

```rust
        // Fullscreen: content fills the window below a slim top strip that holds the
        // chrome's exit button; Esc (handled in the content webview) also exits.
        "view.setFullscreen" => {
            let on = payload.get("on").and_then(Value::as_bool).unwrap_or(false);
            update(app, |l| l.fullscreen = on);
            // Drive the real OS window so it takes over the monitor (hides the titlebar),
            // not just the content-webview geometry. Backend call — no capability needed.
            #[cfg(desktop)]
            if let Some(window) = app.get_window("main") {
                let _ = window.set_fullscreen(on);
            }
            Ok(Value::Null)
        }
```

(The flag is set via `update` BEFORE `set_fullscreen` so the async resize re-runs `apply_inset` with `fullscreen = true` already in effect.)

- [ ] **Step 2: Clear OS fullscreen on the Linux Esc / exit-button path**

In `src-tauri/src/linux_layout.rs`, replace `exit_fullscreen` (`:257-267`):

```rust
fn exit_fullscreen(app: &AppHandle) {
    if let Some(s) = app.try_state::<crate::view::ContentInset>() {
        let mut g = s.0.lock().unwrap();
        if g.fullscreen {
            g.fullscreen = false;
            drop(g);
            // Leave OS-window fullscreen too: the desktop view.setFullscreen path entered it,
            // so Esc / the floating exit button must clear it directly (idempotent alongside
            // the view.fullscreen → React → view.setFullscreen round-trip).
            if let Some(window) = app.get_window("main") {
                let _ = window.set_fullscreen(false);
            }
            crate::view::apply_inset(app);
            crate::emit_event(app, "view.fullscreen", serde_json::json!({ "on": false }));
        }
    }
}
```

- [ ] **Step 3: Verify the existing Rust unit tests still pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml view::`
Expected: PASS — `content_visible_truth_table` and the other `view::tests` are unaffected (the new code is desktop-gated and a no-op under the `MockRuntime`, which has no `"main"` window).

- [ ] **Step 4: Compile-gate desktop + Windows cross-check**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: success.

Run: `cargo check --manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-gnu`
Expected: success (confirms the `#[cfg(desktop)]` `set_fullscreen` compiles for Windows; macOS verified by CI).

- [ ] **Step 5: Update `src-tauri/CLAUDE.md`**

In the `view.rs` module note (or the fullscreen discussion), add:

```markdown
- **Desktop fullscreen now drives the OS window.** `view.setFullscreen` calls
  `Window::set_fullscreen(on)` (`#[cfg(desktop)]`) in addition to the content-webview
  relayout, so the window takes over the monitor (titlebar hidden). On Linux,
  `linux_layout::exit_fullscreen` (Esc / floating exit button) also calls
  `set_fullscreen(false)` directly. Backend call — no capability change. Android fullscreen
  is the immersive `setFullscreen` bridge (hides the system bars) instead.
```

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/view.rs src-tauri/src/linux_layout.rs src-tauri/CLAUDE.md
git commit -m "fix(desktop): fullscreen drives the real OS window (Window::set_fullscreen)

view.setFullscreen only relayouted the content webview; the window kept its
titlebar and stayed windowed. Drive Window::set_fullscreen on enter/exit; Linux
Esc/exit-button clears it directly.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Full verification gate + device-verify handoff

Run every automated gate the change touches, then hand the user the runtime checks that need real hardware.

**Files:** none (verification only; commit any doc fix this surfaces).

- [ ] **Step 1: Full unit suite**

Run: `npm test`
Expected: PASS, including `src/autopilot/safeArea.test.ts` and the desktop + mobile tours.

- [ ] **Step 2: Rust + Android + Windows compile gates**

Run, expecting success on each:

- `cargo test --manifest-path src-tauri/Cargo.toml`
- `cargo check --manifest-path src-tauri/Cargo.toml --target aarch64-linux-android`
- `cargo check --manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-gnu`
- `JAVA_HOME=~/development/android-studio/jbr ./src-tauri/gen/android/gradlew -p src-tauri/gen/android compileUniversalDebugKotlin`

- [ ] **Step 3: Linux live autopilot (runtime behavior)**

Run: `bash scripts/autopilot/run-autopilot.sh`
Expected: `RESULT: … 0 failed` and `ad-block blocking (trace): PASS`.

Specifically confirm the `fullscreen` screen still passes now that entering fullscreen drives the real OS window: the run should reach the fullscreen screen, screenshot, and leave without the window staying fullscreen or the subsequent screens failing. If (and only if) the real OS fullscreen disrupts later screenshots, gate the OS call against the dev autopilot by reading the autopilot env in `view.rs` Step 1 — wrap the `set_fullscreen` call in `if std::env::var("AEGIS_AUTOPILOT_OUT").is_err() { … }` — and re-run. Record the actual result either way (do not claim PASS without the real output).

- [ ] **Step 4: Hand the device/GUI verifies to the user**

These need real hardware and are PENDING the user — list them in the final report (do not mark the feature "done" until the user confirms):

- **Android phone:** Settings and Downloads sheets sit fully inside the safe area (no draw under the status/nav bars); the chrome-hide fullscreen hides the status + nav bars and a swipe reveals them transiently; in landscape (and on a side-cutout / curved-edge device) the chrome and page clear the side insets.
- **Desktop (Linux live, then Win/macOS):** entering fullscreen makes the OS window take over the whole monitor (no titlebar); Esc and the exit button restore the windowed state with correct content geometry.

- [ ] **Step 5: Commit any doc/verification fix surfaced above** (skip if nothing changed)

```bash
git add -A
git commit -m "chore: verification pass for phone safe-zone + fullscreen fixes

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage**

- Part 1 (native four-edge capture, cutout mode, push left/right, inset page horizontally) → **Task 2**. ✔
- Part 2 (CSS consumption on every full-window mobile surface incl. the Settings/Downloads fix) → **Task 1**. ✔ Centered overlays: error/crash/SafetyInterstitial are **not rendered in the mobile shell** (verified in `MobileApp.tsx`) → correctly out of mobile scope; the centered Onboarding + Toaster (which _are_ in the mobile shell and can reach an edge) are covered; small centered confirm/permission dialogs are already inside the viewport (no change). FindBar renders in-flow on mobile and its placement is a separate, unreported concern → **Task 5 device-verify**, not a CSS change.
- Part 3 (immersive mobile fullscreen) → **Task 3**. ✔
- Part 4 (desktop OS-window fullscreen + Linux Esc/exit clears it) → **Task 4**. ✔
- Testing (drift guard, compile gates, live autopilot, device verifies) → **Tasks 1 & 5**. ✔
- Living-docs updates → folded into Tasks 1, 2, 3, 4. ✔
- Non-goals (no F11, no iOS, no inset-the-whole-chrome-webview) → respected. ✔

**2. Placeholder scan:** No "TBD/TODO/handle edge cases". The one conditional (Task 5 Step 3 autopilot remediation) gives the exact code + command and demands the real result — not a vague "add error handling".

**3. Type / name consistency:** CSS var names `--aegis-inset-top/bottom/left/right` are identical across Task 1 (CSS + drift guard) and Task 2 (native push). Kotlin field names `sideLeft`/`sideRight` are introduced in Task 2 Step 2 and used in Steps 4–5. `applyContentMargins` / `setFullscreen` / `exit_fullscreen` names match the real code. `Window::set_fullscreen` used identically in Task 4 Steps 1–2. The drift-guard selector list matches the exact selectors edited in Task 1 Steps 3–7.

---

## Execution

Recommended: subagent-driven (fresh subagent per task, review between tasks). Tasks are mostly independent — Task 1 (CSS, with `env()` fallback) renders correctly even before Task 2 lands, and Tasks 3 / 4 are independent of 1 / 2. Suggested order: 1 → 2 → 3 → 4 → 5.
