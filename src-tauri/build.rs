fn main() {
    // Android 15+ uses 16 KB memory pages; native libs whose LOAD segments aren't
    // 16 KB-aligned fail to load there ("LOAD segment not aligned"). cargo/NDK don't
    // add this alignment for the Rust cdylib by default, so force it for Android
    // targets. No-op on desktop targets.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        println!("cargo:rustc-link-arg=-Wl,-z,max-page-size=16384");
    }
    // `cargo test` on a Windows MSVC host. By default tauri-build embeds the application
    // manifest (whose only content is the Common-Controls v6 dependency) as a RESOURCE that
    // it links into the BIN alone. The lib's unit-test harness is a separate executable that
    // gets no manifest, so it loads the system's comctl32 v5, which lacks `TaskDialogIndirect`,
    // and the loader kills it before `main` with 0xc0000139 STATUS_ENTRYPOINT_NOT_FOUND: not
    // one test runs. `rustc-link-arg-tests` cannot fix that (it reaches integration-test
    // targets only, and cargo rejects it for a package that has none), so instead the LINKER
    // embeds the identical dependency into every artifact, the test harness included, and
    // tauri-build is told not to add its own copy (two manifests in one image is a duplicate
    // resource link error). The shipped exe carries the same dependency either way. Only the
    // MSVC linker understands these flags; windows-gnu keeps tauri-build's resource manifest.
    let msvc = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc");
    if msvc {
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!(concat!(
            "cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' ",
            "name='Microsoft.Windows.Common-Controls' version='6.0.0.0' ",
            "processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'"
        ));
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
    let mut attrs = tauri_build::Attributes::new().app_manifest(manifest);
    if msvc {
        attrs =
            attrs.windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
    }
    tauri_build::try_build(attrs).expect("failed to run tauri build script");
}
