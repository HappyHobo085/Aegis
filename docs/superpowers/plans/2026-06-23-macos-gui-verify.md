# Sub-project I — macOS GUI Runtime Verification (Hardware-Gated Runbook)

> **For agentic workers:** This plan is **NOT** an agent-executed TDD plan. It is a
> **human/owner-executed verification runbook**. The objc2/Cocoa code in this app
> cannot be compiled or run from the Linux development box (`objc2`'s build script
> needs a macOS C toolchain — see `src-tauri/CLAUDE.md` gotcha 13 and the
> `aegis-macos-crosscompile` memory). An agent reading this file should NOT attempt
> to run any step; it should only ever **edit this file** or **transcribe results the
> owner reports back** into `CLAUDE.md` (see Phase 5). Every checklist item below is a
> step a person performs on a real Mac (or a Mac CI runner with a GUI session), with an
> exact action, an exact expected observation, and an evidence-capture instruction.

**Goal:** Confirm that the macOS `.app` (built green in CI but never GUI-launched) actually
runs as a browser on real macOS hardware: it browses, ad-blocks (via the injected tier —
the *sole* ad-block on macOS), and exercises every Improvements-Program feature that has a
macOS surface (find-in-page, zoom, theme, private mode, vault, farbling, proxy) plus the
existing security tiers (HTTPS-Only, MalwareGuard, WebRTC). The outcome is one of two
states recorded in `CLAUDE.md`: **"macOS GUI-runtime-verified"** (with a dated evidence
manifest) or, for any item that can't be reached without the Mac, **"CI-build-verified,
GUI-pending"** stated explicitly per item.

**Architecture:** n/a — this is a verification runbook, not a code change. It modifies **no
source**. The only file it produces is this plan plus, at the end, an owner-reported results
block that updates `CLAUDE.md` (Phase 5). The app architecture under test is the standard
Aegis two-webview shell (chrome React webview + content WKWebView) described in the root
`CLAUDE.md`.

**Tech Stack:** macOS (Apple Silicon or Intel), a built Aegis `.app`/`.dmg` (from CI
artifact `aegis-macos` or a local `npm run tauri:build`), the macOS GUI session, Screenshot
(`Cmd+Shift+4` region capture or `screencapture` CLI), and a terminal for `tcpdump`/network
observation where egress evidence is required.

---

## Global Constraints

These come from §4 ("Verification reality") of
`docs/superpowers/specs/2026-06-23-improvements-program-design.md` and the repo's CLAUDE.md.

