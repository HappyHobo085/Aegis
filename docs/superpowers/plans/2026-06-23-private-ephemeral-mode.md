# Sub-project H — Private / Incognito Mode (full ephemeral)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development`
> to execute this plan. Each task below is a bite-sized, test-first unit. Dispatch one
> subagent per task, in order; do not batch unrelated tasks. After every task, run the
> stated gate and stop on red. The first tasks are the pure, fully-unit-testable core
> (`tab_registry.rs`) and the persistence skip-guards (`history.rs`/session); only after
> those are green do you touch the per-platform webview-creation code (which can only be
> `cargo check`'d here for Win/mac, and live-run for Linux/Android). UI + autopilot land
> last, in the SAME commit as the channel/UI they cover (the drift guard enforces this).

---

## Goal

Add a **private (incognito) tab** to Aegis whose content webview uses an **ephemeral data
partition** — cookies, localStorage/IndexedDB/cache, and HTTP cache live only in memory and
are discarded when the tab closes — and whose browsing is **excluded from every on-disk
persistence write-path**: history, the syncable stores, the downloads record, and the tab
session file. A clear visual treatment marks private tabs, and a new-private affordance
(toolbar/menu + `Ctrl+Shift+N`) creates one. Parity per §4 of the master design: Linux and
Android live-verified, Windows owner-device-verified, macOS CI-built (GUI-pending).

The honest ceiling, stated up front: on **desktop** the ephemeral partition is engine-native
(WebKitGTK ephemeral `WebContext`, WKWebView `nonPersistentDataStore`, WebView2 in-private),
so a private session leaves **no cookie/storage/cache residue** after close. On **Android**
the platform offers no per-WebView incognito — `CookieManager` and the HTTP cache are
process-global — so the private leg is **best-effort**: third-party cookies refused, plus a
targeted cookie/cache/storage flush when the private tab closes. This weaker guarantee is
documented in code and in `src-tauri/CLAUDE.md`, matching the spec's "Android weakest" note.

---

## Architecture

A single per-tab boolean, `private`, originates in the **pure tab registry** and flows
outward through three seams:

```
                       tab_registry::Tab.private  (source of truth; unit-tested)
                                 │
              ┌──────────────────┼───────────────────────────────┐
              │ create(private)  │ tabs_state() → TabMeta.private │ to_persisted() SKIPS private tabs
              ▼                  ▼                                ▼
   tabs::dispatch("tabs.create"  TabsState event → chrome       tabs.json never carries a
     {private:true})  ─────────▶ TabStrip visual treatment       private tab (nothing to restore →
              │                                                   ephemeral by construction)
              ▼
   nav::spawn_tab(app, id, url, private)
              │  desktop: WebviewBuilder::incognito(private)  ← engine-native ephemeral partition
              │  android: createTabWebView(id,url,private)    ← best-effort flush + 3p-cookie refuse
              ▼
   PRIVATE-TAB WRITE-SKIP GUARDS  (a tab is "private?" via tabs::is_private(app, id))
       ├─ history::record / update_title   → no-op for a private tab
       ├─ downloads::on_requested          → still saves the FILE, but records NO row
       └─ (sync is automatically clear: history/downloads aren't syncable; favorites/saved
           are user-initiated actions a private tab never performs implicitly)
```

Key design decisions, each grounded in code I verified:

1. **The ephemeral partition is wry/Tauri-native, not hand-rolled.** Tauri 2.11.2 exposes
   `tauri::webview::WebviewBuilder::incognito(bool)` (verified: `tauri-2.11.2/src/webview/mod.rs:997`).
   wry 0.55.1 maps `incognito` to exactly the per-platform primitives the spec named —
   WebKitGTK `WebContext::new_ephemeral()` (`wry-0.55.1/src/webkitgtk/mod.rs:255`), WKWebView
   `WKWebsiteDataStore::nonPersistentDataStore` (`wry-0.55.1/src/wkwebview/mod.rs:231`), and
   WebView2 `SetIsInPrivateModeEnabled(true)` (`wry-0.55.1/src/webview2/mod.rs:407`). So on
   all three desktop engines we add **one builder call**; we do NOT manually construct a
   `WebsiteDataManager`/`WKWebsiteDataStore`, which `add_child` gives us no seam to inject.
   wry's own doc warns `incognito` is **"Unsupported" on Android** (`wry/src/lib.rs:748`), so
   Android needs a separate best-effort path.

2. **`private` is registry state but NOT persisted.** A persisted private tab would reload on
   next launch — defeating ephemerality and leaking the URL to disk. So `Tab.private` lives in
   the registry but `to_persisted()` filters private tabs out entirely (verified: the session
   round-trips only `PersistedTab{id,url,title,pinned}` today — no private field exists, and we
   keep it that way).

3. **The write-skip is a guard at the write, keyed on the active/owning tab.** `history::record`
   is called from `nav::spawn_tab`'s `on_page_load` with the tab id in scope (`load_id`), and
   `history::update_title` from `linux_layout` with the tab id derivable from the label. The
   guard is `tabs::is_private(app, id)` — a registry lookup. Downloads have no tab id in the
   `on_download` closure today, so we capture the spawning tab's id into the closure (it's the
   same `id` already captured for `app_dl`). **Android needs no history/downloads skip-guard at
   all** — verified: Android never calls `history::record` (no JNI history path; nav state goes
   via the JS bridge) and has no download handler. So Android's only job is the ephemeral flush.

