//! The **popover surface**: one extra webview that renders popovers *over* the page
//! instead of displacing it.
//!
//! # Why a second webview at all
//!
//! Every popover in the chrome today is a DOM element in the chrome webview. The chrome
//! fills the window *behind* the content webview, so a popover can only appear by pushing
//! the content webview down (`view.setContentInset`) — which moves the page under the
//! user's eyes and re-measures the omnibox, which changes the inset again. Measured, that
//! loop ran at ~57 Hz for as long as the omnibox dropdown was open (see `aegis_layout.rs`).
//!
//! Giving popovers their own webview removes the feedback path outright: the surface is a
//! sibling of the chrome and the content inside the container, positioned by an explicit
//! rectangle, and it never moves the page by a pixel.
//!
//! # The boundary (and why it is enforced HERE, not only in the capability file)
//!
//! The surface renders **attacker-influenceable text**: an omnibox suggestion's title is a
//! page title, and page titles are chosen by whatever site the user visited. The surface is
//! therefore treated as untrusted even though it loads only our own bundle.
//!
//! Two independent controls, because either alone is insufficient:
//!
//! 1. **The capability file** (`capabilities/surface.json`) grants the surface exactly three
//!    things — `listen`, `unlisten`, and the one dedicated [`popover_picked`] command —
//!    and deliberately NOT `ipc`. Withholding `ipc` is real only because the app has an ACL
//!    manifest: see `build.rs`. Without one, Tauri lets any *local-origin* webview call
//!    custom commands with no ACL check at all (tauri 2.11.3, `webview/mod.rs`: a custom
//!    command is ACL-checked only `if plugin_command.is_some() || has_app_acl_manifest ||
//!    !is_local`), so `ipc` would have been reachable and "withholding invoke" would have
//!    been a comment rather than a control.
//! 2. **This module re-validates every pick** against what the *chrome* said it was
//!    showing, before re-emitting it. The surface's own idea of what it rendered is never
//!    trusted: an `index` is bounds-checked against the chrome's `itemCount`, an `action`
//!    against the chrome's per-popover allowlist, and a pick for an id that is not currently
//!    open is dropped. A poisoned suggestion title can therefore at most cause the chrome
//!    to be asked to pick an index it already had — the same property the chrome's own
//!    checks give, enforced in a place the surface cannot influence.
//!
//! # Payload delivery is targeted, never broadcast
//!
//! The payload contains browsing-history titles, so it is sent with `emit_to` against the
//! surface's label only. The crate's existing `emit_event` uses `app.emit`, which reaches
//! *every* webview including untrusted content ones; using it here would hand the user's
//! history to every page in every tab.

use serde_json::Value;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// The surface webview's label. Also the capability's target, so changing it without
/// changing `capabilities/surface.json` silently strips the surface of every permission —
/// which is the safe direction to fail in, and there is a test for exactly that.
pub const LABEL: &str = "surface:popover";

/// Logical (dotted) name of the chrome→surface event. Tauri 2 forbids `.` in event names,
/// so it goes on the wire as `popover:payload`, exactly as `emit_event` translates every
/// other shared name. The surface's `listen()` applies the same translation.
pub const EVENT_PAYLOAD: &str = "popover.payload";

/// Logical (dotted) name of the surface→chrome event. Emitted by Rust only, after
/// [`validate_pick`] accepts it.
pub const EVENT_PICKED: &str = "popover.picked";

/// The chrome webview's label, which is the only target [`EVENT_PICKED`] is aimed at.
///
/// MEASURED, not assumed: the Phase-2 gate's `popover.set` succeeded from the chrome, and
/// `popover.set` is ACL-checked against `capabilities/default.json`'s `webviews: ["main"]` —
/// an invoke from a webview outside that list is refused. So the chrome's webview label is
/// "main" on every platform that has one.
///
/// Why this is `emit_to` and not `emit`: a webview's `listen` registers
/// `EventTarget::Webview{label}` (`tauri-2.11.3/src/webview/mod.rs:2233`) and
/// `filter_target` (`tauri-2.11.3/src/manager/mod.rs:604`) matches an `AnyLabel` target
/// against the candidate's **own** label. Content webviews have their own labels, so a
/// targeted emit skips every one of them — where `app.emit` wakes all of them. The pick is
/// low-sensitivity (`{id, index, action}`, never a payload), so this is defence in depth
/// rather than the fix for a leak, and it makes both directions of the contract symmetric.
pub const CHROME_LABEL: &str = "main";

/// The popup's rectangle in window coordinates, in CSS pixels.
///
/// The chrome webview fills the window at (0,0), so chrome-webview client coordinates ARE
/// window coordinates on Linux and no scale conversion is needed. Windows and macOS
/// convert to physical pixels at the point of `set_bounds`.
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// The largest surface we will place. A popover is a dropdown or a small panel; anything
/// bigger is a bug or a hostile measurement, and clamping is cheaper than a 20000px
/// webview. Well above any real panel (the widest popover today is the omnibox dropdown,
/// which tracks the address input's width).
const MAX_DIMENSION: f64 = 4096.0;

/// What the chrome told us it is showing.
///
/// This is BOTH the validated `popover.set` and the **only** authority for validating a pick,
/// which is why there is no second, narrower "open popover" type beside it: two structs
/// describing one piece of state is two structs that can disagree, and that disagreement would
/// be a pick validated against something the user is not looking at. It arrives over `ipc`
/// from the chrome webview, which has full privileges, so it cannot be less trustworthy than
/// the surface.
#[derive(Clone, Debug, PartialEq)]
pub struct Placed {
    pub id: String,
    pub rect: Rect,
    pub payload: Value,
    /// How many items the chrome is rendering. A pick's `index` must be below it.
    pub items: usize,
    /// The action names this popover accepts. A pick's `action` must be one of them.
    pub actions: Vec<String>,
}

/// A validated `popover.set` that means **close**.
///
/// Absent/null `payload` is the close signal, so the chrome never has to invent a
/// "hide" channel and a popover cannot get stuck open by forgetting one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Closed;

impl From<Closed> for Option<Placed> {
    fn from(_: Closed) -> Option<Placed> {
        None
    }
}

