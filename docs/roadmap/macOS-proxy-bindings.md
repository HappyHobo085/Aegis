# macOS Proxy Implementation Guide

## Overview

Aegis routes browsed content through a user-configured HTTP or SOCKS5 proxy on
Linux (live per-webview via WebKitGTK `set_network_proxy_settings`), Windows
(spawn-time `--proxy-server` arg), and Android (process-global `ProxyController`
via Kotlin JNI). macOS currently passes the proxy config through `apply_to_tab`
as a no-op — traffic goes out direct with no proxy applied.

The reason is that macOS proxy support requires `WKWebsiteDataStore.proxyConfigurations`
(macOS 14+), which accepts an array of `nw_proxy_config_*` objects from the
Network.framework C API. These are **C functions, not Objective-C methods** — they
need `extern "C"` FFI declarations, not objc2 message sending. The bindings must be
hand-rolled because:

1. `objc2-web-kit` (v0.3.2) does not expose `proxyConfigurations`.
2. `nw_proxy_config_create_http`, `nw_proxy_config_create_socksv5`, and
   `nw_endpoint_create_host` are plain C functions from Network.framework — not
   Objective-C classes — so they require raw `extern "C"` + `link` attribute FFI.
3. The resulting `nw_proxy_config_t` opaque pointers must be wrapped in a
   `#[repr(transparent)]` newtype to pass as `id` (Objective-C object pointer)
   into the `WKWebsiteDataStore` setter.
4. **objc2 cannot be compiled from Linux** — its build script invokes the
   macOS C toolchain. All verification is CI-only (`macos-latest` in
   `tauri-build-check.yml`).

---

## The API Surface

### `WKWebsiteDataStore.proxyConfigurations` (macOS 14+)

A settable property that accepts an `NSArray` of proxy-configuration objects.
Setting it to an empty array clears the proxy (direct connection). Each
configuration object is created via the Network.framework C API.

Objective-C declaration (for reference):

```objc
@property (nonatomic, copy) NSArray<NWProxyConfiguration *> *proxyConfigurations;
```

### Proxy configuration constructors

Two C functions create the proxy config objects:

```c
// HTTP/HTTPS proxy
nw_proxy_config_t nw_proxy_config_create_http(
    nw_endpoint_t proxy_endpoint,
    nw_endpoint_t target_endpoint   // NULL for all traffic
);

// SOCKS5 proxy
nw_proxy_config_t nw_proxy_config_create_socksv5(
    nw_endpoint_t proxy_endpoint
);
```

### Endpoint creation

```c
// Create a host endpoint from hostname + port
nw_endpoint_t nw_endpoint_create_host(const char *hostname, uint16_t port);
```

### Match domains (bypass list)

Each `nw_proxy_config_t` has a match-domains setter. Matching domains go
**direct** (not proxied). The equivalent Objective-C setter is
`-[NWProxyConfiguration setMatchDomains:]` (an `NSArray<NSString *>`), but
since we're constructing from C FFI, the flow is:

1. Create the config via `nw_proxy_config_create_http` or `_create_socksv5`.
2. Set match domains via `nw_proxy_config_set_match_domains(config, domains, count)`
   or use the Objective-C property setter on the returned object.

> **Note:** `nw_proxy_config_set_match_domains` may require macOS 15+. If targeting
> macOS 14, the match-domains can be set via `objc2` message sending on the returned
> `id` pointer: `[proxyConfig setMatchDomains:@[@"localhost", @"127.0.0.1"]]`.
> Verify the available API surface on the target macOS version.

---

## Required FFI Bindings

The following need `extern "C"` declarations in a new module (e.g.
`src-tauri/src/proxy_mac.rs`):

### Opaque types

```rust
use std::ffi::c_void;

/// Opaque Network.framework endpoint handle.
#[repr(transparent)]
struct __NWEndpoint(c_void);

/// Opaque Network.framework proxy-config handle.
#[repr(transparent)]
struct __NWProxyConfig(c_void);

type nw_endpoint_t = *const __NWEndpoint;
type nw_proxy_config_t = *const __NWProxyConfig;
```

### Link attribute

```rust
#[link(name = "Network", kind = "framework")]
extern "C" {
    fn nw_endpoint_create_host(hostname: *const std::ffi::c_char, port: u16)
        -> nw_endpoint_t;
    fn nw_proxy_config_create_http(
        proxy_endpoint: nw_endpoint_t,
        target_endpoint: nw_endpoint_t,
    ) -> nw_proxy_config_t;
    fn nw_proxy_config_create_socksv5(
        proxy_endpoint: nw_endpoint_t,
    ) -> nw_proxy_config_t;
}
```

These functions are **always available** on macOS 12+ (Network.framework has
been present since macOS 10.14). The `proxyConfigurations` property on
`WKWebsiteDataStore` requires macOS 14+. Guard the runtime path with an
`@available(macOS 14.0, *)` check and fall back to no-op on older macOS.

### Release

