//! Site permissions (permissions.* IPC). Requests from the content webview
//! (geolocation, camera/mic, notifications, pointer-lock) have no decision by
//! default — a recognized request raises a prompt (the renderer's
//! permissions.onPrompt) unless the user already chose for that (origin,
//! permission); unrecognized request types are denied outright. The decision is
//! remembered per (origin, permission) and managed via list/remove/clear.
//!
//! The DECISION half of that is platform-independent and lives here: `origin_of`
//! normalizes a request's origin, `verdict` answers what was remembered for an
//! (origin, permission) pair, and `persist` upserts a new one. The live request object is
//! platform-native (WebKit on Linux/macOS, WebView2 on Windows, and on Android a
//! `PermissionRequest` / `GeolocationPermissions.Callback` that only Kotlin holds), so the
//! RAISE side is per-platform: `install_handler_label` on Linux, and — since there is no
//! Kotlin-to-Rust up-call — three JNI exports below that Android's `NativePermissions`
//! calls, with the prompt itself raised through the chrome bridge. Rust cannot deliver a
//! verdict to a WebView callback, so `permissions.resolve` is a LINUX-ONLY resolution
//! path; the renderer routes the decision to the native bridge on Android instead (see
//! `ipcClient.ts`), exactly as it does for `view.setChromeOverlay`.
//!
//! webkit's PermissionRequest is !Send, so pending requests are held in a
//! main-thread-local map keyed by id; permissions.resolve acts on them via
//! run_on_main_thread (the same main thread), so the request never crosses
//! threads.
use serde_json::{json, Value};
#[cfg(target_os = "linux")]
use tauri::Manager;
use tauri::{AppHandle, Runtime};

use crate::jsonstore;

#[cfg(target_os = "linux")]
thread_local! {
    static PENDING: std::cell::RefCell<
        std::collections::HashMap<u64, (webkit2gtk::PermissionRequest, String, String)>,
    > = std::cell::RefCell::new(std::collections::HashMap::new());
}
#[cfg(target_os = "linux")]
static NEXT_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

fn list<R: Runtime>(app: &AppHandle<R>) -> Vec<Value> {
    jsonstore::load(app, "permissions")
}

#[cfg(any(target_os = "linux", target_os = "android", test))]
/// Remembered decision for (origin, permission): Some(true)=allow, Some(false)=deny,
/// None=ask. Cross-platform, because it is only a read of the JSON store — Android asks
/// the same question through the JNI export below.
fn remembered<R: Runtime>(app: &AppHandle<R>, origin: &str, permission: &str) -> Option<bool> {
    list(app).iter().find_map(|it| {
        let same = it.get("origin").and_then(Value::as_str) == Some(origin)
            && it.get("permission").and_then(Value::as_str) == Some(permission);
        same.then(|| it.get("decision").and_then(Value::as_str) == Some("allow"))
    })
}

#[cfg(any(target_os = "linux", target_os = "android", test))]
/// Upsert a remembered (origin, permission) decision. Reached from the Linux permission
/// handler (`linux_layout`) and, on Android, from `NativePermissions.remember`.
///
/// Reports a failed write rather than dropping it: the caller has just told the page its
/// decision, so a save that did not land leaves the store disagreeing with the live policy
/// and the user is re-prompted on the next load.
///
/// **This store has no serialization mechanism other than the write lock.** It is
/// deliberately not an `HLC_CARRIER` (`sync_stores.rs` documents why: no `hlc` on its rows,
/// plain `jsonstore::load`/`save`), so the lock is the ONLY thing keeping two tabs'
/// read-modify-writes apart — and it is held across the load here for exactly that reason.
fn persist<R: Runtime>(
    app: &AppHandle<R>,
    origin: &str,
    permission: &str,
    allow: bool,
) -> Result<(), String> {
    let mut items =
        jsonstore::with_store_lock("permissions", || jsonstore::load(app, "permissions"));
    items.retain(|it| {
        !(it.get("origin").and_then(Value::as_str) == Some(origin)
            && it.get("permission").and_then(Value::as_str) == Some(permission))
    });
    items.push(json!({
        "origin": origin, "permission": permission,
        "decision": if allow { "allow" } else { "deny" },
    }));
    jsonstore::save(app, "permissions", &items)
}

/// scheme://host[:port] of a URL (the permission origin). Parsed with `Url` so the
/// remembered-decision key is a NORMALIZED origin — host lowercased, default ports dropped,
/// userinfo/path/query stripped — instead of a hand-rolled string split that mis-keys on
/// case/port variants (re-prompting, or matching a visually-distinct origin). Falls back to
#[cfg(any(target_os = "linux", target_os = "android", test))]
/// the raw string for opaque/unparseable URIs. Pure, so both platforms key the same store
/// row (Android normalizes through `NativePermissions.normalizeOrigin`).
fn origin_of(uri: &str) -> String {
    match tauri::Url::parse(uri) {
        Ok(u) => match u.host_str() {
            Some(host) => {
                let host = host.to_ascii_lowercase();
                match u.port() {
                    Some(p) => format!("{}://{}:{}", u.scheme(), host, p),
                    None => format!("{}://{}", u.scheme(), host),
                }
            }
            None => uri.to_string(),
        },
        Err(_) => uri.to_string(),
    }
}

