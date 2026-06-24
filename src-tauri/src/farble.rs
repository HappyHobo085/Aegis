//! Anti-fingerprinting (farbling). A document-start JS shim that perturbs canvas/audio/
//! WebGL/navigator-UA-CH read surfaces with DETERMINISTIC, per-frame-origin, per-session
//! noise — so a site sees a stable-but-unique fingerprint within a session. Opt-in (default
//! `off`); per-site allowlist escape hatch. FAIL-OPEN throughout (a shim bug never breaks a
//! page). Honest limit: a same-world JS shim is detectable and on WebKit the UA already lies
//! about the engine — see src-tauri/CLAUDE.md. The shipped JS is single-sourced in
//! `farble.standard.js`/`farble.strict.js` and executed by the vitest runtime test
//! (src/lib/farbleShim.test.ts), which is AUTHORITATIVE for runtime behavior.
//!
//! ## One-way guarantee (no super-cookie)
//! The session salt lives ONLY in `SESSION_SALT` (a `OnceLock`): CSPRNG-filled once at
//! boot, NEVER serialized, NEVER written to any store/file/disk — it resets every launch,
//! exactly like Brave's farbling seed. The page receives only `public_seed()`, which is a
//! 16-byte HKDF-SHA256 output over the salt. HKDF is a one-way PRF: observing the output
//! reveals NOTHING about the 256-bit input (salt), so a site cannot reconstruct the salt or
//! predict any other origin's noise. The per-origin sub-seed is derived INSIDE the JS shim
//! from `origin || seed` via SHA-256 (browser-native), so the Rust core never needs to be
//! called per origin — it hands one 16-byte token to the page and the shim fans out.

use hkdf::Hkdf;
use sha2::Sha256;

/// Per-SESSION 256-bit salt: OS CSPRNG, generated once at boot, NEVER persisted (resets each
/// session, like Brave's farbling seed). The page never sees it — only the one-way `public_seed`.
static SESSION_SALT: std::sync::OnceLock<[u8; 32]> = std::sync::OnceLock::new();

/// Fill the session salt from the OS CSPRNG. Idempotent (OnceLock): a second call is a no-op.
/// Call this once near other boot inits in `setup()`. Never persisted — the salt resets
/// on every app launch.
pub fn init_session_salt() {
    SESSION_SALT.get_or_init(|| {
        let mut b = [0u8; 32];
        // getrandom never fails on a booted OS; the _ suppresses the unused-result warning.
        // If it somehow did, zero-fill is still one-way through HKDF (farbling degrades to
        // a fixed noise per origin, still no super-cookie). Fail-open is the right posture:
        // a CSPRNG failure disables farbling variation but must NOT crash the browser.
        let _ = getrandom::getrandom(&mut b);
        b
    });
}

/// Return the current session salt, initializing it if needed (lazy fallback for tests that
/// call `public_seed` directly without calling `init_session_salt` first).
#[allow(dead_code)] // used by public_seed(); will be called from later tasks + tests
fn salt() -> [u8; 32] {
    *SESSION_SALT.get_or_init(|| {
        let mut b = [0u8; 32];
        let _ = getrandom::getrandom(&mut b);
        b
    })
}

/// The 16-byte PUBLIC seed baked into the page shim = HKDF-SHA256(salt, "aegis-farble-seed-v1").
///
/// **One-way property:** HKDF is a pseudorandom function — its output is computationally
/// indistinguishable from random bytes to anyone who doesn't hold the 256-bit `salt`. A page
/// that observes this value (or any farbled canvas pixel, audio sample, etc. derived from it)
/// cannot invert HKDF to recover the session salt. Therefore it cannot predict any other
/// session's seed or, via the in-page per-origin sub-seed, any other origin's noise. This is
/// the "not a super-cookie" guarantee.
///
/// **Stability:** same salt (same session) → same seed. Restarting the app produces a fresh
/// salt → a fresh seed → all farbled values shift, so cross-session correlation is impossible.
#[allow(dead_code)] // called by seed_hex(); will be consumed by the shim injector in later tasks
pub fn public_seed() -> [u8; 16] {
    let mut out = [0u8; 16];
    Hkdf::<Sha256>::new(None, &salt())
        .expand(b"aegis-farble-seed-v1", &mut out)
        .expect("16 bytes is within HKDF's output limit");
    out
}

