//! The Aegis sync server's HTTP contract as a Meshnode service (sub-spec 7 §5).
//!
//! A `wasi:http` handler, one fresh instance per request, storing everything in `meshnode:kv`:
//! records and device facts in the replicated `store`, spent replay nonces in the node-local
//! `local`. The protocol itself (token checks, bounds, id repair, LWW stamps, paging, the tie
//! `ord`, device rules) is the shared `aegis-sync-core` (`../core`), the same crate the native server
//! runs; this crate is the glue between it and the kv. Key layout: [`keys`].
//!
//! Request flow: parse → bound → `check_token` at the WASI wall clock → the route's admit rule
//! → the nonce check-and-record in `kv/local` (with the per-device nonce cap) → the handler
//! over kv. Device facts and their rules: [`devices`]; server-wide soft caps: [`caps`];
//! tombstone retention after a push: [`retention`].
mod auth;
mod caps;
mod devices;
mod http;
mod keys;
mod records;
mod retention;
mod store;

wit_bindgen::generate!({
    inline: "package aegis:sync; world kv { import meshnode:kv/store; import meshnode:kv/local; }",
    path: "wit",
    generate_all,
});

#[wstd::http_server]
async fn main(
    req: wstd::http::Request<wstd::http::Body>,
) -> Result<wstd::http::Response<wstd::http::Body>, wstd::http::Error> {
    Ok(http::serve(req).await)
}
