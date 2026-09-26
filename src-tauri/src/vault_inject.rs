// src-tauri/src/vault_inject.rs — In-page badge + autofill JS injection.
//
// Composes the JavaScript that runs in the content webview to:
// 1. Detect password fields (MutationObserver)
// 2. Render an autofill badge near the password field
// 3. Handle badge clicks (smart fill: one match = instant, multiple = pick)
// 4. Listen for form submission to enable save prompt

use std::sync::LazyLock;

/// The composed autofill injection script (loaded once from vault_inject.js).
pub static AUTOFILL_SCRIPT: LazyLock<String> =
    LazyLock::new(|| include_str!("vault_inject.js").to_string());

/// Return the full autofill injection script to append to document-start JS.
pub fn script() -> String {
    AUTOFILL_SCRIPT.clone()
}

/// JNI bridge for Android's `NativeFormDetect.formDetectionScript()`. Returns the vault
/// autofill / form-detection JS for injection at document-start. Registered as a per-tab
/// document-start script in `MainActivity.createTabWebView`. Null jstring on failure
/// (Kotlin skips registration).
#[cfg(target_os = "android")]
#[allow(unsafe_code)]
// `#[no_mangle]` is itself linted as `unsafe_code`: overriding the linker's symbol
// name means two libraries could export the same symbol, which the linker leaves
// undefined. That is inherent to every JNI entry point (Kotlin resolves the symbol
// by name), so it is allowed here explicitly rather than by the module scope —
// `deny(unsafe_code)` in lib.rs would otherwise break every Android build.
#[no_mangle]
pub extern "system" fn Java_com_aegis_browser_NativeFormDetect_formDetectionScript<'a>(
    env: jni::JNIEnv<'a>,
    _this: jni::objects::JObject<'a>,
) -> jni::sys::jstring {
    // An empty script is the same effective outcome as the null-jstring failure below
    // (Kotlin registers nothing either way), so a panic degrades to "no injection".
    let s = crate::ffi_guard(script).unwrap_or_default();
    match env.new_string(s) {
        Ok(js) => js.into_raw(),
        Err(_) => std::ptr::null_mut(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn script_is_not_empty() {
        let s = script();
        assert!(!s.is_empty());
        assert!(s.contains("MutationObserver") || s.contains("mutationObserver"));
    }

    #[test]
    fn script_has_no_unfilled_placeholders() {
        let s = script();
        assert!(!s.contains("{{"), "Script contains unfilled placeholders");
    }

    #[test]
    fn script_is_self_containing_iife() {
        let s = script();
        // Strip leading comment lines — the IIFE may be preceded by JS comments.
        let trimmed = s
            .lines()
            .skip_while(|l| l.starts_with("//") || l.trim().is_empty())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            trimmed.starts_with("(function"),
            "Script must be an IIFE (after comments)"
        );
        assert!(
            trimmed.trim_end().ends_with("})();"),
            "Script must close as IIFE"
        );
    }
}