/// Read one `popover.set` payload. `Ok(None)` means **close**.
///
/// The close signal is checked BEFORE anything else, so a closing set needs nothing but an
/// absent or null payload — the chrome can close a popover whose rect it can no longer
/// measure (the element is already unmounted) and cannot get stuck open.
pub fn parse_set(payload: &Value) -> Result<Option<Placed>, String> {
    let Some(obj) = payload.as_object() else {
        return Err("popover.set: expected an object".into());
    };
    let Some(raw) = obj.get("payload") else {
        return Ok(None);
    };
    if raw.is_null() {
        return Ok(None);
    }

    let id = obj
        .get("id")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .ok_or("popover.set: `id` must be a non-empty string")?
        .to_string();

    // The rect is a NESTED object, matching `shared/types.ts::PopoverSetArgs.rect`
    // (`PopoverRect`). It was flat here first, and the two tests agreed with each other and
    // disagreed with the integration: the Rust unit test built a flat literal and the TS
    // contract test asserted a nested one, so both were green while the live app rejected
    // every popover with "`width` must be a number". `shared/ipcCatalog.drift.test.ts` now
    // pins these key paths across the language boundary so it cannot recur.
    let rect = obj
        .get("rect")
        .and_then(Value::as_object)
        .ok_or("popover.set: `rect` must be an object with x, y, width and height")?;
    let num = |key: &str| -> Result<f64, String> {
        let v = rect
            .get(key)
            .and_then(Value::as_f64)
            .ok_or_else(|| format!("popover.set: `rect.{key}` must be a number"))?;
        if !v.is_finite() {
            return Err(format!("popover.set: `rect.{key}` must be finite"));
        }
        Ok(v)
    };
    let (width, height) = (num("width")?, num("height")?);
    // A zero-sized surface is invisible, so its rows could never be clicked; a negative one
    // asks the platform layer for a size no toolkit can honour.
    if width <= 0.0 {
        return Err("popover.set: `rect.width` must be positive".into());
    }
    if height <= 0.0 {
        return Err("popover.set: `rect.height` must be positive".into());
    }

    // `as_u64` rather than `as_i64` + cast: a negative count would become usize::MAX and
    // make every index "in range".
    let items = obj
        .get("itemCount")
        .and_then(Value::as_u64)
        .ok_or("popover.set: `itemCount` must be a non-negative integer")? as usize;

    let actions = match obj.get("actions") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|v| {
                v.as_str().map(str::to_string).ok_or_else(|| {
                    "popover.set: every `actions` entry must be a string".to_string()
                })
            })
            .collect::<Result<Vec<_>, _>>()?,
        Some(_) => return Err("popover.set: `actions` must be an array".into()),
    };

    Ok(Some(Placed {
        id,
        rect: Rect {
            x: num("x")?,
            y: num("y")?,
            // Clamped rather than rejected: an over-wide measurement is cosmetic, and a
            // rejected popover is invisible.
            width: width.min(MAX_DIMENSION),
            height: height.min(MAX_DIMENSION),
        },
        payload: raw.clone(),
        items,
        actions,
    }))
}

/// Whether a pick the surface reported may be acted on.
///
/// `open` is what the **chrome** said it was showing, which is the only trustworthy
/// statement of what is on screen. Every check here is therefore about refusing to let the
/// surface widen that statement: a different id, an index past the end of the list the
/// chrome rendered, or an action outside the allowlist the chrome declared.
pub fn validate_pick(
    open: Option<&Placed>,
    id: &str,
    index: Option<i64>,
    action: Option<&str>,
) -> bool {
    let Some(o) = open else { return false };
    if o.id != id {
        return false;
    }
    if let Some(i) = index {
        if i < 0 || i as u64 >= o.items as u64 {
            return false;
        }
    }
    if let Some(a) = action {
        if !o.actions.iter().any(|allowed| allowed == a) {
            return false;
        }
    }
    true
}

/// The popover currently shown. At most one: the chrome only ever has one popover open and
/// the surface only has one rect, so a second `popover.set` replaces the first.
#[derive(Default)]
pub struct Registry {
    current: Mutex<Option<Placed>>,
}

impl Registry {
    pub fn show(&self, placed: Placed) {
        *self.current.lock().unwrap_or_else(|e| e.into_inner()) = Some(placed);
    }

    pub fn hide(&self) {
        *self.current.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }

    /// A snapshot, taken under the lock so the caller never holds it across a GTK or Tauri
    /// call. The pick path compares against this and then releases it, and
    /// [`popover_ready`] replays it when the surface says it can receive.
    pub fn open(&self) -> Option<Placed> {
        self.current
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
}

pub fn dispatch<R: Runtime>(
    app: &AppHandle<R>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    let res = match channel {
        "popover.set" => set(app, payload),
        _ => return None,
    };
    Some(res)
}

fn set<R: Runtime>(app: &AppHandle<R>, payload: &Value) -> Result<Value, String> {
    let Some(registry) = app.try_state::<Registry>() else {
        return Err("popover.set: the popover registry is not managed".into());
    };
    match parse_set(payload)? {
        None => {
            registry.hide();
            place(app, None);
            Ok(Value::Null)
        }
        Some(placed) => {
            let rect = placed.rect;
            // The frame is built from the value WE were handed, not from a second read of the
            // registry: one lock, one source, and no window in which a concurrent `set` could
            // change what is stored between the two.
            let frame = surface_frame(&placed);
            registry.show(placed);
            // Targeted, never broadcast: the payload carries browsing-history titles, and
            // `emit` would hand them to every content webview in every tab.
            emit_to_surface(app, EVENT_PAYLOAD, frame);
            place(app, Some(rect));
            Ok(Value::Null)
        }
    }
}

/// The surface's whole reporting channel: one command, no `ipc`, no `emit`.
///
/// The caller's label is re-checked here as well as in the capability, because a permission
/// is a single string in one JSON file and this is the check that cannot drift from the
/// behaviour it protects.
#[tauri::command]
pub fn popover_picked<R: Runtime>(
    app: AppHandle<R>,
    webview: tauri::Webview<R>,
    id: String,
    index: Option<i64>,
    action: Option<String>,
) -> Result<(), String> {
    if webview.label() != LABEL {
        return Err(format!(
            "popover_picked is only callable by {LABEL}; {:?} refused",
            webview.label()
        ));
    }
    let Some(registry) = app.try_state::<Registry>() else {
        return Err("popover_picked: the popover registry is not managed".into());
    };
    let open = registry.open();
    if !validate_pick(open.as_ref(), &id, index, action.as_deref()) {
        // Dropped, not reported: the chrome learns nothing about a rejected pick, so a
        // surface probing for a valid index learns nothing either.
        return Ok(());
    }
    let mut out = serde_json::Map::new();
    out.insert("id".into(), Value::String(id));
    if let Some(i) = index {
        out.insert("index".into(), Value::from(i));
    }
    if let Some(a) = action {
        out.insert("action".into(), Value::String(a));
    }
    emit_to_chrome(&app, EVENT_PICKED, Value::Object(out));
    Ok(())
}

/// Create the surface webview, once, at boot.
///
/// Created here rather than on first use because a webview's first paint is the expensive
/// part: spawning it lazily would put a visible stall on the first omnibox keystroke, which
/// is the exact interaction this whole design exists to make smooth. It costs one webview at
/// launch instead.
///
/// Parked and zero-sized initially, so it cannot paint over the chrome before any popover is
/// open. The first `popover.set` is what gives it a rect.
///
/// A no-op on mobile: Android's content area is a native Kotlin `WebView` in a native layout,
/// not a Tauri child webview, so `add_child` has nothing to attach to. The mobile popovers keep
/// their current in-chrome behaviour — see the popover-surface spec §10.
#[cfg(not(desktop))]
pub fn create_surface<R: Runtime>(_app: &AppHandle<R>) -> tauri::Result<()> {
    Ok(())
}

#[cfg(desktop)]
pub fn create_surface<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let Some(window) = app.get_window("main") else {
        log::warn!("[aegis] popover surface: no main window at boot");
        return Ok(());
    };
    let builder =
        tauri::webview::WebviewBuilder::new(LABEL, tauri::WebviewUrl::App("popover.html".into()))
            // The chrome's honest user agent, NOT `content_ua()`. This webview renders our own
            // bundle from the app's own origin, so it is not a "content engine" impersonating
            // anything — see `nav::content_ua_for` for why that distinction exists at all.
            .user_agent(crate::nav::content_ua());

    // Windows (fractional DPI): PHYSICAL bounds, for the same reason `nav.rs` uses them —
    // with logical bounds at e.g. 125% the WebView2 controller's hit region does not match
    // its render region, and the surface would swallow clicks meant for the chrome. The
    // initial rect is 0x0, so there is no scale to apply here; `place_webview` does the
    // conversion once a real rect arrives.
    #[cfg(target_os = "windows")]
    window.add_child(
        builder,
        tauri::PhysicalPosition::new(0.0, 0.0),
        tauri::PhysicalSize::new(0.0, 0.0),
    )?;
    #[cfg(not(target_os = "windows"))]
    window.add_child(
        builder,
        tauri::LogicalPosition::new(0.0, 0.0),
        tauri::LogicalSize::new(0.0, 0.0),
    )?;

