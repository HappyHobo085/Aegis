// Content-webview layout. The chrome reports a constant top inset (toolbar +
// favbar) via `view.setContentInset`; the content webview fills the window below
// it. Overlays/sidebar/fullscreen adjust this:
//   - a full-window chrome overlay (settings, downloads, …) HIDES the content so
//     the overlay (behind the opaque content) shows;
//   - the History/Saved sidebar is a chrome overlay — like the others it HIDES the
//     content (the opaque content webview would otherwise cover the panel);
//   - fullscreen keeps a slim top strip for the exit button; the content fills the rest.
use serde_json::Value;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, Runtime};

use crate::nav::DEFAULT_INSET_TOP;

/// Default sidebar panel width (matches `.sidebar__panel` in index.css and `SIDEBAR_W` in layout.ts).
const SIDEBAR_WIDTH: f64 = 320.0;

/// Top strip kept clear in fullscreen (non-Linux) so the chrome's exit button stays
/// visible above the content. Linux fills the window edge-to-edge instead, with a
/// native floating exit button on top (see linux_layout).
#[cfg(not(target_os = "linux"))]
const FULLSCREEN_TOP: f64 = 44.0;

/// Content-webview layout state. Managed by Tauri state so the resize handler and
/// the view.* handlers agree.
#[derive(Clone, Copy)]
pub struct Layout {
    pub left: f64,
    pub top: f64,
    /// Right inset (the sidebar panel width when the sidebar is open).
    pub right: f64,
    pub fullscreen: bool,
    /// A full-window chrome overlay is active (hides the content).
    pub overlay: bool,
    /// The sidebar is open: inset the content from the right by its width so the page
    /// stays visible beside the panel (rather than hiding it like a full overlay).
    pub sidebar: bool,
}

pub struct ContentInset(pub Mutex<Layout>);

impl Default for ContentInset {
    fn default() -> Self {
        ContentInset(Mutex::new(Layout {
            left: 0.0,
            top: DEFAULT_INSET_TOP,
            right: 0.0,
            fullscreen: false,
            overlay: false,
            sidebar: false,
        }))
    }
}

fn layout_of<R: Runtime>(app: &AppHandle<R>) -> Layout {
    app.try_state::<ContentInset>()
        .map(|s| *s.0.lock().unwrap_or_else(|e| e.into_inner()))
        .unwrap_or(Layout {
            left: 0.0,
            top: DEFAULT_INSET_TOP,
            right: 0.0,
            fullscreen: false,
            overlay: false,
            sidebar: false,
        })
}

/// The ONE definition of whether the content webview is shown for a given layout:
/// shown in fullscreen, shown when the sidebar insets it (page stays visible beside
/// the panel), and shown whenever no full-window overlay is covering it. A full
/// overlay (settings/downloads/dialogs/…) is the only thing that hides it.
pub fn content_visible(lay: &Layout) -> bool {
    lay.fullscreen || lay.sidebar || !lay.overlay
}

/// Hide the content for a full-window chrome overlay (settings, downloads, …) so the
/// chrome shows above the opaque content webview. The sidebar is NOT a full overlay — it
/// insets the content (page stays visible beside it), so it keeps content shown.
// `app` and `visible` are used only by the platform branches below (Linux's
// `set_content_visible`, and the Win/macOS `w.show()/w.hide()`), and Android runs
// neither — it has no separate content webview to toggle. Same allow as
// `apply_inset` below, for the same reason.
#[allow(unused_variables)]
fn apply_visibility<R: Runtime>(app: &AppHandle<R>, lay: Layout) {
    let visible = content_visible(&lay);
    #[cfg(target_os = "linux")]
    crate::linux_layout::set_content_visible(app, visible);
    // Windows/macOS: Tauri's hide/show work directly. (Mobile is single-webview —
    // there's no separate content webview to toggle.)
    #[cfg(all(desktop, not(target_os = "linux")))]
    if let Some(w) = crate::nav::active_webview(app) {
        let _ = if visible { w.show() } else { w.hide() };
    }
}

