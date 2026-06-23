// Linux-only workaround for tauri#10420: wry packs every webview into the
// window's vertical GtkBox (pack_start, expand+fill), so a chrome + content pair
// stacks vertically and `set_bounds` is ignored. We reach the underlying
// webkit2gtk widgets via `with_webview`, reparent them into a GtkFixed (which
// honors absolute positions), and drive their geometry ourselves.
//
// Hierarchy before:  GtkApplicationWindow → GtkBox → [chrome, content]
// Hierarchy after:   GtkApplicationWindow → GtkBox → GtkFixed → [chrome@(0,0), content@(left,top)]
use gtk::prelude::*;
use tauri::{AppHandle, Manager};
use webkit2gtk::WebViewExt;

/// Record page titles into history as WebKit makes them available. The visit is
/// recorded URL-only at page-load (nav.rs); the title arrives slightly later via
/// the WebView's "title" property, so we fill it in on the title-changed signal.
pub fn connect_title_label(app: &AppHandle, label: &str) {
    let Some(content) = app.get_webview(label) else {
        return;
    };
    let app = app.clone();
    let id = label
        .strip_prefix("content:")
        .and_then(|s| s.parse::<u32>().ok());
    let _ = content.with_webview(move |pw| {
        pw.inner().connect_title_notify(move |wv| {
            let title = wv.title().map(|s| s.to_string()).unwrap_or_default();
            // The element picker signals a picked selector via a title sentinel
            // (off the native IPC surface); route it instead of recording it.
            if let Some(payload) = title.strip_prefix(crate::picker::SENTINEL) {
                crate::picker::on_picked(&app, payload);
                return;
            }
            let url = wv.uri().map(|s| s.to_string()).unwrap_or_default();
            crate::history::update_title(&app, &url, &title, false /* wired in Task 5 */);
            if let Some(id) = id {
                crate::tabs::on_tab_title(&app, id, &title);
            }
        });
    });
}

/// Keep the address bar on the **main-frame** URL across ALL top-frame navigations,
/// including same-document History API (`pushState`/`replaceState`) and hash changes —
/// which `load-changed` (the signal behind `on_page_load`) does NOT fire for, so without
/// this the bar goes stale on SPA in-site navigation (common on streaming sites). The
/// WebView's `uri` property is the top document's URL and is main-frame only (a subframe
/// load does not change it), so `notify::uri` is the correct, flicker-free source.
/// (`on_navigation` can't be used for the bar — it fires for subframes too; see `nav.rs`.)
pub fn connect_url_tracker(app: &AppHandle, label: &str) {
    let Some(content) = app.get_webview(label) else {
        return;
    };
    let Some(id) = label
        .strip_prefix("content:")
        .and_then(|s| s.parse::<u32>().ok())
    else {
        return;
    };
    let app = app.clone();
    let _ = content.with_webview(move |pw| {
        pw.inner().connect_uri_notify(move |wv| {
            let url = wv.uri().map(|s| s.to_string()).unwrap_or_default();
            // The blank home (about:blank) is the chrome's Home tab — don't surface it.
            if url.is_empty() || url == "about:blank" {
                return;
            }
            let title = wv.title().map(|s| s.to_string()).unwrap_or_default();
            crate::nav::emit_state(&app, id, &url, &title, wv.is_loading());
        });
    });
}

/// Count ad/tracker subresources for the shield badge. The WebKit content filter blocks
/// declaratively with no per-block callback, and — contrary to an earlier assumption —
/// `resource-load-started` does NOT fire for a request the content filter blocks: the load
/// is cancelled before the signal (verified via the autopilot's A/B trace — ad subresources
/// fire the signal with ad-block OFF and vanish entirely with it ON). So this counter only
/// sees requests the *capped* content filter ALLOWED, and counts the ones the *full* engine
/// flags via `should_block` (which honors the on/off toggle + per-site allowlist) — i.e. ads
/// that slip past the ~50k-rule filter cap but the engine still catches. Well-known hosts
/// (top of EasyList) are always within the cap, so they're filter-blocked pre-signal and
/// never counted here; their blocking is real but invisible to the badge. `note_blocked`
/// pushes the totals to the chrome.
pub fn connect_block_counter(app: &AppHandle, label: &str) {
    let Some(content) = app.get_webview(label) else {
        return;
    };
    let Some(id) = label
        .strip_prefix("content:")
        .and_then(|s| s.parse::<u32>().ok())
    else {
        return;
    };
    let app = app.clone();
    let _ = content.with_webview(move |pw| {
        pw.inner()
            .connect_resource_load_started(move |wv, _res, request| {
                use webkit2gtk::URIRequestExt;
                let url = request.uri().map(|s| s.to_string()).unwrap_or_default();
                let page = wv.uri().map(|s| s.to_string()).unwrap_or_default();
                let blocked = crate::adblock_engine::should_block(&url, &page, "other");
                // Diagnostic: when AEGIS_AUTOPILOT_TRACE is set, log every subresource the
                // counter signal sees + its should_block verdict (goes to the autopilot app.log).
                if std::env::var("AEGIS_AUTOPILOT_TRACE").is_ok() {
                    eprintln!("[aegis-count] block={blocked} page={page} url={url}");
                }
                if blocked {
                    crate::adblock::note_blocked(&app, id);
                }
            });
    });
}

