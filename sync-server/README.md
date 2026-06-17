# aegis-sync-server

A minimal, self-hosted reference server for Aegis's end-to-end-encrypted sync. It stores
**opaque ciphertext only** — it never holds your encryption keys and cannot read your
bookmarks, saved items, or allowlist. Authentication is per-device Ed25519 signed tokens;
a device self-registers on first contact (the account secret is your recovery phrase).

This reference keeps everything **in memory** (it resets on restart) — fine for trying sync
out or a single-user setup. For durable use, swap the `HashMap`s in `src/main.rs` for a
database or disk-backed store; the HTTP contract stays the same.

## Run

```bash
cargo run                                   # listens on 127.0.0.1:8787
AEGIS_SYNC_ADDR=0.0.0.0:8787 cargo run       # expose on your LAN
```

Then in Aegis: **Settings → Sync → Server URL** = `http://<host>:8787`, and **Start new
sync**. On another device, paste the same URL and **Restore from a recovery phrase**.

## HTTP contract

All requests carry `Authorization: AegisSig {accountId}.{tokenHex}.{sigHex}`.

| Method + path           | Body                                   | Returns                                  |
|-------------------------|----------------------------------------|------------------------------------------|
| `GET  /v1/records?ns=`  | —                                      | `{ records: [{uuid,hlc,deleted,nonce,ct}] }` |
| `POST /v1/records`      | `{ ns, records: [...] }`               | `{ ok: true }` (HLC last-writer-wins upsert) |
| `POST /v1/devices`      | `{ accountId, deviceId, label, accountSig }` | `{ ok: true }` (register; `accountSig` proves the root) |
| `GET  /v1/devices`      | —                                      | `{ devices: [{deviceId,label,lastSeenMs}] }` |
| `POST /v1/devices/remove` | `{ deviceId }`                       | `{ ok: true }`                           |

`hlc`/`uuid`/`deleted` are cleartext routing/ordering metadata; `nonce`/`ct` are the sealed
record. The server applies HLC last-writer-wins using the cleartext `hlc` (so a stale push
can't roll it back) — it never decrypts `ct`.

> The auth `canonical()` serialization in `src/main.rs` MUST match
> `src-tauri/src/sync_auth.rs` byte-for-byte (a round-trip test guards the shape).