/// Resize/reposition the content webview to fill the window below the top inset and
/// left of the right inset (or the whole window in fullscreen).
#[allow(unused_variables)]
pub fn apply_inset<R: Runtime>(app: &AppHandle<R>) {
    let lay = layout_of(app);
    // Fullscreen content geometry differs by platform: Linux fills the window
    // edge-to-edge (a native floating exit button sits on top — see linux_layout),
    // while other platforms keep a top strip for the chrome's exit button.
    #[cfg(target_os = "linux")]
    let fs = (0.0, 0.0, 0.0);
    #[cfg(not(target_os = "linux"))]
    let fs = (0.0, FULLSCREEN_TOP, 0.0);
    let (left, top, right) = if lay.fullscreen {
        fs
    } else {
        (lay.left, lay.top, lay.right)
    };
    let Some(window) = app.get_window("main") else {
        return;
    };
    let Ok(inner) = window.inner_size() else {
        return;
    };
    let scale = window.scale_factor().unwrap_or(1.0);
    let logical = inner.to_logical::<f64>(scale);

    // Linux: wry's GtkBox ignores set_bounds (tauri#10420). Position the webviews
    // ourselves via the GtkFixed workaround. Other platforms: set_bounds works.
    #[cfg(target_os = "linux")]
    {
        let visible = content_visible(&lay);
        crate::linux_layout::layout(
            app,
            left as i32,
            top as i32,
            right as i32,
            logical.width as i32,
            logical.height as i32,
            lay.fullscreen,
            visible,
        );
    }

    // Windows: at fractional DPI (e.g. 125%) wry's Logical set_bounds mispositions the
    // WebView2 controller's INPUT region — the content webview renders below the chrome
    // bars but still captures their clicks, so the toolbar/favourites become dead. Pass
    // PHYSICAL bounds so the controller's hit-test rect matches the host window.
    #[cfg(target_os = "windows")]
    if let Some(content) = crate::nav::active_webview(app) {
        let w = (logical.width - left - right).max(0.0);
        let h = (logical.height - top).max(0.0);
        let _ = content.set_bounds(tauri::Rect {
            position: tauri::PhysicalPosition::new(
                (left * scale).round() as i32,
                (top * scale).round() as i32,
            )
            .into(),
            size: tauri::PhysicalSize::new((w * scale).round() as u32, (h * scale).round() as u32)
                .into(),
        });
    }
    #[cfg(target_os = "macos")]
    if let Some(content) = crate::nav::active_webview(app) {
        let w = (logical.width - left - right).max(0.0);
        let h = (logical.height - top).max(0.0);
        let _ = content.set_bounds(tauri::Rect {
            position: tauri::LogicalPosition::new(left, top).into(),
            size: tauri::LogicalSize::new(w, h).into(),
        });
    }

    // Windows/macOS: per-tab content webviews all sit at the same inset and OVERLAP, and
    // z-order alone doesn't follow the active tab — so on every layout pass show the
    // active tab's webview and hide every other tab's, or switching tabs just leaves the
    // previous page on top. (Linux does this inside linux_layout::layout above.)
    #[cfg(all(desktop, not(target_os = "linux")))]
    {
        let active = crate::nav::active_content_label(app);
        let active_visible = content_visible(&lay);
        for (label, w) in app.webviews() {
            if label.starts_with("content:") {
                let _ = if label == active && active_visible {
                    w.show()
                } else {
                    w.hide()
                };
            }
        }
    }
}

/// Mutate the layout state, then re-apply visibility + geometry.
fn update<F: FnOnce(&mut Layout), R: Runtime>(app: &AppHandle<R>, f: F) {
    if let Some(state) = app.try_state::<ContentInset>() {
        f(&mut state.0.lock().unwrap_or_else(|e| e.into_inner()));
    }
    apply_visibility(app, layout_of(app));
    apply_inset(app);
}

/// Decide whether entering fullscreen should overwrite the saved windowed size.
///
/// Split out and pure so the policy is testable on any platform: the bug it
/// guards against needs a real window, a real WM transition and a tab switch to
/// reproduce, none of which a unit test can arrange.
///
/// `already_fullscreen` covers a re-sent `on: true` after the WM applied
/// fullscreen (the tab-switch path); `slot_empty` covers one that arrives before
/// the WM has. Keeping the original slot is the point of the whole mechanism — a
/// monitor-sized "restored" window is worse than none.
/// The fullscreen-save policy, as a pure predicate so it is testable on every
/// platform (the capture itself is desktop-only, and always has been — Android
/// has no OS window to take over).
#[cfg(any(desktop, test))]
pub(crate) fn should_capture_saved(
    entering: bool,
    already_fullscreen: bool,
    slot_empty: bool,
) -> bool {
    entering && !already_fullscreen && slot_empty
}

