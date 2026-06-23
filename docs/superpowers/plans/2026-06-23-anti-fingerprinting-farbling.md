# Anti-fingerprinting / Farbling (sub-project L) — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development`
> to execute this plan. Each task below is a bite-sized, test-first unit of work: write the
> failing test, get it reviewed, implement, get it reviewed, commit. Do NOT batch tasks.
> The single source of truth for what "done" means is the per-task **Verify** block + the
> repo gate (`npm test` green; for runtime-touching tasks, `bash scripts/autopilot/run-autopilot.sh`
> → `RESULT: … 0 failed` and `ad-block blocking (trace): PASS` on Linux).

## Goal

Add an opt-in anti-fingerprinting ("farbling") layer that perturbs the browser-fingerprint
read surfaces — **canvas**, **audio**, **WebGL**, and **navigator / UA-Client-Hints** — with
**deterministic, per-frame-origin, per-session noise**, so the same site sees a stable
fingerprint within a session but a _different_ one than other sites (and than other sessions),
while the values stay individually plausible. Three levels (`off` / `standard` / `strict`) plus
a per-site allowlist that disables farbling for sites it breaks. The noise seed is derived from
a **crypto-strong, one-way** per-session salt so the salt can never be brute-forced back out of
observed farbled values (the "super-cookie" trap the roadmap flags).

This is **opt-in, default `off`**, because canvas/audio noise is actively flagged by anti-bot/
CAPTCHA vendors and a hand-written same-world JS shim is _detectable_ — see the Global
Constraints honest-limit note. The win is a meaningful, Brave-shaped reduction in passive
fingerprint stability for users who turn it on, not in-engine invisibility (which a shell
cannot reach).

## Architecture

```
boot (lib.rs setup)                         settings.set { antiFingerprint }
   │ farble::init_session_salt()                │
   ▼                                            ▼
SESSION_SALT: OnceLock<[u8;32]>            farble::note_level()  (Android global, like webrtc note_policy)
   │  getrandom CSPRNG, NEVER persisted
   │
   ├─ desktop: nav::spawn_tab
   │     adblock_inject::script(app, host_allowlisted)
   │        = webrtc_shim ++ POPUP_GUARD ++ (non-Linux) adblock-body ++ farble::shim_for(level, salt, allowlisted)
   │            (the farble block is appended to the SAME injection tier; Linux gets it too)
   │
   └─ android: NativeFarble.farbleScript()  JNI getter (mirrors NativeWebrtc.shimScript)
         registered per-tab via WebViewCompat.addDocumentStartJavaScript(wv, …, setOf("*"))

JS shim (shipped artifact farble.standard.js / farble.strict.js, include_str!'d, vitest-tested):
   const SEED = <hex literal baked in by Rust = HKDF(salt, "farble" )>;   // 16 bytes
   perOrigin = sha256_first8( SEED ++ location.origin )   // one-way, computed IN-PAGE from the baked seed
   prng = xoshiro(perOrigin)                              // deterministic noise stream
   patch canvas → audio → webgl → navigator/UA-CH using prng, fail-open
       (per-frame-origin: a cross-origin iframe seeds on ITS OWN origin — window.top is unreadable)

settings + allowlist:
   antiFingerprint: 'off'|'standard'|'strict'   (Settings field — rides settings.get/set, NO new channel)
   fingerprint.toggleAllowlist / removeAllowlist / clearAllowlist / getState   (mirror adblock.*; persisted syncable store)
```

**Salt derivation → noise (one-way, the load-bearing crypto):**

1. At boot, `farble::init_session_salt()` fills a `[u8; 32]` from `getrandom` (OS CSPRNG) into a
   `OnceLock`. It is **never written to disk** — it resets every session, exactly like the WebRTC
   shim's per-session behavior and Brave's per-session farbling seed.
2. The salt is **never shipped to the page.** Rust derives a 16-byte **per-session public seed**
   `SEED = HKDF-SHA256(salt, info="aegis-farble-seed-v1")[..16]` and bakes only `SEED` into the JS
   as a hex literal. Because HKDF is a one-way KDF, a page that observes `SEED` (or any farbled
   value) cannot recover `salt`, and cannot derive the seed for any _other_ session.
3. In-page, the shim computes a per-origin sub-seed `perOrigin = SHA-256(SEED ++ location.origin)[..8]`
   using a tiny self-contained SHA-256 in the shim (no Web Crypto dependency, so it works
   synchronously at document-start and is identical across engines). This is _also_ one-way:
   observing `perOrigin` for site A reveals nothing about `SEED` (so nothing about site B's
   sub-seed). The per-origin sub-seed feeds a deterministic xoshiro128 PRNG that drives every
   surface's noise. **Determinism guarantee:** same `SEED` + same `origin` ⇒ identical noise for
   the whole session (a site that re-reads its canvas gets the same farbled bytes — no per-read
   jitter, which would itself be a tell and would break re-render comparisons).

Why this is strictly better than the roadmap-flagged naive design: the original sketch fed a
CSPRNG salt through a _non-crypto_ JS hash (fnv/xorshift), which is **invertible** — a site could
brute-force the 64-bit salt offline and predict other origins' noise (a cross-site super-cookie).
Here the page only ever sees a one-way HKDF output and one-way SHA-256 sub-seeds; the 256-bit
session salt is never exposed and never reconstructible. (Self-Review item 2.)

