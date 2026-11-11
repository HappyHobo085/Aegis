//! The contract vectors (`core/tests/vectors/*.json`) against the REAL native router.
//!
//! Each vector's `given` facts become a `Store` (the stored owner is `devices::owner` of the
//! facts, which is how the core defines it), the state runs on a fixed clock at
//! `vector::NOW_MS`, and every request goes through `app(state)` with `tower::ServiceExt::oneshot`
//! — routing, extractors, the body limit and the admission guard included. `tower` was already in
//! `Cargo.lock` through axum, so the dev-dependency adds an edge and no package.
//!
//! Meshnode runs the identical files against its WASM service; the core's own
//! `tests/vectors.rs` runs them against a pure model of that service.
use super::*;
use aegis_sync_core::devices;
use aegis_sync_core::vector::{self, Host, Vector, NOW_MS};
use axum::body::Body;
use tower::ServiceExt;

struct FixedClock(i64);

impl Clock for FixedClock {
    fn now_ms(&self) -> i64 {
        self.0
    }
}

/// The native maps a vector's facts describe.
fn store_from(v: &Vector) -> Store {
    let mut s = Store::default();
    for (acct, f) in &v.given.accounts {
        for d in &f.devices {
            let dev = Device {
                device_id: d.device_id.clone(),
                label: d.label.clone(),
                last_seen_ms: d.registered_ms,
                registered_ms: d.registered_ms,
            };
            if f.revoked.contains(&d.device_id) {
                continue; // recorded below; a revoked device is in no map
            }
            let map = if devices::is_pending(f, &d.device_id) {
                &mut s.pending
            } else {
                &mut s.devices
            };
            map.entry(acct.clone())
                .or_default()
                .insert(d.device_id.clone(), dev);
        }
        for id in &f.revoked {
            s.revoked.insert((acct.clone(), id.clone()));
        }
        if let Some(o) = devices::owner(f) {
            s.owner.insert(acct.clone(), o.to_string());
        }
    }
    for (acct, ns, rec) in &v.given.records {
        s.records
            .insert((acct.clone(), ns.clone(), rec.uuid.clone()), rec.clone());
    }
    s
}

async fn run(v: &Vector) -> Result<(), String> {
    let state = AppState::new(store_from(v), None).with_clock(Arc::new(FixedClock(NOW_MS)));
    for (i, (req, expect)) in v.steps().enumerate() {
        let mut b = axum::http::Request::builder()
            .method(req.method.as_str())
            .uri(&req.path);
        for (k, val) in &req.headers {
            b = b.header(k, val);
        }
        let body = match &req.body {
            Some(json) => {
                b = b.header("content-type", "application/json");
                Body::from(serde_json::to_vec(json).expect("body serializes"))
            }
            None => Body::empty(),
        };
        let request = b
            .body(body)
            .map_err(|e| format!("step {i}: bad request: {e}"))?;
        let resp = app(state.clone())
            .oneshot(request)
            .await
            .expect("the router is infallible");
        let status = resp.status().as_u16();
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .map_err(|e| format!("step {i}: body: {e}"))?;
        let json: Option<Value> = serde_json::from_slice(&bytes).ok();
        vector::check(expect, status, json.as_ref())
            .map_err(|e| format!("step {i} ({} {}): {e}", req.method, req.path))?;
    }
    Ok(())
}

#[tokio::test]
async fn every_native_vector_passes_through_the_router() {
    let vectors = vector::load_all(concat!(env!("CARGO_MANIFEST_DIR"), "/core/tests/vectors"));
    let mut ran = 0;
    let mut failures = Vec::new();
    for v in vectors.iter().filter(|v| v.runs_on(Host::Native)) {
        ran += 1;
        if let Err(e) = run(v).await {
            failures.push(format!("{}: {e}", v.name));
        }
    }
    assert!(ran > 0, "no vectors found");
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
