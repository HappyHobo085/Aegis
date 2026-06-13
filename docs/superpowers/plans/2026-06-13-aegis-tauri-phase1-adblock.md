# Aegis Tauri Phase 1 — Desktop Ad-Blocking (GO/NO-GO) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Block ads on the Tauri content webview — network blocking + cosmetic CSS/scriptlet injection — using Brave's `adblock` crate. This phase **proves the whole Tauri bet**: if Tauri can't reliably intercept a content webview's subresource requests, we escalate to the fallback (keep Electron for desktop).

**Architecture:** A Rust `AdblockEngine` wraps `adblock::Engine`, loaded from a shipped *serialized* seed (`engine-seed.bin`) with a raw-list fallback. The content webview's `on_web_resource_request` maps each request to an `adblock::Request` and calls `check_network_request`; matches are aborted. On each top-frame navigation, `url_cosmetic_resources(url)` yields hiding selectors + scriptlets, injected via `webview.eval()`. Blocks are counted and pushed to the chrome via the existing `adblock.blockedCount` event + AdblockShield UI.

**Tech Stack:** `adblock` crate (network + cosmetic), Tauri `on_web_resource_request` / `webview.eval`, serialized-engine seed.

**Depends on Phase 0:** the content webview (Task 6) and a working `on_web_resource_request` hook. **Confirm Phase 0 ran first.**

**Verified `adblock` API (docs.rs, 2026-06-13):**
```rust
Engine::from_rules(rules: impl IntoIterator<Item = impl AsRef<str>>, opts: ParseOptions) -> Self
Engine::from_filter_set(set: FilterSet, optimize: bool) -> Self
engine.check_network_request(&Request) -> BlockerResult   // BlockerResult has `.matched: bool`
engine.url_cosmetic_resources(url: &str) -> UrlSpecificResources  // `.hide_selectors`, `.injected_script`, …
engine.serialize() -> Vec<u8>;  engine.deserialize(&[u8]) -> Result<(), _>
```
**Confirm locally** (post-Phase-0): `Request::new(...)` signature + `RequestType`, `BlockerResult` fields, and `UrlSpecificResources` fields via `cargo doc -p adblock --no-deps`.

---

## File structure

**Created:**
- `src-tauri/src/adblock/mod.rs` — module surface.
- `src-tauri/src/adblock/engine.rs` — `AdblockEngine` wrapper (load, check, cosmetic, allowlist, counts).
- `src-tauri/src/adblock/seed.rs` — load serialized seed; raw-list fallback; ship via Tauri resources.
- `src-tauri/src/net.rs` — `on_web_resource_request` → engine check → block/allow; request→`adblock::Request` mapping.
- `scripts/generate-tauri-seed.mjs` — fetch EasyList+EasyPrivacy, build engine, `serialize()` → `engine-seed.bin`.
- `src-tauri/src/adblock/engine_test.rs` (or `#[cfg(test)]` in engine.rs) — unit tests.

**Modified:**
- `src-tauri/Cargo.toml` — add `adblock`.
- `src-tauri/tauri.conf.json` — `bundle.resources` to ship `engine-seed.bin`.
- `src-tauri/src/lib.rs` — wire real `adblock.*` channels (replace Phase-0 stubs); register the request handler on the content webview; hold the engine in managed state.
- `src-tauri/src/nav.rs` — on top-frame navigation, trigger cosmetic injection + reset the per-page block count.

---

## Task 1: Engine wrapper — network matching (TDD)

**Files:** Create `src-tauri/src/adblock/engine.rs`, `src-tauri/src/adblock/mod.rs`; Modify `src-tauri/Cargo.toml`.

- [ ] **Step 1: Add the dep.** In `Cargo.toml` `[dependencies]`: `adblock = "0.9"` (confirm the latest 0.x on crates.io; pin exact).
- [ ] **Step 2: Failing test** — a network rule blocks a matching URL and passes a non-matching one.