/// LINUX REDIRECT GUARD: own the content webview's `decide-policy` signal. wry connects its
/// own decide-policy handler (powering Tauri's `on_navigation`) and claims the signal with
/// `return true`, so a second handler never runs — we DISCONNECT it and install ours, which
/// has full `NavigationAction` (gesture/type/redirect) + `ResponsePolicyDecision` (reliable
/// main-frame via `is_main_frame_main_resource`) access. It runs the shared `decide_navigation`
/// (the ad-block/malware/HTTPS/overlay policy that used to flow through `on_navigation`) for
/// NavigationAction, and — at Response time, where the main-frame flag is reliable — cancels a
/// scripted cross-origin top-frame redirect. Each NavigationAction records the chain it belongs to
/// by uri (`redirect_guard::note_nav` — begin on a non-redirect hop, inherit the origin on a
/// redirect hop), WITHOUT consuming the app-initiated PendingNavs match (WebKit fires
/// NavigationAction repeatedly, so that one-shot match is deferred). The Response phase
/// (`decide_at_response`) looks the chain up and decides — consuming the PendingNavs match once,
/// against the chain's ORIGIN target — so a scripted cross-origin nav is cancelled however many
/// redirect hops it took (e.g. google.com → www.google.com) while user/app-initiated redirect
/// chains pass. Set AEGIS_NAV_DEBUG to trace the fields. Other policy types fall through (`false`)
/// so WebKit's default handling (downloads/display, new windows) is unchanged.
pub fn install_nav_policy(app: &AppHandle, label: &str) {
    let Some(content) = app.get_webview(label) else {
        return;
    };
    let Some(id) = label
        .strip_prefix("content:")
        .and_then(|s| s.parse::<u32>().ok())
    else {
        return;
    };
    let app = app.clone();
    let _ = content.with_webview(move |pw| {
        use glib::translate::IntoGlib;
        use glib::StaticType;
        use webkit2gtk::{
            NavigationPolicyDecisionExt, PolicyDecisionExt, ResponsePolicyDecisionExt,
            URIRequestExt, URIResponseExt,
        };
        let webview = pw.inner();
        // Disconnect wry's decide-policy handler so ours is the sole one (wry's returns `true`,
        // which would short-circuit the signal before our later-connected handler runs).
        unsafe {
            let signal_id = glib::gobject_ffi::g_signal_lookup(
                c"decide-policy".as_ptr(),
                webkit2gtk::WebView::static_type().into_glib(),
            );
            if signal_id != 0 {
                glib::gobject_ffi::g_signal_handlers_disconnect_matched(
                    webview.as_ptr() as *mut glib::gobject_ffi::GObject,
                    glib::gobject_ffi::G_SIGNAL_MATCH_ID,
                    signal_id,
                    0,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                );
            }
        }
        let debug = std::env::var_os("AEGIS_NAV_DEBUG").is_some();
        webview.connect_decide_policy(move |wv, decision, dtype| {
            match dtype {
                webkit2gtk::PolicyDecisionType::NavigationAction => {
                    if let Some(nav) =
                        decision.dynamic_cast_ref::<webkit2gtk::NavigationPolicyDecision>()
                    {
                        if let Some(mut action) = nav.navigation_action() {
                            let target = action
                                .request()
                                .and_then(|r| r.uri())
                                .map(|s| s.to_string())
                                .unwrap_or_default();
                            // Scripted = navigation type Other with no transient user activation
                            // (a real click/form/back-forward/reload carries a gesture or a
                            // non-Other type). is_redirect marks a hop continuing an in-flight nav.
                            let scripted = action.navigation_type()
                                == webkit2gtk::NavigationType::Other
                                && !action.is_user_gesture();
                            let is_redirect = action.is_redirect();
                            if debug {
                                eprintln!(
                                    "[aegis-navpol] NAV scripted={scripted} type={:?} redirect={is_redirect} target={target}",
                                    action.navigation_type(),
                                );
                            }
                            // Shared policy (ad-block/malware/HTTPS/overlay) — same logic the
                            // other platforms run via Tauri's on_navigation.
                            if let Ok(u) = tauri::Url::parse(&target) {
                                if !crate::nav::decide_navigation(&app, id, &u) {
                                    decision.ignore();
                                    return true; // cancel
                                }
                            }
                            // Resolve the chain this hop belongs to (begin a fresh chain on a
                            // non-redirect hop, or continue the in-flight one on a redirect hop),
                            // then record it for the Response phase — where the main-frame flag is
                            // reliable — so the guard can cancel a scripted cross-origin TOP-frame
                            // redirect, however many redirect hops it took, WITHOUT touching
                            // cross-origin SUBframe navs (embedded players). `current` = the page
                            // we're leaving.
                            let current = wv.uri().map(|s| s.to_string()).unwrap_or_default();
                            crate::redirect_guard::note_nav(
                                &app, id, &current, &target, scripted, is_redirect,
                            );
                        }
                    }
                    // Allow — EXPLICITLY (mirror wry: `use_()` + claim the signal). Relying on
                    // WebKit's default policy instead stalled some navigations (e.g. Cloudflare
                    // challenge sub-navigations whose type doesn't default to "use").
                    decision.use_();
                    true
                }
                webkit2gtk::PolicyDecisionType::Response => {
                    if let Some(resp) =
                        decision.dynamic_cast_ref::<webkit2gtk::ResponsePolicyDecision>()
                    {
                        // Only a DISPLAYABLE main-frame main-resource is a real top-frame page
                        // navigation. Skip subframes (embeds) and downloads (non-displayable mime)
                        // so their default WebKit handling is untouched.
                        if resp.is_main_frame_main_resource() && resp.is_mime_type_supported() {
                            let url = resp
                                .response()
                                .and_then(|r| r.uri())
                                .map(|s| s.to_string())
                                .unwrap_or_default();
                            if let Some(from) = crate::redirect_guard::decide_at_response(&app, id, &url) {
                                decision.ignore();
                                crate::redirect_guard::on_blocked(&app, id, &from, &url);
                                return true; // cancel the scripted cross-origin top-frame redirect
                            }
                            // Top-frame load resolved → drop this tab's in-flight chain + stale actions.
                            crate::redirect_guard::clear_chain(&app, id);
                            crate::redirect_guard::clear_tab_actions(&app, id);
                        }
                    }
                    false // default: display / download / subframe untouched
                }
                _ => false,
            }
        });
    });
}