/// Handle `view.*` channels. Returns `None` if not a view channel.
///
/// PLACE 2 of the three-place rule: the channel names live in `shared/types.ts`
/// and the renderer calls them through `ipcClient`. Every arm here ends in
/// `update`, which mutates the managed `ContentInset` layout and re-applies
/// visibility + geometry to the platform's webviews.
///
/// Generic over `R: Runtime` so the six arms — their `unwrap_or` defaults in
/// particular, which are exactly what a malformed or partial payload hits — are
/// reachable from a `MockRuntime` test. The only production caller is `lib.rs`'s
/// `ipc()`, which infers `Wry`. On a `MockRuntime` the native half is honestly a
/// no-op (no window, no content webview), so the observable a test can assert is
/// the layout state these arms leave behind — which is what
/// `linux_layout::layout`, `nav::decide_navigation` and the resize handler read.
pub fn dispatch<R: Runtime>(
    app: &AppHandle<R>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    let res: Result<Value, String> = match channel {
        "view.setContentInset" => {
            let top = payload
                .pointer("/inset/top")
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            let left = payload
                .pointer("/inset/left")
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            update(app, |l| {
                l.left = left;
                l.top = top;
            });
            Ok(Value::Null)
        }
        "view.setContentVisible" => {
            #[cfg(desktop)]
            {
                let visible = payload
                    .get("visible")
                    .and_then(Value::as_bool)
                    .unwrap_or(true);
                #[cfg(target_os = "linux")]
                crate::linux_layout::set_content_visible(app, visible);
                #[cfg(not(target_os = "linux"))]
                if let Some(w) = crate::nav::active_webview(app) {
                    let _ = if visible { w.show() } else { w.hide() };
                }
            }
            Ok(Value::Null)
        }
        // A full-window chrome overlay (settings, downloads, safety interstitial, …)
        // is in the chrome webview, behind the content; hide the content so it shows.
        "view.setChromeOverlay" => {
            let active = payload
                .get("active")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            update(app, |l| l.overlay = active);
            Ok(Value::Null)
        }
        // The sidebar is a right panel: inset the content from the right (page stays
        // visible) instead of hiding it.
        "view.setSidebar" => {
            let active = payload
                .get("active")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            // The sidebar panel is user-resizable; inset the content by its ACTUAL width
            // (reported by the chrome) so the opaque content never overlaps the panel.
            let width = payload
                .get("width")
                .and_then(Value::as_f64)
                .unwrap_or(SIDEBAR_WIDTH);
            update(app, |l| {
                l.sidebar = active;
                l.right = if active { width } else { 0.0 };
            });
            Ok(Value::Null)
        }
        // Atomic overlay+sidebar update: the chrome computes both flags and sets them in ONE
        // call so the content layout is applied from a single, consistent state. Opening
        // Settings while the sidebar was open used to fire two separate updates
        // (setChromeOverlay + setSidebar), each triggering its own layout pass — which could
        // apply mid-transition and leave Settings rendered behind the content. One update → one
        // apply removes that race.
        "view.setLayout" => {
            let overlay = payload
                .get("overlay")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let sidebar = payload
                .get("sidebar")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let width = payload
                .get("width")
                .and_then(Value::as_f64)
                .unwrap_or(SIDEBAR_WIDTH);
            update(app, |l| {
                l.overlay = overlay;
                l.sidebar = sidebar;
                l.right = if sidebar { width } else { 0.0 };
            });
            Ok(Value::Null)
        }
        // Fullscreen: content fills the window below a slim top strip that holds the
        // chrome's exit button; Esc (handled in the content webview) also exits.
        "view.setFullscreen" => {
            let on = payload.get("on").and_then(Value::as_bool).unwrap_or(false);
            update(app, |l| l.fullscreen = on);
            // Drive the real OS window so it takes over the monitor (hides the titlebar),
            // not just the content-webview geometry. Backend call — no capability needed.
            #[cfg(desktop)]
            if let Some(window) = app.get_window("main") {
                use std::sync::{Mutex, OnceLock};
                // The windowed size captured on enter, restored on exit. tao's
                // unfullscreen just calls gtk_window_unfullscreen() and leaves the geometry
                // restore to the WM, which is unreliable on GTK — without this the window
                // stays monitor-sized on exit and the content tracks it (the reported
                // "keeps fullscreen-ish width" bug). Restoring the saved size fixes it.
                static SAVED: OnceLock<Mutex<Option<tauri::PhysicalSize<u32>>>> = OnceLock::new();
                let saved = SAVED.get_or_init(|| Mutex::new(None));
                if on {
                    // Capture ONLY on a genuine windowed -> fullscreen transition.
                    // The renderer re-sends `on: true` on a tab switch
                    // (`App.tsx` keys the effect on `[tabs.activeId, fullscreen]`),
                    // and this arm used to overwrite SAVED with the CURRENT
                    // fullscreen inner size every time, so Esc restored a
                    // monitor-sized window — the exact bug the SAVED slot exists
                    // to prevent. Two independent guards, because either alone
                    // leaves a hole: `is_fullscreen()` catches the re-send once
                    // the WM has applied it, and the empty slot catches a
                    // re-send that arrives before the WM does.
                    let already_fullscreen = window.is_fullscreen().unwrap_or(false);
                    let mut slot = saved.lock().unwrap_or_else(|e| e.into_inner());
                    if should_capture_saved(true, already_fullscreen, slot.is_none()) {
                        if let Ok(sz) = window.inner_size() {
                            *slot = Some(sz);
                        }
                    }
                }
                let _ = window.set_fullscreen(on);
                if !on {
                    if let Some(sz) = saved.lock().unwrap_or_else(|e| e.into_inner()).take() {
                        let _ = window.set_size(sz);
                    }
                }
            }
            Ok(Value::Null)
        }
        _ => return None,
    };
    Some(res)
}

