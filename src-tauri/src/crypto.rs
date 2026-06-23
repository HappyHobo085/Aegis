//! Sync crypto (F2b): the key tree, recovery phrase, and authenticated record encryption.
//!
//! Everything derives from one 256-bit `RootSecret` (the 24-word BIP39 recovery phrase IS
//! the root). HKDF-SHA256 expands it into per-purpose keys so no single derived key reveals
//! the root or any sibling:
//!   - `account-id`         → a public, non-reversible account identifier (HKDF output, not
//!     the seed) the server keys blobs by.
//!   - `data-key:{ns}`      → a 256-bit XChaCha20-Poly1305 key per namespace.
//!   - `device-sign:{salt}` → the per-INSTALL Ed25519 device signing seed (see sync_keystore).
//!
//! Records are sealed with XChaCha20-Poly1305 (random 24-byte nonce) and AAD binding the
//! ciphertext to `namespace | uuid | hlc_bytes`, so the server can't splice a record into a
//! different identity/version. The server only ever stores opaque ciphertext.
use chacha20poly1305::aead::{Aead, Payload};
use chacha20poly1305::{Key as ChachaKey, KeyInit, XChaCha20Poly1305, XNonce};
use ed25519_dalek::SigningKey;
use hkdf::Hkdf;
use sha2::Sha256;
use zeroize::{Zeroize, ZeroizeOnDrop};

/// HKDF salt = the wire-format version tag, so a future cipher/KDF bump changes every key.
const HKDF_SALT: &[u8] = b"aegis-sync-v1";

/// The 256-bit master secret. The recovery phrase is its BIP39 encoding. Zeroized on drop.
#[derive(Zeroize, ZeroizeOnDrop, Clone)]
pub struct RootSecret(pub [u8; 32]);

/// Generate a fresh random root from the OS CSPRNG.
pub fn generate_root() -> Result<RootSecret, String> {
    let mut b = [0u8; 32];
    getrandom::getrandom(&mut b).map_err(|e| e.to_string())?;
    Ok(RootSecret(b))
}

/// Encode the root as a 24-word BIP39 recovery phrase (256-bit entropy → 24 words).
pub fn root_to_phrase(root: &RootSecret) -> Result<String, String> {
    bip39::Mnemonic::from_entropy(&root.0)
        .map(|m| m.to_string())
        .map_err(|e| e.to_string())
}

/// Recover the root from a 24-word phrase (checksum-validated by bip39).
pub fn phrase_to_root(phrase: &str) -> Result<RootSecret, String> {
    let m = bip39::Mnemonic::parse(phrase.trim()).map_err(|e| e.to_string())?;
    let entropy = m.to_entropy();
    if entropy.len() != 32 {
        return Err("recovery phrase must be 24 words (256-bit)".into());
    }
    let mut b = [0u8; 32];
    b.copy_from_slice(&entropy);
    Ok(RootSecret(b))
}

fn expand(root: &[u8; 32], label: &[u8], out: &mut [u8]) {
    let hk = Hkdf::<Sha256>::new(Some(HKDF_SALT), root);
    hk.expand(label, out)
        .expect("HKDF output length is within the 255*HashLen limit");
}

fn hex(b: &[u8]) -> String {
    let mut s = String::with_capacity(b.len() * 2);
    for x in b {
        s.push_str(&format!("{x:02x}"));
    }
    s
}

/// The account-level Ed25519 signing key (root-derived). Its PUBLIC key IS the account id,
/// so the server can verify a device registration is authorized by the account ROOT
/// (proof-of-root) without ever seeing the root — closing the rogue-registration hole where
/// anyone who learned the public account id could self-register a device.
pub fn account_signing_key(root: &RootSecret) -> SigningKey {
    let mut seed = [0u8; 32];
    expand(&root.0, b"account-sign", &mut seed);
    let key = SigningKey::from_bytes(&seed);
    seed.zeroize();
    key
}

