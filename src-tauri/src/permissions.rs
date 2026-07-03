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
#[allow(dead_code)] // only reached via the Linux permission handler (linux_layout)
fn persist<R: Runtime>(app: &AppHandle<R>, origin: &str, permission: &str, allow: bool) {
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

/// scheme://host[:port] of a URL (the permission origin). Parsed with `Url` so the
/// remembered-decision key is a NORMALIZED origin — host lowercased, default ports dropped,
/// userinfo/path/query stripped — instead of a hand-rolled string split that mis-keys on
/// case/port variants (re-prompting, or matching a visually-distinct origin). Falls back to
/// the raw string for opaque/unparseable URIs.
#[cfg(target_os = "linux")]
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
                            if remember {
                                persist(&app2, &origin, &permission, allow);
                            }
                        }
                    });
                });
            }
            #[cfg(not(target_os = "linux"))]
            {
                let _ = (id, allow, remember);
            }
            Some(Ok(Value::Null))
        }
        _ => None,
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
        // origin_of is #[cfg(target_os = "linux")] — assert it only on Linux hosts.
        #[cfg(target_os = "linux")]
        {
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
    }
}