/// Map a webkit PermissionRequest to a readable permission name; "other" for
/// request types we don't surface (and therefore deny).
///
/// The vocabulary here is the whole one the store can hold. Android cannot reach all of
/// it — the platform WebView has no callback for notifications or pointer-lock — so that
/// platform maps only `geolocation`, `camera`, `microphone` and `camera-microphone`, and
/// the two remaining names are never written from either side. The store therefore only
/// ever holds rows a real callback can act on.
#[cfg(target_os = "linux")]
fn classify(req: &webkit2gtk::PermissionRequest) -> String {
    use glib::object::Cast;
    use webkit2gtk::UserMediaPermissionRequestExt;
    if req
        .downcast_ref::<webkit2gtk::GeolocationPermissionRequest>()
        .is_some()
    {
        return "geolocation".into();
    }
    if req
        .downcast_ref::<webkit2gtk::NotificationPermissionRequest>()
        .is_some()
    {
        return "notifications".into();
    }
    if req
        .downcast_ref::<webkit2gtk::PointerLockPermissionRequest>()
        .is_some()
    {
        return "pointer-lock".into();
    }
    if let Some(um) = req.downcast_ref::<webkit2gtk::UserMediaPermissionRequest>() {
        return match (um.is_for_audio_device(), um.is_for_video_device()) {
            (true, true) => "camera-microphone".into(),
            (true, false) => "microphone".into(),
            (false, true) => "camera".into(),
            _ => "media".into(),
        };
    }
    "other".into()
}

/// Install the permission handler on a specific content webview by label (Linux):
/// allow/deny from the remembered decision, else raise a prompt; deny unrecognized
/// request types. Called per-tab at spawn so every tab handles its own requests.
///
/// # A KNOWN, DELIBERATELY UNFIXED LIMIT: the origin is the MAIN FRAME's
///
/// `connect_permission_request`'s callback gets a `WebView` handle, and the only URI
/// available from it is `wv.uri()` — the webview's own address, i.e. the top-level
/// document. A permission request raised by a **cross-origin IFRAME** is therefore
/// attributed to the page that embedded it, and inherits that page's remembered
/// decision: allow the camera on `example.com` once, and any third-party iframe
/// embedded there can request a camera and be let straight through.
///
/// This is not fixable with the pinned `webkit2gtk` binding. `PermissionRequestExt`
/// exposes only `allow()` and `deny()`; there is no per-request URI getter to read, so
/// there is nothing to attribute the request to but the webview. Fixing it properly
/// needs either a binding that surfaces the requesting frame's URI, or upstream
/// WebKitGTK exposing it on `WebKitPermissionRequest`. Until one of those exists the
/// honest options are (a) ignore a remembered decision whenever the requesting page has
/// ever embedded a third-party frame — far too broad to ship, and it would also break
/// the common single-origin case — or (b) state the limit, which is what this comment
/// does. **Do not "fix" this by trusting `wv.uri()` more than it already is**: the
/// `let origin = …` line below is the only signal available, and re-labelling it does
/// not change what it answers.
///
/// The blast radius is bounded by what a frame can request and by what is remembered:
/// `classify` refuses anything unrecognized, and the same stored decision is consulted
/// on every platform, so a user who never allows camera access on a given origin is
/// unaffected. Recorded here rather than in `AGENTS.md` only, because the comment must
/// be read by anyone editing THIS line.
#[cfg(target_os = "linux")]
pub fn install_handler_label(app: &AppHandle, label: &str) {
    use webkit2gtk::{PermissionRequestExt, WebViewExt};
    let Some(content) = app.get_webview(label) else {
        return;
    };
    let app = app.clone();
    let _ = content.with_webview(move |pw| {
        let app = app.clone();
        pw.inner().connect_permission_request(move |wv, req| {
            let permission = classify(req);
            if permission == "other" {
                req.deny();
                return true;
            }
            let origin = wv.uri().map(|u| origin_of(&u)).unwrap_or_default();
            match remembered(&app, &origin, &permission) {
                Some(true) => req.allow(),
                Some(false) => req.deny(),
                None => {
                    let id = NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    PENDING.with(|p| {
                        p.borrow_mut()
                            .insert(id, (req.clone(), origin.clone(), permission.clone()));
                    });
                    crate::emit_event(
                        &app,
                        "permissions.prompt",
                        json!({ "requestId": id, "origin": origin, "permission": permission }),
                    );
                    eprintln!("[aegis-perm] prompt: id={id} {permission} from {origin}");
                }
            }
            true
        });
    });
}

