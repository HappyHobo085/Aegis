//! Request authentication: the `AegisSig` token shape, its canonical signed bytes, and every
//! check on it that does not need server state.
//!
//! The auth `canonical()` + token shape below MUST match src-tauri/src/sync_auth.rs
//! byte-for-byte (kept in sync by hand; covered by the round-trip test).
//!
//! What is NOT here is the replay-nonce bookkeeping: it is state, so it belongs to the host.
//! [`check_token`] decides whether a token is acceptable at all; the host then runs its own
//! authorization (`admit`) and only after that records the `(device, nonce)` pair. See
//! `verify_auth` in `sync-server/src/main.rs` for why that order is load-bearing.
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};

// ----------------------------------------------------------------------------- auth

#[derive(Serialize, Deserialize)]
pub struct AuthToken {
    pub account_id: String,
    pub device_id: String,
    pub issued_ms: i64,
    pub expires_ms: i64,
    pub nonce: String,
}

/// MUST match src-tauri/src/sync_auth.rs `canonical` byte-for-byte.
pub fn canonical(t: &AuthToken) -> Vec<u8> {
    format!(
        "aegis-auth-v1\n{}\n{}\n{}\n{}\n{}",
        t.account_id, t.device_id, t.issued_ms, t.expires_ms, t.nonce
    )
    .into_bytes()
}

pub fn unhex(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok())
        .collect()
}

/// Lower-case hex only — the one spelling of an id this server will store or compare.
pub fn is_canonical_hex(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Maximum token validity span. MUST be >= the client's `DEFAULT_TTL_MS`
/// (`src-tauri/src/sync_auth.rs`) so honest clients are never rejected; the server enforces it
/// because `expires_ms` is inside the signed-but-self-chosen token body.
pub const MAX_TTL_MS: i64 = 5 * 60_000;
/// Tolerance for a client whose clock runs slightly ahead of the server's.
pub const MAX_FUTURE_SKEW_MS: i64 = 60_000;
/// Tolerance for a client whose clock runs behind, and the bound on replaying a token that was
/// captured long ago (its own `expires_ms` may still be in the future if the attacker minted it).
pub const MAX_PAST_SKEW_MS: i64 = 5 * 60_000;
/// Hard cap on the replay-nonce map so a long-lived process can't grow it without bound. Each
/// authenticated request inserts one entry and the sweep only removes EXPIRED ones, so a
/// high-rate client needs a real ceiling. At the 5-minute TTL this holds ~1 hour of 12k req/s.
pub const MAX_SEEN_NONCES: usize = 250_000;

/// Per-device ceiling on live nonces. The global `MAX_SEEN_NONCES` alone made backpressure
/// *shared*: one high-rate (or hostile) paired device filled the map and every other device on
/// the server got a `429` for up to the 5-minute TTL. Capping per device turns that into "the
/// abusive device is refused on its own while everyone else keeps syncing"; the global cap stays
/// as the memory backstop. 2_000 entries at the 5-minute TTL is ~10 minutes at a sustained 3.3
/// req/s, far above any real client, and 2_000 x 125 devices still fits under the global cap.
pub const MAX_SEEN_NONCES_PER_DEVICE: usize = 2_000;

/// Longest wire nonce accepted. A real client sends 16 random bytes as 32 hex chars
/// (`src-tauri/src/sync_auth.rs` `mint`); the nonce is stored for the token's whole lifetime, so
/// an unbounded caller-chosen string was memory the caller chose how much of to spend.
pub const MAX_NONCE_HEX_LEN: usize = 64;

/// Why [`check_token`] refused a token. Every variant is a `401` on the wire; the reason exists
/// for tests and logs, never for the response body (telling a caller WHICH check failed would
/// only help it forge the next attempt).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthError {
    /// `account_id` or `device_id` is not canonical lower-case hex.
    NonCanonicalId,
    /// The nonce is empty, longer than [`MAX_NONCE_HEX_LEN`], or not hex.
    BadNonce,
    /// `now > expires_ms`.
    Expired,
    /// `issued_ms` is more than [`MAX_FUTURE_SKEW_MS`] ahead of `now`.
    IssuedInFuture,
    /// `issued_ms` is more than [`MAX_PAST_SKEW_MS`] behind `now`.
    IssuedTooLongAgo,
    /// `expires_ms - issued_ms` exceeds [`MAX_TTL_MS`].
    TtlTooLong,
    /// `device_id` is not a valid 32-byte Ed25519 public key.
    BadDeviceKey,
    /// The signature is malformed or does not verify over [`canonical`].
    BadSignature,
}