The `nw_proxy_config_t` and `nw_endpoint_t` are reference-counted CF objects.
Call `CFRelease` (via `objc2_foundation::CFType` or raw `extern "C"` to
`CFRelease`) when done. In practice, they are short-lived: created, handed
to the setter, then released.

---

## Reference Patterns in the Codebase

### `find_mac.rs` — WKWebView access + callback pattern

The established pattern for reaching a content webview's `WKWebView` from a
Tauri `AppHandle`:

```rust
fn with_content_webview<F>(app: &AppHandle, id: u32, f: F)
where
    F: FnOnce(&WKWebView) + Send + 'static,
{
    let label = crate::nav::content_label(id);
    let Some(content) = app.get_webview(&label) else { return; };
    let _ = content.with_webview(move |pw| {
        let ptr = pw.inner() as *mut WKWebView;
        if ptr.is_null() { return; }
        if let Some(wv) = unsafe { Retained::retain(ptr) } {
            f(&wv);
        }
    });
}
```

The `with_webview` closure runs on the macOS main thread, so
`MainThreadMarker::new_unchecked()` is safe inside it.

### `nav_url_mac.rs` — KVO observer pattern

Demonstrates `define_class!` for custom Objective-C classes with ivars,
`addObserver_forKeyPath_options_context`, and `Drop` for cleanup.
Also shows `pw.inner() as *mut WKWebView` → `Retained::retain()`.

### `linux_layout.rs` `apply_proxy_label` — the proxy-apply pattern

The Linux side shows the full flow: get webview by label → `with_webview` →
access the web data manager → call the platform setter. The macOS equivalent
will follow the same shape but use `WKWebsiteDataStore.proxyConfigurations`
instead of `WebsiteDataManagerExt::set_network_proxy_settings`.

---

## Integration Point

The implementation goes into `apply_to_tab` in `src-tauri/src/proxy.rs`,
line ~188:

```rust
#[cfg(target_os = "macos")]
{
    // Currently: let _ = (id, cfg);
    // Implement: apply cfg to the WKWebsiteDataStore for this tab.
}
```

The function receives:

- `app: &AppHandle<R>` — the Tauri application handle
- `id: u32` — the tab id (use `crate::nav::content_label(id)` to get the webview label)
- `cfg: &ProxyConfig` — with fields:
  - `cfg.is_active()` — true when a proxy should be applied
  - `cfg.default_uri()` — `Some("http://host:port")` or `Some("socks5://host:port")`
  - `cfg.host` / `cfg.port` — the proxy endpoint
  - `cfg.scheme` — `"http"` or `"socks5"`
  - `cfg.bypass_hosts` — `Vec<String>` of hosts that should bypass the proxy

### Implementation sketch

```rust
#[cfg(target_os = "macos")]
{
    use objc2::rc::Retained;
    use objc2_web_kit::WKWebView;

    let Some(content) = app.get_webview(&crate::nav::content_label(id)) else {
        return;
    };
    let cfg_owned = cfg.clone();
    let _ = content.with_webview(move |pw| {
        let ptr = pw.inner() as *mut WKWebView;
        if ptr.is_null() { return; }
        let Some(wv) = unsafe { Retained::retain(ptr) } else { return; };

        unsafe {
            let mtm = objc2::MainThreadMarker::new_unchecked();

            if cfg_owned.is_active() {
                // Build proxy endpoint
                let host_cstr = std::ffi::CString::new(cfg_owned.host.clone()).unwrap();
                let endpoint = nw_endpoint_create_host(host_cstr.as_ptr(), cfg_owned.port);

                // Build proxy config based on scheme
                let proxy_config = match cfg_owned.scheme.as_str() {
                    "socks5" => nw_proxy_config_create_socksv5(endpoint),
                    _ => nw_proxy_config_create_http(endpoint, std::ptr::null()),
                };

                // Set match-domains from bypass_hosts (hosts that go direct)
                if !cfg_owned.bypass_hosts.is_empty() {
                    // Use objc2 message sending to set matchDomains on the proxy config
                    // [proxyConfig setMatchDomains:@[@"localhost", @"127.0.0.1"]]
                    // ... (objc2 FFI for NSArray<NSString> construction)
                }

                // Wrap in NSArray and set on the data store
                let data_store = wv.websiteDataStore();
                let configs: Retained<NSArray<_>> = NSArray::from_vec(mtm, vec![proxy_config_id]);
                data_store.setProxyConfigurations(Some(&configs));

                // Release CF objects
                CFRelease(proxy_config as *const c_void);
                CFRelease(endpoint as *const c_void);
            } else {
                // Clear proxy — empty array = direct connection
                let data_store = wv.websiteDataStore();
                data_store.setProxyConfigurations(Some(&NSArray::new(mtm)));
            }
        }
    });
}
```