- **macOS = the hardware gate.** From §4: macOS is "CI build only (objc2 needs Mac
  toolchain)"; "Done" means **"CI-built; GUI verify = sub-project I, hardware-gated."**
  CI compiles, links, and bundles the macOS app, but a CI runner **never launches the
  GUI** — so nothing in this runbook is executable without a real macOS desktop session
  (the owner's Mac, or a self-hosted/`runner`-with-display Mac). State this up front in any
  report: results are only valid if produced on actual macOS hardware.
- **This runbook does not modify source, run tests, run cargo, or run git.** It is
  observe-only. If a defect is found, file it for a separate fix sub-project — do **not**
  patch it inside this verification pass.
- **Two honest outcomes, never a fabricated one.** Per the repo owner's standing "Don't
  guess — verify" rule: every PASS/FAIL must be backed by a screenshot or captured terminal
  output taken on the Mac. An item the Mac session cannot reach is reported as
  **"GUI-pending (reason)"**, not silently skipped and not assumed-pass.
- **Distinguish macOS-native legs from shared/injected legs.** Some features have an
  objc2/Cocoa leg that is *only* exercised at GUI runtime (these are the high-value targets
  of this runbook — they've literally never run); others run identical shared Rust/JS on
  macOS as on Linux and merely need a spot-confirm that they behave the same on this engine.
  The "Leg" column in each checklist row marks which is which. The macOS-native legs as of
  this program are enumerated in **Appendix A**.
- **Parity reporting.** Per CLAUDE.md's parity rule, "done" for the whole program means
  Linux/Windows/macOS/Android reach the same level *subject to §4's hardware reality*. This
  runbook is how macOS reaches "verified" rather than staying "CI-built only." Where a
  feature's macOS leg is genuinely unverifiable even on the Mac (e.g. a CI-only
  Network.framework proxy binding that didn't land), say so — that is a legitimate end state,
  not a failure to hide.

---

## Phase 0 — Obtain the build (pick ONE path)

You need a runnable, GUI-launchable macOS `.app`. Two supported ways:

### Task 0.1 — Path A: download the CI artifact (no Mac toolchain needed to *build*)

The `tauri-build-check.yml` workflow builds the macOS `.app` + `.dmg` and uploads them as
the artifact named **`aegis-macos`** (`.github/workflows/tauri-build-check.yml`, the
`macos-latest` matrix row, `artifact_path: src-tauri/target/release/bundle/**`). It is a
`workflow_dispatch` (on-demand) workflow.

- [ ] **Step 0.1a — Trigger a fresh build.** On GitHub → repo → **Actions** tab →
  **"Tauri Build Check"** → **"Run workflow"** → pick the branch (`feat/improvements-program`
  once the features have merged into it, or `main`) → **Run**. Wait for the `desktop
  (macos-latest)` job to go green.
  - *Expected:* the `macos-latest` job ends with a green check and the run page lists an
    artifact **`aegis-macos`** (alongside `aegis-windows-portable`, `aegis-linux-appimage`,
    `aegis-android-apk`).
- [ ] **Step 0.1b — Download + unzip.** Download `aegis-macos` from the run's Artifacts
  section. It is a zip of `src-tauri/target/release/bundle/**`, so inside you'll find
  `dmg/Aegis_<version>_<arch>.dmg` and `macos/Aegis.app`. Unzip it on the Mac.
  - *Expected:* a `Aegis.app` bundle and/or a `.dmg` exist on disk.
- [ ] **Step 0.1c — Note the unsigned-app gotcha.** CI builds are **unsigned/un-notarized**.
  macOS Gatekeeper will refuse to open it on first double-click ("Aegis can't be opened
  because Apple cannot check it for malicious software"). Bypass for testing **only**:
  right-click the app → **Open** → **Open** in the dialog; OR run
  `xattr -dr com.apple.quarantine /path/to/Aegis.app` in Terminal, then open it.
  - *Expected after bypass:* the app launches to a window. Capture a screenshot of the
    launched window → **`evidence/00-launch.png`**.

### Task 0.2 — Path B: build locally on the Mac

If you have a Mac with the toolchain (Xcode command-line tools + a stable Rust + Node 22):

- [ ] **Step 0.2a — Clone + install.** `git clone` the repo (branch
  `feat/improvements-program`), then `npm install`.
- [ ] **Step 0.2b — Build.** Run `npm run tauri:build`. This runs
  `beforeBuildCommand: npm run build:renderer` then bundles the macOS targets
  (`.app` + `.dmg`).
  - *Expected:* build succeeds; the bundle lands in
    `src-tauri/target/release/bundle/macos/Aegis.app` and
    `src-tauri/target/release/bundle/dmg/Aegis_<version>_<arch>.dmg`.
  - *Note:* a **local** build is signed with your own ad-hoc identity, so it may launch
    without the Gatekeeper prompt; if it still prompts, apply the Step 0.1c bypass.
- [ ] **Step 0.2c — Launch.** Open `Aegis.app`. Capture **`evidence/00-launch.png`**.

> **Gate to continue:** the app window is on screen (`evidence/00-launch.png` exists). If
> the app crashes on launch, capture the crash report from **Console.app → Crash Reports**
> as `evidence/00-crash.txt` and STOP — that is a P0 finding for a separate fix.

---

## Phase 1 — Core browse + the injected ad-block tier (the never-run baseline)

These are the load-bearing macOS surfaces that CI has never exercised: the WKWebView content
view renders, navigation works, the **injected** ad-block tier (`adblock_inject.rs` — the
*only* ad-block on macOS; wry can't intercept WKWebView network requests, so there is no
network tier and no WebKit content-filter tier here) actually blocks, and the macOS-native
address-bar URL tracker (`nav_url_mac.rs`, KVO on the WKWebView `URL`) fires.

| # | Item | Leg | Action (exact) | Expected observation | Evidence |
|---|---|---|---|---|---|
| 1.1 | Page renders | macOS-native (WKWebView via wry) | In the address bar type `https://example.com` and press Enter. | The "Example Domain" page renders fully inside the content area (below the toolbar/favbar/tabstrip), no white/blank screen, no overlap of content over the toolbar. | `evidence/01-render.png` |
| 1.2 | Forward nav + back/forward state | shared | Navigate to `https://www.wikipedia.org`, then click the toolbar **Back** button. | Address bar returns to `example.com`; Back greys out, Forward enables. | `evidence/02-backfwd.png` |
| 1.3 | Same-document URL tracking (`nav_url_mac.rs` KVO) | **macOS-native** | Visit a site that uses History-API/hash routing (e.g. open `https://html.duckduckgo.com/html/?q=test`, then on a JS SPA change the hash/route). Watch the address bar. | The address bar updates to the new in-page URL **without a full reload** — proving the WKWebView `URL` KVO observer (`UrlObserver`) is installed and firing. (This code has *never* run before this test; per `src-tauri/CLAUDE.md` gotcha 13 it was "CI-verified only.") | `evidence/03-sameDoc.png` |
| 1.4 | Injected ad-block blocks (the macOS ad-block tier) | shared (injected JS) | With ad-block **ON** (shield enabled — default), load a page known to fetch ad/tracker subresources (e.g. a news site, or a local probe page serving an `<img>`/`fetch` to `doubleclick.net`/`google-analytics.com`). Open the macOS WKWebView's network behaviour indirectly: in the page, run from the address bar a `javascript:` test that `fetch('https://www.google-analytics.com/analytics.js')` and report the result, OR observe the page's own ad slots. | Ad/tracker requests are blocked: the analytics/ad `fetch` rejects or returns blocked; ad slots are empty/cosmetically hidden. The injected tier (`adblock_inject.rs`) overrides `fetch`/`XHR`/`sendBeacon` and cosmetic-hides — confirm at least one is observable. | `evidence/04-adblock-on.png` |
| 1.5 | Ad-block A/B (toggle OFF restores requests) | shared | Open the shield → toggle ad-block **OFF** for the site (or globally) → reload the same page. | The previously-blocked ad/tracker requests now succeed / ad slots populate — the OFF↔ON delta is the honest proof of blocking (mirrors the Linux A/B method, since macOS has no per-block counter either). | `evidence/05-adblock-off.png` |
| 1.6 | Pop-under guard (`POPUP_GUARD`, shipped every platform) | shared (injected JS) | On a test page, trigger a **cross-origin** scripted `window.open('https://example.org')` from a click handler. | The cross-origin scripted popup is dropped (no new window/tab opens); a same-origin or real `<a target=_blank>` link still opens. | `evidence/06-popunder.png` |
| 1.7 | Chrome UA presented to sites | macOS-native (`CONTENT_UA`) | Navigate to `https://www.whatismybrowser.com/detect/what-is-my-user-agent/` (or run `javascript:alert(navigator.userAgent)`). | The UA reads `…(Macintosh; Intel Mac OS X 10_15_7) … Chrome/148.0.0.0 Safari/537.36` (the macOS `CONTENT_UA` from `nav.rs`), not a raw WebKit string. | `evidence/07-ua.png` |

---

## Phase 2 — Existing security tiers on macOS

These ship identical shared Rust/JS on macOS; this phase spot-confirms they behave on the
WebKit/WKWebView engine. The redirect guard's macOS *hook* leg (WKNavigationDelegate) is the
only native piece.

| # | Item | Leg | Action (exact) | Expected observation | Evidence |
|---|---|---|---|---|---|
| 2.1 | HTTPS-Only upgrade | shared (`nav.rs` callback) | In the address bar type a bare `http://neverssl.com` (or `http://example.com`) and Enter. | The request is upgraded to `https://` (address bar shows `https://`), or an HTTPS-Only interstitial appears if no HTTPS exists. | `evidence/08-https.png` |
| 2.2 | MalwareGuard interstitial | shared (`safety.rs`) | Navigate to a host present in the bundled `malware-hosts.txt` URLhaus set (pick one entry from `src-tauri/resources/malware-hosts.txt`). | A full-window MalwareGuard interstitial blocks the page, with a **Back** button and a session-only "proceed anyway" path. | `evidence/09-malware.png` |
| 2.3 | MalwareGuard proceed-anyway | shared | On the interstitial, click "proceed/continue anyway". | The page loads for this session only; navigating away and back re-shows the interstitial. | `evidence/10-malware-proceed.png` |
| 2.4 | WebRTC IP-leak shim (shim-only on macOS) | shared (injected shim) | Set the WebRTC policy to **public-only** (default) in Settings. Navigate to `https://browserleaks.com/webrtc`. | No **local/private** ICE candidates (192.168.*/10.*/`.local` mDNS) are exposed; public/relay may appear. **Honest limit (state it in the report):** on macOS the shim covers page + iframe scopes but **NOT Web Worker scopes** (per `src-tauri/CLAUDE.md`: macOS is "shim-only (workers leak)" for both `public-only` and `disable` — there is no native backstop on macOS, unlike Linux/Windows). So a worker-based probe may still leak; that is a documented residual, not a regression. | `evidence/11-webrtc.png` |
| 2.5 | Scripted cross-origin redirect block (macOS hook = WKNavigationDelegate) | **macOS-native hook** | Open a page that performs a scripted cross-origin top-frame redirect (the streamex-style malvertising pattern, or a synthetic test page that `location.href='https://example.org'` cross-origin without a user gesture). | The redirect is blocked; the page stays put; a redirect-block notification appears. **Note:** macOS uses Tauri's `on_navigation` + the `WKNavigationDelegate` native top-frame hook (per `src-tauri/CLAUDE.md` gotcha 14, "Other platforms keep Tauri's `on_navigation` + their own native top-frame hooks … macOS `WKNavigationDelegate`"). If the macOS hook leg was not implemented for this engine, mark **GUI-pending** and note it. | `evidence/12-redirect.png` |

---

## Phase 3 — Improvements-Program features with a macOS surface

Each row marks whether the macOS leg is **native** (objc2/WKWebView API — runs for the first
time here) or **shared/injected/renderer** (same code as Linux, spot-confirm). For any
feature whose macOS leg is documented as CI-only/unimplemented, mark it **GUI-pending
(reason)** rather than forcing a pass. See Appendix A for the native/shared split rationale.

### D — Find-in-page (Ctrl+F → `Cmd+F` on macOS)

| # | Item | Leg | Action (exact) | Expected observation | Evidence |
|---|---|---|---|---|---|
| 3.D.1 | Find bar opens | renderer (`FindBar.tsx`) | Load a text-heavy page; press `Cmd+F`. | The find bar appears in the chrome. | `evidence/13-find-open.png` |
| 3.D.2 | Match + count + highlight | **macOS-native** (`WKWebView find(_:)` / JS fallback) | Type a word that appears several times. | Matches highlight on the page and a count ("1 of N") shows. The design (§3 D) specifies the macOS leg as "WKWebView `find(_:)`/JS fallback" — confirm whichever is wired actually highlights+counts on WebKit. | `evidence/14-find-count.png` |
| 3.D.3 | Next / prev cycles | macOS-native/renderer | Click next/prev (or `Cmd+G` / `Cmd+Shift+G`). | Selection cycles through matches; count index updates. | `evidence/15-find-next.png` |
| 3.D.4 | Esc closes | renderer | Press `Esc`. | Find bar closes; highlights clear. | `evidence/16-find-close.png` |

### E — Page zoom (`Cmd +`/`Cmd -`/`Cmd 0`, Cmd-scroll)

| # | Item | Leg | Action (exact) | Expected observation | Evidence |
|---|---|---|---|---|---|
| 3.E.1 | Zoom in | **macOS-native** (`WKWebView pageZoom`/magnification) | On any page press `Cmd +` twice. | Page content scales up; a zoom indicator shows the level (>100%). | `evidence/17-zoom-in.png` |
| 3.E.2 | Zoom out / reset | macOS-native | Press `Cmd -`, then `Cmd 0`. | Page scales down, then resets to 100%. | `evidence/18-zoom-reset.png` |
| 3.E.3 | Persists across in-tab nav | macOS-native/shared | Zoom to 150%, then navigate to a new URL in the same tab. | The 150% zoom persists for the tab across the navigation. | `evidence/19-zoom-persist.png` |

### F — Light / system theme

| # | Item | Leg | Action (exact) | Expected observation | Evidence |
|---|---|---|---|---|---|
| 3.F.1 | Light theme | renderer (`index.css` tokens) | Settings → Appearance → set theme to **Light**. | The chrome re-themes to light **instantly** (toolbar/favbar/sidebar). | `evidence/20-theme-light.png` |
| 3.F.2 | Dark theme | renderer | Set theme to **Dark**. | Chrome re-themes to dark instantly. | `evidence/21-theme-dark.png` |
| 3.F.3 | System-follow (`prefers-color-scheme`) | renderer + macOS appearance | Set theme to **System**. Then toggle the macOS system appearance (System Settings → Appearance → Light↔Dark, or `defaults write -g AppleInterfaceStyle Dark`). | The chrome follows the OS appearance — confirms `prefers-color-scheme` is honored on WebKit and that the macOS system theme reaches the webview. | `evidence/22-theme-system.png` |

### G — Shield block-counter parity

| # | Item | Leg | Action (exact) | Expected observation | Evidence |
|---|---|---|---|---|---|
| 3.G.1 | Counter on macOS | **GUI-pending unless implemented** | Open the shield badge after loading an ad-heavy page. | **Note honestly:** §3 G scopes the counter to **Windows + Android** ("Linux-only today"); macOS is **not** in G's scope and has no per-block counter (no network/content-filter tier to hook). **Expected = badge shows 0; blocking is still proven by Phase 1.5 A/B, not the count.** Record this as a *known/expected* state, not a failure. | `evidence/23-shield-count.png` |

### H — Private / incognito mode (full ephemeral)

| # | Item | Leg | Action (exact) | Expected observation | Evidence |
|---|---|---|---|---|---|
| 3.H.1 | Open a private tab/window | renderer + **macOS-native** (`WKWebsiteDataStore.nonPersistent()`) | Use the new-private affordance to open a private tab. | A private tab opens with a clear visual treatment (distinct from a normal tab). | `evidence/24-private-open.png` |
| 3.H.2 | Ephemeral partition | macOS-native | In the private tab, log into / set a cookie on a test site; close the private tab; reopen the site in the private tab. | No cookie/storage residue persists — the WKWebView non-persistent data store discarded it on close. | `evidence/25-private-ephemeral.png` |
| 3.H.3 | Excluded from history/sync/downloads | shared (skip guards) | Browse several sites in the private tab, then open Settings → History (and the downloads record). | None of the private-tab visits appear in history; private downloads aren't recorded. (§3 H: "Private tabs must bypass the history/saved/sync write paths.") | `evidence/26-private-history.png` |

### K — Password vault (Phase A, no autofill)

| # | Item | Leg | Action (exact) | Expected observation | Evidence |
|---|---|---|---|---|---|
| 3.K.1 | Create + unlock | shared (`vault.rs` + `crypto.rs` AEAD) | Settings → Vault → create a master password → unlock. | Vault unlocks; the manage/add UI appears. Note: on macOS the seed uses the desktop `keyring` path (`sync_keystore.rs`), which is the macOS Keychain — confirm no keychain prompt error blocks unlock. | `evidence/27-vault-unlock.png` |
| 3.K.2 | Add + retrieve | shared | Add a credential (site/user/pass); lock; unlock; retrieve it. | The credential round-trips: add → lock (keys zeroized) → unlock → retrieve shows the same value. | `evidence/28-vault-roundtrip.png` |
| 3.K.3 | Encrypted at rest | shared | (Optional, terminal) `cat` the on-disk vault store file. | Ciphertext only — no plaintext password visible. | `evidence/29-vault-rest.txt` |

### L — Anti-fingerprinting / farbling

| # | Item | Leg | Action (exact) | Expected observation | Evidence |
|---|---|---|---|---|---|
| 3.L.1 | Noise on (Standard/Strict) | shared (injected; **WebKit shim variant**) | Settings → set farbling to **Standard**. Navigate to a fingerprint probe (e.g. `https://browserleaks.com/canvas` or `https://coveryourtracks.eff.org`). | Canvas/audio/WebGL/`navigator` surfaces show **perturbed/noised** values vs noise-off. The design (§3 L) ships **two reconciled shims** — macOS uses the **WebKit-engine** variant (not the Chromium one). Confirm the WebKit shim is the one active here. | `evidence/30-farble-on.png` |
| 3.L.2 | Per-site/session difference | shared | Reload, and visit a different eTLD+1 with noise on. | Values differ per-site (crypto-derived per-eTLD+1 salt). | `evidence/31-farble-persite.png` |
| 3.L.3 | Off + allowlist | shared | Set farbling **Off** (or allowlist the probe site); reload. | Surfaces return to un-noised baseline. | `evidence/32-farble-off.png` |

### M — Proxy (Tier-1)

| # | Item | Leg | Action (exact) | Expected observation | Evidence |
|---|---|---|---|---|---|
| 3.M.1 | Apply a proxy | **macOS-native — likely GUI-pending** | Settings → Proxy → enter a known test proxy (host:port) → enable. Navigate to `https://api.ipify.org` or `https://ifconfig.me` to read the egress IP; optionally `tcpdump -n host <proxy-ip>` in Terminal. | **Honest expectation (§3 M):** the macOS proxy leg is "a hand-rolled Network.framework binding (CI-only, **may slip**)." If it landed: the egress IP becomes the proxy's and traffic is seen going to the proxy host. **If it did not land for macOS, mark GUI-pending (reason: Network.framework binding deferred/CI-only) — that is an accepted end state for M's macOS leg.** Linux+Android are M's verified targets. | `evidence/33-proxy.png` |
| 3.M.2 | Off restores direct | macOS-native | Disable the proxy; reload the IP-echo page. | Egress IP returns to the direct/ISP IP. (Skip if 3.M.1 is GUI-pending.) | `evidence/34-proxy-off.png` |

---

## Phase 4 — Cross-cutting GUI sanity (catch the macOS-only layout/overlay bugs)

The macOS `view.rs` geometry leg (`LogicalPosition` `set_bounds`, the active-tab
show/hide loop) has never run; these checks catch the macOS analog of the Windows
fractional-DPI hit-test bug and the "overlay renders behind content" bug class.

| # | Item | Leg | Action (exact) | Expected observation | Evidence |
|---|---|---|---|---|---|
| 4.1 | Toolbar clicks land (no hit-test offset) | **macOS-native** (`view.rs` macOS `set_bounds`) | After loading a page, click the toolbar buttons (back/forward/reload), the address bar, and a favourites-bar item. | Every chrome control responds — the content webview does NOT swallow clicks meant for the chrome (the macOS analog of the Windows fractional-DPI dead-toolbar bug). Test at a non-100% display scale if available. | `evidence/35-hittest.png` |
| 4.2 | Full-window overlay covers content | **macOS-native** (active-tab show/hide loop) | Open Settings (a full-window overlay), then Downloads. | Each overlay fully covers the page — the content webview does NOT render on top of / behind-then-over the overlay (the overlay-z-order bug class). | `evidence/36-overlay.png` |
| 4.3 | Multi-tab switch shows the right page | macOS-native (show/hide loop) | Open 3 tabs to 3 different sites; click between them. | The active tab's page shows and the others hide — switching doesn't "leave the previous page on top" (the `view.rs` macOS show/hide-every-other-tab pass). | `evidence/37-tabswitch.png` |
| 4.4 | Window resize / minimum | macOS-native (Cocoa window) | Resize the window small and large; try to shrink below a sane minimum. | Content reflows; window shrinks to a floor and clamps (no "can't make it smaller" pin). | `evidence/38-resize.png` |
| 4.5 | Open file/folder from Downloads (`downloads.rs` `open`) | **macOS-native** (`open` cmd) | Download a small file; in Downloads click "open file"/"show in folder". | Finder / the default app opens the file/folder (the macOS `open` command path — never exercised on macOS before). | `evidence/39-download-open.png` |

---

## Phase 5 — Report back (updates `CLAUDE.md`)

After the Mac session, produce a single results block in this exact shape so the status can
be transcribed into the root `CLAUDE.md` "Status" line and `src-tauri/CLAUDE.md`. **An agent
may only fill this in from owner-reported observations — it must not invent results.**

- [ ] **Step 5.1 — Fill the results table.** One row per checklist item (1.1 … 4.5), each
  exactly one of: `PASS` (evidence file exists + observation matched), `FAIL` (observed
  defect — link the screenshot; this becomes a separate fix sub-project), or
  `GUI-PENDING (reason)` (the macOS leg was not reachable — e.g. M's Network.framework
  binding is CI-only/deferred, or a feature hadn't merged at build time).

  ```
  ## macOS GUI verification — <DATE> — build <CI run # or local commit> — <Apple Silicon/Intel>, macOS <version>
  Phase 1 (browse + injected ad-block): 1.1 PASS … 1.7 PASS
  Phase 2 (security tiers):             2.1 PASS … 2.5 <PASS|FAIL|GUI-PENDING:…>
  Phase 3 (program features):           3.D.* … 3.M.* <…>
  Phase 4 (layout/overlay):             4.1 PASS … 4.5 PASS
  Evidence: <link to the evidence/ folder or attached zip>
  Overall: <"macOS GUI-runtime-verified" | "partially verified — N items GUI-pending: …">
  ```

- [ ] **Step 5.2 — Update the root `CLAUDE.md` "Status" line.** It currently reads
  *"macOS compiles + bundles green in CI but is not yet GUI-runtime-verified."* Replace with
  the verified state, e.g.:
  *"macOS GUI-runtime-verified on real hardware (`<date>`): browses, ad-blocks via the
  injected tier (A/B-confirmed), HTTPS-Only/MalwareGuard/WebRTC-shim and the program
  features <list> run; remaining GUI-pending: <e.g. proxy Network.framework leg (CI-only)>."*
  If everything passed, drop the "remaining GUI-pending" clause. If only a subset passed,
  keep macOS as "CI-built; partially GUI-verified" and list exactly what's pending.

- [ ] **Step 5.3 — Update `src-tauri/CLAUDE.md`.** Mark the previously "CI-verified only"
  macOS legs that this pass exercised as **GUI-verified** (gotcha 13's `nav_url_mac.rs`
  same-document tracking; gotcha 14's macOS `WKNavigationDelegate` redirect hook; the
  `view.rs` macOS geometry; the `downloads.rs` macOS `open`). Leave anything still pending
  marked as such. Update in the same commit that records the results (living-docs rule).

- [ ] **Step 5.4 — File defects separately.** Any `FAIL` row → open a follow-up fix
  sub-project with the failing screenshot; do **not** patch from this runbook.

---

## Appendix A — macOS-native legs vs shared/injected/renderer legs (verified from source)

Grepped from `src-tauri/src/` (`#[cfg(target_os = "macos")]`) plus the design §3. This is the
authoritative split the checklist's "Leg" column references.

**macOS-NATIVE legs (objc2/Cocoa/WKWebView — run for the first time only at GUI runtime; the
high-value verification targets):**

| Native leg | File / source | Checklist item |
|---|---|---|
| WKWebView `URL` KVO → same-document address bar | `src-tauri/src/nav_url_mac.rs` (installed in `nav.rs` `spawn_tab`, `#[cfg(target_os="macos")]`) | 1.3 |
| macOS content user-agent | `nav.rs` `CONTENT_UA` (macOS branch) | 1.7 |
| Content webview geometry (`LogicalPosition` `set_bounds`) + active-tab show/hide loop | `view.rs` (`#[cfg(target_os="macos")]` block + `#[cfg(all(desktop, not(target_os="linux")))]` loop) | 4.1, 4.2, 4.3 |
| Open file/folder via `open` | `downloads.rs` (`#[cfg(target_os="macos")]` → `"open"`) | 4.5 |
| Scripted-redirect block via `WKNavigationDelegate` | `src-tauri/CLAUDE.md` gotcha 14 (macOS native top-frame hook) | 2.5 |
| Find-in-page WKWebView `find(_:)` leg | design §3 D (per-engine: "WKWebView `find(_:)`/JS fallback") | 3.D.2/3 |
| Page zoom WKWebView `pageZoom`/magnification | design §3 E | 3.E.1/2/3 |
| Private mode `WKWebsiteDataStore.nonPersistent()` ephemeral store | design §3 H | 3.H.1/2 |
| Proxy via Network.framework binding — **CI-only, "may slip"** | design §3 M | 3.M.* (expect GUI-pending) |

**SHARED / INJECTED / RENDERER on macOS (identical code to other platforms — spot-confirm
behaviour on the WebKit engine, not first-run-risky):**

| Shared leg | Why it's shared | Checklist item |
|---|---|---|
| Injected ad-block (the **sole** macOS ad-block tier) | `adblock_inject.rs` document-start JS (no network/content-filter tier on macOS) | 1.4, 1.5 |
| Pop-under guard `POPUP_GUARD` | shipped every platform via `adblock_inject` | 1.6 |
| HTTPS-Only upgrade | `nav.rs` shared navigation callback | 2.1 |
| MalwareGuard | `safety.rs` shared engine + interstitial | 2.2, 2.3 |
| WebRTC shim (**shim-only on macOS — workers leak; no native backstop**) | `webrtc_shim.rs` injected; macOS has no `set_enable_webrtc`/`--force-webrtc…` backstop | 2.4 |
| Find bar UI, zoom indicator, theme tokens, private affordance | renderer (React/`index.css`) | 3.D.1/4, 3.E (indicator), 3.F.*, 3.H (UI) |
| Vault (`vault.rs` + `crypto.rs` AEAD; seed via desktop `keyring` = macOS Keychain) | shared Rust crypto | 3.K.* |
| Farbling (**WebKit shim variant** of the two reconciled shims) | injected, shared salt (S2) | 3.L.* |
| Shield block-counter | **not in macOS scope** (§3 G = Win+Android); macOS badge shows 0 by design | 3.G.1 |

---

## Self-Review

Checklist totals: **39 checklist items** (1.1–1.7, 2.1–2.5, 3.D.1–4, 3.E.1–3, 3.F.1–3,
3.G.1, 3.H.1–3, 3.K.1–3, 3.L.1–3, 3.M.1–2, 4.1–4.5) across Phases 0–5.

**Every Improvements-Program feature with a macOS surface appears in the checklist:**

- **D — Find-in-page:** ✅ 3.D.1–4 (native WKWebView `find` leg flagged).
- **E — Page zoom:** ✅ 3.E.1–3 (native `pageZoom`/magnification leg flagged).
- **F — Theme:** ✅ 3.F.1–3 (renderer; system-follow via `prefers-color-scheme`).
- **G — Shield counter:** ✅ 3.G.1 — explicitly **not** in macOS scope; documented as
  expected-0, blocking proven by the 1.5 A/B instead.
- **H — Private mode:** ✅ 3.H.1–3 (native `WKWebsiteDataStore.nonPersistent()` + skip guards).
- **K — Vault:** ✅ 3.K.1–3 (shared crypto; macOS Keychain seed noted).
- **L — Farbling:** ✅ 3.L.1–3 (WebKit shim variant noted).
- **M — Proxy:** ✅ 3.M.1–2 — macOS Network.framework leg flagged **GUI-pending/CI-only**
  per §3 M ("may slip"), an accepted end state.

**Existing security tiers covered:** HTTPS-Only (2.1), MalwareGuard (2.2–2.3), WebRTC
(2.4, with the honest macOS worker-leak residual), redirect guard (2.5, native
`WKNavigationDelegate` hook).

**Core baseline + the never-run macOS-native legs covered:** browse/render (1.1–1.2),
same-document KVO tracker (1.3, `nav_url_mac.rs`), injected ad-block A/B (1.4–1.5), pop-under
(1.6), UA (1.7), geometry/hit-test/overlay/tabswitch/resize/download-open (4.1–4.5).

**Required-header check:** title ✅; "For agentic workers" line (annotated human/owner-executed)
✅; **Goal** ✅; **Architecture** (n/a — verification runbook) ✅; **Tech Stack** (macOS, Tauri
build) ✅; **## Global Constraints** carrying §4 verification reality ✅. **No placeholders**:
every step has an exact action and exact expected observation. **Hardware gate stated up front**
(For-agentic-workers note + Global Constraints first bullet). **Where a macOS leg is
CI-only/unverifiable, it is said explicitly** (M proxy 3.M.1; WebRTC worker leak 2.4; G counter
3.G.1). **No source modified; no tests/cargo/git run** — observe-only, per Global Constraints.

Self-review result: **PASS** — all eight macOS-surfaced program features (D, E, F, G, H, K,
L, M) plus all existing security tiers and the never-run macOS-native legs appear in the
checklist, each with native-vs-shared marking, an exact expected observation, and an evidence
capture; CI-only/GUI-pending legs are called out honestly rather than forced to pass.
