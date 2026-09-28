//! Auto-update IPC wiring (tauri-plugin-updater). Bridges the renderer's `update.*`
//! channels to the plugin: check for updates, mirror state to the chrome via the
//! `update.state` event, and download+install+restart on request. The update feed
//! (endpoints + pubkey) is configured in tauri.conf.json.
use std::sync::Mutex;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Runtime};
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

fn set<R: Runtime>(app: &AppHandle<R>, v: Value) {
    if let Some(s) = app.try_state::<UpdateState>() {
        *s.0.lock().unwrap_or_else(|e| e.into_inner()) = v.clone();
    }
    crate::emit_event(app, "update.state", v);
}

/// Handle `update.*` channels. Returns `None` if not an update channel.
///
/// PLACE 2 of the three-place rule: the channel names live in `shared/types.ts`
/// and the renderer calls them through `ipcClient`. `update.getState` answers the
/// last-known state (the managed `UpdateState`, or `idle()` if it is not
/// registered); `update.checkNow` and `update.restartToInstall` both hand off to
/// `tauri::async_runtime::spawn` and answer `Null` straight away, because the
/// network round-trip and the install must not block the synchronous `ipc`
/// command. Every state transition therefore reaches the chrome through `set`,
/// which is generic too.
///
/// Generic over `R: Runtime` so a `MockRuntime` test can reach the routing and
/// the managed state. Note the platform split it forces: the android-only
/// `android_check` half of `update.checkNow` is `#[cfg(target_os = "android")]`,
/// so its own signature is INVISIBLE to a host build — when this dispatcher's
/// type changed, `android_check` stayed concrete and only the Android build
/// (cargo test / clippy / cargo check on Linux all pass) reported
/// `expected AppHandle, found AppHandle<R>`. A cfg-gated callee of a widened
/// function has to be widened in the same edit.
/// which writes the store AND emits `update.state`.
///
/// Generic over `R: Runtime` so the routing and `getState` are reachable from a
/// `MockRuntime` test; the only production caller is `lib.rs`'s `ipc()`, which
/// infers `Wry`. **The two spawn arms are deliberately NOT asserted on**: on a
/// `MockRuntime` the updater plugin is not registered, so the spawned task would
/// write an `error` state at an unpredictable moment. Waiting for it would be a
/// race, and a flaky test is worse than an honest gap — what they share with
/// `getState` (`set`) and their routing is covered below.
pub fn dispatch<R: Runtime>(
    app: &AppHandle<R>,
    channel: &str,
    _payload: &Value,
) -> Option<Result<Value, String>> {
    match channel {
        "update.getState" => {
            let v = app
                .try_state::<UpdateState>()
                .map(|s| s.0.lock().unwrap_or_else(|e| e.into_inner()).clone())
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
fn android_check<R: Runtime>(app: AppHandle<R>) {
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
    use super::{dispatch, is_newer, newer_android_version, set, UpdateState};
    use crate::test_support::with_tmp_app;
    use serde_json::{json, Value};
    use tauri::{AppHandle, Listener, Manager, Runtime};

    /// The router's answer, panicking on the routing decision itself so a test
    /// can never quietly pass by getting `None` for a channel it owns.
    fn update_call<R: Runtime>(app: &AppHandle<R>, channel: &str) -> Result<Value, String> {
        dispatch(app, channel, &Value::Null)
            .unwrap_or_else(|| panic!("{channel} must be owned by update::dispatch"))
    }

    fn state_now<R: Runtime>(app: &AppHandle<R>) -> Value {
        app.try_state::<UpdateState>()
            .expect("test_support manages update::UpdateState")
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

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
    /// A channel this module does not own must fall through to the single `ipc()`
    /// dispatcher, or two modules would answer the same name. The state is asserted
    /// unchanged as well: an arm that fell through to `set` would otherwise hide.
    #[test]
    fn dispatch_declines_every_channel_it_does_not_own() {
        with_tmp_app(|app| {
            let before = state_now(app);
            for channel in [
                "update",
                "update.getstate",  // wrong case
                "update.GetState",  // wrong case
                "update.state",     // the EVENT name, not a channel
                "update.check",     // not the name (the real one is `checkNow`)
                "update.checkNow ", // trailing space
                "settings.get",
                "nav.getState",
            ] {
                assert!(
                    dispatch(app, channel, &Value::Null).is_none(),
                    "{channel} is not an update channel and must be declined"
                );
            }
            assert_eq!(
                state_now(app),
                before,
                "a declined channel must not write state"
            );
        });
    }

    /// The chrome renders this object before the first check ever runs, so the shape
    /// has to be complete — a missing key is a blank row in the About screen, not a
    /// `undefined` the UI can defend against.
    #[test]
    fn a_get_state_answers_the_idle_shape_a_fresh_install_can_render() {
        with_tmp_app(|app| {
            let v = update_call(app, "update.getState").expect("getState answers");
            assert_eq!(v["status"], json!("idle"));
            assert_eq!(v["version"], Value::Null);
            assert_eq!(v["percent"], json!(0));
            assert_eq!(v["error"], Value::Null);
            // Pin the key SET, not just the four values: a fifth key means
            // `UpdateState` in shared/types.ts is out of step with the core.
            assert_eq!(
                v.as_object().map(|o| o.len()),
                Some(4),
                "the idle state must carry exactly the four shared/types.ts keys"
            );
        });
    }

    /// `set` is the ONLY thing that publishes a state transition, and both spawn arms
    /// go through it — so this pins the two halves a caller depends on: the store the
    /// next `getState` answers from, and the event the chrome is listening for. A
    /// renderer that mounted mid-check reads the store; one already mounted reads the
    /// event. If either half were dropped the UI would show a spinner forever.
    #[test]
    fn a_set_is_what_the_next_get_state_answers_and_the_chrome_is_told() {
        with_tmp_app(|app| {
            let (tx, rx) = std::sync::mpsc::channel();
            let _id = app.listen("update:state", move |e| {
                let _ = tx.send(
                    serde_json::from_str::<Value>(e.payload()).expect("event payload is JSON"),
                );
            });

            let announced = json!({
                "status": "available", "version": "0.2.0", "percent": 0, "error": null
            });
            set(app, announced.clone());

            let got = rx
                .recv_timeout(std::time::Duration::from_secs(5))
                .expect("set must announce the new state on update:state");
            assert_eq!(
                got, announced,
                "the event must carry the state that was set"
            );
            assert_eq!(
                update_call(app, "update.getState").expect("getState answers"),
                announced,
                "getState must answer the store, not a re-derived value"
            );
        });
    }

    /// Both of these do network work, so they hand off and answer at once — answering
    /// only once the work is done would freeze the chrome on a synchronous `ipc`
    /// command, which is exactly the bug the async handoff exists to avoid. `Null` is
    /// the contract: there is nothing to report until `set` publishes a state.
    #[test]
    fn a_check_now_and_a_restart_answer_at_once_rather_than_blocking() {
        with_tmp_app(|app| {
            for channel in ["update.checkNow", "update.restartToInstall"] {
                let v = update_call(app, channel).expect("the handoff arm answers");
                assert!(
                    v.is_null(),
                    "{channel} hands off to a spawn and must answer Null, not a state"
                );
            }
        });
    }
}