4. **Sync needs no new guard.** Verified `SYNCABLE = ["favorites","saved","allowlist"]`
   (`sync_stores.rs`) — history and downloads are deliberately absent. Favorites/saved/allowlist
   are explicit user actions (clicking "save", toggling the shield allowlist) that a private tab
   does not perform as a side-effect of browsing. We will **not** let the chrome offer
   "add favorite"/"save page" from a private tab (UI-level), and we add a defensive note. No code
   path silently writes a syncable record during ordinary private browsing.

---

## Tech Stack

- **Rust core** (`src-tauri/src/`): `tab_registry.rs` (pure state machine, `cargo test`),
  `tabs.rs`, `nav.rs`, `history.rs`, `downloads.rs`, `linux_layout.rs`, `lib.rs` dispatcher.
- **Tauri/wry**: `WebviewBuilder::incognito(bool)` (Tauri 2.11.2 → wry 0.55.1). No new crate.
- **Android/Kotlin** (`gen/android/.../MainActivity.kt`): `CookieManager`,
  `WebSettings`, `WebStorage`, `WebView.clearCache` — all in the Android SDK (no new dep).
- **Renderer** (`src/`): React 19 + TS — `TabStrip.tsx`, `App.tsx`, toolbar/menu,
  `index.css` for the visual treatment; `shared/types.ts` (`TabMeta`, `tabs.create` shape),
  `src/lib/ipcClient.ts`.
- **Autopilot** (`src/autopilot/`): `catalog.ts` (a `verify` that a private tab leaves no
  history row), `screens.ts`, `reach.ts`, `interactions/`.
- **Verification:** `cargo test` (registry + guards); `cargo check` /
  `cargo check --target x86_64-pc-windows-gnu` / `cargo check --target aarch64-linux-android`;
  `npm test` (vitest); `bash scripts/autopilot/run-autopilot.sh` (Linux live); manual device
  runs for Windows (owner) and Android (emulator/phone). macOS = CI build only.

---

## Global Constraints (from master design §6 — non-negotiable)

1. **IPC in three places.** The only contract change here is a new **field** on an existing
   channel (`tabs.create` gains an optional `private` flag) and a new field on the `TabMeta`
   event payload — no new channel. Per the shared/CLAUDE.md "settings-field shortcut" precedent,
   a payload field still touches all three sync points: `shared/types.ts` (`AegisApi.tabs.create`
   signature + `TabMeta.private`), the Rust reader in `tabs::dispatch` (`payload.get("private")`),
   and `src/lib/ipcClient.ts` (`tabs.create(url, background, isPrivate)`). Events stay dotted
   logically; the transport rewrites `.`↔`:` — we add no raw dotted emit.