/// A token that passed [`check_token`]: the authenticated ids plus what the host needs to record
/// the spent nonce (it is single-use until `expires_ms`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Verified {
    pub account_id: String,
    pub device_id: String,
    pub nonce: String,
    pub expires_ms: i64,
}

/// Every stateless check `verify_auth` makes on a parsed token, in the same order: canonical ids,
/// nonce shape, lifetime bounds against `now_ms`, then the Ed25519 signature by `device_id` over
/// [`canonical`]. `sig_hex` is the third `.`-separated part of the `Authorization` header.
///
/// Does NOT check the header's account against `token.account_id` (that is header parsing) and
/// does NOT touch replay state: the caller records `(device_id, nonce)` only after its own
/// `admit` decision passes.
pub fn check_token(token: &AuthToken, now_ms: i64, sig_hex: &str) -> Result<Verified, AuthError> {
    // CANONICAL IDS ONLY. `unhex` accepts upper-case digits, so `ABCD…` and `abcd…` decode to the
    // same key while being different strings — and every map this server keys on a device or
    // account (`devices`, `revoked`, `owner`, `pending`) compares STRINGS. A revoked device could
    // re-register under an upper-cased spelling of its own id. Clients emit lower-case hex
    // (`crypto::hex`), so refusing anything else costs an honest client nothing.
    if !is_canonical_hex(&token.account_id) || !is_canonical_hex(&token.device_id) {
        return Err(AuthError::NonCanonicalId);
    }
    if token.nonce.is_empty()
        || token.nonce.len() > MAX_NONCE_HEX_LEN
        || !token.nonce.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err(AuthError::BadNonce);
    }
    let now = now_ms;
    // LIFETIME BOUNDS. `expires_ms` is attacker-controlled (anyone holding one device key can
    // sign their own token), so both the forward window and the *span* must be clamped:
    //   - already expired                      -> reject
    //   - issued in the future                 -> reject (clock-skew allowance only)
    //   - issued implausibly long ago          -> reject (a stale replayed token)
    //   - validity span longer than MAX_TTL_MS -> reject (would be valid FOREVER)
    // Without the span clamp a captured `Authorization` header can be replayed indefinitely,
    // and because `seen` stores the token's OWN expires_ms the replay set never gets swept.
    if now > token.expires_ms {
        return Err(AuthError::Expired);
    }
    if token.issued_ms > now + MAX_FUTURE_SKEW_MS {
        return Err(AuthError::IssuedInFuture);
    }
    if token.issued_ms < now - MAX_PAST_SKEW_MS {
        return Err(AuthError::IssuedTooLongAgo);
    }
    if token.expires_ms.saturating_sub(token.issued_ms) > MAX_TTL_MS {
        return Err(AuthError::TtlTooLong);
    }
    let vk_bytes: [u8; 32] = unhex(&token.device_id)
        .and_then(|b| b.try_into().ok())
        .ok_or(AuthError::BadDeviceKey)?;
    let vk = VerifyingKey::from_bytes(&vk_bytes).map_err(|_| AuthError::BadDeviceKey)?;
    let sig_bytes: [u8; 64] = unhex(sig_hex)
        .and_then(|b| b.try_into().ok())
        .ok_or(AuthError::BadSignature)?;
    let sig = Signature::from_bytes(&sig_bytes);
    vk.verify_strict(&canonical(token), &sig)
        .map_err(|_| AuthError::BadSignature)?;
    Ok(Verified {
        account_id: token.account_id.clone(),
        device_id: token.device_id.clone(),
        nonce: token.nonce.clone(),
        expires_ms: token.expires_ms,
    })
}

