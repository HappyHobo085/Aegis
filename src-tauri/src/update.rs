//! Auto-update IPC wiring (tauri-plugin-updater). Bridges the renderer's `update.*`
//! channels to the plugin: check for updates, mirror state to the chrome via the
//! `update.state` event, and download+install+restart on request. The update feed
//! (endpoints + pubkey) is configured in tauri.conf.json.
use std::sync::Mutex;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::UpdaterExt;

/// Last-known update state, mirrored to the chrome via the `update.state` event.
/// Shape matches `UpdateState` in shared/types.ts.
pub struct UpdateState(pub Mutex<Value>);

impl Default for UpdateState {
    fn default() -> Self {
        UpdateState(Mutex::new(idle()))
    }
}

fn idle() -> Value {
    json!({ "status": "idle", "version": null, "percent": 0, "error": null })
}

/// The Tauri updater manifest (same one the desktop updater reads). Android isn't
/// supported by tauri-plugin-updater, so the Android build fetches and parses this
/// itself. Keep in sync with `plugins.updater.endpoints` in tauri.conf.json.
#[cfg(target_os = "android")]
const MANIFEST_URL: &str =
    "https://github.com/HappyHobo085/Aegis/releases/latest/download/latest.json";

/// True if dotted-numeric `candidate` is a higher version than `current` (any
/// pre-release suffix after '-' is ignored). Avoids a semver dep for a simple check.
#[cfg(any(target_os = "android", test))]
fn is_newer(candidate: &str, current: &str) -> bool {
    fn parts(s: &str) -> Vec<u64> {
        s.split('-')
            .next()
            .unwrap_or("")
            .split('.')
            .map(|p| p.parse().unwrap_or(0))
            .collect()
    }
    let (a, b) = (parts(candidate), parts(current));
    for i in 0..a.len().max(b.len()) {
        let (x, y) = (
            a.get(i).copied().unwrap_or(0),
            b.get(i).copied().unwrap_or(0),
        );
        if x != y {
            return x > y;
        }
    }
    false
}

/// Parse a Tauri updater manifest; return the offered version if it's newer than
/// `current` AND ships an Android build (a `platforms` entry whose key starts with
/// "android"). `None` means up-to-date or no Android artifact.
#[cfg(any(target_os = "android", test))]
fn newer_android_version(manifest: &str, current: &str) -> Option<String> {
    let v: Value = serde_json::from_str(manifest).ok()?;
    let version = v.get("version")?.as_str()?;
    if !is_newer(version, current) {
        return None;
    }
    let has_android = v
        .get("platforms")?
        .as_object()?
        .keys()
        .any(|k| k.starts_with("android"));
    has_android.then(|| version.to_string())
}

fn set(app: &AppHandle, v: Value) {
    if let Some(s) = app.try_state::<UpdateState>() {
        *s.0.lock().unwrap() = v.clone();
    }
    let _ = crate::emit_event(app, "update.state", v);
}