```rust
#[cfg(test)]
mod tests {
    use super::AdblockEngine;
    #[test]
    fn blocks_matching_network_request() {
        let eng = AdblockEngine::from_rules(&["||ads.example.com^"]);
        assert!(eng.should_block("https://ads.example.com/a.js", "https://site.test/", "script"));
        assert!(!eng.should_block("https://site.test/app.js", "https://site.test/", "script"));
    }
}
```

- [ ] **Step 3: Run, expect FAIL.** `cd src-tauri && cargo test adblock::engine && cd ..`
- [ ] **Step 4: Implement `AdblockEngine`** wrapping `adblock::Engine`. `from_rules` via `Engine::from_rules(rules, ParseOptions::default())`. `should_block(url, source_url, req_type)` builds an `adblock::request::Request` (confirm constructor; likely `Request::new(url, source_url, req_type)` or a builder) and returns `engine.check_network_request(&req).matched`. Hold the engine behind a `RwLock` for later list updates.
- [ ] **Step 5: Run, expect PASS.** `cd src-tauri && cargo test adblock::engine && cd ..`
- [ ] **Step 6: Commit.** `git commit -m "feat(tauri/adblock): engine wrapper with network matching (TDD)"`

## Task 2: Cosmetic resources (TDD)

- [ ] **Step 1: Failing test** — a cosmetic rule yields a hiding selector for its domain.

```rust
#[test]
fn returns_cosmetic_hide_selectors() {
    let eng = AdblockEngine::from_rules(&["site.test##.ad-banner"]);
    let css = eng.cosmetic_css("https://site.test/");
    assert!(css.contains(".ad-banner"));
}
```

- [ ] **Step 2: Run, expect FAIL.** `cd src-tauri && cargo test adblock::engine::tests::returns_cosmetic && cd ..`
- [ ] **Step 3: Implement `cosmetic_css(url)`** — call `engine.url_cosmetic_resources(url)`, join `hide_selectors` into `"<sel>{display:none !important}"` CSS; expose `injected_script` separately for `eval`. (Confirm `UrlSpecificResources` field names via cargo doc.)
- [ ] **Step 4: Run, expect PASS.** Same command.
- [ ] **Step 5: Commit.** `git commit -m "feat(tauri/adblock): cosmetic CSS/scriptlet extraction (TDD)"`

## Task 3: Engine seed (serialize/deserialize + ship)

