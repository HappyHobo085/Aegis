# Contract test vectors

Each `*.json` file here is an array of cases for the sync HTTP contract, grouped by file
(`auth`, `bounds`, `devices`, `healthz`, `records`); every case's `name` starts with its file's
group. The same files run against three hosts:

| Runner | Host |
|---|---|
| `core/tests/vectors.rs` | a pure in-memory model built only from `aegis-sync-core` functions, with the mesh's rules (facts, computed owner, `tie_ord`) |
| `src/vectors_native.rs` | the native axum server: the real `app(state)` router via `tower::ServiceExt::oneshot` |
| Meshnode's harness | the `services/aegis-sync` WASM service, from the vendored copy of this directory |

The types, the loader (`vector::load_all`) and the response check (`vector::check`) are in
`core/src/vector.rs`, behind the test-only `vectors` cargo feature.

## Case shape

```json
{
  "name": "records_stale_push_loses",
  "native_only": "reason",               // optional; or "mesh_only"; see below
  "given":   { "accounts": [[acct, AccountFacts]], "records": [[acct, ns, WireRecord]] },
  "request": { "method": "POST", "path": "/v1/records?…", "headers": [[k, v]], "body": {…} },
  "expect":  { "status": 200, "body": {…} | "body_subset": {…} },
  "then":    [ { "request": {…}, "expect": {…} } ]   // optional follow-ups, same state
}
```

- `given.accounts` are `devices::AccountFacts` (`devices: [{device_id, label, registered_ms}]`,
  `pending`, `approved`, `revoked`). A native harness stores the owner as `devices::owner` of
  the facts; the mesh computes it from the same facts.
- `body` is an exact JSON match. `body_subset` matches when every key it names is present and
  matches recursively, with arrays matched as same-length and in any order, since hosts list
  devices in no defined order. With neither, only the status is checked; the native server sends
  error statuses with an empty body.
- `then` steps run in order against the state the earlier steps left, including spent nonces.

## Fixed clock and keys

Every case runs at **`now_ms = 1_800_000_000_000`** (`vector::NOW_MS`, 2027-01-15T08:00:00Z).
The host's `Clock` must be injected with that value.

Test keys are Ed25519 keys whose 32-byte seed is one byte repeated (`SigningKey::from_bytes(&[b; 32])`).
An id is the public key in lower-case hex:

| Name | Role | Seed byte | Id (public key) |
|---|---|---|---|
| `A` | account (root) | `0xa1` | `bc7cbcb5636375fa1d82434d466724d92377f53b980695dd49d26d0ce12205a5` |
| `B` | account (root) | `0xb2` | `55154f42065ea5a1bea05463826be2684eb92df92c100027aabaae57ca554207` |
| `D1` | device | `0x11` | `d04ab232742bb4ab3a1368bd4615e4e6d0224ab71a016baf8520a332c9778737` |
| `D2` | device | `0x12` | `204040e364c10f2bec9c1fe500a1cd4c247c89d650a01ed7e82caba867877c21` |
| `D3` | device | `0x13` | `66cd608b928b88e50e0efeaa33faf1c43cefe07294b0b87e9fe0aba6a3cf7633` |
| `D4` | device | `0x14` | `20828bf5c5bdcacb684863336c202fb5599da48be5596615742170705beca9f7` |

These are public test values. Never use them for anything real.

## Templates

`load_all` expands these in every string before deserializing a case:

| Template | Expands to |
|---|---|
| `{{acct:A}}` | account `A`'s id |
| `{{dev:D1}}` | device `D1`'s id |
| `{{regsig:A:D1}}` | `A`'s root signature over `aegis-register-v1\n{acct}\n{dev}` |
| `{{auth:A:D1:NONCE}}` | `AegisSig {acct}.{token hex}.{sig hex}`, signed by `D1`; token `{account_id, device_id, issued_ms: now, expires_ms: now + 300000, nonce: NONCE}` (the nonce verbatim, so it must be hex) |
| `{{auth:A:D1:NONCE:expired}}` | issued `now - 300000`, expired at `now - 1` |
| `{{auth:A:D1:NONCE:bad_sig}}` | the low bit of the signature's first byte flipped |
| `{{auth:A:D1:NONCE:upper_device}}` | the token's device id in upper-case hex, signed as such |
| `{{repeat:S:N}}` | `S` repeated `N` times |

An object `{"$repeat": N, "item": X}` becomes an array of `N` copies of `X`. Ed25519 signing is
deterministic, so the same `auth` template always produces the same header. Repeating one with
the same nonce is therefore a replay.

## Host marks

A case marked `native_only` or `mesh_only` (with a reason) runs on one host only. The marks are
for real, designed differences, and `tests/vectors.rs` fails if more than two appear. There are
two today, one pair for the cross-uuid HLC tie rule:

- `records_cross_uuid_tie_counter_bump` (`native_only`): native reserves the next free counter in
  `ord`.
- `records_cross_uuid_tie_tie_ord` (`mesh_only`): the mesh serves `order::tie_ord` on each tied
  record except the lowest uuid.

The owner is stored natively and computed on the mesh, but the vectors need no mark for that:
the native harness seeds its stored owner from the same facts.