    // Linux: stamp the widget so `linux_layout::layout()` can recognise the surface and
    // leave its geometry alone instead of mistaking it for the chrome.
    #[cfg(target_os = "linux")]
    if let Some(surface) = app.get_webview(LABEL) {
        let _ = surface.with_webview(move |pw| {
            use gtk::glib::Cast;
            use gtk::prelude::WidgetExt;
            let widget: gtk::Widget = pw.inner().clone().upcast();
            widget.set_widget_name(crate::linux_layout::POPOVER_WIDGET_NAME);
        });
    }
    Ok(())
}

fn wire(name: &str) -> String {
    name.replace('.', ":")
}

/// What the surface renders: which popover, where, and with what.
///
/// One frame, re-sent whole every time — there is no incremental patching, so a dropped
/// frame cannot leave stale rows behind.
fn surface_frame(placed: &Placed) -> Value {
    serde_json::json!({
        "id": placed.id,
        "rect": placed.rect,
        "payload": placed.payload,
    })
}

/// The surface telling Rust it is live, and Rust answering with everything.
///
/// **This handshake is load-bearing, and it is not only a boot race.** `emit_to` is
/// fire-and-forget: it reaches whichever listeners exist at that instant and nobody
/// afterwards. The surface registers its listener from a React effect, so any `popover.set`
/// arriving before that effect runs — the common case at launch, because the surface webview
/// boots with the app while the chrome sends its first popover within a second of it — is
/// delivered to nobody, permanently. The same happens after a WebKit web-process crash and
/// reload, which would otherwise leave the surface blank for the rest of the session.
///
/// MEASURED 2026-10-04 on the built AppImage: with the emit alone, `popover.set` placed the
/// surface at exactly the right rect with `topmost=true visible=true` — and the surface never
/// received the payload at all. A correctly positioned, completely empty popover.
///
/// So the surface calls this from the effect that registered its listener, and Rust re-sends
/// the current frame and re-places the webview. Re-placing is redundant on a plain mount and
/// necessary after a reload, and it costs one geometry pass.
#[tauri::command]
pub fn popover_ready<R: Runtime>(
    app: AppHandle<R>,
    webview: tauri::Webview<R>,
) -> Result<(), String> {
    // The same caller-label check as `popover_picked`: a permission is one string in one JSON
    // file, and this is the check that cannot drift from the behaviour it protects.
    if webview.label() != LABEL {
        return Err(format!(
            "popover_ready is only callable by {LABEL}; {:?} refused",
            webview.label()
        ));
    }
    let Some(registry) = app.try_state::<Registry>() else {
        return Err("popover_ready: the popover registry is not managed".into());
    };
    // Nothing open is the correct answer, not an error: the surface simply has nothing to
    // render, and renders nothing until a `popover.set` arrives.
    let Some(placed) = registry.open() else {
        return Ok(());
    };
    let rect = placed.rect;
    emit_to_surface(&app, EVENT_PAYLOAD, surface_frame(&placed));
    place(&app, Some(rect));
    Ok(())
}

/// `emit_to`, not `emit`. There is no other `emit_to` in the crate, which is precisely why
/// this is worth a source pin: a one-word change here hands the user's history to every
/// page in every tab, and no behavioural test in this file can see it.
fn emit_to_surface<R: Runtime>(app: &AppHandle<R>, name: &str, payload: Value) {
    let _ = app.emit_to(LABEL, &wire(name), payload);
}

/// [`EVENT_PICKED`] to the chrome only. See [`CHROME_LABEL`] for why this is targeted.
fn emit_to_chrome<R: Runtime>(app: &AppHandle<R>, name: &str, payload: Value) {
    let _ = app.emit_to(CHROME_LABEL, &wire(name), payload);
}

/// Move, size, show or hide the surface webview for the current platform.
///
/// `None` means closed: parked offscreen and hidden, exactly like a background tab. Keeping
/// it visible-but-offscreen rather than `set_visible(false)` is deliberate and inherited from
/// the container work — see `aegis_layout::PARK_X` for why (hiding backgrounds the page).
fn place<R: Runtime>(app: &AppHandle<R>, rect: Option<Rect>) {
    let Some(surface) = app.get_webview(LABEL) else {
        return;
    };
    place_webview(&surface, rect);
}

#[cfg(target_os = "linux")]
fn place_webview<R: Runtime>(surface: &tauri::Webview<R>, rect: Option<Rect>) {
    // The container works in whole logical pixels (GTK allocations are integers), so the
    // rect is rounded here rather than inside `aegis_layout` — that module stays free of
    // floats and testable as plain integer geometry.
    let rect = rect.map(|r| {
        crate::aegis_layout::Rect::new(
            r.x.round() as i32,
            r.y.round() as i32,
            r.width.round() as i32,
            r.height.round() as i32,
        )
    });
    let _ = surface.with_webview(move |pw| {
        use gtk::glib::Cast;
        let widget: gtk::Widget = pw.inner().clone().upcast();
        // The container sizes every child from its ROLE, and re-resolves it against its own
        // live allocation on every pass — so the surface is registered with the same entry
        // point as the chrome and the tabs, and never with `move_`/`set_size_request`.
        //
        // `put` owns ORDERING (registration order is z-order on X11) and `set_role` owns
        // GEOMETRY. That is why the surface is re-registered last on every layout pass.
        crate::aegis_container::register_surface(&widget, rect);
    });
}

