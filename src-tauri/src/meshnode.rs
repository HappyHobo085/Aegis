//! Local Meshnode detection — the `meshnode.detected` channel.
//!
//! When a Meshnode runs on this device, the Sync tab OFFERS its local sync gateway
//! ([`LOCAL_SYNC_URL`]) as the server URL. This module only answers "is Meshnode here?". It
//! never connects to Meshnode, never sends it anything, and never writes a setting: the URL is
//! applied only when the user presses the button in the Sync tab.
//!
//! How each platform answers:
//! - **Windows** — the default data dir's admin pipe `\\.\pipe\meshnode-admin` exists. Checked
//!   with `WaitNamedPipeW(name, 1 ms)`, which asks the pipe filesystem whether an instance
//!   exists WITHOUT opening one: `std::fs::metadata` / `GetFileAttributesW` on a pipe path go
//!   through `CreateFile`, which CONNECTS (taking an instance from the server). The timeout is
//!   1 ms, not 0: 0 means `NMPWAIT_USE_DEFAULT_WAIT`, the server's own default wait. A pipe
//!   whose instances are all busy times out with `ERROR_SEM_TIMEOUT`, which still means it
//!   exists. A user-mode daemon (`%LOCALAPPDATA%\Meshnode`) names its pipe
//!   `meshnode-admin-<8 hex>`; v1 detects the default pipe only.
//! - **Linux / macOS** — `<default data dir>/admin.sock` exists and is a socket
//!   (`/var/lib/meshnode`, `/Library/Application Support/Meshnode`). A `stat`, no connect.
//! - **Android** — the `net.meshnode.app` package is installed. Only Kotlin can ask the
//!   `PackageManager`, so `MainActivity.noteMeshnodeInstalled()` asks on every `onResume` and
//!   pushes the answer through `NativeMeshnode.noteInstalled` into [`ANDROID_INSTALLED`].
//!
//! The decision is [`detect_meshnode`], a pure function over an injected "endpoint exists"
//! probe, so it is unit-tested on every OS; [`endpoint_exists`] is the real probe.

use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Runtime};

/// Meshnode's local sync gateway — the URL the Sync tab offers. Fixed by Meshnode's
/// `services/aegis-sync` listener; plain `http://` is fine because it is loopback
/// (`sync::validated_base` allows loopback without the insecure waiver).
pub const LOCAL_SYNC_URL: &str = "http://127.0.0.1:7801";

/// Meshnode's Android application id, mirrored as `NativeMeshnode.PACKAGE` in Kotlin and in
/// the manifest's `<queries>` entry.
#[allow(dead_code)] // read by the tests that pin the Kotlin and manifest copies
pub const ANDROID_PACKAGE: &str = "net.meshnode.app";

/// Whether `net.meshnode.app` is installed, as last pushed by `MainActivity`. Only Android
/// ever writes it; elsewhere it stays `false` and [`detect_meshnode`] ignores it.
pub(crate) static ANDROID_INSTALLED: AtomicBool = AtomicBool::new(false);

/// The admin endpoint of Meshnode's DEFAULT data dir on `os` (a `std::env::consts::OS`
/// value), or `None` where there is no endpoint Aegis may look at.
pub fn admin_endpoint(os: &str) -> Option<&'static str> {
    match os {
        "windows" => Some(r"\\.\pipe\meshnode-admin"),
        "linux" => Some("/var/lib/meshnode/admin.sock"),
        "macos" => Some("/Library/Application Support/Meshnode/admin.sock"),
        _ => None,
    }
}

/// Is Meshnode present on `os`? Android answers from the package flag; a desktop OS asks
/// `endpoint_exists` about its admin endpoint; anything else is `false` without probing.
pub fn detect_meshnode(
    os: &str,
    android_installed: bool,
    endpoint_exists: impl FnOnce(&str) -> bool,
) -> bool {
    if os == "android" {
        return android_installed;
    }
    admin_endpoint(os).is_some_and(endpoint_exists)
}