> **Important notes:**
>
> - The exact `setProxyConfigurations:` method signature depends on the
>   `objc2-web-kit` version. Check the generated bindings for the actual
>   method name and parameter types.
> - If `setProxyConfigurations:` is not exposed by `objc2-web-kit` 0.3.2,
>   you may need to use `msg_send!` directly.
> - `NSArray::from_vec` requires `MainThreadMarker` since it may allocate on
>   the main thread.
> - CF object lifetime: the `nw_proxy_config_t` and `nw_endpoint_t` are
>   consumed by the setter (it copies/retains internally), so they can be
>   released immediately after.

### Spawn-time application

In addition to `apply_to_tab` (live apply), the proxy should also be applied
at tab spawn time. In `nav.rs`, after the macOS webview is created (line ~539),
call `proxy::apply_to_tab(app, id)` — this already happens at line 554. No
additional spawn-time code is needed since `apply_to_tab` is already called
from `spawn_tab`.

---

## Cargo.toml Dependencies

No new dependencies are needed. The existing dependencies cover the FFI:

- `objc2` — message sending, `define_class!`, `Retained`, `MainThreadMarker`
- `objc2-foundation` — `NSString`, `NSArray`, `NSObject`
- `objc2-web-kit` — `WKWebView`, `WKWebsiteDataStore` (check if
  `proxyConfigurations` setter is exposed; if not, use `msg_send!`)

If `WKWebsiteDataStore` doesn't expose `setProxyConfigurations:` in the
current `objc2-web-kit` bindings, add it manually via `msg_send!`:

```rust
use objc2::{msg_send, ClassType};
// Assuming the setter exists but isn't bound:
let data_store = wv.websiteDataStore();
msg_send![data_store, setProxyConfigurations: configs_array];
```

---

## Testing Approach

### 1. TCP-reachability probe (already works)

`proxy.testConnection` performs a TCP connect to `host:port`. This verifies
the proxy server is reachable but does NOT prove traffic egresses through it.

### 2. Live egress verification (the real test)

Same approach used for Windows verification:

1. Start a local logging proxy (e.g. `mitmproxy`, `nc -l`, or a simple
   Node.js `net.createServer` that logs CONNECT requests).
2. Open Aegis on macOS and configure it to use `http://127.0.0.1:<port>`.
3. Navigate to any HTTPS site.
4. Verify the proxy log shows the `CONNECT` request for that host.

Example with netcat:

```bash
# Terminal 1: logging proxy
nc -l 8888 -v

# Terminal 2: launch Aegis, set proxy to http://127.0.0.1:8888, browse
```

Expected: the proxy sees `CONNECT example.com:443` traffic.

### 3. Bypass-list verification

With bypass hosts set (e.g. `["localhost", "127.0.0.1"]`):

1. Navigate to `http://localhost:3000` — should NOT appear in the proxy log.
2. Navigate to `https://example.com` — SHOULD appear in the proxy log.

### 4. SOCKS5 verification

Same as HTTP but with `scheme: "socks5"` and a SOCKS5 proxy (e.g.
`ssh -D 1080` or `dante`). The CONNECT traffic should appear as SOCKS5
handshake bytes.

### 5. Clear-proxy verification

1. Set a proxy, verify traffic flows through it.
2. Call `proxy.clear`, verify the next request goes direct (no proxy log entry).

---

## Compilation Notes

- **objc2 cannot compile from Linux.** The `objc2` build script runs a
  macOS C toolchain to generate bindings. All macOS-specific Rust code is
  CI-only: the `tauri-build-check.yml` workflow on `macos-latest` is the
  verification gate.
- **Cross-compilation check:** `cargo check --target x86_64-apple-darwin` from
  Linux will also fail for the same reason. The CI `macos-latest` job is the
  only way to verify compilation.
- **Runtime verification** requires a macOS 14+ desktop session (physical Mac
  or macOS VM with display). CI builds the artifact (`.app` / `.dmg`) but does
  not run automated GUI tests.

---

## Step-by-Step Implementation Checklist

- [ ] Create `src-tauri/src/proxy_mac.rs` with the Network.framework FFI
      bindings (`extern "C"` declarations for `nw_endpoint_create_host`,
      `nw_proxy_config_create_http`, `nw_proxy_config_create_socksv5`)
- [ ] Implement `apply_to_tab` body in `proxy.rs` under `#[cfg(target_os = "macos")]`
      that calls into the new module
- [ ] Handle the `is_active() == false` case (clear proxy via empty `NSArray`)
- [ ] Handle bypass-hosts via match-domains on the proxy config
- [ ] Handle CF object lifetime (release after the setter consumes them)
- [ ] Add `#[cfg(target_os = "macos")] mod proxy_mac;` to `lib.rs`
- [ ] Verify compilation: trigger `tauri-build-check.yml` on `macos-latest`
- [ ] On a real Mac: run the egress verification test with a local logging proxy
- [ ] Update the doc-comment in `proxy.rs` to remove "NOT implemented" language
- [ ] Update `CLAUDE.md` files and `phase-2-parity-gaps-spec.md` to reflect
      macOS proxy as implemented (pending GUI verify)
