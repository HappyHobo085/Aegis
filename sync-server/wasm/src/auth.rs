//! `Authorization: AegisSig {account}.{token hex}.{sig hex}`: header parsing, the core's
//! stateless `check_token` at the WASI wall clock, the route's admit rule, then the replay
//! nonce, in the native `verify_auth` order.
use aegis_sync_core::auth::{AuthToken, MAX_FUTURE_SKEW_MS, MAX_TTL_MS, check_token, unhex};
use aegis_sync_core::devices::{AccountFacts, is_member};

use crate::caps::MAX_SEEN_NONCES_PER_DEVICE;
use crate::keys;
use crate::meshnode::kv::local;
use crate::store;

/// An authenticated caller.
pub struct Caller {
    pub account: String,
    pub device: String,
}

/// The node's wall clock (`wasi:clocks/wall-clock`) in ms since the UNIX epoch.
pub fn now_ms() -> i64 {
    let t = wasip2::clocks::wall_clock::now();
    let ms = u128::from(t.seconds) * 1000 + u128::from(t.nanoseconds / 1_000_000);
    i64::try_from(ms).unwrap_or(i64::MAX)
}

/// Authenticates `header` and runs `admit(account, device)`; the `Err` is the status to
/// answer with (`401`, the admit rule's own, or `429` when the device holds
/// `MAX_SEEN_NONCES_PER_DEVICE` live nonces or the nonce store is full).
///
/// The nonce is recorded only AFTER `admit` passes: anyone can mint a device key and sign a
/// token with it, so spending nonce slots for callers about to be refused would let a stranger
/// fill the store (the native comment on `verify_auth` explains the attack).
pub fn authenticate(
    header: Option<&str>,
    admit: impl FnOnce(&str, &str) -> Result<(), u16>,
) -> Result<Caller, u16> {
    let rest = header
        .and_then(|h| h.strip_prefix("AegisSig "))
        .ok_or(401u16)?;
    let mut parts = rest.splitn(3, '.');
    let (Some(account), Some(token_hex), Some(sig_hex)) =
        (parts.next(), parts.next(), parts.next())
    else {
        return Err(401);
    };
    let token: AuthToken = unhex(token_hex)
        .and_then(|b| serde_json::from_slice(&b).ok())
        .ok_or(401u16)?;
    if token.account_id != account {
        return Err(401);
    }
    let now = now_ms();
    let ok = check_token(&token, now, sig_hex).map_err(|_| 401u16)?;
    admit(&ok.account_id, &ok.device_id)?;

    // Replay defense: a (device, nonce) pair is single-use on this node. The entry must
    // outlive the token: `check_token` admits a token until `now > expires_ms`, and a token
    // issued up to MAX_FUTURE_SKEW_MS ahead can expire more than MAX_TTL_MS from now. So the
    // ttl is MAX_TTL_MS, extended to just past `expires_ms` when that is later.
    let key = keys::nonce_key(&ok.device_id, &ok.nonce);
    if local::get(&key).is_some() {
        return Err(401);
    }
    // The native per-device cap, checked before the new nonce is recorded: a device holding
    // this many live nonces is refused on its own, rather than filling the node's store and
    // refusing every other device. Refusing (not evicting a live entry) keeps every replay
    // window shut; it only costs an over-fast client a retry.
    if live_nonces(&ok.device_id, now) >= MAX_SEEN_NONCES_PER_DEVICE {
        eprintln!(
            "[aegis-sync] WARN device {} at its replay-nonce cap \
             ({MAX_SEEN_NONCES_PER_DEVICE}); rejecting further nonces for this device",
            ok.device_id
        );
        return Err(429);
    }
    let ttl = ok
        .expires_ms
        .saturating_sub(now)
        .saturating_add(1)
        .max(MAX_TTL_MS);
    // A refused write is the store's cap (100 000 live keys): refuse the request rather than
    // admit an unrecorded nonce, as the native nonce-map cap does (`429`).
    local::set(&key, b"1", ttl as u64).map_err(|_| 429u16)?;
    count_nonce(&ok.device_id, now, now.saturating_add(ttl));
    Ok(Caller {
        account: ok.account_id,
        device: ok.device_id,
    })
}

/// [`authenticate`] with the data endpoints' admit rule ([`member`]), also returning the
/// account's facts the rule read.
pub fn authenticate_member(header: Option<&str>) -> Result<(Caller, AccountFacts), u16> {
    let mut read = None;
    let caller = authenticate(header, |account, device| {
        let facts = store::account_facts(account);
        if !is_member(&facts, device) {
            return Err(403);
        }
        read = Some(facts);
        Ok(())
    })?;
    Ok((caller, read.expect("admit ran and passed")))
}

// Per-device nonce counts. `kv/local` cannot count keys under a prefix, so each spent nonce
// is also counted in the bucket of its expiry time: `noncecount/<device>/<bucket>`, a decimal
// count whose own ttl ends with the bucket, so a bucket disappears once every nonce in it has
// expired. The live count is the sum of the buckets that can still hold a live nonce, from
// now's to that of the latest possible expiry (a token can expire up to MAX_FUTURE_SKEW_MS +
// MAX_TTL_MS from now, and its nonce is kept 1 ms past that): at most 13 `get`s, never a scan.
// A nonce is counted until the end of its bucket, up to `NONCE_BUCKET_MS` past its own
// expiry: the conservative direction, as the native sweep is one second conservative.
// The count is read-modify-write, so two concurrent requests from one device on one node can
// lose one count; the cap is a backpressure bound, not a security property (the nonce itself
// is recorded exactly).

/// How many of `device`'s spent nonces are live at `now`.
fn live_nonces(device: &str, now: i64) -> usize {
    let first = keys::nonce_bucket(now);
    let last = keys::nonce_bucket(now.saturating_add(MAX_FUTURE_SKEW_MS + MAX_TTL_MS + 1));
    (first..=last)
        .map(|b| read_count(&keys::nonce_count_key(device, b)))
        .sum()
}

/// Counts one spent nonce of `device` expiring at `expires_at`.
fn count_nonce(device: &str, now: i64, expires_at: i64) {
    let bucket = keys::nonce_bucket(expires_at);
    let key = keys::nonce_count_key(device, bucket);
    let n = read_count(&key) + 1;
    let ttl = (bucket + 1) * keys::NONCE_BUCKET_MS - now;
    // A refused write (the store's cap) only undercounts; the nonce itself is recorded.
    let _ = local::set(&key, n.to_string().as_bytes(), ttl.max(1) as u64);
}

fn read_count(key: &str) -> usize {
    local::get(key)
        .and_then(|v| std::str::from_utf8(&v).ok()?.parse().ok())
        .unwrap_or(0)
}

/// The data endpoints' admit rule (the native `require_registered`): only a member of the
/// account (registered, not pending, not revoked) gets through; anyone else is a `403`.
pub fn member(account: &str, device: &str) -> Result<(), u16> {
    if is_member(&store::account_facts(account), device) {
        Ok(())
    } else {
        Err(403)
    }
}
