//! Routing, request parsing and response helpers.
//!
//! Errors are a bare status with an empty body, as the native axum server sends them.
use aegis_sync_core::wire::MAX_BODY_BYTES;
use serde_json::Value;
use wstd::http::{Body, Request, Response, StatusCode};

use crate::meshnode::kv::local;
use crate::{devices, keys, records};

pub type Resp = Response<Body>;

pub async fn serve(mut req: Request<Body>) -> Resp {
    warn_open_registration();
    let path = req.uri().path().to_string();
    let query = req.uri().query().unwrap_or("").to_string();
    // A header that is not visible ASCII is as good as absent (native: `to_str().ok()`).
    let authz = req
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let method = req.method().as_str().to_string();
    match (path.as_str(), method.as_str()) {
        // Unauthenticated liveness probe; returns no account data.
        ("/healthz", "GET") => json(&serde_json::json!({ "ok": true })),
        ("/v1/records", "GET") => records::get(&query, authz.as_deref()),
        ("/v1/records", "POST") => match read_body(&mut req).await {
            Ok(body) => records::post(&body, authz.as_deref()),
            Err(code) => status(code),
        },
        ("/v1/devices", "GET") => devices::get(authz.as_deref()),
        ("/v1/devices", "POST") => match read_body(&mut req).await {
            Ok(body) => devices::post(&body, authz.as_deref()),
            Err(code) => status(code),
        },
        ("/v1/devices/remove", "POST") => match read_body(&mut req).await {
            Ok(body) => devices::remove(&body, authz.as_deref()),
            Err(code) => status(code),
        },
        ("/v1/devices/approve", "POST") => match read_body(&mut req).await {
            Ok(body) => devices::approve(&body, authz.as_deref()),
            Err(code) => status(code),
        },
        (
            "/healthz"
            | "/v1/records"
            | "/v1/devices"
            | "/v1/devices/remove"
            | "/v1/devices/approve",
            _,
        ) => status(405),
        _ => status(404),
    }
}

/// How often a node repeats the open-registration warning.
const WARN_EVERY_MS: u64 = 24 * 60 * 60 * 1000;

/// The native server warns once, at startup, when no registration secret is set. The mesh
/// service has none at all (spec §5.1: open registration in v1), and it has no startup: every
/// request runs in a fresh instance. Logging on every request would flood the node log, so
/// the first request on a node logs it and records that in `kv/local`, and the node logs it
/// again once a day. An instance logs it at most once.
fn warn_open_registration() {
    if local::get(keys::WARNED_OPEN_REGISTRATION).is_some() {
        return;
    }
    eprintln!(
        "[aegis-sync] WARNING: registration is open: anyone who can reach this service can \
         create an account on it (bounded only by the per-node caps). The mesh service has no \
         registration secret."
    );
    // A refused write (the store's cap) only means the warning repeats.
    let _ = local::set(keys::WARNED_OPEN_REGISTRATION, b"1", WARN_EVERY_MS);
}

/// The request body, refused with `413` past `MAX_BODY_BYTES` (the native body-limit layer).
/// The runtime caps bodies at the service's `max_body_bytes` before the guest runs; this
/// keeps the native bound when that limit is set higher (see `records::get` on why it may be).
async fn read_body(req: &mut Request<Body>) -> Result<Vec<u8>, u16> {
    let declared = req
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());
    if declared.is_some_and(|n| n > MAX_BODY_BYTES as u64) {
        return Err(413);
    }
    let body = req.body_mut().contents().await.map_err(|_| 400u16)?;
    if body.len() > MAX_BODY_BYTES {
        return Err(413);
    }
    Ok(body.to_vec())
}

pub fn status(code: u16) -> Resp {
    let mut resp = Response::new(Body::empty());
    *resp.status_mut() = StatusCode::from_u16(code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    resp
}

pub fn json(v: &Value) -> Resp {
    let body = serde_json::to_vec(v).unwrap_or_default();
    let mut resp = Response::new(Body::from(body));
    resp.headers_mut().insert(
        "content-type",
        wstd::http::HeaderValue::from_static("application/json"),
    );
    resp
}

/// `application/x-www-form-urlencoded` pairs, decoded as `serde_urlencoded` (axum's `Query`)
/// decodes them: `+` is a space, `%XX` a byte, a malformed escape stays literal, and invalid
/// UTF-8 is replaced.
pub fn query_pairs(q: &str) -> Vec<(String, String)> {
    q.split('&')
        .filter(|kv| !kv.is_empty())
        .map(|kv| {
            let (k, v) = kv.split_once('=').unwrap_or((kv, ""));
            (decode(k), decode(v))
        })
        .collect()
}

fn decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < b.len() => match (hex_val(b[i + 1]), hex_val(b[i + 2])) {
                (Some(h), Some(l)) => {
                    out.push(h << 4 | l);
                    i += 2;
                }
                _ => out.push(b'%'),
            },
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_val(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}