2. **Autopilot coverage in the SAME commit (drift-guarded).** The new `private` capability on
   `tabs.create` → a catalog `verify` proving a private tab records **no** history row; the
   new-private affordance + visual treatment → an interaction test that clicks it and asserts a
   private tab appears; the private visual state → a `screens.ts` entry if it's a distinct
   screen state (it's a strip variant, covered by the interaction test, not a full overlay).
   `coverage.test.ts` fails the build if `tabs.create`'s catalog entry doesn't cover the
   capability — we extend the existing `tabs.lifecycle` entry rather than orphan the channel.
3. **Gate per task.** `npm test` green; for any runtime-touching change, the Linux live
   autopilot `RESULT: … 0 failed` **and** `ad-block blocking (trace): PASS`.
4. **Parity before "done".** Linux + Android live-verified; Windows owner-device-verified;
   macOS CI-built (incognito is compiled but GUI-pending — sub-project I). The plan brings all
   four to the same level (Android explicitly documented as the weaker best-effort tier); no
   "Linux works, the rest is a follow-up."

---

## File Structure (touched / created)

```
src-tauri/src/
  tab_registry.rs      [MODIFY] add Tab.private; create() takes `private`; TabMeta.private;
                                to_persisted() skips private tabs; new #[test]s (test-first)
  tabs.rs              [MODIFY] read `private` from tabs.create payload; is_private(app,id) helper;
                                open_background gains private (inherit opener); pass to spawn()/spawn_tab
  nav.rs               [MODIFY] spawn_tab(app,id,url,private) → WebviewBuilder.incognito(private);
                                history/downloads skip-guards keyed on is_private
  history.rs           [MODIFY] record()/update_title() early-return when the owning tab is private
                                (callers pass the tab id / privateness in)
  downloads.rs         [MODIFY] on_requested() saves the file but skips the record row for a private tab
  linux_layout.rs      [MODIFY] connect_title_label passes the tab id so update_title can check privacy
  lib.rs               [no contract change] — no new dispatcher arm (tabs.create already routed)

src-tauri/gen/android/app/src/main/java/com/aegis/browser/
  MainActivity.kt      [MODIFY] activateTab(id,url,isPrivate); createTabWebView(...,isPrivate):
                                setAcceptThirdPartyCookies(false) + flush cookies/cache/storage on
                                closeTab/discardTab of a private tab; privateTabs:Set<Int>

shared/
  types.ts             [MODIFY] AegisApi.tabs.create(url?,background?,isPrivate?); TabMeta.private?:boolean

src/
  lib/ipcClient.ts     [MODIFY] tabs.create(url,background,isPrivate) → payload {url,background,private}
  components/TabStrip.tsx  [MODIFY] private visual treatment (icon/class); pass through onCreate variant
  components/Toolbar...    [MODIFY] new-private menu item / button affordance (locate the menu host)
  App.tsx              [MODIFY] createPrivateTab handler; Ctrl+Shift+N; pass `private` to tabs.create
  index.css            [MODIFY] .tab--private visual tokens

src/autopilot/
  catalog.ts           [MODIFY] extend tabs.lifecycle verify: a private tab leaves NO history row
  screens.ts           [MODIFY] (only if a distinct screen state is needed — likely not; strip variant)
  reach.ts             [MODIFY] (only if screens.ts gains an entry)
  interactions/        [MODIFY] new-private affordance interaction test (desktop tour)
```

---

## Tasks (bite-sized, test-first)

### Task 1 — `tab_registry.rs`: add the `private` flag (test-first, pure)

Write the `cargo #[test]`s **first**, watch them fail, then implement. Add `private: bool` to
`Tab`, thread it through `create`, expose it on `TabMeta`, and **exclude private tabs from
`to_persisted`**.

**Tests to add (in the existing `mod tests`):**

```rust
#[test]
fn create_private_tab_is_marked_private() {
    let mut r = reg();
    let (id, _) = r.create_private(Some("https://x.test/".into()), false, 0, true);
    let meta = r.tabs_state().tabs.iter().find(|t| t.id == id).cloned().unwrap();
    assert!(meta.private, "a private tab must report private=true");
    // a normal tab stays non-private
    let (n, _) = r.create_private(None, true, 0, false);
    assert!(!r.tabs_state().tabs.iter().find(|t| t.id == n).unwrap().private);
}

#[test]
fn private_tabs_are_excluded_from_persisted_session() {
    let mut r = reg();                                   // tab 1: normal
    r.create_private(Some("https://normal.test/".into()), true, 0, false); // tab 2: normal
    let (p, _) = r.create_private(Some("https://secret.test/".into()), true, 0, true); // tab 3: private
    let session = r.to_persisted();
    assert!(session.tabs.iter().all(|t| t.id != p), "the private tab must not be persisted");
    assert_eq!(session.tabs.len(), 2, "only the two normal tabs persist");
    // next_id is still advanced past the private tab so a restore can't collide.
    assert!(session.next_id > p);
}

#[test]
fn is_private_reads_the_flag() {
    let mut r = reg();
    let (p, _) = r.create_private(None, true, 0, true);
    assert_eq!(r.is_private(p), Some(true));
    assert_eq!(r.is_private(1), Some(false));
    assert_eq!(r.is_private(9999), None);
}

#[test]
fn restored_tabs_are_never_private() {
    // Defense in depth: even a (hypothetically) malformed session can't resurrect a private tab.
    let session = PersistedSession {
        tabs: vec![PersistedTab { id: 5, url: "https://a.test/".into(), title: String::new(), pinned: false }],
        active_id: 5, next_id: 6,
    };
    let r = Registry::restore(session, "https://home.test/".into());
    assert!(r.tabs_state().tabs.iter().all(|t| !t.private));
}
```

**Implementation:**

```rust
// struct Tab — add:
    /// Private (incognito) tab: its content webview uses an ephemeral data partition and
    /// its browsing is excluded from history/sync/downloads + the persisted session.
    private: bool,

// struct TabMeta — add:
    pub private: bool,

// Keep `create` as the public API but route it through a private-aware impl so existing
// callers (registry `restore`, `reopen_closed`, the `close`-empties-list path) need no change:
pub fn create(&mut self, url: Option<String>, background: bool, now_ms: u64) -> (ViewId, String) {
    self.create_private(url, background, now_ms, false)
}

pub fn create_private(
    &mut self, url: Option<String>, background: bool, now_ms: u64, private: bool,
) -> (ViewId, String) {
    let id = self.next_id;
    self.next_id += 1;
    let url = url.unwrap_or_else(|| self.home_url.clone());
    self.tabs.push(Tab {
        id, url: url.clone(), title: String::new(),
        pinned: false, live: true, last_active: now_ms,
        history: vec![url.clone()], hist_index: 0, private,
    });
    if !background {
        if let Some(i) = self.idx(self.active_id) { self.tabs[i].last_active = now_ms; }
        self.active_id = id;
    }
    (id, url)
}

pub fn is_private(&self, id: ViewId) -> Option<bool> {
    self.idx(id).map(|i| self.tabs[i].private)
}
```

Add `private: false` to the three other `Tab { … }` literals (`Registry::new`,
`Registry::restore`'s `.map`, and `reopen_closed`) — restored/reopened tabs are never private.
Add `private: t.private` to the `TabMeta` map in `tabs_state()`. In `to_persisted()`, filter:

```rust
pub fn to_persisted(&self) -> PersistedSession {
    PersistedSession {
        tabs: self.tabs.iter()
            .filter(|t| !t.private)                       // never persist a private tab
            .map(|t| PersistedTab { id: t.id, url: t.url.clone(), title: t.title.clone(), pinned: t.pinned })
            .collect(),
        active_id: self.active_id,
        next_id: self.next_id,
    }
}
```

> Note: if the **active** tab is private, `to_persisted` will emit an `active_id` not present
> in `tabs`. `Registry::restore` already guards exactly this (`if r.idx(active_id).is_none()`
> → falls back to tabs[0]) — verified in the existing `restore_with_unknown_active_id_falls_back…`
> test. Add an assertion to `private_tabs_are_excluded_from_persisted_session` that restoring
> that session is sane (no panic, falls back).

**Gate:** `cargo test tab_registry` green (existing 25 + 4 new = 29).

---

### Task 2 — `history.rs`: skip the visit write for private tabs (test-first)

`history::record` and `update_title` must no-op when the owning tab is private. The cleanest,
testable seam is to gate **at the caller** (the caller knows the tab id), but the functions also
guard defensively. Since `history.rs` has no Tauri-free unit harness today, add the privacy
decision as a **pure helper** that IS unit-testable, and call it from the (Tauri) `record`.

**Test (add a `#[cfg(test)] mod tests` to `history.rs`):**

```rust
#[cfg(test)]
mod tests {
    use super::should_record_visit;
    #[test]
    fn skips_non_web_and_private() {
        assert!(should_record_visit("https://example.com/", false));
        assert!(!should_record_visit("about:blank", false));
        assert!(!should_record_visit("data:text/html,x", false));
        assert!(!should_record_visit("", false));
        // a private tab never records, even for a real web URL.
        assert!(!should_record_visit("https://example.com/", true));
    }
}
```

**Implementation:** factor the existing scheme checks into the pure helper and add the private
gate; pass `is_private` from the caller.

```rust
/// Pure predicate: should this (url, owning-tab-privateness) pair be written to history?
pub fn should_record_visit(url: &str, is_private: bool) -> bool {
    if is_private { return false; }
    !(url.is_empty() || url.starts_with("about:") || url.starts_with("data:"))
}

pub fn record(app: &AppHandle, url: &str, title: &str, is_private: bool) {
    if !should_record_visit(url, is_private) { return; }
    // …unchanged body…
}

pub fn update_title(app: &AppHandle, url: &str, title: &str, is_private: bool) {
    if is_private || url.is_empty() || title.is_empty()
        || url.starts_with("about:") || url.starts_with("data:") { return; }
    // …unchanged body…
}
```

Callers (`nav.rs`, `linux_layout.rs`) pass the tab's privateness — wired in Tasks 4 & 5.

**Gate:** `cargo test history` green; `cargo check` (the new param breaks the two callers — they
are fixed in Tasks 4/5, so this task's `cargo check` is run **after** those, or temporarily pass
`false` and tighten in 4/5; prefer doing 2+4+5 as one commit so the tree always compiles).

---

### Task 3 — `tabs.rs`: `is_private` helper + read the flag from `tabs.create`

Add a registry-backed `is_private(app, id)` and thread `private` through `spawn`, `create`,
`open_background`, and the `tabs.create` dispatch.

```rust
/// Whether tab `id` is a private (incognito) tab. Defaults to false for an unknown id.
pub fn is_private(app: &AppHandle, id: u32) -> bool {
    app.try_state::<Tabs>()
        .and_then(|s| s.reg.lock().unwrap().is_private(id))
        .unwrap_or(false)
}
```

In `dispatch`, the `"tabs.create"` arm:

```rust
"tabs.create" => {
    let url = payload.get("url").and_then(Value::as_str).map(str::to_string);
    let background = payload.get("background").and_then(Value::as_bool).unwrap_or(false);
    let private = payload.get("private").and_then(Value::as_bool).unwrap_or(false);
    let (id, u) = app.state::<Tabs>().reg.lock().unwrap().create_private(url, background, now, private);
    spawn(app, id, &u, private);
    crate::view::apply_inset(app);
    emit_and_persist(app);
    Some(Ok(state_value(app)))
}
```

Change `fn spawn(app, id, url)` → `fn spawn(app, id, url, private)` and pass `private` to
`crate::nav::spawn_tab(&app, id, u, private)` in both the Windows-thread and non-Windows arms.
Update the other `spawn(...)` call sites (`tabs.activate`, `tabs.close` respawn,
`tabs.reopenClosed`, `close_tab`, `open_background`). For **respawn** paths (activate a discarded
tab, close-respawns-neighbor, reopen-closed), read the privateness back from the registry — but
note: a **discarded private tab cannot be faithfully respawned** (its ephemeral data is gone by
definition). Decision: a private tab is **exempt from the idle sweep** (it must never be
discarded-and-reloaded, which would both lose its session and re-create a fresh ephemeral
partition). Implement this in the registry's `sweep_idle` (Task 3a below), so respawn paths only
ever see non-private discarded tabs, and `reopen_closed` already creates non-private tabs.

For `open_background` (target=\_blank / window.open): a popup from a private tab should inherit
privateness. Capture the opener's privateness:

```rust
pub fn open_background(app: &AppHandle, url: &str, private: bool) {
    let now = now_ms(app);
    let (id, u) = app.state::<Tabs>().reg.lock().unwrap().create_private(Some(url.to_string()), true, now, private);
    spawn(app, id, &u, private);
    emit_and_persist(app);
}
```

The caller in `nav.rs on_new_window` passes `is_private(app, opener_id)` (Task 4).

**Gate:** `cargo test` + `cargo check` green (with Tasks 2/4/5 in the same commit so the tree
compiles).

---

### Task 3a — `tab_registry.rs`: exempt private tabs from the idle sweep (test-first)

A discarded private tab would lose its ephemeral session and, on re-activate, spawn a **new**
ephemeral partition — surprising and residue-adjacent. Private tabs must never be swept.

**Test:**

```rust
#[test]
fn sweep_exempts_private_tabs() {
    let mut r = reg();                                          // tab 1 (normal, active)
    let (p, _) = r.create_private(None, true, 0, true);         // tab 2 private, backgrounded@0
    let (_n, _) = r.create_private(None, false, 0, false);      // tab 3 normal, now active
    // long-idle sweep: the normal background tab 1 is a victim; the private tab p is NOT.
    let victims = r.sweep_idle(999_999, 1);
    assert!(victims.contains(&1));
    assert!(!victims.contains(&p), "a private tab must never be discarded");
}
```

**Implementation:** add `&& !t.private` to the `sweep_idle` victim predicate.

**Gate:** `cargo test tab_registry` green.

---

### Task 4 — `nav.rs`: `spawn_tab(…, private)` → `incognito`; wire the write-skips

This is the core ephemeral-partition task (desktop). Change the signature and add the
**verified** Tauri builder call.

```rust
#[cfg(desktop)]
pub fn spawn_tab(app: &AppHandle, id: u32, url: Url, private: bool) -> tauri::Result<()> {
    // …existing setup (window, scale, size, label, redirect_guard::expect, host_allowlisted)…

    let mut builder = tauri::webview::WebviewBuilder::new(&label, WebviewUrl::External(url))
        .user_agent(CONTENT_UA)
        // PRIVATE TAB: ephemeral data partition. Verified mapping (Tauri 2.11.2 → wry 0.55.1):
        //   Linux   WebKitGTK  → WebContext::new_ephemeral()           (in-memory WebsiteDataManager)
        //   macOS   WKWebView  → WKWebsiteDataStore::nonPersistentDataStore
        //   Windows WebView2   → controller SetIsInPrivateModeEnabled(true) (WebView2 ≥101.0.1210.39)
        //   Android: UNSUPPORTED by wry — handled natively in MainActivity (best-effort flush).
        // Cookies/localStorage/IndexedDB/cache live only in memory and vanish when the webview closes.
        .incognito(private)
        .initialization_script_for_all_frames(crate::adblock_inject::script(app, host_allowlisted))
        .on_navigation(move |u| decide_navigation(&app_nav, nav_id, u))
        .on_page_load(move |_webview, payload| {
            // …unchanged emit_state / on_tab_url / mark_tab_has_content / reset_page / set_content_visible…
            if matches!(event, tauri::webview::PageLoadEvent::Finished) {
                // PRIVATE: never record a visit. Look up the owning tab's privateness.
                crate::history::record(&app_load, u, "", crate::tabs::is_private(&app_load, load_id));
            }
        })
        .on_download(move |_webview, event| {
            match event {
                tauri::webview::DownloadEvent::Requested { url, destination } => {
                    // PRIVATE: still save the file the user asked for, but record NO row.
                    crate::downloads::on_requested(&app_dl, url.as_str(), destination,
                        crate::tabs::is_private(&app_dl, dl_id));
                }
                tauri::webview::DownloadEvent::Finished { success, .. } => {
                    crate::downloads::on_finished(&app_dl, success);
                }
                _ => {}
            }
            true
        })
        .on_new_window({
            let app_nw = app.clone();
            let opener_id = id;
            move |url, _features| {
                // …existing is_unwanted_popup gate…
                let inherit_private = crate::tabs::is_private(&app_nw, opener_id);
                let app_main = app_nw.clone();
                let _ = app_nw.run_on_main_thread(move || {
                    crate::tabs::open_background(&app_main, &u, inherit_private);
                });
                tauri::webview::NewWindowResponse::Deny
            }
        });
    // …rest unchanged…
}

#[cfg(mobile)]
pub fn spawn_tab(_app: &AppHandle, _id: u32, _url: Url, _private: bool) -> tauri::Result<()> { Ok(()) }
```

Add `let app_dl = app.clone();` already exists; add `let dl_id = id;` next to `load_id`.

> **Locate-it-first sub-step (uncertainty flagged):** the `on_download` `Requested` event in
> wry does NOT carry a frame/tab handle, so we rely on the closure capturing the spawning tab's
> `id`. This is correct because each tab gets its OWN `spawn_tab` call (verified — `spawn_tab` is
> per-tab, and `app_dl`/`load_id` are already captured per tab). If `on_download` ever fires for
> a download initiated cross-tab, this attributes it to the spawning tab — acceptable. Confirm
> by reading the `on_download` signature in the installed `tauri::webview` before implementing;
> if a frame handle is exposed, prefer it.

**Gate:** `cargo check` (Linux), `cargo check --target x86_64-pc-windows-gnu`,
`cargo check --target aarch64-linux-android` all green. Then `cargo test`.

---

### Task 5 — `linux_layout.rs`: pass tab privateness into `update_title`

`connect_title_label` already derives the tab `id` from the label (`id` Option). Pass its
privateness to `history::update_title`:

```rust
let url = wv.uri().map(|s| s.to_string()).unwrap_or_default();
let is_private = id.map(|i| crate::tabs::is_private(&app, i)).unwrap_or(false);
crate::history::update_title(&app, &url, &title, is_private);
```

**Gate:** `cargo check` (Linux) green. (Win/mac have no title→history path, so no change there.)

---

### Task 6 — `downloads.rs`: save the file, skip the record for private tabs (test-first)

`on_requested` must still set the `destination` (so the user's download succeeds) but skip the
JSON row + the `downloads.changed` event when the owning tab is private. Factor the
record-decision into a pure helper for the unit test.

**Test (extend `downloads.rs`'s tests, or add a `mod tests`):**

```rust
#[cfg(test)]
mod tests {
    use super::should_record_download;
    #[test]
    fn private_downloads_are_not_recorded() {
        assert!(should_record_download(false));   // normal tab → record
        assert!(!should_record_download(true));   // private tab → no record (file still saved)
    }
}
```

**Implementation:**

```rust
pub fn should_record_download(is_private: bool) -> bool { !is_private }

pub fn on_requested(app: &AppHandle, url: &str, destination: &mut PathBuf, is_private: bool) {
    let filename = /* …unchanged… */;
    let save = dir(app).join(&filename);
    *destination = save.clone();                  // ALWAYS set the path — the file must download
    if !should_record_download(is_private) {
        return;                                    // private: no row, no downloads.changed event
    }
    // …unchanged record-building body…
}
```

> Honest note for code + CLAUDE.md: the downloaded **file itself** lands on disk in a private
> session (the user explicitly asked to save it) — only the _downloads-list record_ is omitted.
> This matches mainstream browsers (Chrome/Firefox incognito downloads persist the file, drop
> the history entry). Document it; don't pretend the file evaporates.

**Gate:** `cargo test downloads` green; `cargo check` green (caller updated in Task 4).

---

### Task 7 — Android: best-effort ephemeral private tab (live-verified on device)

wry's `incognito` is a desktop no-op on Android, so `MainActivity` implements the best-effort
tier. Thread `isPrivate` through `activateTab`/`createTabWebView`, track private tab ids, and on
**close/discard of a private tab** flush its cookies, cache, and web storage. Also refuse
third-party cookies on private tab WebViews.

```kotlin
// field:
private val privateTabs = HashSet<Int>()

// Bridge.activateTab gains the flag (chrome passes it):
@JavascriptInterface
fun activateTab(id: Int, url: String, isPrivate: Boolean) = runOnUiThread {
    if (isPrivate) privateTabs.add(id)
    val wv = tabWebViews[id] ?: createTabWebView(id, url, isPrivate).also { tabWebViews[id] = it }
    // …unchanged…
}

private fun createTabWebView(id: Int, url: String, isPrivate: Boolean): WebView {
    val wv = WebView(this)
    wv.settings.javaScriptEnabled = true
    wv.settings.domStorageEnabled = true
    wv.settings.userAgentString = CHROME_UA
    // …multi-window + document-start + webrtc injection unchanged…
    if (isPrivate) {
        // Best-effort incognito (Android has no per-WebView data partition; CookieManager +
        // HTTP cache are process-global). Refuse third-party cookies for this WebView and turn
        // OFF disk cache so its traffic stays in memory where possible; a full wipe runs on close.
        CookieManager.getInstance().setAcceptThirdPartyCookies(wv, false)
        wv.settings.cacheMode = WebSettings.LOAD_NO_CACHE
    }
    // …add to gestureContainer, loadUrl…
}

// closeTab AND discardTab: flush a private tab's residue.
@JavascriptInterface
fun closeTab(id: Int) = runOnUiThread {
    tabWebViews.remove(id)?.let {
        it.visibility = View.GONE
        gestureContainer?.removeView(it)
        if (privateTabs.contains(id)) {
            it.clearCache(true)
            it.clearHistory()
            // Storage is process-global; clear it when the last private tab goes away.
        }
        it.destroy()
    }
    pageUrls.remove(id)
    if (privateTabs.remove(id) && privateTabs.isEmpty()) {
        // No private tabs left → flush the shared cookie + web-storage surfaces.
        CookieManager.getInstance().removeAllCookies(null)
        CookieManager.getInstance().flush()
        WebStorage.getInstance().deleteAllData()
    }
    if (activeTabId == id) { activeTabId = -1; contentWebView = null }
}
```

Apply the same private-flush block to `discardTab` (factor a `private fun teardownTab(id, wipe)`
to avoid duplication). Imports to add: `android.webkit.CookieManager`,
`android.webkit.WebSettings`, `android.webkit.WebStorage`.

> **Honest limit, documented in code + CLAUDE.md:** because `CookieManager`/`WebStorage` are
> process-global, the "wipe on last private tab close" can only run when **no** private tab
> remains; while a private and a normal tab coexist, the normal tab's cookies are also flushed
> at that moment (acceptable — the alternative, per-tab partitioning, doesn't exist pre-Android's
> unreleased per-profile API). This is why the spec calls Android "weaker." We do NOT claim
> cookie isolation between a private and a normal Android tab.

**Gate:** `cargo check --target aarch64-linux-android` (Rust side) + `./gradlew … compileKotlin`
under JDK 21 (per gotcha 8). Live device run: open a private tab, browse a cookie-setting site,
close it, reopen → no cookie; confirm history shows nothing for the private session.

---

### Task 8 — IPC contract: `tabs.create` gains `private`; `TabMeta.private` (PLACE 1 + 3)

**`shared/types.ts` (PLACE 1):**

```ts
export interface TabMeta {
  id: ViewId;
  pinned: boolean;
  live: boolean;
  title: string;
  url: string;
  /** A private (incognito) tab: ephemeral data partition, excluded from history/sync/downloads. */
  private?: boolean;
}
// AegisApi.tabs:
create(url?: string, background?: boolean, isPrivate?: boolean): Promise<TabsState>;
```

**`src/lib/ipcClient.ts` (PLACE 3):**

```ts
create: (url, background, isPrivate) =>
  call<TabsState>(IPC.tabsCreate, { url, background, private: isPrivate }),
```

(PLACE 2, the Rust dispatcher, is the `tabs.create` arm already updated in Task 3 — no new
channel, so `lib.rs`'s arm list is unchanged.)

**Gate:** `npm test` (the `shared/types.test.ts` IPC-naming invariant + the renderer typecheck).

---

### Task 9 — UI: new-private affordance + visual treatment

1. **`App.tsx`** — a `createPrivateTab` handler and a `Ctrl+Shift+N` shortcut:

```tsx
const createPrivateTab = () => void tabs.create(undefined, false, true);
// in the keydown handler, beside the existing Ctrl+T:
else if (k === 'n' && e.shiftKey) { e.preventDefault(); createPrivateTab(); }
```

2. **New-private affordance** — locate the toolbar/menu host (the `…` menu used for
   Settings/Downloads/etc.) and add a **"New private tab"** item that calls `createPrivateTab`.
   If the simplest reachable affordance is a second button on the `TabStrip`, add an
   `onCreatePrivate` prop and a small "incognito +" button beside the existing `tabstrip__new`
   `Plus` button (aria-label "New private tab"). Prefer the menu if one exists; confirm by
   reading the toolbar/menu component before wiring.

3. **Visual treatment** — `TabStrip.tsx`: when `tab.private`, add a `tab--private` class and
   swap the favicon glyph to an incognito icon (lucide `EyeOff` / a mask glyph). `index.css`:

```css
.tab--private {
  background: var(--aegis-private-bg, #2a2440);
}
.tab--private .tab__icon {
  color: var(--aegis-private-accent, #b794f6);
}
```

The treatment must be unmistakable at a glance (distinct tint + icon), per the spec's
"clear visual treatment". On mobile (`MobileApp` shell + Android), surface the same private
indicator in the tab switcher; pass `private` through the tab list the mobile shell renders.

**Gate:** `npm test` (component/interaction tests, incl. Task 11).

---

### Task 10 — Autopilot catalog: a private tab leaves NO history row (`verify`)

Extend the existing `tabs.lifecycle` catalog entry's `verify` (so `tabs.create`'s capability is
covered and the drift guard stays green) with a private-tab round-trip that asserts **no history
row** results from a private navigation.

```ts
verify: async (a) => {
  // …existing create(bg)→assert→close…

  // PRIVATE TAB: browsing in it must leave NO history row.
  const probe = `https://ap-private-${Date.now()}.test/`;
  const created = await a.tabs.create(probe, false, true);    // foreground PRIVATE tab
  const pid = created.tabs.find((t) => t.private)?.id;
  if (pid === undefined) throw new Error('private: created tab not marked private in state');
  // Navigate the private tab and give the (skipped) history write a chance to (not) happen.
  await a.nav.navigate(pid, probe);
  await new Promise((r) => setTimeout(r, 1500));
  const hits = (await a.history.search(probe)).length;
  await a.tabs.close(pid);
  if (hits !== 0) throw new Error(`private: navigation left ${hits} history row(s) for ${probe}`);
  return `tabs lifecycle + private-leaves-no-history ok (privId=${pid})`;
},
```

> Live-assert discipline (from the autopilot memory): this reads **real state** (`history.search`)
> and **throws on a captured change**, so it is a genuine live assertion, not a `['vitest']`
> no-op. In the mock vitest run, `history.search` returns `[]` and `create(...,true)` flows
> through the mock — the entry stays a pure exercise there.

**Gate:** `npm test` (coverage.test.ts drift guard + the entry's exercise path).

---

### Task 11 — Autopilot interaction test: drive the new-private affordance

Add a desktop interaction (in `src/autopilot/interactions/`) that drives the real UI the way a
user does: click the "New private tab" affordance (or press `Ctrl+Shift+N`), then assert a tab
with `private: true` appears in the `TabsState` the strip renders, and that it carries the
`tab--private` visual class.

```ts
// interactions/edge.ts (or a new private.ts wired into index.ts)
{
  id: 'private.newTab',
  title: 'New private tab affordance',
  async run(ctx) {
    const btn = await ctx.findByLabel('New private tab'); // menu item or strip button
    btn.click();
    await ctx.flush();
    const strip = document.querySelector('.tab--private');
    if (!strip) throw new Error('no .tab--private tab appeared after New private tab');
  },
}
```

If `screens.ts` needs a distinct entry (it does NOT — the private tab is a strip variant, not a
full-window overlay), skip it; otherwise add it + `reach.ts`. Document the choice in the entry.

**Gate:** `npm test` (interaction tour + `interactions.coverage.test.ts`).

---

### Task 12 — Docs + parity sweep (same commit)

Update **`src-tauri/CLAUDE.md`** (a new gotcha: "private tabs = `WebviewBuilder::incognito`;
desktop = engine-native ephemeral partition; Android = best-effort flush, process-global cookie
limit documented; private tabs are NOT persisted and NOT swept") and the **root `CLAUDE.md`
status line**. Verify parity: Linux live (autopilot), Windows owner-device, macOS CI-built
(incognito compiles; GUI-pending → sub-project I), Android device.

**Gate:** `npm test` green; `bash scripts/autopilot/run-autopilot.sh` →
`RESULT: … 0 failed` **and** `ad-block blocking (trace): PASS`.

---

## Verification matrix (per §4)

| Platform    | Ephemeral mechanism (verified)                                                    | "Done" gate here                                                          |
| ----------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **Linux**   | `WebContext::new_ephemeral()` via `incognito(true)`                               | live autopilot + manual: cookie/storage/history residue check after close |
| **Android** | best-effort: 3p-cookie refuse + close-time cookie/cache/storage flush             | device run: no cookie after private close; weaker, documented             |
| **Windows** | WebView2 `SetIsInPrivateModeEnabled(true)` via `incognito(true)` (≥101.0.1210.39) | `cargo check --target …-windows-gnu` + owner device run                   |
| **macOS**   | WKWebView `nonPersistentDataStore` via `incognito(true)`                          | CI build only (objc2 needs Mac toolchain); GUI = sub-project I            |

---

## Self-Review

**Does a private session truly leave no residue?**

- **Cookies / localStorage / IndexedDB / HTTP cache (desktop):** YES, on Linux/Windows/macOS —
  the data lives in an engine-native ephemeral partition (`WebContext::new_ephemeral` /
  `nonPersistentDataStore` / in-private controller), which the OS webview discards when the
  webview closes. I verified each mapping in the installed wry 0.55.1 source, not from memory.
- **Cookies / cache (Android):** PARTIAL and **documented as such**. Android has no per-WebView
  data partition; `CookieManager`/`WebStorage` are process-global. We refuse third-party cookies
  on private WebViews, disable disk cache, and flush cookies/cache/storage when the last private
  tab closes — but cannot isolate a private tab's cookies from a coexisting normal tab. This is
  the spec's accepted "Android weakest" tier; the limit is stated in code and CLAUDE.md rather
  than papered over.

**Is every persistence write-path guarded?** I enumerated them by tracing callers (not guessing):

| Write-path                                      | Reached from                                           | Guarded?                                                                                                                                           |
| ----------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `history::record` (page visit)                  | `nav.rs on_page_load` (`load_id` in scope)             | YES — `is_private(load_id)` early-return                                                                                                           |
| `history::update_title` (title fill)            | `linux_layout connect_title_label` (`id` in scope)     | YES — `is_private(id)` early-return                                                                                                                |
| `downloads::on_requested` (download row)        | `nav.rs on_download` (`dl_id` captured)                | YES — record skipped; file still saved (intended)                                                                                                  |
| `tabs.json` session (`to_persisted`)            | `tabs::persist` on every tab/nav change                | YES — `to_persisted` filters out private tabs                                                                                                      |
| Idle sweep discard/respawn                      | `start_idle_sweep` → `sweep_idle`                      | YES — private tabs exempt (can't faithfully respawn an ephemeral partition)                                                                        |
| Syncable stores `favorites`/`saved`/`allowlist` | explicit user actions only (not browsing side-effects) | N/A — no implicit write during private browsing; UI won't offer save/favorite from a private tab; `SYNCABLE` excludes history/downloads (verified) |
| Android history                                 | —                                                      | N/A — Android never calls `history::record` (verified: no JNI history path)                                                                        |
| Android downloads                               | —                                                      | N/A — Android has no download handler (verified)                                                                                                   |

**Per-platform ephemeral-partition API confirmation (the key risk, all confirmed in installed
source — none invented):**

- Linux: `tauri WebviewBuilder::incognito(true)` → wry `WebContext::new_ephemeral()`
  (`wry-0.55.1/src/webkitgtk/mod.rs:255`). Binding has `is_ephemeral`/`website_data_manager`
  if a manual path is ever needed (`webkit2gtk-2.0.2`).
- Windows: → `controller.SetIsInPrivateModeEnabled(true)` (`wry-0.55.1/src/webview2/mod.rs:407`);
  needs WebView2 ≥101.0.1210.39 (no-op below — documented by Tauri).
- macOS: → `WKWebsiteDataStore::nonPersistentDataStore` (`wry-0.55.1/src/wkwebview/mod.rs:231`).
- Android: wry doc says **Unsupported** (`wry/src/lib.rs:748`) → native best-effort path. This is
  the only platform where the exact "no residue" claim does not hold, and it is the one I flag.

**Could-not-confirm / flagged uncertainties:** (1) Whether `add_child` (the multi-webview path)
threads `incognito` identically to the top-level builder — wry routes both through
`WebViewAttributes.incognito`, and Tauri's `WebviewBuilder::incognito` sets that field
(verified), so it SHOULD; Task 4 includes a Linux live check (open private tab → site that sets
a cookie → close → reopen → cookie absent) to prove it end-to-end rather than assume. (2) The
`on_download` event's lack of a frame/tab handle — handled by per-tab closure capture, with a
locate-it-first sub-step in Task 4 to confirm the `on_download` signature before relying on it.

**Build-tree integrity:** Tasks 2, 4, 5, 6 each change a function signature that another file
calls, so they MUST land in one commit (the tree never compiles half-changed). The plan groups
them; the registry (Task 1, 3a) and autopilot/UI (8–11) are independently compilable.

**Net:** the contract change is a single optional `private` flag on `tabs.create` + `TabMeta`
(no new channel), the ephemeral mechanism is a single verified builder call per desktop engine
plus a documented best-effort Android tier, and every on-disk persistence write-path is either
guarded by `is_private` or proven (by tracing) to not fire during private browsing. The
autopilot `verify` makes "a private tab leaves no history row" a build-gating assertion.