/// The real check for this device.
pub fn meshnode_detected() -> bool {
    detect_meshnode(
        std::env::consts::OS,
        ANDROID_INSTALLED.load(Ordering::Relaxed),
        endpoint_exists,
    )
}

/// The `meshnode.detected` reply.
pub fn state_json(detected: bool) -> Value {
    json!({ "detected": detected, "url": LOCAL_SYNC_URL })
}

/// Does the named pipe `path` exist? Never opens it — see the module docs.
#[cfg(windows)]
#[allow(unsafe_code)] // FFI/platform glue; see the deny(unsafe_code) in lib.rs
fn endpoint_exists(path: &str) -> bool {
    use windows::core::HSTRING;
    use windows::Win32::Foundation::{GetLastError, ERROR_SEM_TIMEOUT};
    use windows::Win32::System::Pipes::WaitNamedPipeW;

    // SAFETY: a valid NUL-terminated wide string; the call only queries the pipe filesystem.
    let ready = unsafe { WaitNamedPipeW(&HSTRING::from(path), 1) };
    if ready.as_bool() {
        return true;
    }
    // SAFETY: reads this thread's last-error value, set by the call above.
    let err = unsafe { GetLastError() };
    err == ERROR_SEM_TIMEOUT
}

/// Does the Unix socket `path` exist? A `stat` only; a regular file of that name is not it.
#[cfg(unix)]
fn endpoint_exists(path: &str) -> bool {
    use std::os::unix::fs::FileTypeExt;
    std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_socket())
}

#[cfg(not(any(windows, unix)))]
fn endpoint_exists(_path: &str) -> bool {
    false
}

/// Android JNI: `NativeMeshnode.noteInstalled(installed)` — `MainActivity` reports whether the
/// Meshnode package is installed (on every `onResume`).
#[cfg(target_os = "android")]
#[allow(unsafe_code)]
// `#[no_mangle]` is linted as `unsafe_code`; every JNI entry point needs it (see settings.rs).
#[no_mangle]
pub extern "system" fn Java_com_aegis_browser_NativeMeshnode_noteInstalled(
    _env: jni::JNIEnv<'_>,
    _this: jni::objects::JObject<'_>,
    installed: jni::sys::jboolean,
) {
    // One atomic store cannot panic, but the guard keeps a later edit from unwinding into Java.
    let _ = crate::ffi_guard(|| ANDROID_INSTALLED.store(installed != 0, Ordering::Relaxed));
}