/// Mobile: there is no surface webview, so this never runs — `place` returns early because
/// `get_webview(LABEL)` is `None`. Present so the module compiles and so the reason is written
/// down next to the code that would otherwise need an `unreachable!()`.
#[cfg(not(desktop))]
fn place_webview<R: Runtime>(_surface: &tauri::Webview<R>, _rect: Option<Rect>) {}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn place_webview<R: Runtime>(surface: &tauri::Webview<R>, rect: Option<Rect>) {
    // Windows and macOS have no container to hand a role to: their content webviews are
    // positioned with set_position/set_size, so the surface joins that same set. Closed is
    // (0,0) size 0 plus hide, which is the convention `view.setContentVisible` already uses.
    let (x, y, w, h) = match rect {
        Some(r) => (r.x, r.y, r.width, r.height),
        None => (0.0, 0.0, 0.0, 0.0),
    };
    // Windows needs PHYSICAL bounds, and the conversion happens HERE — exactly as
    // `create_surface`'s comment above promises. Gotcha 17 in `src-tauri/AGENTS.md` records the
    // measured failure: with logical child bounds at fractional DPI, WebView2's HIT region ends
    // up far above the host window, so the child webview swallows clicks meant for the chrome
    // (the favourites bar in the recorded case). `nav::spawn_tab` is the reference
    // implementation. `Rect` is in CSS pixels, so multiplying by the scale is the right
    // direction.
    //
    // The lookup is Windows-only, not just inside a `windows` arm: this function is compiled for
    // macOS too, and a `let scale` macOS never reads is a `-D warnings` failure there.
    #[cfg(target_os = "windows")]
    let scale = surface.window().scale_factor().unwrap_or(1.0);
    #[cfg(target_os = "windows")]
    let _ = surface.set_size(tauri::PhysicalSize::new(
        (w * scale).round(),
        (h * scale).round(),
    ));
    #[cfg(target_os = "windows")]
    let _ = surface.set_position(tauri::PhysicalPosition::new(
        (x * scale).round(),
        (y * scale).round(),
    ));
    #[cfg(target_os = "macos")]
    let _ = surface.set_size(tauri::LogicalSize::new(w, h));
    #[cfg(target_os = "macos")]
    let _ = surface.set_position(tauri::LogicalPosition::new(x, y));
    // `Webview` has `show`/`hide`, not `set_visible` — and `hide` rather than
    // `set_visible(false)` is what `view.setContentVisible` already uses on these platforms.
    if rect.is_some() {
        let _ = surface.show();
    } else {
        let _ = surface.hide();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const ID: &str = "address-omnibox";

    /// A minimal open popover. Only the fields `validate_pick` reads are set, which is the
    /// point of collapsing `Open` into `Placed`: a pick is validated against exactly what the
    /// chrome said, so a test cannot accidentally validate against something else.
    fn open(items: usize, actions: &[&str]) -> Placed {
        Placed {
            id: ID.into(),
            rect: Rect {
                x: 0.0,
                y: 0.0,
                width: 1.0,
                height: 1.0,
            },
            payload: Value::Null,
            items,
            actions: actions.iter().map(|s| (*s).to_string()).collect(),
        }
    }

    /// The EXACT wire shape `shared/types.ts::PopoverSetArgs` declares — nested `rect`, not a
    /// flat x/y/width/height. It is written as a literal rather than assembled so that
    /// `shared/ipcCatalog.drift.test.ts` can pin the same key paths on both sides of the
    /// language boundary.
    fn set_ok() -> Value {
        json!({
            "id": ID,
            "rect": { "x": 120, "y": 44, "width": 640, "height": 312 },
            "payload": { "kind": "omnibox", "items": [{ "title": "a" }, { "title": "b" }] },
            "itemCount": 2,
            "actions": ["pick"],
        })
    }

    fn set_rect_field(key: &str, value: Value) -> Value {
        let mut v = set_ok();
        v["rect"][key] = value;
        v
    }

    // ── parse_set ────────────────────────────────────────────────────────────

    #[test]
    fn a_null_payload_closes_the_surface() {
        assert_eq!(
            parse_set(&json!({ "id": ID, "payload": Value::Null })),
            Ok(None)
        );
    }

    #[test]
    fn an_absent_payload_closes_the_surface_too() {
        assert_eq!(parse_set(&json!({ "id": ID })), Ok(None));
    }

    #[test]
    fn a_populated_set_becomes_a_placement_carrying_the_payload_verbatim() {
        let got = parse_set(&set_ok()).expect("valid set");
        let placed = got.expect("shown");
        assert_eq!(placed.id, ID);
        assert_eq!(
            placed.rect,
            Rect {
                x: 120.0,
                y: 44.0,
                width: 640.0,
                height: 312.0
            }
        );
        // The payload crosses to the surface unchanged: the surface renders it, and Rust
        // must not reshape or re-key it.
        assert_eq!(
            placed.payload,
            json!({ "kind": "omnibox", "items": [{ "title": "a" }, { "title": "b" }] })
        );
        assert_eq!(placed.items, 2);
        assert_eq!(placed.actions, vec!["pick".to_string()]);
    }

    #[test]
    fn a_set_without_an_id_is_rejected() {
        let mut v = set_ok();
        v.as_object_mut().unwrap().remove("id");
        assert!(
            parse_set(&v).is_err(),
            "an id is what identifies the popover"
        );
    }

    #[test]
    fn a_set_with_an_empty_id_is_rejected() {
        let mut v = set_ok();
        v["id"] = json!("");
        assert!(parse_set(&v).is_err());
    }

    /// A zero-sized surface would be invisible, so a popover could never be clicked; a
    /// negative one is a measurement bug that would ask the platform layer for nonsense.
    #[test]
    fn a_zero_or_negative_width_is_rejected() {
        for w in [0.0, -1.0] {
            assert!(
                parse_set(&set_rect_field("width", json!(w))).is_err(),
                "width {w} must be rejected"
            );
        }
    }

    #[test]
    fn a_zero_or_negative_height_is_rejected() {
        for h in [0.0, -1.0] {
            assert!(
                parse_set(&set_rect_field("height", json!(h))).is_err(),
                "height {h} must be rejected"
            );
        }
    }

    /// The rect arrives from a `getBoundingClientRect()` round-trip through JSON. JSON
    /// cannot express NaN or Infinity (`json!(f64::NAN)` becomes `null`), so the reachable
    /// failure is a wrong-typed field, not a non-finite number — but the `is_finite` guard
    /// is kept anyway so a future non-JSON caller cannot smuggle one through to
    /// `set_bounds`.
    #[test]
    fn a_non_numeric_rect_coordinate_is_rejected() {
        for bad in [json!("640"), json!(null), json!([640])] {
            assert!(
                parse_set(&set_rect_field("width", bad.clone())).is_err(),
                "width {bad} must be rejected"
            );
        }
    }

    #[test]
    fn a_rect_larger_than_the_surface_ceiling_is_clamped_not_rejected() {
        // Clamping, not rejecting: a window wider than the ceiling still gets a usable
        // popover, and the failure mode (a too-narrow dropdown) is cosmetic.
        let placed = parse_set(&set_rect_field("width", json!(100_000.0)))
            .expect("valid set")
            .expect("shown");
        assert_eq!(placed.rect.width, MAX_DIMENSION);
    }

    #[test]
    fn a_negative_item_count_is_rejected_rather_than_wrapping() {
        let mut v = set_ok();
        v["itemCount"] = json!(-1);
        assert!(parse_set(&v).is_err(), "-1 must not become usize::MAX");
    }

    #[test]
    fn a_non_string_action_entry_is_rejected() {
        let mut v = set_ok();
        v["actions"] = json!([7]);
        assert!(parse_set(&v).is_err());
    }

    // ── validate_pick ────────────────────────────────────────────────────────

    #[test]
    fn a_pick_for_the_open_popover_whose_index_is_in_range_is_accepted() {
        assert!(validate_pick(Some(&open(3, &["pick"])), ID, Some(2), None));
    }

    #[test]
    fn a_pick_for_a_popover_that_is_not_open_is_dropped() {
        assert!(!validate_pick(None, ID, Some(0), None));
        assert!(!validate_pick(
            Some(&open(3, &[])),
            "adblock-shield",
            Some(0),
            None
        ));
    }

    /// The whole point of recording `items`: the surface renders rows, and a surface that
    /// reports row 9 of a 3-row list must not be able to make the chrome pick index 9.
    #[test]
    fn an_out_of_range_index_is_dropped() {
        let o = open(3, &["pick"]);
        assert!(!validate_pick(Some(&o), ID, Some(3), None));
        assert!(!validate_pick(Some(&o), ID, Some(99), None));
        assert!(!validate_pick(Some(&o), ID, Some(-1), None));
    }

    #[test]
    fn an_action_outside_the_allowlist_is_dropped() {
        let o = open(3, &["pick", "dismiss"]);
        assert!(validate_pick(Some(&o), ID, None, Some("dismiss")));
        assert!(!validate_pick(Some(&o), ID, None, Some("nav.navigate")));
        assert!(!validate_pick(Some(&o), ID, None, Some("PICK")));
        // No allowlist at all means no action is acceptable.
        assert!(!validate_pick(Some(&open(3, &[])), ID, None, Some("pick")));
    }

    #[test]
    fn a_pick_with_neither_index_nor_action_is_accepted_for_an_open_popover() {
        // The contract's `{ id, index?, action?, value? }` makes both optional: a plain
        // "this popover activated" carries neither.
        assert!(validate_pick(Some(&open(3, &[])), ID, None, None));
    }

    // ── the whole path on a MockRuntime: popover.set → popover_picked → popover.picked ───

    /// The behavioural half of the §7.1 contract. `validate_pick` proves the rule in
    /// isolation; these prove the rule is actually ON THE PATH — that `popover.set` records
    /// what the chrome showed, and that `popover_picked` re-emits nothing at all for a
    /// pick that fails it.
    ///
    /// The channel is driven through [`crate::ipc`] and the event is read through a real
    /// `app.listen`, because the two things worth catching here are (a) a pick arriving with
    /// no `popover.set` behind it and (b) a rejected pick that still emits.
    mod path {
        use super::*;
        use std::sync::mpsc;
        use tauri::Listener;

        /// Listen for the wire name, decode nothing, and hand back raw payloads.
        fn listen(app: &AppHandle<tauri::test::MockRuntime>, name: &str) -> mpsc::Receiver<Value> {
            let (tx, rx): (mpsc::Sender<Value>, mpsc::Receiver<Value>) = mpsc::channel();
            app.listen(wire(name), move |ev| {
                // `Event::payload()` is the raw JSON TEXT, so decoding is the test's job —
                // which is also what proves the wire name is the one we asked to listen for.
                let parsed: Value =
                    serde_json::from_str(ev.payload()).expect("an emitted event is valid JSON");
                let _ = tx.send(parsed);
            });
            rx
        }

        fn picked(app: &AppHandle<tauri::test::MockRuntime>) -> mpsc::Receiver<Value> {
            listen(app, EVENT_PICKED)
        }

        /// A `popover.picked` listener attached to the CHROME webview, which is where the
        /// event is actually aimed.
        ///
        /// `app.listen` — [`picked`] above — registers the GLOBAL target, and `filter_target`
        /// never matches it for a targeted emit, so it observes nothing at all once the emit is
        /// `emit_to`. That is not a test artefact: in the app the chrome listens from its
        /// webview, exactly like this. So every assertion about a pick reaching the chrome uses
        /// THIS, and [`picked`] is left only where a global listener is the thing being tested.
        fn picked_at_chrome(app: &AppHandle<tauri::test::MockRuntime>) -> mpsc::Receiver<Value> {
            let chrome = webview(app, CHROME_LABEL);
            let (tx, rx): (mpsc::Sender<Value>, mpsc::Receiver<Value>) = mpsc::channel();
            chrome.listen(wire(EVENT_PICKED), move |ev| {
                let parsed: Value =
                    serde_json::from_str(ev.payload()).expect("an emitted event is valid JSON");
                let _ = tx.send(parsed);
            });
            rx
        }

        /// `popover::dispatch`, not `crate::ipc` — `ipc` is concrete over the Wry runtime
        /// (`AppHandle` with no generic), so it cannot be driven on `MockRuntime`. `dispatch`
        /// is exactly what `ipc` delegates to, and the last test here pins that it only claims
        /// `popover.set`.
        fn set(app: &AppHandle<tauri::test::MockRuntime>, payload: Value) -> Result<Value, String> {
            dispatch(app, "popover.set", &payload).expect("popover.set must be claimed")
        }

        /// A mock webview with `label`, so the command's own caller-label check is exercised
        /// rather than assumed.
        fn webview(
            app: &AppHandle<tauri::test::MockRuntime>,
            label: &str,
        ) -> tauri::Webview<tauri::test::MockRuntime> {
            tauri::WebviewWindowBuilder::new(app, label, tauri::WebviewUrl::default())
                .build()
                .expect("mock webview builds");
            app.get_webview(label)
                .expect("the mock webview is registered under its label")
        }

        fn report(
            app: &AppHandle<tauri::test::MockRuntime>,
            surface: &tauri::Webview<tauri::test::MockRuntime>,
            id: &str,
            index: Option<i64>,
            action: Option<&str>,
        ) -> Result<(), String> {
            popover_picked(
                app.clone(),
                surface.clone(),
                id.to_string(),
                index,
                action.map(str::to_string),
            )
        }

        fn next(rx: &mpsc::Receiver<Value>) -> Option<Value> {
            rx.try_recv().ok()
        }

        /// WHY the pick assertions listen on a WEBVIEW, stated as a test rather than as prose.
        ///
        /// `app.listen` — the global target — cannot observe a targeted emit at all, because
        /// `filter_target` only ever matches a candidate's own label. So `picked` (above)
        /// receiving nothing here is not a gap in the test helper; it is the same property the
        /// surface's payload leg depends on, and the reason every assertion about a pick
        /// reaching the chrome goes through `picked_at_chrome` instead.
        ///
        /// It also discriminates: reverting the emit to `app.emit` turns this red (a broadcast
        /// reaches the global target) as well as
        /// `a_pick_reaches_the_chrome_and_no_other_webview`.
        #[test]
        fn a_global_listener_observes_no_targeted_pick() {
            crate::test_support::with_tmp_app(|app| {
                let surface = webview(app, LABEL);
                let global = picked(app);
                set(app, set_ok()).expect("valid set");
                report(app, &surface, ID, Some(0), None).expect("accepted");
                assert_eq!(
                    next(&global),
                    None,
                    "a global listener saw a targeted emit; the emit is a broadcast"
                );
            });
        }

        /// THE defect: `popover.picked` was `app.emit`, so every webview in the window was
        /// woken by it. A pick carries no payload, so this is defence in depth rather than a
        /// leak — but it was the one leg of the surface contract still going the wrong way,
        /// and the payload leg had already been tightened to `emit_to`.
        ///
        /// Modelled the way the app actually runs: both listeners are attached to WEBVIEWS, so
        /// the difference between `emit` and `emit_to` is observable. Swapping `emit_to_chrome`
        /// back for `emit_event` makes exactly this test red.
        #[test]
        fn a_pick_reaches_the_chrome_and_no_content_webview() {
            crate::test_support::with_tmp_app(|app| {
                let surface = webview(app, LABEL);
                let content = webview(app, "content-1");
                let crx = picked_at_chrome(app);
                let (ctx, ctx_rx): (mpsc::Sender<Value>, mpsc::Receiver<Value>) = mpsc::channel();
                content.listen(wire(EVENT_PICKED), move |ev| {
                    let parsed: Value =
                        serde_json::from_str(ev.payload()).expect("an emitted event is valid JSON");
                    let _ = ctx.send(parsed);
                });
                set(app, set_ok()).expect("valid set");
                report(app, &surface, ID, Some(1), None).expect("accepted");

                let got = crx.try_recv().expect("the chrome must receive the pick");
                assert_eq!(got, json!({ "id": ID, "index": 1 }));
                assert_eq!(
                    ctx_rx.try_recv().ok(),
                    None,
                    "a content webview received popover.picked; the emit is a broadcast"
                );
            });
        }

        /// THE comment/code divergence this review found, pinned.
        ///
        /// `create_surface`'s comment promised that `place_webview` "does the conversion once a
        /// real rect arrives", and `place_webview` used LOGICAL bounds on Windows — so the
        /// promise was false and the fractional-DPI hit-region bug of gotcha 17 (a child webview
        /// swallowing clicks meant for the chrome) applied to the surface. The comment read as
        /// documentation of an implementation that did not exist, which is worse than no comment:
        /// it is what a reader checks instead of the code.
        #[test]
        fn the_surface_is_placed_in_physical_bounds_on_windows() {
            let prod = crate::test_support::rust_production_source(include_str!("popover.rs"));
            let body = prod
                .split(
                    "#[cfg(any(target_os = \"windows\", target_os = \"macos\"))]\nfn place_webview",
                )
                .nth(1)
                .and_then(|rest| rest.split("\n}").next())
                .expect(
                    "place_webview's Windows/macOS arm is reachable after its cfg attribute. \
                     Three `place_webview` arms exist (linux / windows+macos / non-desktop) and \
                     the other two must NOT satisfy this pin — anchoring on the cfg attribute is \
                     what makes the pin about the arm that matters.",
                );
            // PHYSICAL on Windows, and only there — macOS keeps logical bounds, so the two
            // arms are asserted separately rather than as "one of them uses Physical*".
            assert!(
                body.contains("tauri::PhysicalSize::new"),
                "place_webview must size the surface in PHYSICAL bounds on Windows: {body}"
            );
            assert!(
                body.contains("tauri::PhysicalPosition::new"),
                "place_webview must position the surface in PHYSICAL bounds on Windows: {body}"
            );
            // …and the conversion must actually multiply by the scale. A `PhysicalSize::new(w, h)`
            // with no scale is the SAME bug wearing a different hat.
            assert!(
                body.contains("scale_factor()"),
                "place_webview must read the scale factor or the physical bounds are wrong: {body}"
            );
            assert!(
                body.contains("(w * scale)"),
                "the surface's width must be scaled: {body}"
            );
            assert!(
                body.contains("(y * scale)"),
                "the surface's y must be scaled: {body}"
            );
            assert!(
                body.contains("#[cfg(target_os = \"macos\")]"),
                "the logical arm must stay macOS-only or the macOS build warns under -D warnings: \
                 {body}"
            );
        }

        #[test]
        fn a_valid_pick_is_re_emitted_to_the_chrome() {
            crate::test_support::with_tmp_app(|app| {
                let surface = webview(app, LABEL);
                let rx = picked_at_chrome(app);
                set(app, set_ok()).expect("valid set");
                report(app, &surface, ID, Some(1), None).expect("accepted");
                let got = next(&rx).expect("popover.picked must fire");
                assert_eq!(got, json!({ "id": ID, "index": 1 }));
            });
        }

        #[test]
        fn an_out_of_range_index_never_reaches_the_chrome() {
            crate::test_support::with_tmp_app(|app| {
                let surface = webview(app, LABEL);
                let rx = picked_at_chrome(app);
                set(app, set_ok()).expect("valid set");
                report(app, &surface, ID, Some(7), None).expect("dropped, not refused");
                assert_eq!(next(&rx), None, "index 7 of a 2-item list must be dropped");
                // …and a good one still works, so the assertion above is not just "the event
                // never fires for any reason".
                report(app, &surface, ID, Some(1), None).expect("accepted");
                assert!(next(&rx).is_some());
            });
        }

        #[test]
        fn an_action_outside_the_allowlist_never_reaches_the_chrome() {
            crate::test_support::with_tmp_app(|app| {
                let surface = webview(app, LABEL);
                let rx = picked_at_chrome(app);
                set(app, set_ok()).expect("valid set");
                report(app, &surface, ID, None, Some("nav.navigate")).expect("dropped");
                assert_eq!(next(&rx), None);
            });
        }

        #[test]
        fn a_pick_for_a_popover_that_was_never_shown_never_reaches_the_chrome() {
            crate::test_support::with_tmp_app(|app| {
                let surface = webview(app, LABEL);
                let rx = picked_at_chrome(app);
                // No `popover.set` at all.
                report(app, &surface, ID, Some(0), None).expect("dropped");
                assert_eq!(next(&rx), None);
                // A set for a DIFFERENT id must not admit a pick for this one.
                let mut other = set_ok();
                other["id"] = json!("adblock-shield");
                set(app, other).expect("valid set");
                report(app, &surface, ID, Some(0), None).expect("dropped");
                assert_eq!(next(&rx), None);
            });
        }

        #[test]
        fn closing_the_popover_also_closes_the_window_on_a_pick() {
            crate::test_support::with_tmp_app(|app| {
                let surface = webview(app, LABEL);
                let rx = picked_at_chrome(app);
                set(app, set_ok()).expect("valid set");
                set(app, json!({ "id": ID, "payload": Value::Null })).expect("valid close");
                report(app, &surface, ID, Some(0), None).expect("dropped");
                assert_eq!(
                    next(&rx),
                    None,
                    "a pick for a popover the chrome has already closed must be dropped"
                );
            });
        }

        #[test]
        fn a_second_popover_replaces_the_first_rather_than_adding_to_it() {
            crate::test_support::with_tmp_app(|app| {
                let surface = webview(app, LABEL);
                let rx = picked_at_chrome(app);
                set(app, set_ok()).expect("valid set");
                let mut second = set_ok();
                second["id"] = json!("zoom-indicator");
                second["itemCount"] = json!(1);
                set(app, second).expect("valid set");
                // The FIRST id is no longer open: the surface has one rect, so a pick naming
                // the previous popover is stale by definition.
                report(app, &surface, ID, Some(0), None).expect("dropped");
                assert_eq!(next(&rx), None);
                report(app, &surface, "zoom-indicator", Some(0), None).expect("accepted");
                assert!(next(&rx).is_some());
            });
        }

        #[test]
        fn a_rejected_set_leaves_the_previous_popover_open() {
            // A malformed `popover.set` is a chrome bug; it must not silently tear down a
            // popover the user is looking at. It returns an Err and changes nothing.
            crate::test_support::with_tmp_app(|app| {
                let surface = webview(app, LABEL);
                let rx = picked_at_chrome(app);
                set(app, set_ok()).expect("valid set");
                assert!(set(
                    app,
                    json!({ "id": ID, "payload": 1, "rect": { "width": -5 } })
                )
                .is_err());
                report(app, &surface, ID, Some(0), None).expect("accepted");
                assert!(
                    next(&rx).is_some(),
                    "the rejected set must not have unregistered the open popover"
                );
            });
        }

        #[test]
        fn the_payload_reaches_the_surface_and_no_other_webview() {
            // The behavioural half of "targeted, never broadcast". A listener on a CONTENT
            // webview must hear nothing: the payload carries browsing-history titles, so a
            // broadcast would hand the user's history to every page in every tab.
            //
            // This is a real discriminator, not a restatement of the source pin. The
            // listeners here are attached to WEBVIEWS (`Webview::listen`), so Tauri records
            // their target; `app.emit` broadcasts unfiltered and would wake both, while
            // `emit_to(LABEL, …)` wakes only the surface's. Swapping one for the other makes
            // THIS test red.
            //
            // Rust-side listeners cannot otherwise observe a targeted emit — `app.listen`
            // registers the global target, which `filter_target` never matches — which is
            // why the source pin exists as well: in the app the failure would be invisible.
            crate::test_support::with_tmp_app(|app| {
                let surface = webview(app, LABEL);
                let content = webview(app, "content-1");
                let (stx, srx): (mpsc::Sender<Value>, mpsc::Receiver<Value>) = mpsc::channel();
                let (ctx, crx): (mpsc::Sender<Value>, mpsc::Receiver<Value>) = mpsc::channel();
                surface.listen(wire(EVENT_PAYLOAD), move |ev| {
                    let _ = stx.send(serde_json::from_str(ev.payload()).expect("valid JSON"));
                });
                content.listen(wire(EVENT_PAYLOAD), move |ev| {
                    let _ = ctx.send(serde_json::from_str(ev.payload()).expect("valid JSON"));
                });

                set(app, set_ok()).expect("valid set");

                let got = srx
                    .try_recv()
                    .expect("the surface must receive its payload");
                assert_eq!(got["id"], json!(ID));
                assert_eq!(
                    got["rect"],
                    json!({ "x": 120.0, "y": 44.0, "width": 640.0, "height": 312.0 })
                );
                assert_eq!(got["payload"]["kind"], json!("omnibox"));
                assert_eq!(
                    crx.try_recv().ok(),
                    None,
                    "a content webview received the payload; the emit is a broadcast"
                );
            });
        }

        /// The command re-checks the caller's label rather than trusting the capability, so
        /// even a mis-scoped permission cannot let another webview report a pick.
        #[test]
        fn a_pick_reported_by_another_webview_is_refused() {
            crate::test_support::with_tmp_app(|app| {
                let impostor = webview(app, "content-1");
                let rx = picked_at_chrome(app);
                set(app, set_ok()).expect("valid set");
                let err = report(app, &impostor, ID, Some(0), None)
                    .expect_err("a content webview must not be able to report a pick");
                assert!(
                    err.contains(LABEL),
                    "the refusal must name who may call it, got: {err}"
                );
                assert_eq!(next(&rx), None);
            });
        }

        /// THE defect this handshake exists for, and the one no unit test could have found.
        ///
        /// `emit_to` is fire-and-forget. A payload emitted before the surface's listener
        /// exists is delivered to nobody, permanently — which is the normal case at launch.
        /// MEASURED on the built AppImage with the emit and no handshake: `popover.set`
        /// placed the surface at exactly the right rect with `topmost=true visible=true`, and
        /// the surface never received the payload at all.
        ///
        /// So this test drives the sequence the app actually runs — `popover.set` first,
        /// `popover_ready` after — with NO listener registered at the time of the `set`, and
        /// asserts the surface's listener still ends up holding the payload.
        #[test]
        fn a_payload_emitted_before_the_surface_was_ready_is_still_delivered() {
            crate::test_support::with_tmp_app(|app| {
                let surface = webview(app, LABEL);
                // Nothing is listening yet — exactly the boot ordering.
                set(app, set_ok()).expect("valid set");
                let (tx, rx): (mpsc::Sender<Value>, mpsc::Receiver<Value>) = mpsc::channel();
                surface.listen(wire(EVENT_PAYLOAD), move |ev| {
                    let _ = tx.send(serde_json::from_str(ev.payload()).expect("valid JSON"));
                });
                // …and now the surface says it is live.
                popover_ready(app.clone(), surface.clone()).expect("the surface may ask");

                let got = rx
                    .try_recv()
                    .expect("the surface must receive the payload it missed while it was booting");
                assert_eq!(got["id"], json!(ID));
                assert_eq!(
                    got["payload"]["kind"],
                    json!("omnibox"),
                    "the replayed frame must be the whole payload, not a placeholder"
                );
            });
        }

        /// After a WebKit reload the surface is blank for the rest of the session otherwise.
        /// Same command, and it must replay even though nothing has changed.
        #[test]
        fn ready_replays_the_current_frame_so_a_reloaded_surface_recovers() {
            crate::test_support::with_tmp_app(|app| {
                let surface = webview(app, LABEL);
                set(app, set_ok()).expect("valid set");
                popover_ready(app.clone(), surface.clone()).expect("first mount");
                popover_ready(app.clone(), surface.clone()).expect("after a reload");
                popover_ready(app.clone(), surface).expect("and again");
            });
        }

        /// Nothing open is the correct answer, not an error: the surface renders nothing until
        /// a `popover.set` arrives, and it must not be told to expect otherwise.
        #[test]
        fn ready_with_nothing_open_is_a_no_op() {
            crate::test_support::with_tmp_app(|app| {
                let surface = webview(app, LABEL);
                popover_ready(app.clone(), surface).expect("an empty surface is not an error");
            });
        }

        #[test]
        fn ready_reported_by_another_webview_is_refused() {
            crate::test_support::with_tmp_app(|app| {
                let impostor = webview(app, "content-1");
                let err = popover_ready(app.clone(), impostor)
                    .expect_err("a content webview must not be able to drive the surface");
                assert!(
                    err.contains(LABEL),
                    "the refusal must name the caller: {err}"
                );
            });
        }

        #[test]
        fn an_unknown_channel_is_not_claimed_by_this_module() {
            crate::test_support::with_tmp_app(|app| {
                assert!(
                    dispatch(app, "nav.navigate", &Value::Null).is_none(),
                    "popover.rs must not swallow channels it does not own"
                );
            });
        }
    }

    // ── the wire shape ───────────────────────────────────────────────────────

    #[test]
    fn the_event_names_go_on_the_wire_with_colons_because_tauri_forbids_dots() {
        assert_eq!(EVENT_PAYLOAD, "popover.payload");
        assert_eq!(wire(EVENT_PAYLOAD), "popover:payload");
        assert_eq!(wire(EVENT_PICKED), "popover:picked");
    }

    // ── source pins: the two properties that are otherwise invisible ─────────

    /// The payload carries browsing-history titles. `emit` broadcasts to every webview,
    /// including untrusted content ones, so a single `app.emit` here would hand the user's
    /// history to every page in every tab. This is the one line that cannot be caught by a
    /// behavioural test, because the damage is in what is NOT reached.
    #[test]
    fn the_payload_is_emitted_to_the_surface_and_never_broadcast() {
        let src = crate::test_support::rust_production_source(include_str!("popover.rs"));
        let emit_surface = src
            .split("fn emit_to_surface")
            .nth(1)
            .expect("emit_to_surface must exist");
        let body = &emit_surface[..emit_surface.find("\n}").expect("fn must close")];
        assert!(
            body.contains("emit_to(LABEL"),
            "emit_to_surface must address the surface label: {body}"
        );
        assert!(
            !body.contains(".emit(") || body.contains("emit_to(LABEL"),
            "emit_to_surface must not broadcast with app.emit: {body}"
        );
    }

    /// **THE DEFECT THIS FILE EXISTS NOW EXISTS TWICE OVER.** `capabilities/surface.json`
    /// originally read `windows: ["surface:popover"]`, and Tauri resolves a capability's
    /// `windows` list against the WINDOW label and its `webviews` list against the WEBVIEW
    /// label (`ipc/authority.rs::resolve_access`). The surface is a CHILD webview of `main`
    /// (`window.add_child`), so its window label is `main` and that list matched NOTHING:
    /// every grant in the file was inert.
    ///
    /// Measured consequence on the built AppImage: the surface's document loaded
    /// (`on_page_load Started/Finished`) and `popover.set` placed it at the right rect with
    /// `topmost=true visible=true` — and the surface could not listen, could not report a pick
    /// and could not handshake. Nothing errored anywhere.
    #[test]
    fn both_capabilities_are_scoped_by_webview_label_not_window_label() {
        for (name, src) in [
            ("default.json", include_str!("../capabilities/default.json")),
            ("surface.json", include_str!("../capabilities/surface.json")),
        ] {
            let cap: Value = serde_json::from_str(src).unwrap_or_else(|e| panic!("{name}: {e}"));
            // A `windows` entry here is not merely redundant: it matches the WINDOW, which
            // every content webview shares with the chrome, so it would hand each tab the
            // whole grant list.
            assert!(
                cap.get("windows").is_none(),
                "capabilities/{name} still scopes by `windows`. Every content webview is a \
                 CHILD webview of the `main` window, so `windows: [\"main\"]` matches their \
                 window label too and grants every tab the chrome's privileges. Scope by \
                 `webviews`, which is matched against the webview's own label."
            );
            assert!(
                cap.get("webviews").is_some(),
                "capabilities/{name} must scope by `webviews`: a capability that names neither \
                 axis matches nothing, and every permission in it is silently inert."
            );
        }
    }

    /// The corollary of the above, stated as a property rather than left to the reader: the
    /// chrome and the surface are two DIFFERENT webviews of one window, so their grants are
    /// disjoint by construction and a label can never match both.
    #[test]
    fn the_chrome_and_the_surface_are_disjoint_webview_scopes() {
        // `include_str!` needs a literal, so the two files are inlined rather than joined at
        // run time — which is also why this cannot accidentally read a file that does not
        // exist: the build fails instead.
        let scoped = |raw: &str| -> Vec<String> {
            let v: Value = serde_json::from_str(raw).expect("valid JSON");
            v["webviews"]
                .as_array()
                .expect("webviews array")
                .iter()
                .map(|x| x.as_str().expect("string").to_string())
                .collect()
        };
        let chrome = scoped(include_str!("../capabilities/default.json"));
        let surface = scoped(include_str!("../capabilities/surface.json"));
        assert_eq!(chrome, vec!["main".to_string()]);
        assert_eq!(surface, vec![LABEL.to_string()]);
        assert!(
            !chrome.iter().any(|l| surface.contains(l)),
            "a webview label in both capability files would give the surface the chrome's \
             `ipc`, which is the one grant it must not have"
        );
    }

    #[test]
    fn the_surface_label_matches_the_capability_file() {
        let cap: Value =
            serde_json::from_str(include_str!("../capabilities/surface.json")).expect("json");
        assert_eq!(
            cap["webviews"],
            serde_json::json!([LABEL]),
            "capabilities/surface.json must name {LABEL} in `webviews`; a mismatch strips \
             the surface of every permission it has, silently"
        );
    }

    // ── the security boundary, in the three files that decide it ─────────────

    /// **The control that makes "withholding `ipc`" mean anything at all.** Tauri only
    /// ACL-checks a custom (non-plugin) command when the app HAS an ACL manifest
    /// (`webview/mod.rs`: `plugin_command.is_some() || has_app_acl_manifest || !is_local`).
    /// With no manifest, `has_app_acl_manifest` is false and the surface — a *local*-origin
    /// webview, like the chrome — reaches `ipc` with no check at all, so `settings.set` and
    /// `nav.navigate` would be one `invoke` away. That this pin matters is not a claim: the
    /// `allow-popover-picked` entry in `capabilities/surface.json` is *unresolvable* without
    /// the manifest, so dropping the build.rs declaration turns this from a silent hole into
    /// a build failure. The pin is here to say which line is load-bearing.
    #[test]
    fn the_app_has_an_acl_manifest_covering_both_custom_commands() {
        let build_rs = include_str!("../build.rs");
        assert!(
            build_rs.contains("AppManifest") && build_rs.contains("ipc"),
            "build.rs must build an AppManifest listing the `ipc` command. Without it the \
             surface can invoke `ipc` unchecked and the capability boundary is decorative."
        );
        assert!(
            build_rs.contains("popover_picked"),
            "build.rs must list `popover_picked` so `allow-popover-picked` exists and the \
             surface's one command is gated by the same ACL as everything else."
        );
    }

    #[test]
    fn the_surface_is_granted_neither_ipc_nor_the_ability_to_emit() {
        // The PERMISSIONS ARRAY, parsed. Asserting on the raw file text would match this
        // capability's own `description`, which names the permissions it withholds — so the
        // assertion would be green while the file granted everything.
        let cap: Value =
            serde_json::from_str(include_str!("../capabilities/surface.json")).expect("valid JSON");
        let granted: Vec<String> = cap["permissions"]
            .as_array()
            .expect("permissions must be an array")
            .iter()
            .map(|v| {
                v.as_str()
                    .expect("permission entries are strings")
                    .to_string()
            })
            .collect();

        assert!(
            !granted.iter().any(|p| p == "ipc" || p == "allow-ipc"),
            "the surface is granted an ipc permission ({granted:?}). That is the one grant \
             that would let it reach every app command."
        );
        assert!(
            !granted.iter().any(|p| p.contains("emit")),
            "the surface is granted an emit permission ({granted:?}), so it could forge any \
             event name another listener acts on. Picks go through popover_picked."
        );
        assert!(
            !granted.iter().any(|p| p == "core:event:default"),
            "core:event:default is the blanket grant (listen+unlisten+emit+emit_to). The \
             surface must name only the commands it needs."
        );
        assert!(
            !granted.iter().any(|p| p == "core:default"),
            "core:default is every core permission including webview and window control. The \
             surface needs three entries, not a bundle."
        );
        // And it must actually name them, or the surface renders nothing and reports nothing.
        assert!(granted.contains(&"core:event:allow-listen".to_string()));
        assert!(granted.contains(&"allow-popover-picked".to_string()));
        // `allow-popover-ready` is the handshake the surface performs once its listener is
        // registered. It was a FOURTH grant added after the live AppImage showed the first
        // payload of every session being emitted before any listener existed and lost — the
        // surface was placed at the right rect and stayed empty.
        assert!(granted.contains(&"allow-popover-ready".to_string()));
        assert_eq!(
            granted.len(),
            4,
            "the surface's grant list is meant to be exactly these four: {granted:?}. A fifth \
             grant is either a capability the surface does not need or one that lets it do \
             something it must not."
        );
    }

    /// `default.json`'s `windows` list is what keeps every content webview out of IPC. The
    /// surface is added by a SEPARATE file precisely so this one stays a one-element list —
    /// a content webview's label appearing here would hand it the chrome's full privileges.
    #[test]
    fn the_chrome_capability_still_lists_only_the_main_window() {
        let cap: Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).expect("valid JSON");
        let scoped: Vec<String> = cap["webviews"]
            .as_array()
            .expect("webviews must be an array")
            .iter()
            .map(|v| v.as_str().expect("labels are strings").to_string())
            .collect();
        assert_eq!(
            scoped,
            vec!["main".to_string()],
            "capabilities/default.json must scope its permissions to the chrome webview alone. \
             A content webview's label here would hand every tab the chrome's full privileges."
        );
        let granted: Vec<String> = cap["permissions"]
            .as_array()
            .expect("permissions must be an array")
            .iter()
            .map(|v| {
                v.as_str()
                    .expect("permission entries are strings")
                    .to_string()
            })
            .collect();
        assert!(
            granted.contains(&"allow-ipc".to_string()),
            "capabilities/default.json must grant the chrome `allow-ipc`. With the app ACL \
             manifest enabled, withholding it breaks the app entirely rather than quietly \
             tightening it."
        );
        assert!(
            !granted.contains(&"allow-popover-picked".to_string()),
            "only the surface may report a pick; the chrome has no business calling its own \
             reporting command"
        );
    }

    /// No capability file may name a content webview. Content labels are minted at runtime
    /// (`content-<n>`), so this pins the SHAPE rather than a list: a capability whose
    /// `windows` is anything other than `["main"]` or `["<the surface label>"]` is a bug.
    #[test]
    fn no_capability_names_a_content_webview() {
        for (name, src) in [
            ("default.json", include_str!("../capabilities/default.json")),
            ("surface.json", include_str!("../capabilities/surface.json")),
        ] {
            let cap: Value = serde_json::from_str(src).unwrap_or_else(|e| panic!("{name}: {e}"));
            for w in cap["webviews"].as_array().expect("webviews array") {
                let label = w.as_str().expect("label string");
                assert!(
                    label == "main" || label == LABEL,
                    "capabilities/{name} names window {label:?}; the only two webview labels \
                     allowed a capability are the chrome and the popover surface"
                );
            }
        }
    }
}