/// Leave fullscreen: clear the flag, re-inset the content, and notify the chrome.
/// Shared by the Esc key handler and the native floating exit button.
fn exit_fullscreen(app: &AppHandle) {
    if let Some(s) = app.try_state::<crate::view::ContentInset>() {
        let mut g = s.0.lock().unwrap();
        if g.fullscreen {
            g.fullscreen = false;
            drop(g);
            crate::view::apply_inset(app);
            crate::emit_event(app, "view.fullscreen", serde_json::json!({ "on": false }));
        }
    }
}

/// Exit fullscreen on Esc pressed in the content webview. In fullscreen the content
/// fills the whole window; Esc (which the focused content webview receives) exits,
/// alongside the floating exit button. Only acts while fullscreen; otherwise the key
/// passes through to the page.
pub fn connect_fullscreen_exit_label(app: &AppHandle, label: &str) {
    let Some(content) = app.get_webview(label) else {
        return;
    };
    let app = app.clone();
    let _ = content.with_webview(move |pw| {
        pw.inner().connect_key_press_event(move |_w, ev| {
            if ev.keyval() == gtk::gdk::keys::constants::Escape {
                let in_fs = app
                    .try_state::<crate::view::ContentInset>()
                    .map(|s| s.0.lock().unwrap().fullscreen)
                    .unwrap_or(false);
                if in_fs {
                    exit_fullscreen(&app);
                    return glib::Propagation::Stop;
                }
            }
            glib::Propagation::Proceed
        });
    });
}

