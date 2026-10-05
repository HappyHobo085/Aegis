fn main() {
    // Android 15+ uses 16 KB memory pages; native libs whose LOAD segments aren't
    // 16 KB-aligned fail to load there ("LOAD segment not aligned"). cargo/NDK don't
    // add this alignment for the Rust cdylib by default, so force it for Android
    // targets. No-op on desktop targets.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        println!("cargo:rustc-link-arg=-Wl,-z,max-page-size=16384");
    }
    // The app ACL manifest. Naming the custom commands here is what generates
    // `allow-ipc` / `allow-popover_picked` and, more importantly, what turns the ACL on for
    // THEM at all: Tauri ACL-checks a non-plugin command only when
    // `plugin_command.is_some() || has_app_acl_manifest || !is_local` (tauri's
    // `webview/mod.rs`). Without an app manifest every LOCAL-origin webview could invoke
    // `ipc` — and therefore `settings.set`, `nav.navigate`, and every other channel — with no
    // check, so a capability file could not have withheld it from the popover surface.
    //
    // Two consequences worth knowing before editing this list:
    //   - `capabilities/default.json` must grant `allow-ipc` to `main`, or the chrome cannot
    //     talk to the app at all.
    //   - A command added to `generate_handler!` but NOT listed here has no permission, so no
    //     capability can grant it and it is callable by nobody. Add it to both places.
    //
    // `popover_ready` is the surface's handshake ("I can receive now"): without it the first
    // payload of every session is emitted before the surface's listener exists and is lost
    // forever, and after a WebKit reload the surface stays blank. See `popover.rs`.
    let manifest =
        tauri_build::AppManifest::new().commands(&["ipc", "popover_picked", "popover_ready"]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
        .expect("failed to run tauri build script");
}