/// Handle `permissions.*`. list/remove/clear are cross-platform (JSON store);
/// resolve acts on the held request (Linux) and remembers the choice.
pub fn dispatch<R: Runtime>(
    app: &AppHandle<R>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    match channel {
        "permissions.list" => Some(Ok(json!(list(app)))),
        "permissions.remove" => {
            let origin = payload.get("origin").and_then(Value::as_str).unwrap_or("");
            let permission = payload
                .get("permission")
                .and_then(Value::as_str)
                .unwrap_or("");
            // Load, mutate, save under the store lock, and REPORT the save. The old body
            // answered `Some(Ok(json!(items)))` built from the IN-MEMORY list and threw the
            // save's `Result` away, so a write that did not land reported success: the UI
            // dropped the row, the file still held it, and a grant the user had just
            // revoked came back on the next start. The `?` is the fix, and the lock is what
            // stops a concurrent `persist` (a prompt answer on another tab) from being
            // clobbered by this arm's save.
            Some(jsonstore::with_store_lock("permissions", || {
                let mut items = jsonstore::load(app, "permissions");
                items.retain(|it| {
                    !(it.get("origin").and_then(Value::as_str) == Some(origin)
                        && it.get("permission").and_then(Value::as_str) == Some(permission))
                });
                jsonstore::save(app, "permissions", &items)?;
                Ok(json!(items))
            }))
        }
        "permissions.clear" => {
            // Same obligation as `remove`: `let _ = …` here made "Clear all permissions"
            // report success while the file kept every row.
            Some(jsonstore::with_store_lock("permissions", || {
                let empty: [Value; 0] = [];
                jsonstore::save(app, "permissions", &empty)?;
                Ok(json!([]))
            }))
        }
        "permissions.resolve" => {
            let id = payload
                .get("requestId")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let decision = payload
                .get("decision")
                .and_then(Value::as_str)
                .unwrap_or("deny")
                .to_string();
            let allow = decision == "allow" || decision == "allow-once";
            let remember = decision != "allow-once";
            // Resolve the pending request EAGERLY so an unknown/duplicate id is reported instead
            // of being silently swallowed. Previously the `PENDING.remove` only ran inside
            // `if let Some(..)`, so a resolve for an id the chrome had already dropped (double
            // click, or a prompt for a webview that went away) still answered `ok`, the chrome
            // dismissed the row, and the page's `PermissionRequest` stayed pending forever —
            // WebKit then blocks that permission on the page with no way for the user to answer.
            #[cfg(target_os = "linux")]
            {
                let app2 = app.clone();
                let _ = app.run_on_main_thread(move || {
                    use webkit2gtk::PermissionRequestExt;
                    let entry = PENDING.with(|p| p.borrow_mut().remove(&id));
                    let Some((req, origin, permission)) = entry else {
                        eprintln!(
                            "[aegis-perm] resolve for unknown/stale request id={id} \
                             (already answered, or the webview is gone); ignoring"
                        );
                        return;
                    };
                    if allow {
                        req.allow();
                    } else {
                        req.deny();
                    }
                    if remember {
                        // A save that did not land is a real failure: the page already has its
                        // answer, so the store falling behind means the same prompt returns on
                        // the next load. Log it — this runs inside `run_on_main_thread`, where
                        // there is no caller left to return an `Err` to.
                        if let Err(e) = persist(&app2, &origin, &permission, allow) {
                            eprintln!(
                                "[aegis-perm] could not remember {permission} for {origin}: {e}"
                            );
                        }
                    }
                });
            }
            // Off Linux the pending request is held by the PLATFORM, not by this map, so
            // there is nothing here to resolve. It is not silently a no-op any more: the
            // renderer routes the decision to the native bridge on Android (there is no
            // Kotlin-to-Rust up-call, and a JNI export cannot reach a WebView callback),
            // and a direct IPC caller gets told so instead of a bare `let _ = (...)` that
            // looked like working code.
            #[cfg(not(target_os = "linux"))]
            {
                eprintln!(
                    "[aegis-perm] permissions.resolve for id={id} (allow={allow}, \
                     remember={remember}) has no effect here: this platform holds the \
                     request natively, so the decision must be delivered there"
                );
            }
            Some(Ok(Value::Null))
        }
        _ => None,
    }
}

/// What the user already decided for (origin, permission), as the string the callers
/// speak: `"allow"`, `"deny"`, or `""` for "ask".
///
/// A `String` return rather than an `Option<bool>` because it crosses into Kotlin, where a
/// nullable return is awkward and a sentinel is idiomatic; and it is a three-way answer so
/// the JNI shell is a single call with no branching of its own.
///
/// Gated to Android and the test build, NOT to Linux as well: the Linux handler inlines
/// the `remembered` match (it has to hold the request across the prompt, so it needs the
/// `Option<bool>` half), and the only production caller of `verdict` is the
/// `NativePermissions.decision` JNI shell. `cargo clippy --all-targets -- -D warnings`
/// caught the over-wide gate as a `dead_code` error on the host build, which is the point
/// of gating instead of `allow(dead_code)`.
#[cfg(any(target_os = "android", test))]
pub fn verdict<R: Runtime>(app: &AppHandle<R>, origin: &str, permission: &str) -> &'static str {
    match remembered(app, origin, permission) {
        Some(true) => "allow",
        Some(false) => "deny",
        None => "",
    }
}

