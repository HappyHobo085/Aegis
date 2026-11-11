//! Pure protocol core of the Aegis self-hosted sync server.
//!
//! Everything here is a function of its arguments: no sockets, no files, no OS clock and no OS
//! randomness. The native axum server (`sync-server/src/main.rs`) is one host of this crate; a
//! WASM service is another. Time and entropy come in through [`env::Clock`] and
//! [`env::Entropy`], which each host implements.
//!
//! The auth `canonical()` + token shape in [`auth`] MUST match `src-tauri/src/sync_auth.rs`
//! byte-for-byte (kept in sync by hand; covered by the round-trip test in the server).
pub mod auth;
pub mod env;
pub mod wire;