/// Capture tab keyboard shortcuts (Ctrl+T/W/Shift+T/Tab/Shift+Tab) in the content
/// webview and emit `tabs.shortcut` so the chrome can handle them. Mirrors
/// `connect_fullscreen_exit_label`; called from `nav::spawn_tab` for each tab.
pub fn connect_tab_keys_label(app: &AppHandle, label: &str) {
    let Some(content) = app.get_webview(label) else {
        return;
    };
    let app = app.clone();
    let _ = content.with_webview(move |pw| {
        pw.inner().connect_key_press_event(move |_w, ev| {
            let ctrl = ev.state().contains(gtk::gdk::ModifierType::CONTROL_MASK);
            let shift = ev.state().contains(gtk::gdk::ModifierType::SHIFT_MASK);
            if !ctrl {
                return glib::Propagation::Proceed;
            }
            use gtk::gdk::keys::constants as k;
            let s = match ev.keyval() {
                x if x == k::t && !shift => "new",
                x if x == k::w && !shift => "close",
                x if x == k::T && shift => "reopen",
                x if x == k::Tab && !shift => "next",
                x if (x == k::Tab || x == k::ISO_Left_Tab) && shift => "prev",
                x if x == k::_1 && !shift => "jump1",
                x if x == k::_2 && !shift => "jump2",
                x if x == k::_3 && !shift => "jump3",
                x if x == k::_4 && !shift => "jump4",
                x if x == k::_5 && !shift => "jump5",
                x if x == k::_6 && !shift => "jump6",
                x if x == k::_7 && !shift => "jump7",
                x if x == k::_8 && !shift => "jump8",
                x if x == k::_9 && !shift => "jumpLast",
                _ => return glib::Propagation::Proceed,
            };
            crate::emit_event(&app, "tabs.shortcut", s);
            glib::Propagation::Stop
        });
    });
}

/// Show/hide a specific content webview by label at the GTK level (Tauri's hide()
/// doesn't act on the reparented widget). Used per-tab from nav.rs's on_page_load so
/// each tab hides/shows its OWN webview.
pub fn set_content_visible_label(app: &AppHandle, label: &str, visible: bool) {
    let Some(w) = app.get_webview(label) else {
        return;
    };
    let _ = w.with_webview(move |pw| {
        pw.inner().set_visible(visible);
    });
}

/// Show/hide the active content webview at the GTK level. Used by
/// view.setChromeOverlay to reveal chrome overlays.
pub fn set_content_visible(app: &AppHandle, visible: bool) {
    let label = crate::nav::active_content_label(app);
    set_content_visible_label(app, &label, visible);
}

/// WebRTC native backstop for a content webview via WebKitGTK settings.
/// `set_enable_webrtc` is all-or-nothing, so this only ENFORCES "disable" — it turns
/// WebRTC off engine-wide (incl. Web Worker scopes the injected shim can't reach).
/// "public-only"/"default" leave WebRTC enabled and rely on the injected shim.
pub fn apply_webrtc_policy_label(app: &AppHandle, label: &str, policy: &str) {
    let Some(w) = app.get_webview(label) else {
        return;
    };
    let disable = policy == "disable";
    let _ = w.with_webview(move |pw| {
        use webkit2gtk::SettingsExt;
        // UFCS: `gtk::prelude::WidgetExt` also has a `settings()`, so name the WebView one.
        if let Some(s) = WebViewExt::settings(&pw.inner()) {
            s.set_enable_webrtc(!disable);
        }
    });
}

/// Set a content webview's WebKitGTK page-zoom level (1.0 == 100%). Per-tab.
pub fn set_zoom_level_label(app: &AppHandle, label: &str, factor: f64) {
    let Some(w) = app.get_webview(label) else {
        return;
    };
    let _ = w.with_webview(move |pw| {
        pw.inner().set_zoom_level(factor);
    });
}

/// Stamp a content webview's GTK widget with CONTENT_WIDGET_NAME so layout() can
/// classify it. Called once per tab from nav::spawn_tab.
pub fn mark_content_label(app: &AppHandle, label: &str) {
    if let Some(w) = app.get_webview(label) {
        let _ = w.with_webview(|pw| {
            pw.inner().set_widget_name(CONTENT_WIDGET_NAME);
        });
    }
}