/// JNI bridge for Android's `NativePermissions`. Rust cannot deliver a verdict to a
/// WebView callback, so these are the whole of the Android "remembered decision" contract:
/// normalize the origin the request reported, read what was remembered, and upsert a new
/// decision once the user answers. Same pattern (and same `ffi_guard` obligation) as
/// `history.rs`'s `recordVisit`; lives in libapp_lib.so.
#[cfg(target_os = "android")]
#[allow(unsafe_code)]
// `#[no_mangle]` is itself linted as `unsafe_code`: overriding the linker's symbol name
// means two libraries could export the same symbol, which the linker leaves undefined. That
// is inherent to every JNI entry point (Kotlin resolves the symbol by name), so it is
// allowed here explicitly rather than by the module scope — `deny(unsafe_code)` in lib.rs
// would otherwise break every Android build.
#[no_mangle]
pub extern "system" fn Java_com_aegis_browser_NativePermissions_normalizeOrigin(
    mut env: jni::JNIEnv,
    _this: jni::objects::JObject,
    uri: jni::objects::JString,
) -> jni::sys::jstring {
    let uri: String = env.get_string(&uri).map(|s| s.into()).unwrap_or_default();
    let out = env
        .new_string(origin_of(&uri))
        .unwrap_or_else(|_| jni::objects::JString::from(jni::objects::JObject::null()));
    out.into_raw()
}

/// `verdict` as a jstring. The `String` is built OUTSIDE `ffi_guard` because it borrows
/// `env`, and `jni::JNIEnv` is `!UnwindSafe`; a panic across the FFI boundary would abort
/// the process rather than unwind.
#[cfg(target_os = "android")]
#[allow(unsafe_code)]
#[no_mangle]
pub extern "system" fn Java_com_aegis_browser_NativePermissions_decision(
    mut env: jni::JNIEnv,
    _this: jni::objects::JObject,
    origin: jni::objects::JString,
    permission: jni::objects::JString,
) -> jni::sys::jstring {
    let origin: String = env
        .get_string(&origin)
        .map(|s| s.into())
        .unwrap_or_default();
    let permission: String = env
        .get_string(&permission)
        .map(|s| s.into())
        .unwrap_or_default();
    // An empty side is refused rather than answered: a request with no origin would key
    // every such site to the same row, so "ask" is the only safe verdict.
    let text = if origin.is_empty() || permission.is_empty() {
        String::new()
    } else {
        // `match` rather than `let ... else`: the else arm must diverge, and "no app
        // handle" is a value here, not an early return.
        match crate::android_app() {
            None => String::new(),
            Some(app) => match crate::ffi_guard(|| verdict(app, &origin, &permission)) {
                Some(v) => v.to_string(),
                None => {
                    eprintln!("[aegis-perm] decision panicked for {origin} {permission}");
                    String::new()
                }
            },
        }
    };
    env.new_string(text)
        .unwrap_or_else(|_| jni::objects::JString::from(jni::objects::JObject::null()))
        .into_raw()
}