/// The public, non-reversible account id the server keys data by = hex of the account's
/// Ed25519 public key. Public by design (it travels in every auth header); knowing it does
/// NOT let anyone forge the account-root signature required to register a device.
pub fn account_id(root: &RootSecret) -> String {
    hex(&account_signing_key(root).verifying_key().to_bytes())
}

/// The 256-bit data key for namespace `ns`.
pub fn data_key(root: &RootSecret, ns: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    expand(&root.0, format!("data-key:{ns}").as_bytes(), &mut out);
    out
}

/// The per-install Ed25519 device signing seed = HKDF(root, "device-sign:" + salt). The
/// per-install `salt` makes every install's key distinct so `removeDevice` can revoke one.
pub fn device_signing_seed(root: &RootSecret, device_salt: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    let mut label = b"device-sign:".to_vec();
    label.extend_from_slice(device_salt);
    expand(&root.0, &label, &mut out);
    out
}

/// The AAD binding a sealed record to its identity + version. LENGTH-PREFIXED (u32 BE per
/// field) so the encoding is INJECTIVE — a delimiter byte (0x7C) inside `uuid`/`hlc_bytes`
/// can't make two different triples collide to the same AAD (which a `|`-joined form would
/// allow). The reference server must reproduce this byte-for-byte.
fn aad_for(ns: &str, uuid: &str, hlc_bytes: &[u8]) -> Vec<u8> {
    let mut aad = Vec::with_capacity(12 + ns.len() + uuid.len() + hlc_bytes.len());
    for field in [ns.as_bytes(), uuid.as_bytes(), hlc_bytes] {
        aad.extend_from_slice(&(field.len() as u32).to_be_bytes());
        aad.extend_from_slice(field);
    }
    aad
}

fn cipher_for(data_key: &[u8; 32]) -> XChaCha20Poly1305 {
    XChaCha20Poly1305::new(ChachaKey::from_slice(data_key))
}

/// Seal `plaintext` for namespace `ns`/record `uuid`/version `hlc_bytes`. Returns
/// `(nonce, ciphertext)`; the nonce is a fresh random 24 bytes.
pub fn seal(
    data_key: &[u8; 32],
    ns: &str,
    uuid: &str,
    hlc_bytes: &[u8],
    plaintext: &[u8],
) -> Result<(Vec<u8>, Vec<u8>), String> {
    let mut nonce = [0u8; 24];
    getrandom::getrandom(&mut nonce).map_err(|e| e.to_string())?;
    let aad = aad_for(ns, uuid, hlc_bytes);
    let ct = cipher_for(data_key)
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad: &aad,
            },
        )
        .map_err(|_| "seal failed".to_string())?;
    Ok((nonce.to_vec(), ct))
}