**Per-frame-origin, not per-top-eTLD+1 (honest, documented).** Brave seeds farbling by the _top_
frame's eTLD+1 so a site and its sub-resources farble consistently. In a shell the all-frames
document-start script _does_ run in cross-origin iframes, but a cross-origin child **cannot read
`window.top`'s origin** in JS (same-origin policy) — so Brave's "seed by top eTLD+1" is
unreachable. We therefore seed by **each frame's own `location.origin`** and document that as the
real, weaker behavior (a cross-origin iframe gets its own noise stream, not the top frame's). We do
NOT expose this as a configurable toggle — it is a platform limitation, stated plainly in the UI
copy and `src-tauri/CLAUDE.md`. (Roadmap §3.2 "Cross-origin iframe seeding (corrected)".)

**JS shim surfaces (what each level patches):**

| Surface                       | `standard` | `strict` | Technique (fail-open)                                                                                                                                                                                                                                                                                                    |
| ----------------------------- | ---------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Canvas**                    | yes        | yes      | Wrap `CanvasRenderingContext2D.getImageData`, `HTMLCanvasElement.toDataURL`/`toBlob` to flip ≤ a few LSBs of a deterministic subset of pixels (perceptually invisible, breaks hash).                                                                                                                                     |
| **Audio**                     | yes        | yes      | Wrap `AnalyserNode.getFloatFrequencyData`/`getByteFrequencyData` + `AudioBuffer.getChannelData` to add ≈1e-7 deterministic noise to samples.                                                                                                                                                                             |
| **WebGL**                     | no         | yes      | Wrap `WebGLRenderingContext.getParameter`/`WebGL2…` for `UNMASKED_RENDERER_WEBGL`/`UNMASKED_VENDOR_WEBGL` + a few precision/extension reads, returning a deterministic-but-plausible value; perturb `readPixels` LSBs. (strict only — highest breakage risk.)                                                            |
| **navigator / UA-CH**         | yes        | yes      | Normalize `navigator.hardwareConcurrency`, `deviceMemory`, `navigator.plugins`/`mimeTypes` length, and keep `navigator.userAgentData.brands` **consistent with `CONTENT_UA` (Chrome 148)** so the UA-CH brands can't go stale and become a tell. No randomization here — _consistency cleanup_, the most defensible win. |
| `Function.prototype.toString` | yes        | yes      | Patch the wrapped fns to report `[native code]` (reduces, never removes, detectability — documented).                                                                                                                                                                                                                    |

**Injection on each engine** (reuses S4, already done):

- **Desktop (Linux/Windows/macOS):** `farble::shim_for(level, salt, host_allowlisted)` returns the
  shim string (or `""` when off/allowlisted). `adblock_inject::compose` appends it after the
  WebRTC shim + pop-under guard, so it ships through the **same** `initialization_script_for_all_frames`
  path `nav::spawn_tab` already calls — Linux included (the farble JS runs in any engine).
- **Android:** a new `NativeFarble.farbleScript()` JNI getter (mirrors `NativeWebrtc.shimScript`)
  reads the Android-global level (seeded at boot + on `settings.set` via `farble::note_level`) and
  the boot session salt, registered per-tab in `MainActivity.createTabWebView` via
  `WebViewCompat.addDocumentStartJavaScript(wv, farble, setOf("*"))`.

**Settings / allowlist:**

- `antiFingerprint: 'off'|'standard'|'strict'` is a **settings field** (rides `settings.get/set`,
  no new channel — per the shared/ "settings-field shortcut"). Reader `farble::level(app)` mirrors
  `settings::webrtc_policy`.
- Per-site allowlist gets its **own** dispatch module `farble.rs` with channels
  `fingerprint.toggleAllowlist` / `fingerprint.removeAllowlist` / `fingerprint.clearAllowlist` /
  `fingerprint.getState`, backed by a persisted **syncable** store `fp-allowlist` (mirrors the
  ad-block allowlist `jsonstore::load_synced`/`stamp_new`/`tombstone` pattern). It is a _separate_
  list from the ad-block allowlist (a user may want ads blocked but farbling off on a banking site,
  or vice-versa). `farble::host_allowlisted(app, host)` (exact + subdomain match) is the desktop
  escape hatch consumed by `adblock_inject::script`.

## Tech Stack

- **Rust:** existing direct deps only — `getrandom 0.2` (session salt CSPRNG), `hkdf 0.12` +
  `sha2 0.10` (one-way SEED derivation). No new crate. `serde_json` for the allowlist store /
  state JSON. (`Cargo.toml` already carries all three — verified.)
- **Shim JS:** shipped as `src-tauri/src/farble.standard.js` / `farble.strict.js`, `include_str!`'d
  by `farble.rs` and executed verbatim by a vitest runtime test — the _exact same single-tested-artifact
  pattern_ as `webrtc_shim.public-only.js` + `src/lib/webrtcShim.test.ts`. The Rust composes the
  shim by prepending a `var __aegisFarbleSeed="<hex>";` line to the chosen artifact (so the test can
  inject its own seed and assert determinism).
- **TS/React:** `SecurityTab.tsx` gets the level `<select>` + the allowlist list UI;
  `src/lib/ipcClient.ts` adds the `fingerprint.*` namespace; `shared/types.ts` adds the field +
  channels + `AegisApi.fingerprint`.
- **Android:** Kotlin `NativeFarble.kt` getter + `MainActivity.createTabWebView` registration.
- **Autopilot:** `catalog.ts` (the `fingerprint.*` channels + a `verify` round-trip), `screens.ts`
  (the Security tab already exists; the allowlist is a sub-region — no new screen), `interactions/`
  (the level select + an allowlist add/remove gesture).

## Global Constraints

From the master design §6 (cross-cutting), the roadmap, and the repo CLAUDE.md — every task must honor:

1. **IPC in three places.** The `fingerprint.*` channels go in `shared/types.ts` (`IPC` const +
   `AegisApi.fingerprint`), the Rust `ipc()` dispatcher (`farble::dispatch` arm in `lib.rs`), and
   `src/lib/ipcClient.ts`. The `antiFingerprint` _setting_ needs NO channel (settings shortcut),
   only the `Settings` interface + `settings.rs defaults()` + a Rust reader. Event names stay dotted
   logically; there is no new event in this sub-project.
2. **Autopilot coverage in the same commit (drift-guarded).** The new `fingerprint.*` channels MUST
   appear in a `catalog.ts` entry's `channels[]` (the `coverage.test.ts` drift guard fails the build
   otherwise) with a `verify(api)` round-trip (toggle allowlist on → assert in `getState` → remove →
   assert gone). The level select + allowlist controls get `interactions/` specs + new
   `INTERACTIVE_CONTROLS` ids in the same commit (the `interactions.coverage.test.ts` guard).
