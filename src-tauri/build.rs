fn main() {
  // Android 15+ uses 16 KB memory pages; native libs whose LOAD segments aren't
  // 16 KB-aligned fail to load there ("LOAD segment not aligned"). cargo/NDK don't
  // add this alignment for the Rust cdylib by default, so force it for Android
  // targets. No-op on desktop targets.
  if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
    println!("cargo:rustc-link-arg=-Wl,-z,max-page-size=16384");
  }
  tauri_build::build()
}