/// Open a sealed record. The AAD is rebuilt from `ns`/`uuid`/`hlc_bytes`; a mismatch (a
/// spliced or tampered record) fails authentication.
pub fn open(
    data_key: &[u8; 32],
    nonce: &[u8],
    ciphertext: &[u8],
    ns: &str,
    uuid: &str,
    hlc_bytes: &[u8],
) -> Result<Vec<u8>, String> {
    if nonce.len() != 24 {
        return Err("nonce must be 24 bytes".into());
    }
    let aad = aad_for(ns, uuid, hlc_bytes);
    cipher_for(data_key)
        .decrypt(
            XNonce::from_slice(nonce),
            Payload {
                msg: ciphertext,
                aad: &aad,
            },
        )
        .map_err(|_| "open failed: authentication error".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phrase_round_trips_and_is_24_words() {
        let root = generate_root().unwrap();
        let phrase = root_to_phrase(&root).unwrap();
        assert_eq!(phrase.split_whitespace().count(), 24);
        let back = phrase_to_root(&phrase).unwrap();
        assert_eq!(back.0, root.0);
    }

    #[test]
    fn phrase_to_root_rejects_garbage() {
        assert!(phrase_to_root("not a real recovery phrase at all nope").is_err());
        assert!(phrase_to_root("").is_err());
    }

    #[test]
    fn account_id_is_deterministic_and_root_specific() {
        let a = RootSecret([1u8; 32]);
        let b = RootSecret([2u8; 32]);
        assert_eq!(account_id(&a), account_id(&a)); // deterministic
        assert_ne!(account_id(&a), account_id(&b)); // root-specific
        assert_eq!(account_id(&a).len(), 64); // 32 bytes hex
    }

    #[test]
    fn data_keys_differ_per_namespace_and_are_deterministic() {
        let r = RootSecret([7u8; 32]);
        assert_eq!(data_key(&r, "favorites"), data_key(&r, "favorites"));
        assert_ne!(data_key(&r, "favorites"), data_key(&r, "saved"));
        // The data key is not the account id material.
        assert_ne!(&data_key(&r, "favorites")[..], account_id(&r).as_bytes());
    }

    #[test]
    fn device_seed_differs_per_install_salt() {
        let r = RootSecret([9u8; 32]);
        assert_ne!(
            device_signing_seed(&r, b"salt-A"),
            device_signing_seed(&r, b"salt-B")
        );
        assert_eq!(
            device_signing_seed(&r, b"salt-A"),
            device_signing_seed(&r, b"salt-A")
        );
    }

    #[test]
    fn seal_open_round_trips() {
        let key = data_key(&RootSecret([3u8; 32]), "favorites");
        let hlc = b"\x00\x00\x00\x01";
        let (nonce, ct) = seal(&key, "favorites", "uuid-1", hlc, b"hello world").unwrap();
        let pt = open(&key, &nonce, &ct, "favorites", "uuid-1", hlc).unwrap();
        assert_eq!(pt, b"hello world");
    }

    #[test]
    fn open_fails_on_aad_mismatch() {
        let key = data_key(&RootSecret([3u8; 32]), "favorites");
        let hlc = b"\x00\x00\x00\x01";
        let (nonce, ct) = seal(&key, "favorites", "uuid-1", hlc, b"secret").unwrap();
        // Wrong namespace, uuid, or hlc each fail authentication (no splicing).
        assert!(open(&key, &nonce, &ct, "saved", "uuid-1", hlc).is_err());
        assert!(open(&key, &nonce, &ct, "favorites", "uuid-2", hlc).is_err());
        assert!(open(
            &key,
            &nonce,
            &ct,
            "favorites",
            "uuid-1",
            b"\xff\xff\xff\xff"
        )
        .is_err());
        // A wrong key fails too.
        let other = data_key(&RootSecret([4u8; 32]), "favorites");
        assert!(open(&other, &nonce, &ct, "favorites", "uuid-1", hlc).is_err());
    }

    #[test]
    fn generate_root_is_random() {
        assert_ne!(generate_root().unwrap().0, generate_root().unwrap().0);
    }

    #[test]
    fn account_key_is_root_derived_and_id_is_its_pubkey() {
        let r = RootSecret([11u8; 32]);
        let k = account_signing_key(&r);
        assert_eq!(k.to_bytes(), account_signing_key(&r).to_bytes()); // deterministic
        assert_eq!(account_id(&r), super::hex(&k.verifying_key().to_bytes())); // id IS the pubkey
        assert_ne!(
            account_signing_key(&RootSecret([12u8; 32])).to_bytes(),
            k.to_bytes()
        );
    }

    #[test]
    fn aad_is_injective_across_delimiter_confusable_inputs() {
        // A `|`-joined AAD would collide these two triples ("ns|u||x"); the length-prefixed
        // form must not — the field-length bytes differ.
        assert_ne!(aad_for("ns", "u|", b"x"), aad_for("ns", "u", b"|x"));
    }
}