#[cfg(test)]
mod tests {
    use super::{
        content_visible, dispatch, should_capture_saved, ContentInset, Layout, SIDEBAR_WIDTH,
    };
    use crate::test_support::with_tmp_app;
    use serde_json::json;
    use tauri::{AppHandle, Manager, Runtime};

    /// The layout these arms leave behind, as one comparable tuple. `Layout` has no
    /// `PartialEq` (it is a plain state struct read by three consumers), and the tuple
    /// keeps a test's assertions about ONE field from being lost among the others.
    type Snap = (f64, f64, f64, bool, bool, bool);

    fn layout_now<R: Runtime>(app: &AppHandle<R>) -> Layout {
        app.try_state::<ContentInset>()
            .map(|s| *s.0.lock().unwrap_or_else(|e| e.into_inner()))
            .expect("ContentInset is managed")
    }

    fn snap<R: Runtime>(app: &AppHandle<R>) -> Snap {
        let l = layout_now(app);
        (l.left, l.top, l.right, l.fullscreen, l.overlay, l.sidebar)
    }

    fn view_call<R: Runtime>(app: &AppHandle<R>, channel: &str, payload: serde_json::Value) {
        dispatch(app, channel, &payload)
            .unwrap_or_else(|| panic!("{channel} is a view channel"))
            .unwrap_or_else(|e| panic!("{channel} failed: {e}"));
    }

    /// The re-sent `on: true` is what broke it: the renderer keys the fullscreen
    /// effect on `[tabs.activeId, fullscreen]`, so switching tabs while
    /// fullscreen re-enters the arm with the window ALREADY fullscreen and
    /// overwrites the saved windowed size with the monitor size.
    #[test]
    fn a_re_enter_while_already_fullscreen_does_not_overwrite_the_saved_size() {
        assert!(
            !should_capture_saved(true, true, true),
            "a re-sent enter must not re-capture, or Esc restores a monitor-sized window"
        );
        assert!(
            !should_capture_saved(true, false, false),
            "an enter that arrives before the WM applied fullscreen must not \
             re-capture either — the first enter already filled the slot"
        );
    }

    /// The capture must still happen on the real transition, or the mechanism
    /// silently stops existing and GTK leaves the window monitor-sized on exit.
    #[test]
    fn a_genuine_enter_still_captures_the_windowed_size() {
        assert!(
            should_capture_saved(true, false, true),
            "a first enter from a windowed state must capture"
        );
    }

    /// Exiting is not a capture at all, whatever the slot and the WM think.
    #[test]
    fn an_exit_never_captures() {
        assert!(!should_capture_saved(false, false, true));
        assert!(!should_capture_saved(false, true, true));
        assert!(!should_capture_saved(false, false, false));
    }

    fn lay(overlay: bool, sidebar: bool, fullscreen: bool) -> Layout {
        Layout {
            left: 0.0,
            top: 0.0,
            right: 0.0,
            fullscreen,
            overlay,
            sidebar,
        }
    }