- [ ] **Step 1: Seed generator** `scripts/generate-tauri-seed.mjs` — download EasyList + EasyPrivacy, but since parsing is Rust-side, instead add a `src-tauri` bin or test that builds `Engine::from_rules(lists)` then writes `engine.serialize()` to `src-tauri/resources/engine-seed.bin`. (Mirror the existing `scripts/generate-seed.mjs` intent.)
- [ ] **Step 2: Load path** in `seed.rs` — `AdblockEngine::from_seed(bytes)` does `Engine::from_rules([], default)` then `engine.deserialize(bytes)`; on failure, fall back to `from_rules(bundled_raw_lists)` and log.
- [ ] **Step 3: Ship the seed** — `tauri.conf.json` `bundle.resources: ["resources/engine-seed.bin"]`; resolve at runtime via the Tauri path API.
- [ ] **Step 4: Verify** the packaged path resolves and the engine loads (asserted in Task 7's run). Commit.

## Task 4: Request interception on the content webview (THE go/no-go)

**Files:** Create `src-tauri/src/net.rs`; Modify `src-tauri/src/lib.rs` (build the content webview with the handler), managed engine state.

- [ ] **Step 1: Confirm the hook signature** via `cargo doc -p tauri --features unstable` — `WebviewBuilder::on_web_resource_request(|request, responder| { … })`: inspect what `request` exposes (URI, headers) and how to abort (respond 204/empty vs. a block error). Record it.
- [ ] **Step 2: Map + check** — in the handler, read the request URI and the initiator/page URL (from `Referer`/`Sec-Fetch-*` headers or the webview's current `url()`), infer the resource type (from `Sec-Fetch-Dest` / `Accept`), call `engine.should_block(...)`. If blocked, respond with an empty 204 (or the responder's abort) and bump the counter; else let it pass.
- [ ] **Step 3: Wire** the handler onto the content `WebviewBuilder` in `lib.rs`; store the `AdblockEngine` in Tauri managed state so the handler and the `adblock.*` commands share it.
- [ ] **Step 4: Verify interception fires** — temporary `log::info!` per request; run `tauri dev`, load a page, confirm requests are seen and an ad host is blocked. **If the hook does NOT fire for subresources, STOP — this is the NO-GO; escalate to the user (fallback: keep Electron desktop).**
- [ ] **Step 5: Commit.** `git commit -m "feat(tauri/adblock): block network requests on the content webview"`

## Task 5: Cosmetic injection on navigation

**Files:** Modify `src-tauri/src/nav.rs`.

- [ ] **Step 1:** On each top-frame navigation completion, call `engine.cosmetic_css(url)` + `injected_script`, and `content_webview.eval(&format!("<style>{}</style> injection + scriptlets"))` (inject a `<style>` element + run scriptlets). Confirm `eval` availability on the content webview.
- [ ] **Step 2: Verify** a cosmetic rule hides an element on a fixture page (Task 7). Commit.

## Task 6: State, counter, allowlist (replace Phase-0 stubs)

**Files:** Modify `src-tauri/src/lib.rs`, `src-tauri/src/adblock/engine.rs`.

- [ ] **Step 1:** Per-page + session block counters; emit `adblock.blockedCount` (`{viewId,page,session}`) to the chrome after blocks (debounced). Reset `page` on top-frame nav.
- [ ] **Step 2:** Wire real `adblock.getState` / `setEnabled` / `toggleAllowlist` / `removeAllowlist` / `clearAllowlist` to the engine + an in-memory allowlist (host set). When a host is allowlisted or `enabled=false`, `should_block` returns false and cosmetic injection is skipped.
- [ ] **Step 3: Verify** the AdblockShield UI shows a live count and the toggle disables blocking. Commit.

## Task 7: GO/NO-GO verification

- [ ] **Step 1:** Extend the fixture server (port `electron/test/e2e/fixtureServer.ts` or add a Rust test fixture) to serve a page that requests a known ad URL and contains a `.ad-banner` element.
- [ ] **Step 2:** Automated check (tauri-driver/WebDriver if available, else a scripted `tauri dev` + assertion): the ad request is blocked and `.ad-banner` is hidden. Record pass/fail in a VERIFY doc.
- [ ] **Step 3:** Run `cd src-tauri && cargo test && cd ..` (all green) and `npm run tauri:build` (bundle builds with the seed).
- [ ] **Step 4:** Update the spec Phase 1 row to ✅ (or escalate NO-GO). Commit.

---

## Self-review

**Spec coverage:** design §5 (desktop tier: network via `on_web_resource_request` + cosmetic injection) → Tasks 1–6; the go/no-go risk (design §10) → Task 4 Step 4 + Task 7. Seed/`extraResources` (design §4) → Task 3.

**Placeholder scan:** exact `Request::new` / `BlockerResult` / `UrlSpecificResources` / Tauri responder signatures are flagged "confirm via cargo doc" (honest verification, not TODO) — fabricating them would violate the no-invented-API rule. All structural steps have concrete commands.

**Type consistency:** `AdblockEngine::should_block(url, source_url, req_type) -> bool` and `cosmetic_css(url) -> String` are used identically across Tasks 1, 2, 4, 5, 6; the `adblock.blockedCount` payload matches `BlockedCount` in shared/types.ts.

**Risk:** Task 4 is the pivot. If interception is unworkable, the fallback (design §10) is to keep Electron for desktop and use Tauri only where it works — escalate to the user rather than ship broken blocking.