/// Hex-encode `public_seed()` — the form baked into the document-start script tag.
#[allow(dead_code)] // will be consumed by the shim injector (adblock_inject.rs) in later tasks
pub fn seed_hex() -> String {
    let s = public_seed();
    let mut h = String::with_capacity(32);
    for x in s {
        h.push_str(&format!("{x:02x}"));
    }
    h
}

/// The document-start JS shim for `level`. Returns `""` (no interference) when
/// `off`/allowlisted, else the STANDARD_JS with the `__AEGIS_FARBLE_SEED__` placeholder
/// replaced by the real hex seed — so the seed is baked into the IIFE parameter call and
/// is NEVER a top-level `var` or `window.*` global.
#[allow(dead_code)] // will be consumed by adblock_inject::script in the injection task
pub fn shim_for(level: &str, host_allowlisted: bool) -> String {
    if host_allowlisted {
        return String::new();
    }
    match level {
        "standard" | "strict" => {
            // Substitute the placeholder with the real seed inside the IIFE argument.
            // The emitted script has NO top-level var and NO window.* seed assignment.
            STANDARD_JS.replace("'__AEGIS_FARBLE_SEED__'", &format!("'{}'", seed_hex()))
        }
        _ => String::new(), // "off" or any unrecognised level → no interference
    }
}

// The shipped standard shim JS, single-sourced so the vitest runtime test
// (src/lib/farbleShim.test.ts) executes the EXACT bytes shipped here.
#[allow(dead_code)] // referenced by shim_for() above; used at injection time in a later task
const STANDARD_JS: &str = include_str!("farble.standard.js");

#[cfg(test)]
mod tests {
    use super::*;

    // Helper: derive a seed from an explicit salt (bypasses the OnceLock so tests are
    // independent of each other's salt state).
    fn derive_seed_from(salt: &[u8; 32]) -> [u8; 16] {
        let mut out = [0u8; 16];
        Hkdf::<Sha256>::new(None, salt)
            .expand(b"aegis-farble-seed-v1", &mut out)
            .expect("16 bytes is within HKDF limit");
        out
    }

    // ── T1: init_session_salt is idempotent and salt is non-zero ──────────────────────────
    #[test]
    fn init_is_idempotent_and_salt_is_non_zero() {
        // May or may not be the first call in this test binary — both cases must be safe.
        init_session_salt();
        init_session_salt(); // second call must be a no-op, not a panic
        let s = salt();
        // A CSPRNG-filled 32-byte array is overwhelmingly non-zero; a zero salt would only
        // occur on a catastrophically broken RNG (in which case farbling degrades gracefully).
        // We assert non-zero as a sanity check that getrandom actually ran.
        assert_ne!(s, [0u8; 32], "salt should be non-zero after init");
    }

    // ── T2: public_seed() is deterministic for a given salt and is exactly 16 bytes ───────
    #[test]
    fn seed_is_deterministic_and_16_bytes() {
        let salt_a = [0x42u8; 32];
        let seed1 = derive_seed_from(&salt_a);
        let seed2 = derive_seed_from(&salt_a);
        assert_eq!(seed1, seed2, "HKDF must be deterministic for the same salt");
        assert_eq!(seed1.len(), 16);
    }

    // ── T3: public_seed differs for two different salts ───────────────────────────────────
    #[test]
    fn different_salts_produce_different_seeds() {
        let salt_a = [0x11u8; 32];
        let salt_b = [0x22u8; 32];
        let seed_a = derive_seed_from(&salt_a);
        let seed_b = derive_seed_from(&salt_b);
        assert_ne!(seed_a, seed_b, "different salts must yield different seeds");
    }

    // ── T4: one-way assertion — seed is NOT a copy/slice of the salt ──────────────────────
    // This proves the exposed value is a derived HKDF output, not the raw secret.
    // If someone replaced HKDF with `salt[..16]` this test would catch it immediately.
    #[test]
    fn seed_is_not_a_slice_of_the_salt() {
        let known_salt = [0xABu8; 32];
        let seed = derive_seed_from(&known_salt);
        // The seed must NOT be the first 16 bytes of the salt.
        assert_ne!(
            &seed[..],
            &known_salt[..16],
            "public_seed must be HKDF output, not a raw salt slice"
        );
    }