/// Widget name of the native floating fullscreen-exit button, so we can find it
/// among the GtkFixed's children on later layout calls.
const FS_EXIT_NAME: &str = "aegis-fs-exit";
/// GTK widget name stamped on every content (tab) webview so `layout()` can tell
/// content webviews apart from the chrome webview without per-frame `with_webview`.
const CONTENT_WIDGET_NAME: &str = "aegis-content";
/// Floating exit button box size (px).
const FS_EXIT_SIZE: i32 = 34;
/// Its margin from the top-right corner (px).
const FS_EXIT_MARGIN: i32 = 8;

/// The effective content insets (left, top, right) from the most recent `layout()` pass.
/// `size_fixed_children` reads them to re-size the chrome + content webviews when GTK
/// re-allocates the canonical GtkFixed (e.g. on a window resize) — see the SIZING NOTE on
/// `layout()`. Managed Tauri state (registered in `lib.rs`).
#[derive(Default)]
pub struct LayoutInsets(pub std::sync::Mutex<(i32, i32, i32)>);

/// Connect the canonical GtkFixed's "size-allocate" handler exactly once.
static FIXED_SIZE_HANDLER: std::sync::Once = std::sync::Once::new();

/// Size the chrome (fill) + content (inset) webviews to the GtkFixed's CURRENT allocation
/// via `size_allocate`, so no `set_size_request` pins the window's minimum size. Positions
/// come from each child's existing allocation (set by `layout()`'s `move_`), so a parked
/// background tab stays offscreen and the active tab stays inset. Connected with `after=true`
/// so it runs AFTER GtkFixed's own size-allocate (which sizes children to their 0×0 request);
/// it does NOT call `move_`/`queue_resize`, so it can't loop. The fullscreen-exit button keeps
/// its own small request and is positioned by `layout()`.
fn size_fixed_children(app: &AppHandle, fixed: &gtk::Fixed) {
    let (left, top, right) = app
        .try_state::<LayoutInsets>()
        .map(|s| *s.0.lock().unwrap())
        .unwrap_or((0, 0, 0));
    let a = fixed.allocation();
    let (fw, fh) = (a.width(), a.height());
    for child in fixed.children() {
        let name = child.widget_name();
        if name == FS_EXIT_NAME {
            continue;
        }
        let ca = child.allocation();
        let (w, h) = if name == CONTENT_WIDGET_NAME {
            ((fw - left - right).max(0), (fh - top).max(0)) // content: inset (full in fullscreen)
        } else {
            (fw.max(0), fh.max(0)) // chrome: fill the window behind the content
        };
        child.size_allocate(&gtk::gdk::Rectangle::new(ca.x(), ca.y(), w, h));
    }
}

/// Find (or create once) the native GTK floating fullscreen-exit button in the
/// GtkFixed. It's a real GTK widget — not the WebKit chrome — so it paints reliably
/// over the opaque, edge-to-edge content (a shrunk WebKit chrome wouldn't repaint on
/// the NVIDIA/X11 path) and needs no transparency/compositing (the GPU path that
/// crashes the NVIDIA WebKit web process). Styled via the CSS provider in lib.rs.
fn fs_exit_button(fixed: &gtk::Fixed, app: &AppHandle) -> gtk::Widget {
    if let Some(w) = fixed
        .children()
        .into_iter()
        .find(|c| c.widget_name() == FS_EXIT_NAME)
    {
        return w;
    }
    let ebox = gtk::EventBox::new();
    ebox.set_visible_window(true);
    ebox.set_widget_name(FS_EXIT_NAME);
    ebox.set_size_request(FS_EXIT_SIZE, FS_EXIT_SIZE);
    let label = gtk::Label::new(Some("\u{2198}\u{2196}")); // ↘↖ exit-fullscreen (arrows pointing inward)
    ebox.add(&label);
    let app = app.clone();
    ebox.connect_button_press_event(move |_, _| {
        exit_fullscreen(&app);
        glib::Propagation::Stop
    });
    fixed.put(&ebox, 0, 0);
    label.show();
    ebox.upcast()
}