/// Upsert a remembered decision. The live request is answered on the Kotlin side, so this
/// only has to persist what the user chose.
#[cfg(target_os = "android")]
#[allow(unsafe_code)]
#[no_mangle]
pub extern "system" fn Java_com_aegis_browser_NativePermissions_remember(
    mut env: jni::JNIEnv,
    _this: jni::objects::JObject,
    origin: jni::objects::JString,
    permission: jni::objects::JString,
    allow: jni::sys::jboolean,
) {
    let origin: String = env
        .get_string(&origin)
        .map(|s| s.into())
        .unwrap_or_default();
    let permission: String = env
        .get_string(&permission)
        .map(|s| s.into())
        .unwrap_or_default();
    if origin.is_empty() || permission.is_empty() {
        return;
    }
    let Some(app) = crate::android_app() else {
        return;
    };
    match crate::ffi_guard(|| persist(app, &origin, &permission, allow != 0)) {
        None => eprintln!("[aegis-perm] remember panicked for {origin} {permission}"),
        Some(Err(e)) => {
            eprintln!("[aegis-perm] could not remember {permission} for {origin}: {e}")
        }
        Some(Ok(())) => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::with_tmp_app;
    use serde_json::json;
    use tauri::test::MockRuntime;

    fn seed(app: &AppHandle<MockRuntime>) {
        let rows = vec![
            json!({ "origin": "https://a.test", "permission": "geolocation", "decision": "allow" }),
            json!({ "origin": "https://a.test", "permission": "camera", "decision": "deny" }),
            json!({ "origin": "https://b.test", "permission": "notifications", "decision": "allow" }),
        ];
        crate::jsonstore::save(app, "permissions", &rows).unwrap();
    }

    #[test]
    fn list_returns_all_seeded_decisions() {
        with_tmp_app(|app| {
            seed(app);
            let v = dispatch(app, "permissions.list", &json!({}))
                .unwrap()
                .unwrap();
            assert_eq!(v.as_array().unwrap().len(), 3);
        });
    }

    #[test]
    fn remove_deletes_only_the_matching_origin_permission_pair() {
        with_tmp_app(|app| {
            seed(app);
            let after = dispatch(
                app,
                "permissions.remove",
                &json!({ "origin": "https://a.test", "permission": "camera" }),
            )
            .unwrap()
            .unwrap();
            let rows = after.as_array().unwrap();
            assert_eq!(rows.len(), 2);
            // The (a.test, camera) pair is gone; (a.test, geolocation) stays.
            assert!(rows
                .iter()
                .all(
                    |it| !(it.get("origin").and_then(Value::as_str) == Some("https://a.test")
                        && it.get("permission").and_then(Value::as_str) == Some("camera"))
                ));
            assert!(rows
                .iter()
                .any(|it| it.get("permission").and_then(Value::as_str) == Some("geolocation")));
        });
    }

    #[test]
    fn clear_empties_the_store() {
        with_tmp_app(|app| {
            seed(app);
            let after = dispatch(app, "permissions.clear", &json!({}))
                .unwrap()
                .unwrap();
            assert!(after.as_array().unwrap().is_empty());
            assert!(crate::jsonstore::load(app, "permissions").is_empty());
        });
    }

    #[test]
    fn origin_of_strips_path_keeping_scheme_host_port() {
        // Cross-platform since 6.8: Android normalizes a request's origin through this
        // same function (NativePermissions.normalizeOrigin), so an origin that keys the
        // store on one platform must key it identically on the other.
        assert_eq!(
            origin_of("https://example.com:8443/some/path?x=1"),
            "https://example.com:8443"
        );
        assert_eq!(origin_of("https://example.com/"), "https://example.com");
        assert_eq!(origin_of("not-a-url"), "not-a-url");
        // Normalized origin key: host lowercased, default port dropped, userinfo stripped —
        // so visually-distinct URIs for the same origin share one remembered decision.
        assert_eq!(origin_of("https://EXAMPLE.com/x"), "https://example.com");
        assert_eq!(origin_of("https://example.com:443/"), "https://example.com");
        assert_eq!(
            origin_of("https://user@example.com/"),
            "https://example.com"
        );
    }

    #[test]
    fn verdict_answers_the_stored_decision_and_asks_when_there_is_none() {
        // `verdict` is the whole of the Android-facing contract, so it is the unit worth
        // testing: a remembered ALLOW is what stops the prompt reappearing for a site the
        // user already trusted, and a remembered DENY is what stops a site re-asking until
        // the user gets tired of saying no.
        with_tmp_app(|app| {
            assert_eq!(verdict(app, "https://a.test", "camera"), "");
            assert_eq!(verdict(app, "https://a.test", "microphone"), "");

            persist(app, "https://a.test", "camera", true).unwrap();
            assert_eq!(verdict(app, "https://a.test", "camera"), "allow");
            // A decision is per (origin, permission): allowing the camera on one site says
            // nothing about the microphone, or about another site.
            assert_eq!(verdict(app, "https://a.test", "microphone"), "");
            assert_eq!(verdict(app, "https://b.test", "camera"), "");

            persist(app, "https://a.test", "camera", false).unwrap();
            assert_eq!(verdict(app, "https://a.test", "camera"), "deny");
        });
    }

    #[test]
    fn persisting_twice_replaces_the_row_rather_than_duplicating_it() {
        // The store is rendered as a list in SitePermissionsTab, so a duplicate row would
        // show the same site twice and remove one copy would leave the other in force.
        with_tmp_app(|app| {
            persist(app, "https://a.test", "camera", true).unwrap();
            persist(app, "https://a.test", "camera", false).unwrap();
            let rows = dispatch(app, "permissions.list", &json!({}))
                .unwrap()
                .unwrap();
            let rows = rows.as_array().unwrap();
            assert_eq!(rows.len(), 1, "{rows:?}");
            assert_eq!(rows[0]["origin"], json!("https://a.test"));
            assert_eq!(rows[0]["permission"], json!("camera"));
            assert_eq!(rows[0]["decision"], json!("deny"));
        });
    }

    #[test]
    fn a_permission_answered_on_one_platform_is_visible_to_the_list_the_other_renders() {
        // The user-facing point of keeping the store in Rust: a decision recorded on
        // Android shows up in the same SitePermissionsTab the desktop renders, and
        // removing it there takes effect for the next request.
        with_tmp_app(|app| {
            persist(app, "https://a.test", "geolocation", true).unwrap();
            let after = dispatch(
                app,
                "permissions.remove",
                &json!({ "origin": "https://a.test", "permission": "geolocation" }),
            )
            .unwrap()
            .unwrap();
            assert!(after.as_array().unwrap().is_empty());
            assert_eq!(verdict(app, "https://a.test", "geolocation"), "");
        });
    }

    // ------------------------------------------------------------------ Kotlin / manifest pins
    //
    // There is NO Kotlin test source set in this project, so a `.kt` or manifest change is
    // compile-verified by the Gradle build and NOTHING else. A test that reads the source
    // is the only thing that can catch a future Android edit silently undoing any of the
    // above: without `onPermissionRequest` the WebView denies every request silently, and
    // without the manifest permissions a granted request still fails. Both would leave the
    // permissions list empty — the very symptom 6.8 exists to fix — with a green suite.

    fn kotlin(file: &str) -> String {
        crate::test_support::kotlin_source(file)
    }

    fn fn_body(src: &str, signature: &str) -> String {
        crate::test_support::kotlin_fn_body(src, signature)
    }

    #[test]
    fn the_android_webview_client_answers_permission_requests_through_the_rust_store() {
        let src = kotlin("MainActivity.kt");
        let camera = fn_body(&src, "override fun onPermissionRequest(");
        // Without this override the platform WebView denies every request silently, which
        // is the defect: a site asking for the camera got no prompt and no remembered row.
        assert!(
            camera.contains("askUser("),
            "onPermissionRequest must go through askUser, so the remembered decision is \
             consulted and a remembered allow/deny is honoured: {camera}"
        );
        // A resource set Aegis cannot name must be denied, not prompted about: a prompt the
        // user can answer but nothing acts on is worse than a silent no.
        assert!(
            camera.contains("request.deny()"),
            "onPermissionRequest must deny what it cannot key: {camera}"
        );
        // The resource -> NAME mapping lives in its own helper, because the same three
        // names are what the desktop `classify` produces and the store has to agree with.
        let names = fn_body(&src, "private fun permissionFor(");
        for name in [
            "RESOURCE_VIDEO_CAPTURE",
            "RESOURCE_AUDIO_CAPTURE",
            "camera-microphone",
            "microphone",
            "camera",
        ] {
            assert!(
                names.contains(name),
                "permissionFor no longer names {name:?}, so a media request would either be \
                 denied or keyed to a row nothing reads: {names}"
            );
        }
        assert!(
            camera.contains("permissionFor(resources)"),
            "onPermissionRequest must derive the permission name from the resource set: \
             {camera}"
        );
    }

    #[test]
    fn geolocation_uses_its_own_android_callback_and_the_same_prompt() {
        let src = kotlin("MainActivity.kt");
        // Geolocation never arrives as a `PermissionRequest` on the platform WebView, so
        // without this override it has no path at all — which is why a geolocation site
        // simply never worked on a phone.
        let geo = fn_body(&src, "override fun onGeolocationPermissionsShowPrompt(");
        assert!(
            geo.contains("askUser(") && geo.contains("callback.invoke("),
            "the geolocation prompt must go through askUser AND answer the platform \
             callback: {geo}"
        );
        assert!(
            geo.contains("\"geolocation\""),
            "the geolocation prompt must be keyed as `geolocation`, the name the desktop \
             `classify` uses: {geo}"
        );
    }

    #[test]
    fn the_chrome_can_answer_and_the_native_side_answers_only_a_live_request() {
        let src = kotlin("MainActivity.kt");
        let resolve = fn_body(&src, "fun resolvePermission(");
        // The decision has to come back over the bridge: Rust cannot up-call into Kotlin,
        // and the IPC channel's non-Linux arm has no way to reach a WebView callback.
        assert!(
            resolve.contains("pendingPermissions.remove("),
            "resolvePermission must consume the queued request, so a second click cannot \
             grant twice: {resolve}"
        );
        assert!(
            resolve.contains("NativePermissions.remember("),
            "resolvePermission must persist the decision in Rust's store, or the \
             permissions list the user sees never changes: {resolve}"
        );
        assert!(
            resolve.contains("!decision.contains(\"allow-once\")")
                || resolve.contains("decision != \"allow-once\""),
            "resolvePermission must treat `allow-once` as the one decision that is NOT \
             remembered, or every once-only grant becomes permanent: {resolve}"
        );
        // The prompt itself has to reach the chrome, which is where the dialog is.
        let push = fn_body(&src, "private fun pushPermissionPrompt(");
        assert!(
            push.contains("__aegisPermissionPrompt"),
            "pushPermissionPrompt must raise window.__aegisPermissionPrompt, the same push \
             the find/zoom/nav counters use: {push}"
        );
    }

    #[test]
    fn a_permission_the_device_was_never_asked_for_is_declared_in_the_manifest() {
        // A web grant is useless without the app's own grant: getUserMedia and geolocation
        // both fail at the platform layer no matter what the site was told. So the three
        // app-wide permissions have to be declared, and optional (so a device with no
        // camera or microphone can still install the app).
        let manifest = std::fs::read_to_string(format!(
            "{}/gen/android/app/src/main/AndroidManifest.xml",
            env!("CARGO_MANIFEST_DIR")
        ))
        .expect("cannot read AndroidManifest.xml");
        for name in [
            "android.permission.CAMERA",
            "android.permission.RECORD_AUDIO",
            "android.permission.ACCESS_FINE_LOCATION",
        ] {
            assert!(
                manifest.contains(&format!("<uses-permission android:name=\"{name}\" />")),
                "{name} is not declared, so an allowed camera/microphone/geolocation \
                 request would still fail at the platform layer"
            );
        }
        for feature in [
            "android.hardware.camera",
            "android.hardware.microphone",
            "android.hardware.location.gps",
        ] {
            assert!(
                manifest.contains(&format!(
                    "<uses-feature android:name=\"{feature}\" android:required=\"false\" />"
                )),
                "{feature} must be an OPTIONAL uses-feature, or the app cannot install on a \
                 device without it"
            );
        }
        // And the request has to actually be made when a web request is granted. Asserted
        // PER ARM, not per constant: the `camera-microphone` arm names CAMERA and
        // RECORD_AUDIO too, so a loose `contains("Manifest.permission.CAMERA")` stays green
        // when the plain `"camera"` arm stops asking for the camera at all - which is
        // exactly what probe P6 did, and it caught THIS TEST rather than the code.
        let src = kotlin("MainActivity.kt");
        let ask = fn_body(&src, "private fun requestAndroidPermissionFor(");
        for (permission, constant) in [
            ("camera", "Manifest.permission.CAMERA"),
            ("microphone", "Manifest.permission.RECORD_AUDIO"),
            ("geolocation", "Manifest.permission.ACCESS_FINE_LOCATION"),
        ] {
            let arm = format!("\"{permission}\" -> arrayOf({constant})");
            assert!(
                ask.contains(&arm),
                "requestAndroidPermissionFor no longer maps `{permission}` to {constant}, so \
                 a granted web request would fail at the platform layer: {ask}"
            );
        }
        assert!(
            ask.contains(concat!(
                "\"camera-microphone\" -> arrayOf(Manifest.permission.CAMERA, ",
                "Manifest.permission.RECORD_AUDIO)"
            )),
            "requestAndroidPermissionFor no longer asks for BOTH the camera and the \
             microphone for a combined request: {ask}"
        );
    }

    #[test]
    fn the_native_bridge_declares_the_three_calls_the_android_side_makes() {
        // The JNI exports above are invisible to a Linux build, so the Kotlin side's
        // `external fun` declarations are pinned from here: a rename on one side only is a
        // runtime UnsatisfiedLinkError on a phone, and a green suite either way.
        let kt = kotlin("NativePermissions.kt");
        for sig in [
            "external fun normalizeOrigin(uri: String): String",
            "external fun decision(origin: String, permission: String): String",
            "external fun remember(origin: String, permission: String, allow: Boolean)",
        ] {
            assert!(
                kt.contains(sig),
                "NativePermissions.kt no longer declares `{sig}`, so the JNI export for it \
                 would be unreachable from Kotlin"
            );
        }
    }
    #[test]
    fn the_remembered_decision_is_honoured_before_any_prompt_is_raised() {
        // `askUser` is the whole point of the fix: a site the user already answered must not be
        // asked again, and a site that HAS been asked must reach the dialog. Neither half is
        // visible from the two WebView callbacks, so without this pin the store lookup could
        // be dropped and every request would re-prompt (P2 proves that: replacing the
        // `decision` call with `""` reddened nothing else).
        let src = kotlin("MainActivity.kt");
        let ask = fn_body(&src, "private fun askUser(");
        assert!(
            ask.contains("NativePermissions.normalizeOrigin("),
            "askUser must key the store by the NORMALIZED origin, the same key the desktop \
             `origin_of` writes, or a site re-prompts for a differently-spelled URL to \
             itself: {ask}"
        );
        assert!(
            ask.contains("NativePermissions.decision("),
            "askUser must ask Rust for the remembered decision, or every request re-prompts \
             and nothing is ever remembered: {ask}"
        );
        // Order is the behaviour: consult the store, act on it, and only then queue a prompt.
        let decided = ask
            .find("NativePermissions.decision(")
            .expect("asserted above");
        let pushed = ask
            .find("pushPermissionPrompt(")
            .expect("askUser must raise a prompt at all, or a new request is silently dropped");
        assert!(
            decided < pushed,
            "askUser raises the prompt before it consults the store, so a remembered decision \
             is asked about again: {ask}"
        );
        assert!(
            ask.contains("onDecision(remembered == \"allow\")"),
            "askUser must ACT on the verdict, not merely read it: {ask}"
        );
        // An origin-less request has no safe store key (every such site would share one row),
        // so it is refused instead of prompted.
        assert!(
            ask.contains("key.isEmpty()") && ask.contains("onDecision(false)"),
            "askUser must refuse a request with no origin instead of remembering it under a \
             key that would collide: {ask}"
        );
        // And the request itself has to be queued, or `resolvePermission` has nothing to answer.
        assert!(
            ask.contains("pendingPermissions[requestId] = PendingPermission("),
            "askUser must queue the live request against its id, or the chrome's answer has \
             nothing to apply to: {ask}"
        );
    }

    #[test]
    fn a_closing_tab_denies_the_permission_requests_it_never_answered() {
        // A queued `PermissionRequest` holds a live platform callback, so a tab that closes
        // with one pending leaks it AND leaves a stale id in the queue that a later request
        // could be answered by. Denying on teardown is the whole fix.
        let src = kotlin("MainActivity.kt");
        let drop = fn_body(&src, "private fun dropPermissionsForTab(");
        assert!(
            drop.contains("pendingPermissions.remove(") && drop.contains("pending.answer(false)"),
            "dropPermissionsForTab must consume the queued entry AND deny it, so a closed \
             tab leaves no live callback and no stale id: {drop}"
        );
        let teardown = fn_body(&src, "private fun teardownTab(");
        assert!(
            teardown.contains("dropPermissionsForTab(id)"),
            "teardownTab must drop that tab's pending permission requests; a request left \
             open outlives the webview it belongs to: {teardown}"
        );
    }

    /// The store `permissions` has NO serialization mechanism other than the write lock:
    /// it is deliberately not an `HLC_CARRIER` (no `hlc` on its rows, plain
    /// `jsonstore::load`/`save`), so a read-modify-write here can interleave with another
    /// tab's prompt answer and one of the two writes silently vanishes.
    #[test]
    fn a_revoked_permission_that_could_not_be_saved_is_reported_not_silently_lost() {
        // The defect: `permissions.remove` loaded, mutated, then threw the save's `Result`
        // away (`let _ = …`) and answered `Ok` built from the IN-MEMORY list. The UI dropped
        // the row, the file kept it, and the grant the user had just revoked came back on the
        // next start — a permission the user believes they took away, still in force.
        with_tmp_app(|app| {
            seed(app);
            let blocked = crate::test_support::block_store_file(app, "permissions.json");
            let reported = dispatch(
                app,
                "permissions.remove",
                &json!({ "origin": "https://a.test", "permission": "camera" }),
            );
            let err = reported
                .expect("the channel is handled")
                .expect_err("a save that did not land must NOT report success");
            assert!(
                !err.is_empty(),
                "the refusal must carry the reason, or the UI cannot show it"
            );
            crate::test_support::unblock_store_file(&blocked);
            // And the row is genuinely still on disk — the point of the assertion is that the
            // answer and the file agree.
            let rows = dispatch(app, "permissions.list", &json!({}))
                .unwrap()
                .unwrap();
            assert!(
                rows.as_array().unwrap().iter().any(|it| {
                    it.get("origin").and_then(Value::as_str) == Some("https://a.test")
                        && it.get("permission").and_then(Value::as_str) == Some("camera")
                }),
                "the unrevoked grant must still be on disk, so the refusal is honest: {rows:?}"
            );
        });
    }

    #[test]
    fn clearing_permissions_that_could_not_be_saved_is_reported_not_silently_lost() {
        // The same `let _ = …` in the `clear` arm: "Clear all permissions" reported success
        // with an empty list while the file kept every row. Same user-visible lie, same fix.
        with_tmp_app(|app| {
            seed(app);
            let blocked = crate::test_support::block_store_file(app, "permissions.json");
            let reported = dispatch(app, "permissions.clear", &json!({}));
            assert!(
                reported.expect("the channel is handled").is_err(),
                "a clear that did not land must be reported, or the user sees an empty list \
                 over a file that still grants every permission"
            );
            crate::test_support::unblock_store_file(&blocked);
            let rows = dispatch(app, "permissions.list", &json!({}))
                .unwrap()
                .unwrap();
            assert_eq!(
                rows.as_array().unwrap().len(),
                3,
                "all three seeded decisions are still on disk: {rows:?}"
            );
        });
    }

    #[test]
    fn a_remembered_decision_that_could_not_be_saved_is_reported_to_the_caller() {
        // The third `let _ = …`: `persist` is what both platform handlers reach (the Linux
        // `run_on_main_thread` resolve, and Android's `NativePermissions.remember` JNI
        // export). Both had nowhere to return an error to, so the refusal was dropped twice.
        with_tmp_app(|app| {
            let blocked = crate::test_support::block_store_file(app, "permissions.json");
            let err = persist(app, "https://c.test", "camera", true)
                .expect_err("a save that did not land must be reported");
            assert!(!err.is_empty());
            crate::test_support::unblock_store_file(&blocked);
            assert_eq!(
                verdict(app, "https://c.test", "camera"),
                "",
                "nothing may be remembered when the write failed"
            );
        });
    }
}