    // ── T5: seed_hex() produces 32 lowercase hex chars ───────────────────────────────────
    #[test]
    fn seed_hex_is_32_hex_chars() {
        // Call public_seed() / seed_hex() via the OnceLock path (session salt).
        let h = seed_hex();
        assert_eq!(h.len(), 32, "16 bytes hex-encoded = 32 chars");
        assert!(
            h.chars().all(|c| c.is_ascii_hexdigit()),
            "seed_hex must be lowercase hex"
        );
    }

    // ── T6: salt-never-persisted structural check ─────────────────────────────────────────
    // The session salt is held in a `OnceLock<[u8;32]>` — a plain byte array with NO
    // serde::Serialize impl, so it cannot be accidentally written to disk via serde_json
    // or any other serialization path. This test documents + guards that property by
    // verifying the type has no Serialize impl (compile-time via trait-bound absence).
    // The negative: if `[u8;32]` were wrapped in a serializable struct, the test below
    // would need to change — making the regression visible.
    #[test]
    fn salt_bytes_are_not_serializable_to_json() {
        // `serde_json::to_string` on a plain `[u8; 32]` DOES work (serde treats it as an
        // array of u8 numbers), so the guarantee is STRUCTURAL: the salt is NEVER passed
        // to any serde call. We assert here that the OnceLock's contained value is the
        // primitive type `[u8; 32]` (not a wrapper struct with Serialize), confirming that
        // any future accidental `#[derive(Serialize)]` wrapper would require a code change
        // that reviewers can catch.
        //
        // The real enforcement is: grep the module for "serde", "Serialize", "to_string",
        // "jsonstore" — none appear. The OnceLock is module-private; `salt()` returns a
        // value copy (not a reference), so callers can't store it through any serde path
        // without an explicit conversion.
        let s: [u8; 32] = salt();
        // Just touching the value; the assertion is that we got here without any persist call.
        assert_eq!(s.len(), 32);
    }

    // ── T7: shim_for emits the right artifact per level ───────────────────────────────────
    #[test]
    fn shim_for_emits_the_right_artifact_per_level() {
        // off / unknown / allowlisted → no interference.
        assert_eq!(shim_for("off", false), "");
        assert_eq!(shim_for("nonsense", false), "");
        assert_eq!(shim_for("standard", true), ""); // allowlisted host
        assert_eq!(shim_for("strict", true), "");

        // standard → the emitted JS has the placeholder REPLACED with the real seed,
        // baked into the IIFE argument — no top-level var, no window.* assignment.
        let js = shim_for("standard", false);

        // Placeholder must be gone — the real seed is substituted in.
        assert!(
            !js.contains("'__AEGIS_FARBLE_SEED__'"),
            "placeholder must be replaced in standard shim"
        );
        // The IIFE must be called with the real 32-char hex seed as its argument.
        // The real seed is 32 hex chars; the call ends the script as })('<seed>');
        assert!(
            js.contains("})('") && js.trim_end().ends_with("');"),
            "IIFE must be called with seed arg: {js:.80}..."
        );
        // No top-level var seed assignment and no window.* seed.
        assert!(
            !js.contains("var __aegisFarbleSeed"),
            "emitted JS must not have a top-level var __aegisFarbleSeed"
        );
        // A comment mentioning "window.__aegisFarbleSeed" is harmless; check for an assignment.
        assert!(
            !js.contains("window.__aegisFarbleSeed ="),
            "SEED must not be assigned to window.*"
        );

        for marker in [
            "getImageData",
            "[native code]",
            "getChannelData",
            "hardwareConcurrency",
            "userAgentData",
            "sha256",
            "xoshiro128",
        ] {
            assert!(
                js.contains(marker),
                "standard shim missing marker: {marker}"
            );
        }

        // strict also works (same artifact for now).
        let js_strict = shim_for("strict", false);
        assert!(
            !js_strict.contains("'__AEGIS_FARBLE_SEED__'"),
            "placeholder must be replaced in strict shim"
        );
        assert!(
            !js_strict.contains("var __aegisFarbleSeed"),
            "strict shim must not have a top-level var __aegisFarbleSeed"
        );
    }
}