/// Route `meshnode.*` IPC channels. Returns `None` for unowned channels.
pub fn dispatch<R: Runtime>(
    _app: &AppHandle<R>,
    channel: &str,
    _payload: &Value,
) -> Option<Result<Value, String>> {
    match channel {
        "meshnode.detected" => Some(Ok(state_json(meshnode_detected()))),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    /// The URL is a fixed contract with Meshnode's local sync listener, not a guess: the UI
    /// offers exactly this string, so a typo here is a suggestion that can never connect.
    #[test]
    fn detect_meshnode_state_json_carries_the_fixed_local_url() {
        assert_eq!(LOCAL_SYNC_URL, "http://127.0.0.1:7801");
        assert_eq!(
            state_json(true),
            serde_json::json!({ "detected": true, "url": "http://127.0.0.1:7801" })
        );
        assert_eq!(
            state_json(false),
            serde_json::json!({ "detected": false, "url": "http://127.0.0.1:7801" })
        );
    }

    #[test]
    fn detect_meshnode_is_true_when_the_admin_endpoint_exists() {
        for os in ["windows", "linux", "macos"] {
            assert!(detect_meshnode(os, false, |_| true), "{os}");
        }
    }

    #[test]
    fn detect_meshnode_is_false_when_the_admin_endpoint_is_missing() {
        for os in ["windows", "linux", "macos"] {
            assert!(!detect_meshnode(os, false, |_| false), "{os}");
            // The Android package flag means nothing on a desktop OS.
            assert!(!detect_meshnode(os, true, |_| false), "{os}");
        }
    }

    /// Each desktop OS probes the admin endpoint of Meshnode's DEFAULT data dir, and only
    /// that one path.
    #[test]
    fn detect_meshnode_probes_the_default_data_dir_endpoint_per_os() {
        let cases = [
            ("windows", r"\\.\pipe\meshnode-admin"),
            ("linux", "/var/lib/meshnode/admin.sock"),
            ("macos", "/Library/Application Support/Meshnode/admin.sock"),
        ];
        for (os, want) in cases {
            let seen = RefCell::new(Vec::<String>::new());
            detect_meshnode(os, false, |p| {
                seen.borrow_mut().push(p.to_string());
                true
            });
            assert_eq!(seen.into_inner(), vec![want.to_string()], "{os}");
            assert_eq!(admin_endpoint(os), Some(want), "{os}");
        }
    }

    /// Android has no admin endpoint Aegis may look at; it answers from the package flag that
    /// `MainActivity` pushes, and must never call the filesystem probe.
    #[test]
    fn detect_meshnode_on_android_follows_the_package_flag_and_never_probes() {
        let probe = |p: &str| -> bool { panic!("android must not probe {p}") };
        assert!(detect_meshnode("android", true, probe));
        assert!(!detect_meshnode("android", false, probe));
        assert_eq!(admin_endpoint("android"), None);
    }

    #[test]
    fn detect_meshnode_is_false_on_an_os_with_no_known_endpoint() {
        let probe = |p: &str| -> bool { panic!("ios must not probe {p}") };
        assert!(!detect_meshnode("ios", true, probe));
        assert!(!detect_meshnode("freebsd", false, probe));
        assert_eq!(admin_endpoint("ios"), None);
    }

    /// The channel answers on every platform, with the shape the renderer reads.
    #[test]
    fn detect_meshnode_dispatch_answers_the_channel_and_ignores_others() {
        // A bare mock app, not `with_tmp_app`: this module owns no store and needs no managed
        // state. (A bare mock app resolves `app_data_dir()` to the REAL data-dir root, so a
        // test that does store IO must use `with_tmp_app`, which redirects it on every OS.)
        let app = tauri::test::mock_app();
        let app = app.handle();
        let v = dispatch(app, "meshnode.detected", &serde_json::Value::Null)
            .expect("meshnode.detected is owned here")
            .expect("never an error");
        assert!(v["detected"].is_boolean());
        assert_eq!(v["url"], "http://127.0.0.1:7801");
        assert!(dispatch(app, "sync.getState", &serde_json::Value::Null).is_none());
    }

    // ---- the real Windows probe -------------------------------------------------------

    #[cfg(windows)]
    fn unique_pipe_name(tag: &str) -> String {
        format!(
            r"\\.\pipe\aegis-meshnode-probe-test-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        )
    }

    #[cfg(windows)]
    #[test]
    fn detect_meshnode_pipe_probe_is_false_for_a_missing_pipe() {
        assert!(!endpoint_exists(&unique_pipe_name("missing")));
    }

    /// The probe must see a live pipe WITHOUT connecting to it. The server below allows ONE
    /// instance; if the probe had opened it, that instance would be taken and the client open
    /// afterwards would fail with ERROR_PIPE_BUSY.
    #[cfg(windows)]
    #[test]
    #[allow(unsafe_code)] // creating a named pipe server has no safe std API
    fn detect_meshnode_pipe_probe_sees_a_live_pipe_without_taking_its_instance() {
        use windows::core::HSTRING;
        use windows::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
        use windows::Win32::Storage::FileSystem::PIPE_ACCESS_DUPLEX;
        use windows::Win32::System::Pipes::{CreateNamedPipeW, PIPE_TYPE_BYTE, PIPE_WAIT};

        let name = unique_pipe_name("live");
        // SAFETY: plain Win32 call with a valid, NUL-terminated HSTRING and no security attrs.
        let server = unsafe {
            CreateNamedPipeW(
                &HSTRING::from(name.as_str()),
                PIPE_ACCESS_DUPLEX,
                PIPE_TYPE_BYTE | PIPE_WAIT,
                1,
                0,
                0,
                0,
                None,
            )
        };
        assert_ne!(
            server, INVALID_HANDLE_VALUE,
            "could not create the test pipe"
        );

        assert!(endpoint_exists(&name), "the probe must see a live pipe");
        assert!(
            endpoint_exists(&name),
            "and keep seeing it (nothing was consumed)"
        );

        let client = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&name);
        assert!(
            client.is_ok(),
            "the single pipe instance must still be free after probing: {client:?}"
        );
        drop(client);
        // SAFETY: `server` is the valid handle created above, closed exactly once.
        unsafe {
            let _ = CloseHandle(server);
        }
    }

    // ---- the real Unix probe ----------------------------------------------------------

    #[cfg(unix)]
    #[test]
    fn detect_meshnode_socket_probe_sees_a_socket_and_ignores_a_plain_file() {
        let dir = std::env::temp_dir().join(format!(
            "aegis-meshnode-probe-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let sock = dir.join("admin.sock");
        let file = dir.join("plain.sock");
        let _listener = std::os::unix::net::UnixListener::bind(&sock).unwrap();
        std::fs::write(&file, b"").unwrap();
        assert!(endpoint_exists(sock.to_str().unwrap()));
        assert!(!endpoint_exists(file.to_str().unwrap()));
        assert!(!endpoint_exists(dir.join("absent.sock").to_str().unwrap()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- the Android half -------------------------------------------------------------
    //
    // There is deliberately NO cleartext waiver to pin: Aegis sync runs in Rust, which never
    // reads Android's cleartext policy, and `sync::validated_base` already allows loopback
    // `http://`. Release keeps `usesCleartextTraffic="false"` with no network security config.

    fn android_file(rel: &str) -> String {
        let path = format!("{}/{rel}", env!("CARGO_MANIFEST_DIR"));
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("cannot read {path}: {e}"))
    }

    /// XML with every `<!-- … -->` comment removed, so a pin cannot be satisfied by a
    /// comment that quotes the markup.
    fn strip_xml_comments(src: &str) -> String {
        let mut out = String::new();
        let mut rest = src;
        while let Some(start) = rest.find("<!--") {
            out.push_str(&rest[..start]);
            let end = rest[start..]
                .find("-->")
                .unwrap_or_else(|| panic!("unterminated XML comment"));
            rest = &rest[start + end + 3..];
        }
        out.push_str(rest);
        out
    }

    /// The manifest declares the Meshnode package query: without it, API 30+ package
    /// visibility hides the package and detection is always false.
    #[test]
    fn android_manifest_queries_the_meshnode_package() {
        let manifest = strip_xml_comments(&android_file(
            "gen/android/app/src/main/AndroidManifest.xml",
        ));
        let q = manifest.find("<queries>").expect("a <queries> block");
        let q_end = manifest.find("</queries>").expect("</queries>");
        assert!(manifest[q..q_end].contains(r#"<package android:name="net.meshnode.app" />"#));
        assert_eq!(ANDROID_PACKAGE, "net.meshnode.app");
    }

    /// The Kotlin half: `MainActivity` re-checks the package on every resume (the user can
    /// install Meshnode while Aegis is in the background) and pushes the answer to Rust.
    #[test]
    fn android_activity_pushes_the_package_check_on_resume() {
        let src = crate::test_support::kotlin_source("MainActivity.kt");
        let on_resume = crate::test_support::kotlin_fn_body(&src, "override fun onResume()");
        assert!(on_resume.contains("noteMeshnodeInstalled()"), "{on_resume}");
        let note = crate::test_support::kotlin_fn_body(&src, "private fun noteMeshnodeInstalled()");
        assert!(note.contains("NativeMeshnode.noteInstalled("), "{note}");
        assert!(note.contains("getPackageInfo("), "{note}");
        assert!(note.contains("NativeMeshnode.PACKAGE"), "{note}");
        let bridge = crate::test_support::kotlin_production_source(
            &crate::test_support::kotlin_source("NativeMeshnode.kt"),
        );
        assert!(bridge.contains(r#"const val PACKAGE = "net.meshnode.app""#));
        assert!(bridge.contains("external fun noteInstalled(installed: Boolean)"));
    }
}