3. **Gate per task.** `npm test` green; for the injection / runtime tasks,
   `bash scripts/autopilot/run-autopilot.sh` → `RESULT: … 0 failed` and `ad-block blocking
(trace): PASS` on Linux. A capability without its autopilot coverage is incomplete.
4. **Parity before "done."** Linux (live), Android (device), Windows (CI build + owner runtime),
   macOS (CI build; GUI-verify is hardware-gated sub-project I). Do NOT ship Linux-only. The shim is
   one artifact run on all four engines; the Android JNI getter + Kotlin registration is the genuine
   cross-platform work and is in scope here, not a follow-up.
5. **Fail-open everywhere.** Every wrapped surface is wrapped in `try/catch` and returns the
   original value on any error — a shim bug must never break a page's own JS (same contract as the
   WebRTC shim's FAIL-OPEN rule). The shim must also not throw at document-start.
6. **Secrets/seed hygiene.** The session salt lives only in process memory (a `OnceLock`), is never
   persisted, never enters `settings.json`, and is therefore never in `data.export`. Only the
   one-way `SEED` is exposed to the page. (Self-Review item 2.)
7. **No new trust boundary.** The shim is a one-way injected string + a public seed literal; content
   tabs have no `addJavascriptInterface` and gain none here — the no-page→core invariant is preserved
   (only sync/WebRTC/farbling features that _don't_ break it; autofill is the only one that does, and
   it's out of scope).

### The honest documented limit (must be written into `src-tauri/CLAUDE.md` + the UI + the plan's Self-Review)

A hand-written, **same-world** JS shim is the only fingerprint lever a shell has on all four
engines, and it is **detectable and potentially net-negative**:

- **Detectable.** `Function.prototype.toString` tampering, `Proxy`/getter-trap probing, and
  pristine-prototype comparison via a fresh `<iframe>` can all reveal that canvas/audio/WebGL are
  patched. A determined fingerprinter can detect _the presence of Aegis farbling_ and fingerprint on
  _that_ — and on a tiny user population this can make a user **more** identifiable, not less. That is
  why this ships **default-off** with a per-site escape hatch.
- **The two-engine consistency trap.** One shim must emit self-consistent values on a **WebKit**
  baseline (Linux/macOS) and a **Chromium** baseline (Windows/Android) while matching a Chrome-148 UA
  that _already lies about the engine on WebKit_. A `Chrome` UA + a WebKit-only quirk + farbled WebGL
  is a unique, stable Aegis signature — engine-quirk detection defeats the UA spoof regardless of the
  shim. We minimize, not eliminate, this; `strict`/WebGL is the riskiest and is opt-in within opt-in.
- **Per-frame-origin, not per-top-origin** (above) — weaker than Brave by design, not a bug.
- **Web-compat.** Canvas/audio noise is flagged by anti-bot/CAPTCHA vendors and can get users
  _challenged more_. Default-off + per-site disable is the mitigation.

This plan does NOT claim engine-level (Brave/Blink) farbling. It claims a meaningful, opt-in,
per-session/per-origin passive-fingerprint reduction with the salt provably one-way — and documents
exactly where it is weaker.

## File Structure

```
src-tauri/src/
├── farble.rs                  NEW  session salt (getrandom→OnceLock), one-way SEED (HKDF),
│                                   shim_for(level, allowlisted), level(app) reader,
│                                   fingerprint.* dispatch + fp-allowlist syncable store,
│                                   host_allowlisted(), Android note_level + NativeFarble JNI getter
├── farble.standard.js         NEW  shipped shim: canvas + audio + navigator/UA-CH + toString
├── farble.strict.js           NEW  shipped shim: standard + WebGL (highest-breakage, opt-in)
├── adblock_inject.rs          EDIT compose() appends farble::shim_for(...) to the injection tier;
│                                   script() passes level + allowlisted through
├── settings.rs                EDIT defaults() += "antiFingerprint":"off"; level() reader;
│                                   Android note_level() on set/apply_synced (mirror note_policy)
├── lib.rs                     EDIT mod farble; farble::init_session_salt() + note_level at boot;
│                                   farble::dispatch arm in ipc()
└── (Cargo.toml)               none — getrandom/hkdf/sha2 already present

src-tauri/gen/android/app/src/main/java/com/aegis/browser/
├── NativeFarble.kt            NEW  JNI getter object (mirrors NativeWebrtc.kt)
└── MainActivity.kt            EDIT createTabWebView: register the farble document-start script

shared/
└── types.ts                   EDIT Settings.antiFingerprint; IPC.fingerprint*; AegisApi.fingerprint

src/
├── lib/ipcClient.ts           EDIT aegis.fingerprint.{getState,toggleAllowlist,removeAllowlist,clearAllowlist}
├── lib/farbleShim.test.ts     NEW  vitest runtime test of the SHIPPED farble.*.js (mirror webrtcShim.test.ts)
├── components/SecurityTab.tsx EDIT level <select> + farble allowlist list UI
├── hooks/useFingerprint.ts    NEW  hook owning fingerprint allowlist state (mirror useAdblock shape)
└── autopilot/
    ├── catalog.ts             EDIT fingerprint.* entry (channels + exercise + verify round-trip)
    ├── interactions/settings.ts EDIT level-select + allowlist add/remove specs
    └── interactions/controls.ts EDIT new INTERACTIVE_CONTROLS ids
```

---

## Tasks (bite-sized, test-first)

### Task 1 — One-way session salt + public SEED derivation (Rust `#[test]`)

**Test first** (`farble.rs` `#[cfg(test)] mod tests`):

- `init_session_salt` is idempotent and the salt is non-zero after init.
- `public_seed()` is **deterministic for a given salt** (`expand` is a pure HKDF) and **16 bytes**.
- `public_seed` for two different salts differ.
- **One-way assertion:** `public_seed` is NOT a copy/slice of the salt (`assert_ne!(&seed[..], &salt[..16])`),
  proving the exposed value is a derived HKDF output, not the raw secret. (Self-Review item 2.)

**Implement** in a new `src-tauri/src/farble.rs`:

```rust
//! Anti-fingerprinting (farbling). A document-start JS shim that perturbs canvas/audio/
//! WebGL/navigator-UA-CH read surfaces with DETERMINISTIC, per-frame-origin, per-session
//! noise — so a site sees a stable-but-unique fingerprint within a session. Opt-in (default
//! `off`); per-site allowlist escape hatch. FAIL-OPEN throughout (a shim bug never breaks a
//! page). Honest limit: a same-world JS shim is detectable and on WebKit the UA already lies
//! about the engine — see src-tauri/CLAUDE.md. The shipped JS is single-sourced in
//! `farble.standard.js`/`farble.strict.js` and executed by the vitest runtime test
//! (src/lib/farbleShim.test.ts), which is AUTHORITATIVE for runtime behavior.
use hkdf::Hkdf;
use sha2::Sha256;

/// Per-SESSION 256-bit salt: OS CSPRNG, generated once at boot, NEVER persisted (resets each
/// session, like Brave's farbling seed). The page never sees it — only the one-way `public_seed`.
static SESSION_SALT: std::sync::OnceLock<[u8; 32]> = std::sync::OnceLock::new();

/// Fill the session salt from the OS CSPRNG. Idempotent (OnceLock): a second call is a no-op.
pub fn init_session_salt() {
    SESSION_SALT.get_or_init(|| {
        let mut b = [0u8; 32];
        // Fail-CLOSED on RNG failure would disable farbling, which is the safe default;
        // but getrandom failing is catastrophic, so just zero-fill (still one-way through HKDF)
        // — in practice getrandom never fails on a booted OS.
        let _ = getrandom::getrandom(&mut b);
        b
    });
}

fn salt() -> [u8; 32] {
    *SESSION_SALT.get_or_init(|| {
        let mut b = [0u8; 32];
        let _ = getrandom::getrandom(&mut b);
        b
    })
}

/// The 16-byte PUBLIC seed baked into the page shim = HKDF-SHA256(salt, "aegis-farble-seed-v1").
/// One-way: a page observing this (or any farbled value) cannot recover the 256-bit session
/// salt, so it cannot predict any other session's or — via the in-page per-origin SHA-256
/// sub-seed — any other origin's noise. This is the "not a super-cookie" guarantee.
pub fn public_seed() -> [u8; 16] {
    let mut out = [0u8; 16];
    Hkdf::<Sha256>::new(None, &salt())
        .expand(b"aegis-farble-seed-v1", &mut out)
        .expect("16 bytes is within HKDF's output limit");
    out
}

fn seed_hex() -> String {
    let s = public_seed();
    let mut h = String::with_capacity(32);
    for x in s { h.push_str(&format!("{x:02x}")); }
    h
}
```

**Verify:** `cargo test farble::` passes (run by the owner per the no-tests-here rule). Add `mod farble;`
to `lib.rs` and call `farble::init_session_salt()` near the other boot inits in `setup()`.

---

### Task 2 — The `standard` shim artifact + the runtime vitest test (the heart; mirror `webrtcShim.test.ts`)

**Test first** — `src/lib/farbleShim.test.ts`, mirroring `webrtcShim.test.ts`'s structure
(read the shipped `.js`, run it with a baked seed, assert behavior):

```ts
// Runtime test of the SHIPPED farble shim JS (src-tauri/src/farble.*.js). The Rust side
// include_str!'s these exact files (prefixing a seed literal), so executing them here tests
// the actual shipped bytes. Mirrors webrtcShim.test.ts. Runs in the vitest jsdom project.
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (n: string) => readFileSync(join(process.cwd(), 'src-tauri/src', n), 'utf8');
const STANDARD = read('farble.standard.js');

// Compose like Rust does: prepend the public-seed literal, then the shipped artifact.
const withSeed = (js: string, hex: string) =>
  `var __aegisFarbleSeed=${JSON.stringify(hex)};\n${js}`;
const SEED_A = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const SEED_B = '00112233445566778899aabbccddeeff';

function run(js: string, hex: string, origin = 'https://example.com') {
  // jsdom lets us set location via the constructor; emulate origin for the shim's read.
  Object.defineProperty(window, 'location', {
    value: { origin, href: origin + '/' },
    configurable: true,
  });
  // The shim is an IIFE; run it in global scope (it patches window/navigator prototypes).
  new Function(withSeed(js, hex))();
}

afterEach(() => {
  /* jsdom resets per-file; nothing persisted */
});

describe('farble shim (standard) — shipped JS, runtime', () => {
  it('perturbs canvas getImageData but stays within a few LSBs (plausible)', () => {
    run(STANDARD, SEED_A);
    const c = document.createElement('canvas');
    c.width = 8;
    c.height = 8;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, 8, 8);
    const a = ctx.getImageData(0, 0, 8, 8).data;
    const b = ctx.getImageData(0, 0, 8, 8).data;
    // DETERMINISTIC: two reads in the SAME session+origin are identical (no per-read jitter).
    expect(Array.from(a)).toEqual(Array.from(b));
    // PERTURBED but PLAUSIBLE: every channel within ±a small bound of 0x80 (LSB flip).
    for (let i = 0; i < a.length; i += 4) expect(Math.abs(a[i] - 0x80)).toBeLessThanOrEqual(3);
  });

  it('noise is DETERMINISTIC per seed+origin, DIFFERENT across origins', () => {
    run(STANDARD, SEED_A, 'https://a.example');
    const sig = (o: string) => {
      /* render+toDataURL helper */ return '';
    };
    // (helper renders a fixed scene and returns toDataURL; asserted equal on re-run, ≠ across origin)
  });

  it('noise DIFFERS across sessions (different seed)', () => {
    /* SEED_A vs SEED_B → different toDataURL */
  });

  it('audio getChannelData is perturbed deterministically and bounded (~1e-7)', () => {
    /* … */
  });

  it('navigator.userAgentData.brands stay consistent with the Chrome-148 UA (no stale tell)', () => {
    /* … */
  });

  it('FAIL-OPEN: a surface that throws leaves the original value', () => {
    /* monkeypatch a getter to throw */
  });

  it('patched fn toString reports [native code]', () => {
    run(STANDARD, SEED_A);
    expect(Function.prototype.toString.call(HTMLCanvasElement.prototype.toDataURL)).toContain(
      '[native code]',
    );
  });
});
```

**Implement** `src-tauri/src/farble.standard.js` — a self-contained IIFE. Skeleton (real, no
placeholders for the load-bearing parts; full bodies written during implementation):

```js
// Farble "standard" document-start shim — perturbs canvas/audio/navigator-UA-CH reads with
// deterministic per-frame-origin, per-session noise. FAIL-OPEN: any error leaves the original
// value, and nothing throws at document-start. Seed literal `__aegisFarbleSeed` (hex) is
// prepended by Rust; it is HKDF(salt) — one-way, never the raw salt. Per-FRAME-origin: a
// cross-origin iframe seeds on its own location.origin (window.top is unreadable cross-origin).
(function () {
  try {
    var SEEDHEX = typeof __aegisFarbleSeed === 'string' ? __aegisFarbleSeed : '';
    if (!SEEDHEX) return; // no seed → no-op (fail-open)
    function hexToBytes(h) {
      var a = [];
      for (var i = 0; i < h.length; i += 2) a.push(parseInt(h.substr(i, 2), 16));
      return a;
    }
    // --- tiny self-contained SHA-256 (sync, engine-identical; no Web Crypto async dependency) ---
    function sha256(bytes) {
      /* standard 64-round SHA-256 over a byte array → 32-byte array */
    }
    var origin = '';
    try {
      origin = String(location.origin || '');
    } catch (e) {}
    // per-ORIGIN one-way sub-seed = SHA-256(SEED ++ origin)[..8]; reveals nothing about SEED.
    var sub = sha256(
      hexToBytes(SEEDHEX).concat(
        Array.prototype.map.call(origin, function (c) {
          return c.charCodeAt(0) & 255;
        }),
      ),
    ).slice(0, 8);
    // --- xoshiro128** PRNG seeded from sub (deterministic noise stream) ---
    var s0 = (sub[0] | (sub[1] << 8) | (sub[2] << 16) | (sub[3] << 24)) >>> 0,
      s1 = (sub[4] | (sub[5] << 8) | (sub[6] << 16) | (sub[7] << 24)) >>> 0,
      s2 = 0x9e3779b9,
      s3 = 0x243f6a88;
    function rotl(x, k) {
      return ((x << k) | (x >>> (32 - k))) >>> 0;
    }
    function next() {
      var r = (rotl((s1 * 5) >>> 0, 7) * 9) >>> 0;
      var t = (s1 << 9) >>> 0;
      s2 ^= s0;
      s3 ^= s1;
      s1 ^= s2;
      s0 ^= s3;
      s2 ^= t;
      s3 = rotl(s3, 11);
      return r;
    }
    function nextFloat() {
      return next() / 4294967296;
    } // [0,1)
    function noiseByte() {
      return (next() % 3) - 1;
    } // -1,0,+1 (a single LSB step)

    function markNative(fn) {
      try {
        fn.toString = function () {
          return 'function ' + (fn.name || '') + '() { [native code] }';
        };
      } catch (e) {}
      return fn;
    }

    // ---- CANVAS ----
    try {
      var gid = CanvasRenderingContext2D.prototype.getImageData;
      CanvasRenderingContext2D.prototype.getImageData = markNative(function () {
        var img = gid.apply(this, arguments);
        try {
          var d = img.data;
          for (var i = 0; i < d.length; i += 4) {
            d[i] = Math.max(0, Math.min(255, d[i] + noiseByte()));
          }
        } catch (e) {}
        return img;
      });
      ['toDataURL', 'toBlob'].forEach(function (m) {
        var o = HTMLCanvasElement.prototype[m];
        if (typeof o !== 'function') return;
        HTMLCanvasElement.prototype[m] = markNative(function () {
          try {
            var ctx = this.getContext('2d');
            if (ctx) {
              /* re-noise a deterministic pixel subset before serialize */
            }
          } catch (e) {}
          return o.apply(this, arguments);
        });
      });
    } catch (e) {}

    // ---- AUDIO ----   (AnalyserNode.getFloatFrequencyData / AudioBuffer.getChannelData, +~1e-7)
    // ---- NAVIGATOR / UA-CH ---- (normalize hardwareConcurrency/deviceMemory; keep UA-CH brands == Chrome 148)
    // (full bodies, all wrapped in try/catch, written during implementation)
  } catch (e) {}
})();
```

**Implement** in `farble.rs`: `shim_for(level, host_allowlisted) -> String` that returns `""` when
`off`/allowlisted, else `format!("var __aegisFarbleSeed=\"{}\";\n{}", seed_hex(), artifact)` where
`artifact = include_str!("farble.standard.js")` (or strict). Add a Rust marker test that the composed
`standard` string contains the seed line + `getImageData` + `[native code]`, mirroring
`webrtc_shim`'s `shim_for_emits_the_right_artifact_per_policy`.

**Verify:** `npm test src/lib/farbleShim.test.ts` green — asserts deterministic-per-seed+origin,
different across origins, different across sessions, bounded/plausible, fail-open, `[native code]`.
This vitest file is the authoritative runtime test (Self-Review item 1: every surface covered).

---

### Task 3 — The `strict` shim artifact (adds WebGL) + its runtime test

**Test first** (extend `farbleShim.test.ts`): the `strict` artifact does everything `standard`
does **plus** `WebGLRenderingContext.getParameter(UNMASKED_RENDERER_WEBGL)` returns a
deterministic-but-plausible string (not the real GPU), `readPixels` LSBs are perturbed, and it is
still fail-open. Assert `standard` does NOT patch WebGL (so the level gradient is real).

**Implement** `farble.strict.js`: concatenation-friendly — emit the shared canvas/audio/navigator
block plus a WebGL block. To avoid divergence, factor the shared block into a string both artifacts
build from at _Rust_ compose time is overkill; instead duplicate-by-include is fine since the vitest
test runs both. (Decide during impl; the test pins behavior either way.)

**Verify:** `npm test src/lib/farbleShim.test.ts` green for both `standard` and `strict` describes.

---

### Task 4 — Settings field `antiFingerprint` + Rust reader + Android level note

**Test first:** extend `shared/types.test.ts` invariants if needed; add a `settings.rs` `#[test]`
that `defaults()` carries `"antiFingerprint":"off"` and `level(app)` returns the default/override.
(Follow `webrtc_policy`'s test-less reader style — if there's no direct settings reader test, add a
small `#[test]` for the new reader in `farble.rs`.)

**Implement:**

- `shared/types.ts`: add `antiFingerprint: 'off' | 'standard' | 'strict';` to `Settings` (with the
  doc comment explaining opt-in + detectability).
- `settings.rs defaults()`: add `"antiFingerprint": "off"`.
- `farble.rs`: `pub fn level(app: &AppHandle) -> String` mirroring `settings::webrtc_policy` (reads
  `antiFingerprint`, default `"off"`).
- `settings.rs`: in `dispatch` `settings.set` **and** `apply_synced` (the synced path), add
  `#[cfg(target_os="android")] crate::farble::note_level(&farble::level(app));` right next to the
  existing `webrtc_shim::note_policy` calls (so a peer-synced or local change updates the Android
  document-start getter — same pattern, no restart needed).
- `farble.rs`: `#[cfg(target_os="android")]` `static ANDROID_LEVEL: RwLock<String>` + `note_level` +
  `android_level()` (default `"off"`), mirroring `webrtc_shim::note_policy`/`android_policy`.

**Verify:** `npm test` (shared + jsdom) green; `cargo test settings:: farble::`.

---

### Task 5 — `fingerprint.*` allowlist dispatch + persisted syncable store (Rust)

**Test first** (`farble.rs` `#[test]`): mirror `adblock`'s allowlist semantics on a temp store —
`host_allowlisted` matches exact + subdomain (`example.com` covers `www.example.com`), is false for
empty/unlisted; the dispatch toggles a host on→off and `getState` reflects it. (Use the same
`jsonstore::load_synced`/`stamp_new`/`tombstone` helpers the ad-block allowlist uses; the store key is
`"fp-allowlist"`.)

**Implement** in `farble.rs`:

- `pub fn host_allowlisted(app, host) -> bool` (exact + `.host` subdomain match; the desktop escape
  hatch), `#[cfg_attr(target_os="android", allow(dead_code))]` (desktop-only escape hatch in v1, like
  the WebRTC one).
- `load_allowlist_hosts` / `add_host` / `remove_host` / `clear_hosts` / `seed`-on-boot — copy the
  `adblock.rs` shape verbatim but on the `"fp-allowlist"` store; call `crate::sync::nudge(app)` after
  mutations (the list is syncable, no-op when sync off).
- `pub fn dispatch(app, channel, payload) -> Option<Result<Value,String>>`:
  `fingerprint.getState` → `{ level, allowlistedHosts }`; `fingerprint.toggleAllowlist` /
  `fingerprint.removeAllowlist` / `fingerprint.clearAllowlist` (mirror `adblock::dispatch`).
- `lib.rs`: add `if let Some(r) = farble::dispatch(&app, &channel, &payload) { return r; }` to the
  `ipc()` chain, and seed the boot allowlist near `adblock::seed_from_disk`.

**Verify:** `cargo test farble::`; manual dispatch round-trip exercised by the catalog `verify` in Task 9.

---

### Task 6 — Wire the shim into the desktop injection tier (`adblock_inject.rs`)

**Test first** (`adblock_inject.rs` `#[test]`): `compose` with a non-empty farble argument appends it
after the pop-under guard (`assert!(super::compose("", "/*farble*/").ends_with("/*farble*/"))` or
similar), and `compose("", "")` is unchanged from today — so an `off`/allowlisted page injects no
farble. Keep the existing pop-under-guard/WebRTC assertions passing.

**Implement:**

- `adblock_inject.rs`: extend `script(app, host_allowlisted)` to also compute
  `let farble = crate::farble::shim_for(&crate::farble::level(app), crate::farble::host_allowlisted(app, /*tab host*/));`
  — **note:** `script` currently only knows the ad-block-allowlist flag; the farble allowlist is a
  _separate_ list, so resolve the tab host and call `farble::host_allowlisted` here. (The tab host is
  already derivable where `script` is called in `nav::spawn_tab`; thread the host through if not
  already — confirm against `nav::spawn_tab` and pass the host, defaulting empty if unknown.)
- `compose(webrtc, farble)`: append `farble` after the pop-under guard (and after the non-Linux
  ad-block body), Linux included.
- Update the module doc comment + `src-tauri/CLAUDE.md` to record that the farble block now rides this
  tier, with the detectability/honest-limit note.

**Verify:** `cargo test adblock_inject::`; then the runtime gate —
`bash scripts/autopilot/run-autopilot.sh` → `RESULT: … 0 failed` and `ad-block blocking (trace): PASS`
(the farble injection must not regress ad-block or navigation; default-off means the trace runs with
no farble unless a probe enables it).

---

### Task 7 — Android: `NativeFarble` JNI getter + `MainActivity` registration

**Test first:** there is no Rust unit test harness for the JNI export (the WebRTC one has none either);
the test is the **Android compile gate** + device run. Add a `farble.rs` `#[cfg(target_os="android")]`
JNI export `Java_com_aegis_browser_NativeFarble_farbleScript` that returns
`shim_for(&android_level(), false)` with the boot seed baked in (host allowlist is desktop-only in v1,
matching the WebRTC getter's `host_allowlisted=false`). Null jstring on failure (Kotlin skips).

**Implement:**

- `src-tauri/src/farble.rs`: the JNI export (copy `webrtc_shim`'s `Java_..._NativeWebrtc_shimScript`
  shape exactly).
- `gen/android/app/src/main/java/com/aegis/browser/NativeFarble.kt`: copy `NativeWebrtc.kt`, rename to
  `farbleScript()`.
- `MainActivity.createTabWebView`: after the WebRTC block, add a `DOCUMENT_START_SCRIPT`-gated block
  that reads `NativeFarble.farbleScript()` and registers it via
  `WebViewCompat.addDocumentStartJavaScript(wv, farble, setOf("*"))`, in a try/catch (mirror the
  WebRTC registration verbatim). Read fresh per tab so a level change applies to new tabs.

**Verify:** `JAVA_HOME=~/development/android-studio/jbr npm run android:build` compiles (Rust
`cargo check --target aarch64-linux-android` + Kotlin `compileUniversalDebugKotlin` both run on this
host — per the memory note). Owner device-run confirms farbling applies on Android (probe page shows
perturbed canvas with level=standard).

---

### Task 8 — `ipcClient.ts` + `useFingerprint` hook + `SecurityTab` UI (level select + allowlist)

**Test first** (`src/components/SecurityTab.test.tsx` — extend or add): rendering the tab with a
mocked `aegis.fingerprint` shows the level `<select>` (aria-label "Anti-fingerprinting level") with
the current value; changing it calls `update({ antiFingerprint: … })`; the allowlist list renders the
hosts from `getState`, and clicking "Remove" calls `removeAllowlist(host)` and drops the row (mirror
the existing HTTP-exceptions list test pattern in this file).

**Implement:**

- `shared/types.ts`: `IPC.fingerprintGetState/ToggleAllowlist/RemoveAllowlist/ClearAllowlist` +
  `AegisApi.fingerprint = { getState, toggleAllowlist, removeAllowlist, clearAllowlist }` returning
  `{ level: string; allowlistedHosts: string[] }`.
- `src/lib/ipcClient.ts`: the `fingerprint` namespace (`call<…>(IPC.fingerprint*, …)`), mirroring
  `adblock`.
- `src/hooks/useFingerprint.ts`: owns the allowlist state + the four calls (mirror `useAdblock`).
- `SecurityTab.tsx`: add an "Anti-fingerprinting" `<h3>` + a `<select>` (off/standard/strict) bound to
  `settings.antiFingerprint` via the existing `update` prop, an explanatory `<p>` that **states the
  opt-in + detectability limit + per-frame-origin behavior** (the honest UI copy), and a "Sites with
  fingerprint protection off" allowlist list (reuse the HTTP-exceptions list markup) wired to
  `useFingerprint`. Thread `useFingerprint` into the Settings parent that renders `SecurityTab`.

**Verify:** `npm test src/components/SecurityTab.test.tsx` + the shared/types tests green.

---

### Task 9 — Autopilot coverage (catalog + interactions) — drift-guard required

**Test first:** the drift guards ARE the tests. After adding the channels in Task 8, `npm test`
(`coverage.test.ts`) FAILS until a catalog entry lists them — that red is the test-first signal.

**Implement:**

- `src/autopilot/catalog.ts`: a `fingerprint` entry —
  `{ id: 'fingerprint.allowlist', domain: 'fingerprint', title: 'Anti-fingerprint level + allowlist',
channels: [IPC.fingerprintGetState, IPC.fingerprintToggleAllowlist, IPC.fingerprintRemoveAllowlist, IPC.fingerprintClearAllowlist],
exercise: a => a.fingerprint.getState(),
verify: async a => { /* getState → toggleAllowlist('probe.test') → assert present → removeAllowlist → assert gone */ } }`.
  The `antiFingerprint` _setting_ is already covered by the existing `settings.getset` entry (it rides
  `settings.set`), so no extra channel coverage is needed for it — but add an assertion in that
  entry's `verify` that set/restore of `antiFingerprint` round-trips, OR add it to the fingerprint
  entry's verify (set standard → assert getState.level → restore off).
- `src/autopilot/interactions/settings.ts`: a spec for the level `<select>`
  (`settings.security.farbleLevel` → change to `strict`, assert `settings.set` called with
  `antiFingerprint:'strict'`) and an allowlist remove spec (mirror the WebRTC/HTTP-exception specs).
- `src/autopilot/interactions/controls.ts`: add the new `INTERACTIVE_CONTROLS` ids in the same commit
  (the `interactions.coverage.test.ts` guard requires each has ≥1 spec).

**Verify:** `npm test` green (both drift guards pass), and the desktop interaction tour exercises the
new controls.

---

### Task 10 — Docs, parity sweep, and the live/runtime gate

**Implement:**

- `src-tauri/CLAUDE.md`: add a "Anti-fingerprinting / farbling" module bullet (the surfaces, the
  one-way salt→SEED→per-origin-sub-seed model, the per-frame-origin limit, the
  default-off/detectability honest limit, the desktop-only allowlist hatch in v1) — the same
  living-docs discipline the WebRTC bullet follows.
- `docs/FEATURE_ROADMAP.md`: flip farbling from "ABSENT/planned" to its real shipped state with the
  documented limits (this is partly sub-project B's job, but record the L-specific reality here).
- Confirm `data.export` does NOT carry the session salt (it can't — it's a `OnceLock`, never in
  `settings.json`) and the `fp-allowlist` store rides the existing syncable-store machinery.

**Verify (the parity + runtime gate):**

- Linux live: `bash scripts/autopilot/run-autopilot.sh` → `RESULT: … 0 failed` +
  `ad-block blocking (trace): PASS`. Plus a manual probe: navigate to a canvas-fingerprint probe with
  `antiFingerprint=standard` and observe the canvas hash differs from `off` (and is stable on reload,
  differs cross-origin).
- Android: `npm run android:build` compiles (JBR 21); owner device-run shows perturbed canvas.
- Windows/macOS: CI build green (the shim is the same artifact; macOS GUI is sub-project I).
- `npm test` green (all drift guards + the farble runtime test + SecurityTab test).

---

## Self-Review

Run this checklist before declaring sub-project L complete:

1. **Every surface covered.** `farble.standard.js` patches **canvas** (`getImageData`/`toDataURL`/
   `toBlob`), **audio** (`getFloatFrequencyData`/`getChannelData`), and **navigator/UA-CH**
   (`hardwareConcurrency`/`deviceMemory`/`userAgentData.brands` kept consistent with Chrome 148);
   `farble.strict.js` adds **WebGL** (`getParameter` UNMASKED\_\*/`readPixels`). The vitest
   `farbleShim.test.ts` asserts each surface is perturbed-but-plausible. **PASS criterion:** a test
   exists and passes for every row of the surfaces table; `strict` demonstrably patches WebGL and
   `standard` demonstrably does not.
2. **Salt is one-way.** The 256-bit `SESSION_SALT` is a `OnceLock` filled by `getrandom`, never
   persisted, never in `settings.json`/`data.export`. The page receives only `public_seed =
HKDF-SHA256(salt)[..16]`; per-origin sub-seeds are `SHA-256(SEED ++ origin)[..8]` — both one-way.
   The Task 1 Rust test asserts `public_seed != salt[..16]`; no non-crypto/invertible hash is used on
   the seed path. **PASS criterion:** no code path exposes the raw salt to JS or disk, and the
   one-way assertion test passes.
3. **Allowlist respected.** `farble::host_allowlisted` (exact + subdomain) is consulted in
   `adblock_inject::script` before composing the farble block, so an allowlisted site injects `""`;
   the `fingerprint.*` dispatch + persisted syncable `fp-allowlist` store is round-tripped by the
   catalog `verify`. **PASS criterion:** the verify round-trip passes and an allowlisted host receives
   no farble shim (Rust compose test + the desktop probe).
4. **Limit documented.** The detectability / two-engine-consistency / per-frame-origin /
   default-off / web-compat limits are written into the plan's Global Constraints, the
   `SecurityTab` UI copy, and `src-tauri/CLAUDE.md`. **PASS criterion:** all three locations carry the
   honest limit; the UI never claims engine-level or Brave-parity farbling.
5. **Parity + fail-open.** The shim is one artifact on all four engines; Android JNI getter + Kotlin
   registration shipped here (not deferred). Every wrapped surface is `try/catch` fail-open and the
   shim cannot throw at document-start. **PASS criterion:** `npm test` green, Linux autopilot
   `0 failed` + ad-block trace PASS, Android build compiles, Win/macOS CI green.

### Honest limits restated (not resolved, by design)

- Same-world JS shim → **detectable** (toString/Proxy/pristine-iframe probing); on a tiny user
  population farbling can be net-negative, hence **default-off + per-site hatch**.
- **Per-frame-origin** seeding (cross-origin iframes can't read the top origin), not Brave's
  per-top-eTLD+1 — weaker, documented, not a toggle.
- On **WebKit** (Linux/macOS) the Chrome-148 UA already lies about the engine; engine-quirk detection
  defeats the spoof regardless of the shim. We minimize, never eliminate, the resulting Aegis
  signature; `strict`/WebGL is the riskiest and is opt-in-within-opt-in.
- This is **not** engine-level (Blink) farbling and the plan never claims to be.

```

```