    #[test]
    fn content_visible_truth_table() {
        // Nothing open → content shown.
        assert!(content_visible(&lay(false, false, false)));
        // A full overlay hides the content.
        assert!(!content_visible(&lay(true, false, false)));
        // The sidebar insets (does NOT hide) — content stays shown even though
        // overlay rides true while the sidebar is open.
        assert!(content_visible(&lay(true, true, false)));
        // Fullscreen always shows content, even if an overlay flag lingers.
        assert!(content_visible(&lay(true, false, true)));
    }

    /// The router is the whole of the contract here: an unrecognised name must be
    /// declined so `ipc()` keeps looking (and eventually reports "unknown channel"),
    /// NOT answered as a silent no-op that looks like success to the caller.
    #[test]
    fn view_dispatch_declines_every_channel_it_does_not_own() {
        with_tmp_app(|app| {
            let before = snap(app);
            for name in [
                "view",
                "view.getState",
                "view.setlayout",   // case variant
                "view.setSidebar ", // trailing space
                "view.set",
                "view.setContentInsetX",
                "nav.getState",
                "settings.get",
            ] {
                assert_eq!(
                    dispatch(app, name, &json!({})),
                    None,
                    "{name} is not a view channel and must be declined, not answered"
                );
            }
            // A declined channel must also leave the layout untouched — a `_` arm that
            // still ran an `update` would pass the loop above while quietly resetting
            // whatever the user's chrome had just reported.
            assert_eq!(snap(app), before, "a declined channel changed the layout");
        });
    }

    /// `setContentInset` is the ONLY arm that writes the two left/top edges, and it is
    /// told the chrome's measured DOM height. A payload that carries no numbers (or
    /// non-numbers) collapses both to zero, which slides the page up under the
    /// toolbar — so the renderer always reports both, and the default is pinned here
    /// because it is a real input shape, not a formality.
    #[test]
    fn a_content_inset_call_writes_the_two_edges_and_nothing_else() {
        with_tmp_app(|app| {
            // Fresh state: no insets but the built-in default top, no flags.
            assert_eq!(snap(app), (0.0, 164.0, 0.0, false, false, false));

            view_call(
                app,
                "view.setContentInset",
                json!({ "inset": { "top": 96, "left": 8 } }),
            );
            assert_eq!(
                snap(app),
                (8.0, 96.0, 0.0, false, false, false),
                "both edges are written and the right inset / flags are left alone"
            );

            // Half a report: the missing edge becomes 0, NOT \"unchanged\".
            view_call(
                app,
                "view.setContentInset",
                json!({ "inset": { "left": 4 } }),
            );
            assert_eq!(snap(app), (4.0, 0.0, 0.0, false, false, false));

            // Wrong type is the same as absent (`and_then(as_f64)`), not a silent skip.
            view_call(
                app,
                "view.setContentInset",
                json!({ "inset": { "top": "96", "left": true } }),
            );
            assert_eq!(snap(app), (0.0, 0.0, 0.0, false, false, false));
        });
    }

    /// The sidebar INSETS the content from the right (the page stays visible beside
    /// the panel) rather than hiding it, and the inset is the width the chrome
    /// actually measured. Closing it must give the whole edge back — a right inset
    /// left behind on close is a page permanently squeezed for a panel nobody sees.
    #[test]
    fn the_sidebar_insets_from_the_right_and_gives_the_edge_back_when_it_closes() {
        with_tmp_app(|app| {
            view_call(
                app,
                "view.setSidebar",
                json!({ "active": true, "width": 420 }),
            );
            assert_eq!(snap(app), (0.0, 164.0, 420.0, false, false, true));

            // The user resized the panel to 420, then closed it: the edge comes back.
            view_call(
                app,
                "view.setSidebar",
                json!({ "active": false, "width": 420 }),
            );
            assert_eq!(
                snap(app),
                (0.0, 164.0, 0.0, false, false, false),
                "closing the sidebar must give the right edge back, not keep the last width"
            );

            // A panel opened without a measured width falls back to the chrome's own
            // constant, so the content is never left UN-insetted under an open panel.
            view_call(app, "view.setSidebar", json!({ "active": true }));
            assert_eq!(snap(app).2, SIDEBAR_WIDTH);
            assert!(snap(app).5, "no `active` key is not \"close it\"");

            // `active: false` with no width must not resurrect the constant either.
            view_call(app, "view.setSidebar", json!({ "active": false }));
            assert_eq!(snap(app), (0.0, 164.0, 0.0, false, false, false));
        });
    }