/// Compare two byte strings without an early exit on the first differing byte, so the time a
/// wrong registration secret takes to refuse does not reveal how much of it was right. (The
/// length is not hidden; it is not the secret.)
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Verify that `account_sig` is a valid signature over the registration message by the
/// account key — and the account id IS that key's public half. So only a holder of the
/// account root (which derives the account signing key) can register a device; knowing the
/// public account id is not enough.
pub fn verify_account_root(account_id: &str, device_id: &str, account_sig: &str) -> bool {
    let Some(vk_bytes) = unhex(account_id).and_then(|b| <[u8; 32]>::try_from(b).ok()) else {
        return false;
    };
    let Ok(vk) = VerifyingKey::from_bytes(&vk_bytes) else {
        return false;
    };
    let Some(sig_bytes) = unhex(account_sig).and_then(|b| <[u8; 64]>::try_from(b).ok()) else {
        return false;
    };
    let sig = Signature::from_bytes(&sig_bytes);
    let msg = format!("aegis-register-v1\n{account_id}\n{device_id}");
    vk.verify_strict(msg.as_bytes(), &sig).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    const NOW: i64 = 1_700_000_000_000;

    fn hx(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }

    /// A token signed by `key`, issued at `issued` and valid until `expires`, with its sig hex.
    fn signed(key: &SigningKey, issued: i64, expires: i64) -> (AuthToken, String) {
        let token = AuthToken {
            account_id: "abcd".into(),
            device_id: hx(&key.verifying_key().to_bytes()),
            issued_ms: issued,
            expires_ms: expires,
            nonce: "00ff".into(),
        };
        let sig = hx(&key.sign(&canonical(&token)).to_bytes());
        (token, sig)
    }

    #[test]
    fn canonical_is_stable() {
        let t = AuthToken {
            account_id: "acct".into(),
            device_id: "dev".into(),
            issued_ms: 10,
            expires_ms: 20,
            nonce: "ab".into(),
        };
        assert_eq!(
            canonical(&t),
            b"aegis-auth-v1\nacct\ndev\n10\n20\nab".to_vec()
        );
    }

    #[test]
    fn unhex_and_canonical_hex() {
        assert_eq!(unhex("00ff10").unwrap(), vec![0x00, 0xff, 0x10]);
        assert_eq!(unhex("00FF").unwrap(), vec![0x00, 0xff]);
        assert!(unhex("xyz").is_none());
        assert!(unhex("abc").is_none());
        assert!(is_canonical_hex("00ff"));
        assert!(!is_canonical_hex("00FF"));
        assert!(!is_canonical_hex(""));
    }

    #[test]
    fn check_token_accepts_a_fresh_signed_token() {
        let key = SigningKey::from_bytes(&[3; 32]);
        let (t, sig) = signed(&key, NOW, NOW + MAX_TTL_MS);
        let v = check_token(&t, NOW, &sig).unwrap();
        assert_eq!(v.account_id, "abcd");
        assert_eq!(v.device_id, t.device_id);
        assert_eq!(v.nonce, "00ff");
        assert_eq!(v.expires_ms, NOW + MAX_TTL_MS);
    }

    #[test]
    fn check_token_rejects_expired() {
        let key = SigningKey::from_bytes(&[3; 32]);
        let (t, sig) = signed(&key, NOW, NOW + 1_000);
        // `now > expires_ms` rejects, so the expiry instant itself is still valid.
        assert!(check_token(&t, NOW + 1_000, &sig).is_ok());
        assert_eq!(
            check_token(&t, NOW + 1_001, &sig).unwrap_err(),
            AuthError::Expired
        );
    }

    #[test]
    fn check_token_rejects_future_skew() {
        let key = SigningKey::from_bytes(&[3; 32]);
        let (ok, ok_sig) = signed(&key, NOW + MAX_FUTURE_SKEW_MS, NOW + MAX_FUTURE_SKEW_MS + 1);
        assert!(check_token(&ok, NOW, &ok_sig).is_ok());
        let (t, sig) = signed(
            &key,
            NOW + MAX_FUTURE_SKEW_MS + 1,
            NOW + MAX_FUTURE_SKEW_MS + 2,
        );
        assert_eq!(
            check_token(&t, NOW, &sig).unwrap_err(),
            AuthError::IssuedInFuture
        );
    }

    #[test]
    fn check_token_rejects_stale_issue_and_overlong_span() {
        let key = SigningKey::from_bytes(&[3; 32]);
        let (t, sig) = signed(&key, NOW - MAX_PAST_SKEW_MS - 1, NOW + 1);
        assert_eq!(
            check_token(&t, NOW, &sig).unwrap_err(),
            AuthError::IssuedTooLongAgo
        );
        let (t, sig) = signed(&key, NOW, NOW + MAX_TTL_MS + 1);
        assert_eq!(
            check_token(&t, NOW, &sig).unwrap_err(),
            AuthError::TtlTooLong
        );
    }

    #[test]
    fn check_token_rejects_uppercase_hex() {
        let key = SigningKey::from_bytes(&[3; 32]);
        let (mut t, _) = signed(&key, NOW, NOW + 1_000);
        t.device_id = t.device_id.to_uppercase();
        let sig = hx(&key.sign(&canonical(&t)).to_bytes());
        assert_eq!(
            check_token(&t, NOW, &sig).unwrap_err(),
            AuthError::NonCanonicalId
        );
        let (mut t, _) = signed(&key, NOW, NOW + 1_000);
        t.account_id = "ABCD".into();
        let sig = hx(&key.sign(&canonical(&t)).to_bytes());
        assert_eq!(
            check_token(&t, NOW, &sig).unwrap_err(),
            AuthError::NonCanonicalId
        );
    }

    #[test]
    fn check_token_bounds_the_nonce() {
        let key = SigningKey::from_bytes(&[3; 32]);
        for (nonce, ok) in [
            ("a".repeat(MAX_NONCE_HEX_LEN), true),
            ("a".repeat(MAX_NONCE_HEX_LEN + 1), false),
            ("not-hex!".to_string(), false),
            (String::new(), false),
        ] {
            let (mut t, _) = signed(&key, NOW, NOW + 1_000);
            t.nonce = nonce;
            let sig = hx(&key.sign(&canonical(&t)).to_bytes());
            match check_token(&t, NOW, &sig) {
                Ok(_) => assert!(ok, "nonce {:?} should be refused", t.nonce),
                Err(e) => {
                    assert!(!ok, "nonce {:?} should pass", t.nonce);
                    assert_eq!(e, AuthError::BadNonce);
                }
            }
        }
    }

    #[test]
    fn check_token_rejects_a_bad_signature() {
        let key = SigningKey::from_bytes(&[3; 32]);
        let other = SigningKey::from_bytes(&[4; 32]);
        let (t, _) = signed(&key, NOW, NOW + 1_000);
        let forged = hx(&other.sign(&canonical(&t)).to_bytes());
        assert_eq!(
            check_token(&t, NOW, &forged).unwrap_err(),
            AuthError::BadSignature
        );
        assert_eq!(
            check_token(&t, NOW, "zz").unwrap_err(),
            AuthError::BadSignature
        );
    }

    #[test]
    fn account_root_and_constant_time_eq() {
        let account_key = SigningKey::from_bytes(&[7u8; 32]);
        let account_id = hx(&account_key.verifying_key().to_bytes());
        let msg = format!("aegis-register-v1\n{account_id}\ndeadbeef");
        let ok = hx(&account_key.sign(msg.as_bytes()).to_bytes());
        assert!(verify_account_root(&account_id, "deadbeef", &ok));
        assert!(!verify_account_root(&account_id, "other", &ok));
        assert!(constant_time_eq(b"secret", b"secret"));
        assert!(!constant_time_eq(b"secret", b"secreT"));
        assert!(!constant_time_eq(b"secret", b"secre"));
    }

    #[test]
    fn max_ttl_matches_the_clients_default() {
        assert_eq!(MAX_TTL_MS, 300_000);
    }
}