/// Handle `update.*` channels. Returns `None` if `channel` is not an update channel.
pub fn dispatch(app: &AppHandle, channel: &str, _payload: &Value) -> Option<Result<Value, String>> {
    match channel {
        "update.getState" => {
            let v = app
                .try_state::<UpdateState>()
                .map(|s| s.0.lock().unwrap().clone())
                .unwrap_or_else(idle);
            Some(Ok(v))
        }
        "update.checkNow" => {
            // Android: tauri-plugin-updater is desktop-only, so check the manifest
            // ourselves (installing happens via the releases page — see the client).
            #[cfg(target_os = "android")]
            android_check(app.clone());
            #[cfg(not(target_os = "android"))]
            {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    set(
                        &app,
                        json!({ "status": "checking", "version": null, "percent": 0, "error": null }),
                    );
                    let result = match app.updater() {
                        Ok(updater) => updater.check().await,
                        Err(e) => Err(e),
                    };
                    match result {
                        Ok(Some(update)) => set(
                            &app,
                            json!({
                                "status": "available", "version": update.version, "percent": 0, "error": null
                            }),
                        ),
                        Ok(None) => set(
                            &app,
                            json!({
                                "status": "not-available", "version": null, "percent": 0, "error": null
                            }),
                        ),
                        Err(e) => set(
                            &app,
                            json!({
                                "status": "error", "version": null, "percent": 0, "error": e.to_string()
                            }),
                        ),
                    }
                });
            }
            Some(Ok(Value::Null))
        }
        "update.restartToInstall" => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let Ok(updater) = app.updater() else { return };
                if let Ok(Some(update)) = updater.check().await {
                    set(
                        &app,
                        json!({ "status": "downloading", "version": update.version, "percent": 0, "error": null }),
                    );
                    let progress_app = app.clone();
                    let result = update
                        .download_and_install(
                            move |_chunk, _total| {
                                // Per-chunk progress; a richer percent could be emitted here.
                                let _ = &progress_app;
                            },
                            || {},
                        )
                        .await;
                    match result {
                        Ok(()) => app.restart(),
                        Err(e) => set(
                            &app,
                            json!({
                                "status": "error", "version": null, "percent": 0, "error": e.to_string()
                            }),
                        ),
                    }
                }
            });
            Some(Ok(Value::Null))
        }
        _ => None,
    }
}

/// Android update check: fetch the manifest, compare to the running version, and
/// mirror the result to the chrome (same UpdateState shape as desktop). Runs on a
/// background thread (blocking reqwest, like subs).
#[cfg(target_os = "android")]
fn android_check(app: AppHandle) {
    std::thread::spawn(move || {
        set(
            &app,
            json!({ "status": "checking", "version": null, "percent": 0, "error": null }),
        );
        let current = app.package_info().version.to_string();
        let fetched = reqwest::blocking::get(MANIFEST_URL)
            .and_then(|r| r.error_for_status())
            .and_then(|r| r.text());
        match fetched {
            Ok(body) => match newer_android_version(&body, &current) {
                Some(version) => set(
                    &app,
                    json!({
                        "status": "available", "version": version, "percent": 0, "error": null
                    }),
                ),
                None => set(
                    &app,
                    json!({
                        "status": "not-available", "version": null, "percent": 0, "error": null
                    }),
                ),
            },
            Err(e) => set(
                &app,
                json!({
                    "status": "error", "version": null, "percent": 0, "error": e.to_string()
                }),
            ),
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{is_newer, newer_android_version};

    #[test]
    fn version_compare() {
        assert!(is_newer("0.2.0", "0.1.0"));
        assert!(is_newer("0.1.1", "0.1.0"));
        assert!(is_newer("1.0.0", "0.9.9"));
        assert!(is_newer("0.2.0-beta", "0.1.0")); // pre-release suffix ignored
        assert!(!is_newer("0.1.0", "0.1.0"));
        assert!(!is_newer("0.1.0", "0.2.0"));
    }

    #[test]
    fn detects_newer_android_build() {
        let m = r#"{"version":"0.2.0","platforms":{"android-universal":{"url":"https://x/app.apk"},"linux-x86_64":{"url":"https://x/app.AppImage"}}}"#;
        assert_eq!(newer_android_version(m, "0.1.0").as_deref(), Some("0.2.0"));
        assert_eq!(newer_android_version(m, "0.2.0"), None); // up to date
        assert_eq!(newer_android_version(m, "0.3.0"), None); // local build is newer
                                                             // Newer version, but no Android artifact published yet → don't offer it.
        let no_android = r#"{"version":"0.2.0","platforms":{"linux-x86_64":{"url":"u"}}}"#;
        assert_eq!(newer_android_version(no_android, "0.1.0"), None);
        assert_eq!(newer_android_version("not json", "0.1.0"), None);
    }
}