    /// `setLayout` exists to make the overlay+sidebar pair ATOMIC: the chrome computes
    /// both and sends one call, so a layout pass can never run between the two and
    /// paint Settings behind the content. That property is observable: after one call
    /// the two flags always agree with each other.
    #[test]
    fn one_layout_call_sets_the_overlay_and_the_sidebar_together() {
        with_tmp_app(|app| {
            view_call(
                app,
                "view.setLayout",
                json!({ "overlay": true, "sidebar": true, "width": 200 }),
            );
            assert_eq!(snap(app), (0.0, 164.0, 200.0, false, true, true));

            // The atomic call REPLACES the pair: a payload that omits `sidebar` closes
            // it (and gives the edge back). This is the deliberate difference from
            // `setChromeOverlay`, which touches only the overlay flag.
            view_call(app, "view.setLayout", json!({ "overlay": true }));
            assert_eq!(
                snap(app),
                (0.0, 164.0, 0.0, false, true, false),
                "setLayout is a full replace, so an omitted flag is false"
            );

            // …and the two-channel route cannot close the sidebar by accident. Opening
            // Settings while the History panel is open is the case that motivated
            // `setLayout`: two separate updates, each triggering its own layout pass.
            view_call(
                app,
                "view.setLayout",
                json!({ "overlay": false, "sidebar": true, "width": 200 }),
            );
            assert_eq!(snap(app), (0.0, 164.0, 200.0, false, false, true));
            view_call(app, "view.setChromeOverlay", json!({ "active": true }));
            view_call(app, "view.setChromeOverlay", json!({ "active": false }));
            assert_eq!(
                snap(app),
                (0.0, 164.0, 200.0, false, false, true),
                "setChromeOverlay must not touch the sidebar or the right inset"
            );
        });
    }

    /// Whether the page is hidden is ONE decision, `content_visible`, and every
    /// consumer reads it. Asserting through that predicate rather than through the
    /// flags is what makes this a statement about the user-visible outcome: an overlay
    /// hides the page, fullscreen shows it again, and the sidebar never hides it.
    #[test]
    fn a_full_window_overlay_hides_the_page_and_fullscreen_shows_it_again() {
        with_tmp_app(|app| {
            assert!(
                content_visible(&layout_now(app)),
                "nothing open shows the page"
            );

            view_call(app, "view.setChromeOverlay", json!({ "active": true }));
            assert!(
                !content_visible(&layout_now(app)),
                "a full-window overlay must hide the page or the chrome renders behind it"
            );

            // The sidebar rides `overlay` true in the chrome but still leaves the page
            // visible beside the panel — the one case where overlay does not hide.
            view_call(
                app,
                "view.setLayout",
                json!({ "overlay": true, "sidebar": true, "width": 320 }),
            );
            assert!(content_visible(&layout_now(app)));

            // Fullscreen shows the content even while an overlay flag lingers.
            view_call(app, "view.setFullscreen", json!({ "on": true }));
            assert!(content_visible(&layout_now(app)));
            assert!(snap(app).3, "the fullscreen flag itself is stored");

            // A payload with no `on` key is an exit, not a no-op.
            view_call(app, "view.setFullscreen", json!({}));
            assert!(
                !snap(app).3,
                "a fullscreen call that says nothing must leave fullscreen, not keep it"
            );
        });
    }

    /// `setContentVisible` is the one arm with no layout effect — it drives the
    /// platform's webview directly, which a `MockRuntime` has none of. So the
    /// observable here is that it answers Ok AND leaves the layout byte-identical:
    /// implementing it by flipping the overlay flag instead of the webview would
    /// answer just as successfully and show the wrong thing.
    #[test]
    fn a_content_visible_call_answers_without_disturbing_the_layout() {
        with_tmp_app(|app| {
            view_call(
                app,
                "view.setLayout",
                json!({ "overlay": true, "sidebar": true, "width": 250 }),
            );
            let before = snap(app);
            for visible in [true, false] {
                view_call(app, "view.setContentVisible", json!({ "visible": visible }));
                assert_eq!(
                    snap(app),
                    before,
                    "show/hide of the webview must not be implemented by moving the layout"
                );
            }
            // A payload with no `visible` key asks for the webview to be shown
            // (visible is the protective default: `unwrap_or(true)`), which on a mock
            // is unobservable — but the call must still succeed rather than error.
            view_call(app, "view.setContentVisible", json!({}));
        });
    }
}
