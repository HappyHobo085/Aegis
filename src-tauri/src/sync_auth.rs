//! Per-device authentication for the sync server (F2b): short-lived Ed25519 signed tokens.
//!
//! Each device has its own signing key (derived per-install from the root — see
//! `crypto::device_signing_seed`), so a lost device can be revoked without rotating the
//! recovery phrase. A request carries `Authorization: AegisSig {accountId}.{tokenHex}.{sigHex}`
//! where the token is a short-TTL claim signed by the device key. The server authorizes iff
//! the signature verifies AND the device id is in the account's registered-pubkey set
//! (registration happens at pairing). Replay defense: each token carries a random per-token
//! nonce, and the server records spent `(device, nonce)` pairs and rejects a repeat — so a
//! captured `Authorization` header can't be replayed. For this to hold, the client mints a
//! FRESH token per HTTP request (see `sync::sync_ns`), never reusing one across a GET+POST.
//!
//! Honest residuals: a stolen device key grants access until `removeDevice` revokes it; and the
//! server's spent-nonce set is in-memory, so a server restart forgets it (a token captured
//! pre-restart could replay within its ≤5-min TTL afterward).
//!
//! The signed bytes use a CANONICAL fixed-field-order encoding (NOT serde — serde's object
//! key order isn't guaranteed); the reference server MUST reproduce `canonical()` byte-for-byte.
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use serde::{Deserialize, Serialize};

use crate::crypto::{hex, unhex};

/// Default token lifetime (5 min) — long enough for a sync round, short enough to bound replay.
pub const DEFAULT_TTL_MS: i64 = 300_000;

/// A signed authentication claim. Serialized as JSON only for transport; the SIGNATURE is
/// over `canonical()`, not the JSON.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct AuthToken {
    pub account_id: String,
    /// hex of the Ed25519 public key — this device's identity (the server checks it's registered).
    pub device_id: String,
    pub issued_ms: i64,
    pub expires_ms: i64,
    /// random per-token (replay defense).
    pub nonce: String,
}

/// Deterministic, fixed-field-order bytes that get signed/verified. A version tag prefix
/// lets the scheme evolve. Fields are hex/ids/decimals — none can contain a newline.
fn canonical(t: &AuthToken) -> Vec<u8> {
    format!(
        "aegis-auth-v1\n{}\n{}\n{}\n{}\n{}",
        t.account_id, t.device_id, t.issued_ms, t.expires_ms, t.nonce
    )
    .into_bytes()
}

/// Mint a token for `account_id`, signed by the device key `seed`. Returns the token and
/// its signature (hex). `now_ms` + `ttl_ms` set the validity window.
pub fn mint(
    seed: &[u8; 32],
    account_id: &str,
    now_ms: i64,
    ttl_ms: i64,
) -> Result<(AuthToken, String), String> {
    let sk = SigningKey::from_bytes(seed); // infallible
    let device_id = hex(&sk.verifying_key().to_bytes());
    let mut nonce = [0u8; 16];
    getrandom::getrandom(&mut nonce).map_err(|e| e.to_string())?;
    let token = AuthToken {
        account_id: account_id.to_string(),
        device_id,
        issued_ms: now_ms,
        expires_ms: now_ms + ttl_ms,
        nonce: hex(&nonce),
    };
    let sig: Signature = sk.sign(&canonical(&token));
    Ok((token, hex(&sig.to_bytes())))
}

/// This device's id (hex public key) for the given signing seed — what gets registered
/// with the server and what `removeDevice` targets.
pub fn device_id_for(seed: &[u8; 32]) -> String {
    hex(&SigningKey::from_bytes(seed).verifying_key().to_bytes())
}

/// Verify a token + signature at `now_ms`: not expired, not issued in the future (small
/// skew allowance), signature valid under the key named by `device_id` (so a valid
/// signature proves the holder owns `device_id`'s private key). Server-side authorization
/// ALSO requires `device_id` ∈ the account's registered set (checked by the caller).
///
/// The CLIENT only mints; this is the SERVER's check (the reference axum server reuses it),
/// so it's unused in the app build itself — hence the allow.
#[allow(dead_code)]
pub fn verify(token: &AuthToken, sig_hex: &str, now_ms: i64) -> Result<(), String> {
    if now_ms > token.expires_ms {
        return Err("token expired".into());
    }
    if token.issued_ms > now_ms + 60_000 {
        return Err("token issued in the future".into());
    }
    let vk_bytes = unhex(&token.device_id).ok_or("bad device_id hex")?;
    let vk_arr: [u8; 32] = vk_bytes
        .try_into()
        .map_err(|_| "device_id must be 32 bytes")?;
    let vk = VerifyingKey::from_bytes(&vk_arr).map_err(|_| "invalid public key")?;
    let sig_bytes = unhex(sig_hex).ok_or("bad signature hex")?;
    let sig_arr: [u8; 64] = sig_bytes
        .try_into()
        .map_err(|_| "signature must be 64 bytes")?;
    let sig = Signature::from_bytes(&sig_arr);
    vk.verify_strict(&canonical(token), &sig)
        .map_err(|_| "signature verification failed".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seed() -> [u8; 32] {
        // A fixed device signing seed (in production this is HKDF-derived).
        let mut s = [0u8; 32];
        for (i, b) in s.iter_mut().enumerate() {
            *b = i as u8;
        }
        s
    }

    #[test]
    fn mint_then_verify_succeeds() {
        let (token, sig) = mint(&seed(), "acct-1", 1_000, DEFAULT_TTL_MS).unwrap();
        assert!(verify(&token, &sig, 1_500).is_ok());
        // device_id is the hex public key for this seed.
        assert_eq!(token.device_id, device_id_for(&seed()));
    }

    #[test]
    fn expired_token_is_rejected() {
        let (token, sig) = mint(&seed(), "acct-1", 1_000, DEFAULT_TTL_MS).unwrap();
        assert!(verify(&token, &sig, 1_000 + DEFAULT_TTL_MS + 1).is_err());
    }

    #[test]
    fn tampering_breaks_the_signature() {
        let (mut token, sig) = mint(&seed(), "acct-1", 1_000, DEFAULT_TTL_MS).unwrap();
        // Mutate a signed field → signature no longer matches the canonical bytes.
        token.account_id = "acct-2".into();
        assert!(verify(&token, &sig, 1_500).is_err());
    }

    #[test]
    fn wrong_key_is_rejected() {
        let (token, _sig) = mint(&seed(), "acct-1", 1_000, DEFAULT_TTL_MS).unwrap();
        // A signature from a different device key must not verify against this token's device_id.
        let mut other = seed();
        other[0] ^= 0xff;
        let (_t2, sig2) = mint(&other, "acct-1", 1_000, DEFAULT_TTL_MS).unwrap();
        assert!(verify(&token, &sig2, 1_500).is_err());
    }

    #[test]
    fn future_issued_token_is_rejected() {
        let (token, sig) = mint(&seed(), "acct-1", 1_000_000, DEFAULT_TTL_MS).unwrap();
        // "now" is well before issued_ms (beyond the skew allowance).
        assert!(verify(&token, &sig, 1_000).is_err());
    }
}
