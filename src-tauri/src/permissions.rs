//! Site permissions (permissions.* IPC). Requests from the content webview
//! (geolocation, camera/mic, notifications, pointer-lock) have no decision by
//! default — a recognized request raises a prompt (the renderer's
//! permissions.onPrompt) unless the user already chose for that (origin,
//! permission); unrecognized request types are denied outright. The decision is
//! remembered per (origin, permission) and managed via list/remove/clear.
//!
//! webkit's PermissionRequest is !Send, so pending requests are held in a
//! main-thread-local map keyed by id; permissions.resolve acts on them via
//! run_on_main_thread (the same main thread), so the request never crosses
//! threads.
use serde_json::{json, Value};
use tauri::AppHandle;
#[cfg(target_os = "linux")]
use tauri::Emitter;

use crate::jsonstore;

#[cfg(target_os = "linux")]
thread_local! {
    static PENDING: std::cell::RefCell<
        std::collections::HashMap<u64, (webkit2gtk::PermissionRequest, String, String)>,
    > = std::cell::RefCell::new(std::collections::HashMap::new());
}
#[cfg(target_os = "linux")]
static NEXT_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

fn list(app: &AppHandle) -> Vec<Value> {
    jsonstore::load(app, "permissions")
}

/// Remembered decision for (origin, permission): Some(true)=allow, Some(false)=deny,
/// None=ask.
#[cfg(target_os = "linux")]
fn remembered(app: &AppHandle, origin: &str, permission: &str) -> Option<bool> {
    list(app).iter().find_map(|it| {
        let same = it.get("origin").and_then(Value::as_str) == Some(origin)
            && it.get("permission").and_then(Value::as_str) == Some(permission);
        same.then(|| it.get("decision").and_then(Value::as_str) == Some("allow"))
    })
}

/// Upsert a remembered (origin, permission) decision.
fn persist(app: &AppHandle, origin: &str, permission: &str, allow: bool) {
    let mut items = list(app);
    items.retain(|it| {
        !(it.get("origin").and_then(Value::as_str) == Some(origin)
            && it.get("permission").and_then(Value::as_str) == Some(permission))
    });
    items.push(json!({
        "origin": origin, "permission": permission,
        "decision": if allow { "allow" } else { "deny" },
    }));
    let _ = jsonstore::save(app, "permissions", &items);
}

/// scheme://host[:port] of a URL (the permission origin).
#[cfg(target_os = "linux")]
fn origin_of(uri: &str) -> String {
    if let Some(i) = uri.find("://") {
        let after = &uri[i + 3..];
        let end = after.find('/').unwrap_or(after.len());
        format!("{}{}", &uri[..i + 3], &after[..end])
    } else {
        uri.to_string()
    }
}

/// Map a webkit PermissionRequest to a readable permission name; "other" for
/// request types we don't surface (and therefore deny).
#[cfg(target_os = "linux")]
fn classify(req: &webkit2gtk::PermissionRequest) -> String {
    use glib::object::Cast;
    use webkit2gtk::UserMediaPermissionRequestExt;
    if req.downcast_ref::<webkit2gtk::GeolocationPermissionRequest>().is_some() {
        return "geolocation".into();
    }
    if req.downcast_ref::<webkit2gtk::NotificationPermissionRequest>().is_some() {
        return "notifications".into();
    }
    if req.downcast_ref::<webkit2gtk::PointerLockPermissionRequest>().is_some() {
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

/// Install the content-webview permission handler (Linux): allow/deny from the
/// remembered decision, else raise a prompt; deny unrecognized request types.
#[cfg(target_os = "linux")]
pub fn install_handler(app: &AppHandle) {
    use tauri::Manager;
    use webkit2gtk::{PermissionRequestExt, WebViewExt};
    let Some(content) = app.get_webview(crate::nav::CONTENT_LABEL) else {
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
                    let _ = app.emit(
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
pub fn dispatch(app: &AppHandle, channel: &str, payload: &Value) -> Option<Result<Value, String>> {
    match channel {
        "permissions.list" => Some(Ok(json!(list(app)))),
        "permissions.remove" => {
            let origin = payload.get("origin").and_then(Value::as_str).unwrap_or("");
            let permission = payload.get("permission").and_then(Value::as_str).unwrap_or("");
            let mut items = list(app);
            items.retain(|it| {
                !(it.get("origin").and_then(Value::as_str) == Some(origin)
                    && it.get("permission").and_then(Value::as_str) == Some(permission))
            });
            let _ = jsonstore::save(app, "permissions", &items);
            Some(Ok(json!(items)))
        }
        "permissions.clear" => {
            let empty: [Value; 0] = [];
            let _ = jsonstore::save(app, "permissions", &empty);
            Some(Ok(json!([])))
        }
        "permissions.resolve" => {
            let id = payload.get("requestId").and_then(Value::as_u64).unwrap_or(0);
            let allow = payload.get("decision").and_then(Value::as_str) == Some("allow");
            #[cfg(target_os = "linux")]
            {
                let app2 = app.clone();
                let _ = app.run_on_main_thread(move || {
                    use webkit2gtk::PermissionRequestExt;
                    PENDING.with(|p| {
                        if let Some((req, origin, permission)) = p.borrow_mut().remove(&id) {
                            if allow {
                                req.allow();
                            } else {
                                req.deny();
                            }
                            persist(&app2, &origin, &permission, allow);
                        }
                    });
                });
            }
            #[cfg(not(target_os = "linux"))]
            {
                let _ = (id, allow);
            }
            Some(Ok(Value::Null))
        }
        _ => None,
    }
}