/// Reparent (once, idempotent) into a GtkFixed and lay out the chrome (full window,
/// behind) and the N content webviews. Called for the initial layout and on every
/// window resize; all coordinates in logical px (scale handled by the caller).
///
/// Drives off the ACTIVE tab's webview to find the GtkFixed parent (reparenting from
/// the GtkBox on the first call). The active content webview is positioned in the
/// inset area and shown; every OTHER content webview is hidden and parked offscreen;
/// the chrome webview is stretched full-window behind it.
///
/// Normal: chrome fills the window behind the active content, which is inset so the
/// toolbar shows in the gap above it. Fullscreen: the active content fills the whole
/// window edge-to-edge and a native floating exit button (`fs_exit_button`) is raised
/// on top in the top-right corner — no top strip, and no WebKit compositing for it.
///
/// SIZING NOTE: the chrome + content webviews are sized via `size_allocate` (in
/// `size_fixed_children`, run from the Fixed's "size-allocate" handler), NOT via
/// `set_size_request`. In a GtkFixed, `set_size_request(w, h)` sets each child's MINIMUM
/// size, which GTK propagates up as the WINDOW's minimum — pinning the window to its current
/// size so it can only ever grow, never shrink (the "can't make the window smaller" bug).
/// Keeping a (0,0) size request removes that pin; the real size is applied by `size_allocate`.
#[allow(clippy::too_many_arguments)] // mirrors the GtkFixed geometry call shape; a struct wrap would add churn without clarity
pub fn layout(
    app: &AppHandle,
    left: i32,
    top: i32,
    right: i32,
    win_w: i32,
    // Window height: the webviews are now sized from the GtkFixed's live allocation (see
    // size_fixed_children), so layout() no longer uses it directly; kept for caller symmetry.
    _win_h: i32,
    fullscreen: bool,
    content_visible: bool,
) {
    // Publish the effective insets so the Fixed's size-allocate handler can re-size the
    // webviews on a window resize (they carry a 0×0 size request so they don't pin the
    // window minimum — see the SIZING NOTE above).
    if let Some(s) = app.try_state::<LayoutInsets>() {
        *s.0.lock().unwrap() = (left, top, right);
    }
    let active_label = crate::nav::active_content_label(app);
    let Some(active) = app.get_webview(&active_label) else {
        return;
    };
    // The active content is shown only when no full-window chrome overlay is up AND the
    // tab isn't sitting at about:blank (where the chrome's home shows through). Read the
    // active tab's URL from the registry here (lock released before the GTK closure).
    let active_at_home = app
        .try_state::<crate::tabs::Tabs>()
        .map(|s| {
            let r = s.reg.lock().unwrap();
            let id = r.active_id();
            r.url_of(id)
                .map(|u| u.starts_with("about:"))
                .unwrap_or(true)
        })
        .unwrap_or(true);
    let active_visible = content_visible && !active_at_home;
    let app2 = app.clone();
    let _ = active.with_webview(move |pw| {
        let active_w = pw.inner();
        let active_widget: gtk::Widget = active_w.clone().upcast();
        let Some(parent) = active_w.parent() else {
            return;
        };

        // Resolve THE single canonical GtkFixed that must hold the chrome + every content
        // webview. The active webview's parent is either the window's GtkBox (this webview is
        // a stray just add_child'd) or the canonical GtkFixed (already reparented). Find the
        // GtkBox, find-or-create the one Fixed beneath it, then pull any stray webviews from
        // the Box into it. This prevents the nested-Fixed bug where new tabs land in a sibling
        // Fixed and never get hidden.
        let box_: gtk::Box;
        let fixed: gtk::Fixed;
        if let Some(f) = parent.dynamic_cast_ref::<gtk::Fixed>() {
            let Some(b) = f.parent().and_then(|p| p.downcast::<gtk::Box>().ok()) else { return; };
            box_ = b;
            fixed = f.clone();
        } else if let Some(b) = parent.dynamic_cast_ref::<gtk::Box>() {
            let existing = b.children().into_iter().find_map(|c| c.downcast::<gtk::Fixed>().ok());
            fixed = match existing {
                Some(f) => f,
                None => {
                    let f = gtk::Fixed::new();
                    b.pack_start(&f, true, true, 0);
                    f.show();
                    f
                }
            };
            box_ = b.clone();
        } else {
            eprintln!("[aegis-gtk] layout: unexpected parent {}", parent.type_().name());
            return;
        }
        // Pull every stray webview still parented to the Box (the chrome on the first call;
        // each newly add_child'd tab on later calls) INTO the canonical Fixed. Skip the Fixed
        // itself. Use show() per widget — NOT show_all(), which would re-reveal the hidden
        // fullscreen-exit button.
        let mut moved = 0;
        for child in box_.children() {
            if child.dynamic_cast_ref::<gtk::Fixed>().is_some() {
                continue; // the canonical Fixed
            }
            box_.remove(&child);
            fixed.put(&child, 0, 0);
            child.show();
            moved += 1;
        }
        if moved > 0 {
            eprintln!(
                "[aegis-gtk] reparented {moved} stray webview(s) into the canonical fixed; it now has {} children",
                fixed.children().len()
            );
        }

        // Re-size the webviews whenever GTK re-allocates the Fixed (window resize) — they
        // carry a 0×0 size request (so they never pin the window minimum) and are sized by
        // `size_allocate` here instead. Connected once, AFTER GtkFixed's own size-allocate.
        FIXED_SIZE_HANDLER.call_once(|| {
            let app_h = app2.clone();
            let fixed_h = fixed.clone();
            fixed.connect_local("size-allocate", true, move |_| {
                size_fixed_children(&app_h, &fixed_h);
                None
            });
        });

        // The active content fills the window in fullscreen (left/top/right all 0), else it's
        // inset and the chrome shows in the gap. Sizes are applied by `size_fixed_children`
        // (above); here we only set the 0×0 request (no window-min pin) + position via `move_`.
        // The floating exit button is positioned/raised separately below.
        let mut active_window = None;
        let mut chrome_window = None;
        for child in fixed.children() {
            let is_active = child.as_ptr() == active_widget.as_ptr();
            let name = child.widget_name();
            if is_active {
                // NEVER hide the active content with set_visible(false): on this stack that
                // (a) backgrounds the page — rAF stalls, which malvertising uses to redirect —
                // and (b) doesn't even reliably hide it (the WebKit native window stays stacked
                // on top, leaving a full overlay rendered BEHIND it — confirmed via layout
                // logging: flags were correct, content stayed on top anyway). Instead keep it
                // visible and, when a full overlay should cover the screen, park it OFFSCREEN —
                // the same mechanism that reliably hides background tabs below. Visible +
                // offscreen = not backgrounded (no redirect) and not covering the chrome.
                child.set_visible(true);
                child.set_size_request(0, 0); // no window-min pin; sized by size_fixed_children
                if active_visible {
                    fixed.move_(&child, left, top);
                } else {
                    fixed.move_(&child, -10000, -10000);
                }
                active_window = child.window();
            } else if name == FS_EXIT_NAME {
                // handled below
            } else if name == CONTENT_WIDGET_NAME {
                // a background tab's webview: hide it and park it offscreen.
                child.set_visible(false);
                fixed.move_(&child, -10000, -10000);
            } else {
                // the chrome webview: fill the window behind the active content.
                child.set_size_request(0, 0); // no window-min pin; sized by size_fixed_children
                fixed.move_(&child, 0, 0);
                chrome_window = child.window();
            }
        }
        // Z-order: when the active content is shown, raise it on top; when it's hidden (a full
        // overlay is up, or the tab is at home), raise the CHROME instead. Crucially we must
        // NOT raise the content while it's hidden — raise() re-stacks the WebKit native window
        // on top even after set_visible(false), which re-covered the chrome and left Settings
        // rendered behind the (supposedly hidden) page. raise() acts on the realized GdkWindow
        // (reliable on X11).
        if active_visible {
            if let Some(w) = active_window {
                w.raise();
            }
        } else if let Some(w) = chrome_window {
            w.raise();
        }

        // Native floating exit button: shown ABOVE the content in fullscreen only,
        // pinned to the top-right corner. Raised after the content so it stays on top.
        let btn = fs_exit_button(&fixed, &app2);
        if fullscreen {
            // Content webviews added after the button sit above it in the Fixed's child
            // stacking, and GdkWindow.raise() alone doesn't reliably lift a GTK widget above
            // WebKit's native windows. Re-add the button LAST so it's the topmost child.
            fixed.remove(&btn);
            fixed.put(&btn, (win_w - FS_EXIT_SIZE - FS_EXIT_MARGIN).max(0), FS_EXIT_MARGIN);
            btn.show_all();
            if btn.window().is_none() {
                btn.realize();
            }
            if let Some(w) = btn.window() {
                w.raise();
            }
        } else {
            btn.hide();
        }
        // No show_all here: re-showing every layout call would override the hidden
        // background tabs and the content webview's hide (view.setChromeOverlay).
    });
}
