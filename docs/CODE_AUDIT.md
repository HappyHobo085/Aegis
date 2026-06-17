# Aegis Security & Code Audit — Final Report

> **Date:** 2026-06-16 · **Scope:** full tree at `main` (~5.3k Rust LOC / 27 files, ~5.7k TS/TSX, ~1.7k Kotlin, config/CI/supply-chain).
> **Method:** 15 component & cross-cutting auditors → an adversarial verifier per component re-read the *actual cited code* → an independent second skeptic on every confirmed critical/high → synthesis. ~42 agents, ~3M tokens. The Android-native auditor crashed in the first pass and was re-run separately (its findings are folded in below). Every finding cites `file:line`; 0 of 93 raw findings were rejected in verification.
> **This was a static read-only audit** — no build/test was run as part of it. Line numbers reflect the working tree at audit time.

## 1. Executive summary

Aegis is a Tauri 2 + React 19 ad-blocking browser shell whose **core trust boundary is sound**. The single most important security property — that untrusted web content cannot drive the privileged IPC surface — holds correctly and for the right structural reason: the content webview loads remote pages (`WebviewUrl::External`) while the capability set defaults to `local: true` with no `remote` block, so Tauri's ACL never grants `invoke('ipc')` to browsed pages. The IPC layer funnels through a single `ipc()` chokepoint, the `.`→`:` event-name translation is symmetric and consistently applied, the `!Send` Brave ad-block `Engine` is correctly confined to one thread, the renderer has no `dangerouslySetInnerHTML`/`innerHTML` sinks, and the desktop updater is minisign-verified. No critical, web-content-reachable RCE or arbitrary-write was found.

That said, the audit surfaced **no critical findings but a dense cluster of high/medium issues concentrated in two themes**: (a) **cross-platform parity gaps in security features**, and (b) **persistence durability and untrusted-input handling on the desktop platforms**.

Headline risks, in priority order:

- **WebRTC local-IP leak protection is absent on every platform** — a fingerprint/leak guard that the prior Electron build shipped and that did not carry over to Tauri. Any visited page can enumerate the user's private (and often public) IP via ICE candidates, undercutting the app's advertised anti-fingerprint posture.
- **User custom filters and filter-list subscriptions only feed the engine on Linux.** The management UI ships everywhere (including mobile), persists rules, lists them — and they block nothing on Windows/macOS/Android, and nothing for pop-under/redirect blocking on any desktop. A user trusting a subscribed list for protection is silently unprotected on three of four platforms.
- **The injected ad-block tier (the SOLE tier on macOS) ignores the on/off toggle and the per-site allowlist entirely**, so two user-facing security/UX controls behave inconsistently across platforms.
- **Auto-update never fires on Android** (the mobile shell never mounts `useUpdate`), so the platform that sideloads outside an app store has no patch-delivery channel — contradicting the documented "Android auto-update verified end-to-end."
- **`nav.navigate` has no backend scheme allowlist**, despite an in-code comment claiming a defensive check exists; the renderer is the sole gate keeping `file:`/`data:`/`javascript:` out of the untrusted content webview.

Several security features (MalwareGuard, the picker handler, subscription fetch, downloads) share an evasion/weakness pattern around **host normalization, cleartext fetch, and unsanitized untrusted input**. None are remotely exploitable across the trust boundary today, but they erode the protections the app advertises and several violate the project's explicit parity mandate. The data layer's **non-atomic JSON persistence** is a latent durability risk that can silently lose a user's entire profile on an ill-timed crash.

**Overall health: good architecture, sound trust boundary, but the "all platforms at the same level" mandate is materially unmet for security features, and durability/untrusted-input hardening needs work.**

Counts (including the Android-native re-run): **0 critical, 6 high, 34 medium, 41 low, 11 info — 92 findings.** 0 findings were rejected in verification; the 5 trust-boundary/parity highs were double-confirmed by two independent reviewers, and the Android HTTPS-Only bypass was downgraded HIGH→MEDIUM by the second skeptic (an OS-level cleartext block mitigates it). The dedicated Android-native auditor crashed on a transient socket error in the first pass and was re-run separately with the same verify+escalate rigor — its findings are in the **Android-native deep-dive** subsection below.

---

## 2. Findings by severity

### HIGH

#### [HIGH] WebRTC local-IP leak protection is absent on all platforms (regression from the Electron build) — *double-confirmed*
- **Location:** `src-tauri/src/nav.rs:58-66` (and all of `src-tauri/src`, `src-tauri/gen/android`)
- **Component:** Cross-platform parity sweep · **Category:** parity/security
- **What's wrong:** Project memory records the Electron app shipped WebRTC leak protection via `default_public_interface_only` plus a Chrome UA. The Chrome UA carried over (`nav.rs` `CONTENT_UA`, Android `CHROME_UA`); the WebRTC protection did not. A full-tree grep for `webrtc`/`default_public_interface`/`enable_webrtc`/`rtc` finds zero handling in `src-tauri/src`, the Android Kotlin, or `tauri.conf.json` (only filter-list rule hits). WebKitGTK, WKWebView, WebView2, and the Android WebView all expose `RTCPeerConnection` by default.
- **Impact:** Any page can enumerate the user's private/local IP addresses (and often the public IP behind a VPN) via ICE candidates, defeating part of the advertised fingerprint/leak posture. Affects Linux, Windows, macOS, and Android equally.
- **Fix:** Restore the mitigation on every platform: on Android block/shim `RTCPeerConnection` (the app holds only INTERNET, so disabling WebRTC outright is reasonable); on Linux gate `webkit_settings_set_enable_webrtc(false)` or force a public-interface-only policy; on WKWebView/WebView2 inject a document-start script that neuters/limits ICE candidate exposure. Mirror the single-source pattern used for ad-block so all four platforms move together.

#### [HIGH] Custom filters and subscriptions never reach the matching engine or inject tier — Linux-only, breaks parity — *double-confirmed*
- **Location:** `src-tauri/src/adblock_engine.rs:60-81`; also `subs.rs:90-95`, `customfilters.rs:47-48`
- **Component:** Rust ad-block engine / Cross-platform parity · **Category:** parity
- **What's wrong:** The Brave matching engine is built exactly once inside `tx()`'s `OnceLock` closure, loading ONLY `adblock_lists::ALL` (the four bundled lists). The only mutator, `set_policy` (lines 30-35), just flips the `ENABLED` atomic and replaces the allowlist `HashSet` — there is no API to rebuild the engine or add rules. User custom filters (`customfilters::load`) and enabled subscriptions (`subs::enabled_text`) are folded into the ad-block set ONLY by Linux's `#[cfg(target_os = "linux")]` `install_adblock` (lib.rs:132-133,148), feeding the WebKit content-filter converter. Every engine-consuming tier — Android JNI `shouldBlock`, the Windows WebView2 interceptor (`adblock_win.rs:69`), the desktop pop-under (`nav.rs:255`) and ad-nav (`nav.rs:154`) blocking — therefore matches the bundled lists only, as does `adblock_inject::build` (`adblock_inject.rs:69`).
- **Impact:** Custom rules and subscribed lists are dead on Android/Windows/macOS and for pop-under/redirect blocking everywhere. A user relying on a subscribed regional list or a custom `||tracker.example^` rule is unprotected on most platforms with no error or indication.
- **Fix:** Make the engine rebuildable: add a `Reload{custom, subs}` control message the worker thread handles by rebuilding the `FilterSet` from `ALL` + custom + subs and swapping the owned `Engine` (stays `!Send`-confined; only `String` rule text crosses). Call it from `subs::reinstall_adblock` and `customfilters::dispatch` on **every** platform, and mirror the same source set into `adblock_inject::build`.
- **Note:** This is the same defect captured by cross-platform-parity-2; grouped here.

#### [HIGH] Injected ad-block tier ignores the on/off toggle and the per-site allowlist — *double-confirmed*
- **Location:** `src-tauri/src/adblock_inject.rs:52-61, 108-123`; `nav.rs:118-123`
- **Component:** Cross-platform parity · **Category:** parity
- **What's wrong:** The document-start injected blocker (fetch/XHR/sendBeacon blocking + cosmetic CSS) — the SOLE ad-block tier on macOS and the cosmetic/JS tier on Windows — is a static string baked into the webview at spawn (`initialization_script_for_all_frames(adblock_inject::script())`) with no reference to the `ENABLED` flag or the allowlist (grep for `ENABLED`/`allowlist`/`enabled` in `adblock_inject.rs` returns nothing). On macOS, toggling ad-block OFF does not stop cosmetic hiding or fetch/XHR blocking, and allowlisting a host does not re-enable ads there. On Linux the toggle works (filters are removed/reinstalled) and the engine path honors both, so behavior diverges by platform.
- **Impact:** On macOS the ad-block off switch is a no-op for the only blocking tier, and the per-site allowlist silently fails — both are user-facing security/UX controls behaving inconsistently across platforms.
- **Fix:** Make the injected script read live policy: call back through the bridge for current enabled+allowlist state (or re-inject/replace the active document script on policy change and reload), and short-circuit blocking when ad-block is off or the page host is allowlisted, mirroring `adblock_engine::should_block`'s guards.

#### [HIGH] `nav.navigate` IPC accepts any parseable URL — no scheme allowlist on the Rust side — *double-confirmed*
- **Location:** `src-tauri/src/nav.rs:336-345`
- **Component:** Rust navigation & URL handling · **Category:** security
- **What's wrong:** The `nav.navigate` channel parses the renderer-supplied URL with `Url::parse` and navigates the content webview directly, with no check that the scheme is in the allowed http/https/about:blank set. The only scheme allowlist in the whole path is `src/lib/schemes.ts` (`isAllowedNavigationUrl`), enforced purely in the renderer by `addressParse`. `src/hooks/useNav.ts:59-60` explicitly states "main also rejects the scheme defensively in nav.navigate" — but no such rejection exists in `nav::dispatch`. `Url::parse` succeeds for `file://`, `data:`, and `javascript:`, and the `on_navigation` checks do not catch them: `is_blocked()` returns false when `host_str()` is `None`, `should_block()` needs `://` and fails open, and the HTTPS-Only branch only triggers for `scheme=="http"`. So `file:///etc/passwd`, `data:text/html,…`, or `javascript:` pass straight to `w.navigate()`.
- **Impact:** Defense-in-depth is broken: the documented backend check is absent, so the http(s)/about:blank invariant rests entirely on the renderer. A compromised/buggy renderer or any future internal caller that skips `addressParse` (e.g. the Android `__aegisOpenTab`/`tabs.create` path) can point the untrusted content webview at local files, attacker-controlled `data:` origins, or `javascript:` URLs.
- **Fix:** Add a scheme allowlist in `nav::dispatch` for `nav.navigate` (after `Url::parse`, reject unless scheme is `http`/`https` or the value is exactly `about:blank`), mirroring `shared/types.ts` `ALLOWED_NAV_SCHEMES`. This makes the `useNav.ts` comment true. Apply the same guard to `nav.home/back/forward` targets and `tabs::open_background` (`tabs.rs:160`).
- **Note:** react-core-2 is the renderer-side view of the same gap; grouped here.

#### [HIGH] Auto-update is never triggered on Android — `useUpdate`/`checkNow` not wired into MobileApp — *double-confirmed*
- **Location:** `src/components/mobile/MobileApp.tsx:55-72`
- **Component:** React mobile components · **Category:** parity/security
- **What's wrong:** DesktopApp mounts `useUpdate()` (`src/App.tsx:97`), whose effect auto-fires `aegis.update.checkNow()` on launch and renders an `UpdateIndicator`. MobileApp imports none of `useUpdate`, `UpdateIndicator`, or `aegis.update` — it never calls `checkNow()`. On Android the Rust manifest check (`update.rs` `android_check`) is reachable ONLY via the `update.checkNow` IPC channel (`update.rs:89-93`), and nothing in `lib.rs` setup fires it at boot. So the Android build never checks for updates and has no UI to surface one — contradicting the documented "Android auto-update verified end-to-end" and making this a regression introduced by the mobile shell.
- **Impact:** Android users are never notified of (and cannot trigger) updates, so security/bugfix releases are not delivered on mobile — the one platform installing browsers outside an app store.
- **Fix:** Add `const update = useUpdate();` to MobileApp (mounting it auto-fires `checkNow`), and surface the result — a menu-sheet row or toast that calls `update.restartToInstall()` (on Android opens the releases page via the bridge). At minimum call `aegis.update.checkNow()` on mount so `android_check` runs.

#### [HIGH] Custom filters and filter-list subscriptions only affect ad-block on Linux — *double-confirmed*
- **Location:** `src-tauri/src/adblock_engine.rs:61-81`, `subs.rs:90-95`, `customfilters.rs:47-48`
- **Component:** Cross-platform parity sweep · **Category:** parity
- *This is the parity-sweep restatement of the engine finding above (HIGH: "Custom filters and subscriptions never reach the matching engine"). The two were filed by different component auditors against the same root cause and are remediated by the single rebuildable-engine fix.* The additional observation from the parity sweep: the management UI (`FilterListsTab`, `MyFiltersTab`, `AllowlistTab`) ships on **every** platform including `MobileApp.tsx`, so a Windows/macOS/Android user can add a subscription or custom rule, see it persisted and listed, and have it block nothing — a misleading, capability-level parity gap. Fix as above; also re-inject the document-start script with user rules on Win/macOS or route them through the engine path there.

---

### MEDIUM

#### [MEDIUM] All JSON stores use non-atomic truncate-then-write; a crash mid-write corrupts the file and the loader silently discards it
- **Location:** `src-tauri/src/jsonstore.rs:26-35, 17-23` (same pattern in `settings.rs:42,118`, `customfilters.rs:29,42`, `tabs.rs:180`, `data.rs:42`)
- **Component:** Rust IPC dispatcher, state & data layer · **Category:** durability/resource-leak
- **What's wrong:** `save()` calls `std::fs::write(&p, txt)`, which truncates the file then writes. A kill/power-loss/disk-full between truncate and completion leaves an empty/half-written file. `load()` does `serde_json::from_str::<Vec<Value>>(&t).ok().unwrap_or_default()`, so a corrupt file parses to an empty `Vec` and the entire collection (favorites, saved, history, downloads, permissions, subs, settings, custom filters, tabs) is silently lost with no error.
- **Impact:** Silent, unrecoverable loss of all persisted user data on any crash/power-loss/disk-full during a save; the loader masks the corruption as "empty."
- **Fix:** Write to a sibling temp file in the same directory, flush/sync, then `std::fs::rename(tmp, p)` (atomic on the same filesystem). Apply uniformly via `jsonstore::save` and mirror it in `settings.rs`, `customfilters.rs`, `tabs::persist`, `data::export`. Optionally keep a `.bak` of the prior good file so a load-time parse failure can recover instead of returning empty.
- **Note:** rust-security-features-4 is the same defect from the security-feature audit (notes the permissions.json impact); grouped here.

#### [MEDIUM] `subs.json` has unsynchronized concurrent writers doing load-mutate-save, causing lost updates
- **Location:** `src-tauri/src/subs.rs:100-118, 132-189, 196-249`
- **Component:** Rust IPC core · **Category:** concurrency
- **What's wrong:** The JSON stores have no in-process lock; each op independently does `load` → mutate → `save`. For `subs.json` this is genuinely concurrent: `subs.add`/`subs.setEnabled` spawn `fetch_in_background` (line 100), which on its own thread reloads, stamps `lastUpdated`/`hash`, and saves; `lists.updateNow` (`update_all`) spawns one fetch thread per enabled list and then re-loads/re-saves. Overlapping ops each read the array, mutate a copy, and write the whole array back — last writer wins (classic lost update).
- **Impact:** Subscription metadata (enabled flag, lastUpdated, hash) silently lost or reverted on overlapping operations; a list can show "never updated" or an enabled list not be folded into the engine.
- **Fix:** Serialize store mutations behind a per-file lock (a `Mutex<()>` held across load+save, or a single writer thread/queue for subs). At minimum, have the background fetch update only its own row via a compare-and-set re-read under a lock.
- **Note:** rust-adblock-engine-4 (low) is the same race observed from the ad-block side, including the `enabled_text` mid-write read; see Low.

#### [MEDIUM] `data.import` is replace-mode and applies partial bundles destructively
- **Location:** `src-tauri/src/data.rs:48-89`
- **Component:** Rust IPC core · **Category:** correctness
- **What's wrong:** `data.import` overwrites each present store via `jsonstore::save(app, s, arr)` (line 75) with no whole-bundle validation and no transaction. A structurally-wrong-but-parseable bundle silently replaces good data for present keys and leaves absent keys untouched — a half-replaced, inconsistent state. Settings import (lines 79-81) calls `settings::write` without merging against defaults. There is no pre-import backup, so a bad import is unrecoverable. Compounded by the non-atomic save above.
- **Impact:** A corrupt/hand-edited backup can silently destroy existing favorites/saved/history/downloads with no undo, yielding a partially-replaced profile.
- **Fix:** Validate the whole bundle (version + expected shapes) before writing anything; treat import as all-or-nothing (write temp copies, then atomically swap); snapshot current stores to `.bak`; reject unexpected `version` rather than partially applying.

#### [MEDIUM] `data.import` declares a merge/replace mode the Rust handler ignores — merge silently replaces
- **Location:** `src-tauri/src/data.rs:48-89` (contract: `shared/types.ts:195, 376-377`; `ipcClient.ts:233-237`) — *double-confirmed*
- **Component:** IPC contract consistency · **Category:** correctness
- **What's wrong:** The contract types `data.import(mode: 'merge'|'replace', source?)`, but the Rust arm reads only `text`/`path` and unconditionally overwrites; it never inspects `mode`. The module doc admits "Import is replace-mode; merge-mode is a follow-up," yet the contract exposes merge as a first-class, callable option.
- **Impact:** A user who picks "merge" to add a backup instead has all existing data overwritten — data loss on a path the UI presents as additive.
- **Fix:** Implement merge (union imported rows with existing by id/url before saving), or remove/disable the "merge" option from the contract and UI until then.
- **Note:** Closely related to the destructive-import finding above; both live in `data.rs:48-89`.

#### [MEDIUM] Malware gate and HTTPS-Only escape hatch rely on `host_str()` + a tiny hardcoded host set
- **Location:** `src-tauri/src/nav.rs:68-73, 181-183`; `safety.rs:41-52`
- **Component:** Rust navigation · **Category:** security
- **What's wrong:** `is_local_host()` matches only the exact strings `localhost`, `127.0.0.1`, `::1` — missing the rest of loopback (127.0.0.0/8, `0.0.0.0`, bracketed IPv6 forms), so HTTPS-Only force-upgrades a legitimate `http://127.0.0.2` dev server. Conversely `safety::is_blocked` keys on exact lowercased `host_str()` against the URLhaus set, so a malware host reached by IP, trailing dot, or added userinfo is not matched; the check is skipped entirely when `host_str()` is `None` (which with the `nav.navigate` finding means `data:`/`file:` navigations are never consulted).
- **Impact:** Malware blocking can be evaded by a non-byte-identical host form; HTTPS-Only under-covers loopback so non-127.0.0.1 local http dev servers break.
- **Fix:** Normalize hosts before comparison: strip trailing dots; treat the loopback range via parsed `IpAddr::is_loopback`; for the malware gate consider registrable-domain / IP-literal matching. Pair with the `nav.navigate` fix so host-less schemes are rejected before reaching a gate that can't evaluate them.
- **Note:** rust-security-features-5, threat-model-2, rust-ipc-core-7 all describe the malware-host exact-match weakness; consolidated here and in the Low section.

#### [MEDIUM] Malware host matching is exact-only — subdomains / trailing-dot / IDN bypass (all platforms)
- **Location:** `src-tauri/src/safety.rs:41-52`
- **Component:** Rust security features / threat model · **Category:** security/parity — *threat-model-2 + rust-security-features-5*
- **What's wrong:** `is_blocked` lowercases the host and does an exact `HashSet` lookup. No subdomain handling, no trailing-dot stripping, no punycode/IDN normalization. A list entry `bad.example.com` does not block `www.bad.example.com` or `bad.example.com.` (a valid, browser-resolvable absolute FQDN). The same exact-match logic is mirrored in the Android JNI `is_malware_host`, so the evasion is consistent across platforms.
- **Impact:** Known-malware sites reached via subdomain or trailing-dot bypass the interstitial on every platform — a common evasion pattern.
- **Fix:** Normalize the host (strip trailing `.`) and match by registrable-suffix / parent-domain walk (block `host` and any `*.host`), mirroring the ad-block engine's label walking. Apply the same change to the Android JNI export.

#### [MEDIUM] Downloads silently overwrite existing files with the same name
- **Location:** `src-tauri/src/downloads.rs:35-36`
- **Component:** Rust security features · **Category:** correctness
- **What's wrong:** The save path is `dir(app).join(&filename)` with no collision handling. Two files sharing a basename (or a re-download) overwrite the earlier file with no `(1)` suffix and no prompt.
- **Impact:** Silent data loss: a second `report.pdf` destroys the first; a page serving a file named after a user document overwrites it.
- **Fix:** If the target exists, append a counter (`name (1).ext`, …) until a free path is found; use it for both `destination` and the recorded `savePath`.
- **Note:** Pairs with the unsanitized-filename note in threat-model-4 (Low).

#### [MEDIUM] `on_finished` marks the wrong entry when downloads overlap
- **Location:** `src-tauri/src/downloads.rs:55-67`
- **Component:** Rust security features · **Category:** concurrency
- **What's wrong:** Finished events carry no identifier, so `on_finished` marks "the newest progressing entry" completed/interrupted. With two downloads in flight, the first to finish updates whichever started last, and the success/interrupted flag can attach to the wrong file. Requested/Finished events are not correlated by URL or destination.
- **Impact:** With concurrent downloads, the list shows the wrong file as completed/failed.
- **Fix:** Correlate by the destination path captured in `on_requested` (track last-requested path per webview, or match on saved path). At minimum document the single-download limitation.

#### [MEDIUM] `spawn_tab` failure is silently discarded, leaving the registry claiming a live tab with no webview
- **Location:** `src-tauri/src/tabs.rs:57-61, 92-105, 144-156`
- **Component:** Rust tab registry · **Category:** correctness
- **What's wrong:** Every spawn point calls `let _ = crate::nav::spawn_tab(...)`. `spawn_tab` (`nav.rs:105-319`) can return `Err` from `window.inner_size()?` or `window.add_child(...)?`. On `Err` the registry has already set `live:true` (and possibly active) with no webview, no retry, no rollback — reachable even with a valid URL (e.g. `add_child` failing under tauri#10420 conditions).
- **Impact:** A transient `add_child` failure permanently desyncs the registry (`live=true`) from reality; the tab renders blank and its layout pass is a no-op.
- **Fix:** On `spawn_tab` `Err`, roll back the registry (mark not-live or close) and/or log; at minimum log so the divergence is diagnosable.
- **Note:** rust-tabs-1/2 (Low) are related state-divergence variants (idle-sweep race, unparseable-URL create).

#### [MEDIUM] Subscription fetch allows plaintext `http://` and follows https→http redirects — rule injection via MITM
- **Location:** `src-tauri/src/subs.rs:44-56, 203-205` (also threat-model-3: `subs.rs:203-216`)
- **Component:** Rust ad-block engine / threat model · **Category:** security
- **What's wrong:** `subs.add` accepts `http://` URLs (line 203), and `fetch_text` builds a default reqwest client with no redirect policy override, so an `https://` list can silently redirect to `http://`. The body is parsed as filter rules and folded into the engine/content filters. A network attacker can inject arbitrary filter syntax — `@@||doubleclick.net^`-style allow rules that UN-block trackers, or cosmetic `##` rules that break pages. The URL is entered in trusted chrome (content webview cannot reach this IPC), keeping it at medium rather than high.
- **Impact:** A MITM (or hostile redirect target) can substitute a list that disables ad/tracker blocking or injects breaking cosmetic rules into every page — silently, with no integrity check.
- **Fix:** Require `https://` for subscriptions (drop the `http://` branch); set a redirect policy that refuses any non-https redirect; optionally pin/verify a known list's hash.
- **Note:** threat-model-3 is the same finding; grouped.

#### [MEDIUM] No response-size limit on subscription fetch — hostile/runaway list can OOM the process
- **Location:** `src-tauri/src/subs.rs:51-55`
- **Component:** Rust ad-block engine · **Category:** resource-leak
- **What's wrong:** `fetch_text` reads the whole body via `resp.text()` with no Content-Length or streamed-byte cap. `update_all` fetches all enabled lists concurrently (one thread each), multiplying memory pressure; the text is also passed through `into_content_blocking` on Linux. The 25s timeout does not bound bytes received.
- **Impact:** A single oversized (or MITM'd) list, or several fetched concurrently, can exhaust memory and crash the browser — DoS against the user.
- **Fix:** Check `resp.content_length()` against a sane cap (e.g. reject >32 MB) before reading, and read with a hard limit (`Read::take(MAX)`), erroring past the cap.

#### [MEDIUM] Shared ready-marker counter lets a tab spawned mid-compile write the marker early (stale-cache under-blocking returns)
- **Location:** `src-tauri/src/adblock_webkit.rs:55-83, 109-122, 257-269`
- **Component:** Rust ad-block platform · **Category:** concurrency
- **What's wrong:** `SAVES_PENDING` (the deferred ready-marker counter that exists to prevent the stale-cache race) is one process-global counter, but `save_done` → `note_save_complete` is called for every compile on every webview including `apply_to_new_tab`. On a first run, opening/activating a second tab during the multi-second initial compile triggers `install_on` with `cached==false`, which re-saves each chunk and decrements the same armed counter — driving it to the trigger before all boot-tab chunks have persisted, so the marker is written over partial blobs.
- **Impact:** First-run race (must open a 2nd tab during the initial compile): next launch sees `cached=true` and loads incomplete filters → silent under-blocking until the filter source hash changes.
- **Fix:** Make `apply_to_new_tab` always LOAD (`cached=true`) — a post-boot tab loads from the store the boot tab is filling (retry if the blob isn't there yet) — or arm a per-store one-shot guard so non-boot saves don't decrement the counter; mark `CachedFilters.cached=true` as soon as the boot compile is armed.

#### [MEDIUM] Windows network ad-block ignores the per-site allowlist (parity gap vs Android)
- **Location:** `src-tauri/src/adblock_win.rs:66-78`
- **Component:** Rust ad-block platform / parity sweep · **Category:** parity — *rust-adblock-platform-2 + cross-platform-parity-4*
- **What's wrong:** The WebView2 handler calls `should_block(&url, "", "other")` with an EMPTY source URL. In `adblock_engine::should_block` the allowlist is consulted via `host_of(source_url)`; `host_of("")` returns `None`, so the allowlist branch is skipped entirely. Android passes the real `pageUrls[id]` and honors the allowlist; Windows network blocking does not. The on/off toggle still works (the `ENABLED` check needs no source).
- **Impact:** A site the user explicitly allowlisted still has its subresources blocked on Windows, breaking sites the user is trying to un-break, and silently diverging from Android.
- **Fix:** Thread the content webview's current top-frame URL into the handler (capture per-tab like Android's `pageUrls`, or query `ICoreWebView2.Source`) and pass it as the source URL so `should_block` can apply the allowlist and first-party context. Also fixes the `$third-party`/`domain=`/type matching quality (see rust-adblock-platform-3, Low).

#### [MEDIUM] Per-site permission prompting is Linux-only — no parity on Windows/macOS/Android
- **Location:** `src-tauri/src/permissions.rs:139-183, 96-135, 178-181`; `MainActivity.kt:186-259`
- **Component:** Rust security features / parity sweep · **Category:** parity — *rust-security-features-7 + cross-platform-parity-5*
- **What's wrong:** The entire permission pipeline (classify → remembered decision → raise prompt → remember) is `#[cfg(target_os = "linux")]`. `install_handler_label` exists only on Linux; `permissions.resolve` is `let _ = (id, allow);` (a no-op) elsewhere. The Android `WebChromeClient` overrides only `onShowCustomView`/`onHideCustomView`/`onCreateWindow` — not `onPermissionRequest` or `onGeolocationPermissionsShowPrompt`. The chrome ships `PermissionPromptDialog` + `usePermissions` + `SitePermissionsTab` on all platforms including `MobileApp.tsx`.
- **Impact:** "Remembered per-site permissions" is effectively Linux-only; on the other three targets the UI lists/removes/clears decisions but a fresh geolocation/camera/mic/notification request is never mediated by Aegis. (Android's INTERNET-only manifest softens but does not close the gap.)
- **Fix:** Implement interception on WebView2 (`PermissionRequested`), WKWebView (`requestMediaCapturePermission`), and the Android WebView (`onPermissionRequest`/`onGeolocationPermissionsShowPrompt`), bridged to the same store, so prompts fire and `permissions.resolve` binds on every platform.

#### [MEDIUM] Android "Home" navigates to `about:blank`, ignoring the configured home URL
- **Location:** `src/lib/ipcClient.ts:102-109`
- **Component:** React core / mobile · **Category:** parity — *react-core-1 + react-mobile-3*
- **What's wrong:** Desktop `nav.home()` routes to `IPC.navHome` → `crate::settings::home_url(app)` (`nav.rs:372-375`). On Android the same call detects the bridge and hard-codes `a.navigate('about:blank')`, discarding the user's Settings `homeUrl`. The `AndroidBridge` interface has no `home()` method or settings access, so the configured home page is unreachable. The mobile Home button (`MobileApp.tsx:159` → `MobileMenuSheet`) and Settings > Home tab (`MobileApp.tsx:234`) are both rendered, so the control is inert.
- **Impact:** Android users who set a custom home page never reach it from Home; pressing Home blanks the page — divergence from every desktop platform.
- **Fix:** Read the configured home URL on the JS side before dispatching (`await aegis.settings.get()`, then `a.navigate(homeUrl || 'about:blank')`), or add a `home()`/`getHomeUrl` bridge method so the native side resolves it like desktop.

#### [MEDIUM] `useNav`: initial `getState()` can overwrite a newer pushed `nav.state` (out-of-order async race)
- **Location:** `src/hooks/useNav.ts:31-46`
- **Component:** React hooks · **Category:** concurrency
- **What's wrong:** On mount and every `viewId` change, the effect fires a one-shot `aegis.nav.getState(viewId)` AND subscribes to live `aegis.nav.onState`. Both write `state`. The `active` flag guards only unmount, not ordering. If a live `onState` arrives before the slower `getState` round-trip resolves (e.g. navigating immediately after a tab switch), the late `getState` resolves last and overwrites the fresher pushed state with a stale snapshot. Same class repeats in `useAdblock` (getState vs onBlockedCount), `useUpdate` (getState vs onState), `useSafety` (getState vs onInterstitial), `usePermissions` (list vs onPrompt).
- **Impact:** Transient but user-visible nav-state desync after tab switches/fast navigation: the toolbar URL/title/back-forward/spinner can revert to a stale value until the next push.
- **Fix:** Subscribe BEFORE the initial fetch and drop the fetch result if a live event has already arrived (a `gotEvent` flag applied only when `active && !gotEvent`), or stamp each state with a monotonic sequence and ignore older writes.

#### [MEDIUM] SafetyInterstitial offers only "Continue anyway" — no "Go back to safety," and the overlay covers the toolbar Back button
- **Location:** `src/components/SafetyInterstitial.tsx:47-55` (styles `index.css:3460-3471`; `NavControls.tsx:16`)
- **Component:** React desktop components · **Category:** security
- **What's wrong:** The malware/phishing/HTTPS interstitial renders exactly one interactive element: a "Continue anyway (not recommended)" / "Continue to HTTP for this site" button that calls `onProceed(interstitial.url)` and navigates to the dangerous URL. There is no "Go back to safety" / dismiss control. It does NOT use the shared `useDialog` hook, so Escape does nothing. The container is `position: fixed; inset: 0; z-index: 10100` with an opaque background, so while shown it completely covers the toolbar including the NavControls Back/Home buttons. The only control the warning presents leads directly into the malicious site — inverting standard safe-browsing interstitial design.
- **Impact:** On a malware/phishing block, the user's only in-overlay action navigates into the dangerous site; there is no in-overlay retreat and the toolbar Back button is visually covered, nudging users toward the unsafe choice and undermining MalwareGuard's intent.
- **Fix:** Add a primary, default-focused "Go back to safety" button (new `onDismiss`/`onBack` prop → `nav.back()` or home + clears `safety.interstitial`), demote "Continue anyway" to a secondary style, and wire the component through `useDialog` so Escape maps to the safe path.

#### [MEDIUM] Ad-block shield popover hides native content but is not registered with the native Back interceptor (Android)
- **Location:** `src/components/mobile/MobileApp.tsx:83-94`
- **Component:** React mobile components · **Category:** correctness
- **What's wrong:** `overlayOpen` includes `shieldOpen`, so opening the shield popover calls `setChromeOverlay(..., true)` → on Android hides the native content WebView (`ipcClient.ts:147-156` `setContentHidden(true)`). But the Back interceptor registers only for sheets/fullscreen (`setBackInterceptActive(sheet !== null || fullscreen)`), and `__aegisMobileBack` handles only sheet/fullscreen. The shield popover has no outside-click handler (`useDialog` binds only Escape+Tab; there's no hardware Escape on a phone). Pressing hardware Back with the popover open is NOT intercepted: it navigates the page back while content is still hidden behind the open popover.
- **Impact:** Device Back with the shield popover open triggers an unintended page navigation while content is hidden — a confusing, recoverable touch/back bug.
- **Fix:** `setBackInterceptActive(sheet !== null || fullscreen || shieldOpen)`, have `__aegisMobileBack` close the shield first (`setShieldOpen(false)`), and add `shieldOpen` to the effect deps.

#### [MEDIUM] Declared events `nav.failed` / `nav.crashed` are never emitted by the Rust core on any platform — the ErrorOverlay is dead — *double-confirmed*
- **Location:** `src-tauri/src/nav.rs:75-96, 327-400` (contract `shared/types.ts:60-61`; `ipcClient.ts:129-130`; `App.tsx:196-205, 371`)
- **Component:** IPC contract consistency · **Category:** parity/correctness
- **What's wrong:** `shared/types.ts` declares `nav.failed`/`nav.crashed`, `ipcClient.ts` exposes `onFailed`/`onCrashed`, and `App.tsx` subscribes to both to render `ErrorOverlay`. But the Rust core only ever calls `emit_event(app, "nav.state", …)` (the sole emit sites are `emit_state` at `nav.rs:83` and its call at `nav.rs:202`); a grep for `nav.failed`/`nav.crashed` returns zero matches. The Android Kotlin client never pushes them either. So a failed load, TLS/cert error, or web-process crash never surfaces an overlay on any platform.
- **Impact:** Users get a silent blank page on load failures, certificate errors, and renderer crashes instead of the intended retry/home overlay — degraded UX on every platform; a contract feature fully wired on the JS side but unimplemented on Rust.
- **Fix:** Wire the failure/crash signals in `nav.rs` to emit the declared events — WebKit `load-failed`/`web-process-terminated` (Linux), WebView2/WKWebView equivalents (Win/macOS), `onReceivedError`/`onRenderProcessGone` (Android) — building `NavFailed`/`NavCrashed` payloads matching `shared/types.ts`. Honor the parity mandate across all four platforms; or, if deferring, gate the `App.tsx` subscriptions behind a TODO so the contract reflects reality.

#### [MEDIUM] No vulnerability gating or update automation for the Rust dependency tree (only JS is audited)
- **Location:** `.github/workflows/ci.yml:37-39`; `.github/dependabot.yml:7-22`; `src-tauri/Cargo.toml`
- **Component:** Config, build, CI & supply chain · **Category:** supply-chain
- **What's wrong:** The only supply-chain gate is `node scripts/check-npm-audit.mjs`, which audits JavaScript only. The security-critical Rust core (tauri 2.11.2, reqwest 0.13.4, rustls 0.23.40, hyper 1.10.1, ring 0.17.14, adblock 0.12.5 — the engine parsing untrusted filter lists and matching untrusted page URLs) has no `cargo audit`/`cargo deny` step in any workflow, and `dependabot.yml` declares only `npm` and `github-actions` ecosystems. A published RUSTSEC advisory against any of these would never be flagged or auto-bumped; the dependabot comment itself concedes "Cargo/Rust deps aren't covered yet."
- **Impact:** A known-vulnerable Rust crate (TLS, HTTP, or the ad-block parser handling attacker-controlled input) can ship with zero CI signal and no automated bump — defeating SECURITY.md's "kept current + gated in CI" claim for the half of the tree most relevant to the trust boundary.
- **Fix:** Add a `cargo audit` (RustSec) or `cargo deny check advisories` job gated on `Cargo.lock`, add a `cargo` ecosystem to `dependabot.yml`, and correct SECURITY.md.

#### [MEDIUM] npm-audit gate passes silently when `npm audit` returns an error/malformed report
- **Location:** `scripts/auditCheck.mjs:24-54, 77-86`; `scripts/check-npm-audit.mjs:14-44`
- **Component:** Config, build, CI & supply chain · **Category:** supply-chain
- **What's wrong:** `collectBlockingAdvisories` reads `auditJson.vulnerabilities`, defaulting to `{}` when absent, and `evaluateAudit` returns zero blocking advisories for any input lacking that key. When the registry is unreachable/rate-limited, `npm audit --json` can emit `{ "error": {...} }`; the wrapper recovers only from a thrown/non-zero exit and from JSON parse failure, so a successfully-parsed error object flows into `evaluateAudit` and reports "OK." Verified directly: `evaluateAudit({ error: { code: 'ENETUNREACH' } }, { allow: [] })` returns `blocking: 0`.
- **Impact:** A transient registry/network failure turns the supply-chain gate into a no-op that reports success, so a PR or main push can merge with the audit effectively disabled.
- **Fix:** Require a real report (`auditReportVersion` or a `vulnerabilities` object) and fail (exit 1) if the parsed report has an `error` field or lacks `vulnerabilities`, rather than treating a missing key as "clean."

#### [MEDIUM] Native multi-OS build/compile check never runs on PRs — only after merge to main
- **Location:** `.github/workflows/tauri-build-check.yml:12-16`; `.github/workflows/ci.yml:6-13`
- **Component:** Config, build, CI & supply chain · **Category:** test
- **What's wrong:** `ci.yml` (the only workflow with `pull_request: {}`) runs `npm test` + the npm-audit gate on Ubuntu — no native build. The workflow that compiles/links/bundles the Rust core on Windows/macOS/Linux/Android (`tauri-build-check.yml`) triggers only on `push` to `main` and `workflow_dispatch`. Per `src-tauri/CLAUDE.md`, desktop-only Tauri API misuse and platform-specific Rust breakage are caught only by these native builds.
- **Impact:** Rust/native and cross-platform regressions are not gated before merge; main can be broken by a PR that looked green, and parity breakage on Win/macOS/Android isn't caught until after it lands.
- **Fix:** Add `pull_request: {}` to `tauri-build-check.yml`, or at minimum run a fast `cargo check` per target (incl. `--target aarch64-linux-android`) in `ci.yml` on PRs.

#### [MEDIUM] Android auto-update lacks the signature verification the desktop updater enforces
- **Location:** `src-tauri/src/update.rs:89-116, 148-173`; `tauri-build-check.yml:164-174`
- **Component:** Config, build, CI & supply chain / threat model · **Category:** parity — *config-build-ci-4 + threat-model-5*
- **What's wrong:** Desktop uses tauri-plugin-updater, which verifies the minisign signature against the pubkey in `tauri.conf.json` before installing. On Android the plugin is unsupported, so `android_check` fetches `latest.json` over HTTPS, compares versions, and surfaces "available"; installing "happens via the releases page" (manual APK). There is no minisign verification on the Android path — integrity rests on TLS-to-GitHub plus the APK's own package signature. Compounding this, CI APKs are debug-key-signed per-runner, so there's no stable Android signing identity to anchor trust to.
- **Impact:** If the release/CDN is compromised or the manifest tampered at the edge, desktop refuses the forged update but an Android user is steered to sideload an unverified APK — a weaker integrity guarantee than the documented signed-update model.
- **Fix:** Verify the APK's signature/hash against a value in the signed `latest.json` (or a pinned cert) before prompting; establish a stable Android release-signing key. At minimum, document in SECURITY.md that Android updates are not minisign-verified.

#### [MEDIUM] Windows network interceptor cannot honor the per-site allowlist (empty source URL)
- **Location:** `src-tauri/src/adblock_win.rs:66-78`
- **Component:** Cross-platform parity sweep · **Category:** parity
- *This is the parity-sweep restatement of the Windows-allowlist MEDIUM above (rust-adblock-platform-2). Same root cause (`should_block(&url, "", "other")` defeats the allowlist branch), same fix (thread the real top-frame source URL into the handler).* Only `on_new_window` pop-under blocking, which passes a real opener, honors the allowlist on Windows today.

#### [MEDIUM] Android HTTPS-Only ignores the user's `httpsOnly` setting (always upgrades)
- **Location:** `src-tauri/gen/android/.../MainActivity.kt:361-374`
- **Component:** Cross-platform parity sweep · **Category:** parity
- **What's wrong:** Desktop gates the http→https upgrade on `crate::settings::https_only(&app_nav)`, so a user who turns HTTPS-Only off can reach http pages. On Android `secureUrl()` upgrades any non-localhost http URL to https unconditionally — it never reads the `httpsOnly` setting. So the SecurityTab toggle (shipped in `MobileApp.tsx`) has no effect on Android.
- **Impact:** The HTTPS-Only setting is honored on desktop but ignored on Android; an Android user cannot disable the upgrade to visit a legitimately http-only site — a behavioral parity gap in a security setting.
- **Fix:** Read the persisted `httpsOnly` setting on Android (via a bridge call or by reading `settings.json` through the Rust core/JNI) and skip the upgrade when off, matching the desktop gate.

#### [MEDIUM] Untrusted page can inject persistent cross-site cosmetic filter rules via the picker title sentinel (no active-pick gate)
- **Location:** `src-tauri/src/linux_layout.rs:23-37`
- **Component:** Cross-cutting threat model · **Category:** security
- **What's wrong:** On Linux the WebKit title-changed handler routes ANY page title beginning with `AEGISPICK:` into `picker::on_picked`, with no check that an element-picking session was actually started by the trusted chrome. Untrusted page JS can set `document.title = 'AEGISPICK:' + JSON.stringify({selector:'.login', host:'bank.com'})` and cause the Rust side to append `bank.com##.login` (an arbitrary, page-chosen host + selector) to the user's persistent `custom-filters.txt`, then reinstall the engine. Because `host` is page-controlled, a page on `evil.com` can write a cosmetic rule scoped to a DIFFERENT site, and can spam thousands of rules. The page-side `window.__aegisPicking` guard does not gate the Rust handler.
- **Impact:** Untrusted web content silently writes persistent cosmetic rules into the user's profile, scoped to arbitrary hosts (cross-site `display:none` injection / breakage) and can pollute/bloat the filter store. Reachable on every Linux page load with no user interaction.
- **Fix:** Gate `on_picked` on a Rust-side "pick session active" flag set only by `picker.start` (cleared on pick/cancel/navigation), so a page title is ignored unless the chrome actually started a pick. Additionally ignore the page-supplied `host` and use the active tab's real origin from the webview (`wv.uri()`), and validate/limit the selector.

#### [MEDIUM] Filter-list subscriptions accepted over cleartext `http://` — MITM can inject arbitrary engine rules
- **Location:** `src-tauri/src/subs.rs:203-216`
- **Component:** Cross-cutting threat model · **Category:** security
- *Same root cause as the subscription-fetch MEDIUM above (rust-adblock-engine-2). Filter rules decide what network requests are blocked and what cosmetic CSS is injected into every page, so a MITM-controlled http list can selectively un-block trackers/ads or inject breakage. The fetch follows reqwest default redirects with no scheme pinning after the initial check.* Fix: require `https://`, refuse non-https redirects, optionally pin the list hash.

---

### LOW

#### [LOW] Pervasive `Mutex::lock().unwrap()` on the IPC path risks lock poisoning that permanently disables a state domain
- **Location:** `src-tauri/src/tabs.rs:29, 84, 92, 100, 108, 117, 125, 132, 146, 162` (and `adblock.rs`/`adblock_engine.rs`/`nav.rs` `OnceLock<Mutex<..>>` globals)
- **Component:** Rust IPC core · **Category:** concurrency
- **What's wrong:** Every managed-mutex access uses `.lock().unwrap()`. A panic while holding a lock poisons the mutex; every later `.lock().unwrap()` then panics. A panic inside a `#[tauri::command]` is caught by Tauri (app keeps running), but the poisoned mutex permanently breaks every later IPC call touching that state for the session. Latent today (ops are mostly panic-free) but offers no recovery.
- **Impact:** A single panic-under-lock turns into a session-long outage of an entire feature domain (tabs, ad-block, …) with the app still "running," hard to diagnose because the original panic is swallowed.
- **Fix:** `lock().unwrap_or_else(|e| e.into_inner())` behind a small helper, or switch to `parking_lot`; at minimum document that state methods must never panic while holding the lock.

#### [LOW] `data.export`/`import` honor a caller-supplied absolute file path with no validation
- **Location:** `src-tauri/src/data.rs:17-27, 40-45, 61-65` (also threat-model-6: `data.rs:17-45`)
- **Component:** Rust IPC core / threat model · **Category:** security
- **What's wrong:** `export_file()` returns `PathBuf::from(p)` for any non-empty `payload.path`, with no canonicalization/traversal check/confinement. `data.export` writes the full bundle there; `data.import` reads from it. The renderer currently sends only `mode`/`text` and the content webview cannot reach IPC, so it is not currently reachable — but the backend will write the user's full data to, and read from, any absolute path the IPC caller names.
- **Impact:** Latent arbitrary file write (export) / read-into-import controlled by the IPC payload path; becomes a real primitive if a future caller forwards an attacker-influenced path or the renderer is compromised.
- **Fix:** Drop the caller-supplied path (the UI doesn't use it) or constrain it under the OS Downloads/Documents dir, reject `..`/absolute escapes, and prefer the dialog plugin's scoped save/open.
- **Note:** threat-model-6 is the same defense-in-depth note.

#### [LOW] Malware-block warning is shown on the ACTIVE tab even when the block occurred in another tab or a subframe
- **Location:** `src-tauri/src/safety.rs:80-97`
- **Component:** Rust IPC core · **Category:** correctness
- **What's wrong:** `safety::raise` navigates `active_content_label(app)` to the data: warning page, but `is_blocked`/`raise` is called from `on_navigation`, which fires for every navigation including subframes and any tab. `raise` does not use the per-tab id the callback closes over, so a malware nav in a background tab or an active-page iframe replaces the ACTIVE top-frame document.
- **Impact:** A malware iframe (or a background-tab nav) blanks the user's active page with the interstitial, losing page state; the block itself still works, the targeting is wrong.
- **Fix:** Thread the tab id into `raise`, navigate that tab's `content_label(id)`, and only show the full-page warning for main-frame navigations.

#### [LOW] Malware-host check is exact-host-only — subdomains of a known-malware host bypass the block
- **Location:** `src-tauri/src/safety.rs:41-52, 14-30`
- **Component:** Rust IPC core · **Category:** security
- *The Rust-IPC-core view of the malware exact-match weakness already filed at MEDIUM (safety.rs:41-52). Same fix: host-suffix matching (`host == entry || host.ends_with(".".to_owned()+entry)`).* Session exceptions are likewise keyed on exact host only (consistent on the bypass side).

#### [LOW] Win/mac same-document URL trackers diverge on the loading flag emitted to the address bar
- **Location:** `src-tauri/src/nav_url_mac.rs:111-119` (vs `nav_url_win.rs:30-44`)
- **Component:** Rust navigation · **Category:** parity
- **What's wrong:** The Windows tracker reads WebView2's `IsNewDocument` and forwards it as `loading`. The macOS KVO tracker always passes `false`, but the WKWebView `URL` KVO key also fires on full navigations, where macOS then reports `loading=false` while Windows reports `loading=true` for the equivalent event.
- **Impact:** Minor UX/parity inconsistency in the address-bar spinner for a full navigation surfaced by the KVO observer; no security impact. Not runtime-verifiable here (CI/desktop-only).
- **Fix:** Either document that macOS spinner state is intentionally driven only by `on_page_load` (and keep the KVO observer same-document-only), or observe `WKWebView.isLoading` alongside `URL` so both platforms emit the same `loading` value.

#### [LOW] Idle sweep marks a tab discarded before the webview close is dispatched; a failed dispatch leaks the webview
- **Location:** `src-tauri/src/tabs.rs:199-209` (`tab_registry.rs:329-339`)
- **Component:** Rust tab registry · **Category:** resource-leak
- **What's wrong:** `sweep_idle()` sets `t.live=false` on victims under the lock; the GTK teardown (`close_webview`) and persist/emit happen later on the main thread via `run_on_main_thread` whose `Result` is discarded. If that dispatch fails (event loop stopping), the registry considers the tabs non-live (and persists that) while their webkit2gtk widgets are never destroyed — a leak. Re-activating such a tab spawns a NEW webview with the SAME `content:<id>` label while the old widget is still parked. Even on success, the gap between marking `live=false` in the worker and the main-thread close allows a concurrent `activate()` to flip the tab back to live and spawn a webview the queued close then destroys.
- **Impact:** On the failure path the registry/session say discarded while the webview still exists (GTK/WebKit leak, duplicate-label risk).
- **Fix:** Do the registry mutation and webview teardown together on the main thread (dispatch `sweep_idle` + close loop + persist inside one `run_on_main_thread`), so the registry never advertises a discard whose teardown hasn't run.

#### [LOW] `tabs.create` switches the active tab in the registry before spawning; an unparseable URL leaves the active tab with no webview
- **Location:** `src-tauri/src/tabs.rs:57-61, 79-89` (`tab_registry.rs:194-208`)
- **Component:** Rust tab registry · **Category:** correctness
- **What's wrong:** `create()` sets the new tab `live:true` and `active_id=id` BEFORE the Tauri layer spawns; `spawn()` only spawns if `Url::parse` succeeds and silently no-ops otherwise. A create with an invalid `url` (the JS bridge controls the payload) yields an active, live, webview-less tab; `apply_inset`/layout then bail, leaving a broken/blank active tab. Same class for `activate()`/`reopen_closed()`/`close()`-respawn.
- **Impact:** A malformed URL from chrome (or `open_background` with a non-URL string) makes the active tab a dead, webview-less tab.
- **Fix:** Validate/normalize the URL before mutating the registry (parse in `tabs.rs`, fall back to `home_url` on failure, or reject), and make `spawn()` fall back to home rather than no-op. Surface `spawn_tab` errors instead of discarding.

#### [LOW] Session restore does not de-duplicate or validate persisted tab ids
- **Location:** `src-tauri/src/tab_registry.rs:101-135`
- **Component:** Rust tab registry · **Category:** invariant
- **What's wrong:** `restore()` trusts every `PersistedTab.id` from `tabs.json`. `idx()` resolves an id via `Vec::position` (first match only). Duplicate ids in the (on-disk, editable) session file mean later operations act only on the first, and desktop labels `content:<id>` collide so two tabs share one webview. `next_id` is `max(id)+1` so new tabs are safe, but duplicates remain; no non-zero/distinct check.
- **Impact:** A corrupted/hand-edited `tabs.json` with duplicate ids yields tabs that can't be independently closed/activated and that share a webview. Not remotely exploitable (local file).
- **Fix:** After mapping, de-dup by id (drop or re-id collisions) and drop `id==0`; a `HashSet<ViewId>` pass before constructing the `Registry` suffices.

#### [LOW] Every navigation event triggers a synchronous JSON serialize + full disk write of the session
- **Location:** `src-tauri/src/tabs.rs:40-45, 172-182`
- **Component:** Rust tab registry · **Category:** performance
- **What's wrong:** `on_tab_url` (called from `on_page_load` for every top-frame load, both Started and Finished) unconditionally calls `emit_and_persist`, which serde-serializes the full session to pretty JSON and writes `tabs.json` synchronously on the main/IPC path; same on every title change and via the Linux `notify::uri` tracker. On a busy SPA this is a full-file rewrite per event even when nothing changed.
- **Impact:** Repeated synchronous full-file writes add latency and disk churn on SPA-heavy sites.
- **Fix:** Debounce persistence (coalesce on a timer or persist only when the projection changed); skip `emit_and_persist` when `record_nav` reports no change.

#### [LOW] Non-atomic session write can leave a truncated/corrupt `tabs.json` on crash; load silently discards it
- **Location:** `src-tauri/src/tabs.rs:172-189`
- **Component:** Rust tab registry · **Category:** resource-leak
- **What's wrong:** `persist()` writes directly with `std::fs::write` (truncate-then-write). A crash mid-write leaves a partial file; `load_session` swallows the parse error with `.ok()?` and returns `None`, losing the whole restored session. The per-navigation writes (above) hit the truncation window frequently.
- **Impact:** Session loss on an ill-timed crash, no diagnostic; lost data is only tab URLs/titles (low value).
- **Fix:** Write to `tabs.json.tmp` then `rename`; log when `load_session` fails to parse an existing file.

#### [LOW] `state_value`/`dispatch` use `app.state::<Tabs>()` (panics if unmanaged) while siblings use `try_state`
- **Location:** `src-tauri/src/tabs.rs:28-31`
- **Component:** Rust tab registry · **Category:** maintainability
- **What's wrong:** `state_value` and the `dispatch()` arms use `app.state::<Tabs>()` (panics with "state not managed" if absent), whereas `persist()`, `now_ms()`, `on_tab_url`, `on_tab_title`, `start_idle_sweep` defensively use `try_state`. Reachable only during teardown or an unexpectedly early/late event, but a latent panic source.
- **Impact:** If a `tabs.*` dispatch runs before `Tabs` is managed or after removal (e.g. an event during shutdown), the IPC thread panics instead of returning an error.
- **Fix:** Use `try_state` consistently and return `Err`/`Value::Null` when unmanaged.

#### [LOW] Non-atomic `subs.json` read-modify-write races between concurrent fetches and reinstall reading the cache
- **Location:** `src-tauri/src/subs.rs:100-118, 132-189`
- **Component:** Rust ad-block engine · **Category:** concurrency
- *The ad-block-side view of the subs.json lost-update race already at MEDIUM. Adds: `fetch_in_background` writes the cache file then `reinstall_adblock` → Linux `install_adblock` reads `subs::enabled_text` (`read_to_string(cache_path)`), so a concurrent fetch rewriting that cache can be read mid-write.* Fix: serialize subs mutations behind a Mutex/single updater thread; write cache files atomically (temp + rename).

#### [LOW] `host_of` mishandles IPv6 literal hosts in the allowlist check
- **Location:** `src-tauri/src/adblock_engine.rs:37-42`
- **Component:** Rust ad-block engine · **Category:** correctness
- **What's wrong:** `host_of` splits the authority on `:` and takes the first segment. For `https://[2001:db8::1]:8443/` the authority is `[2001:db8::1]:8443`, so it yields `[2001` — the allowlist comparison can never match a bracketed IPv6 host.
- **Impact:** Per-site allowlisting silently fails for IPv6-literal-host pages.
- **Fix:** Handle the bracketed form (take up to `]` when the authority starts with `[`), or reuse the `url` crate (already in-tree via reqwest) for host extraction.

#### [LOW] WebView2 interception passes empty source + rtype "other", degrading first/third-party and resource-type matching
- **Location:** `src-tauri/src/adblock_win.rs:66-70`
- **Component:** Rust ad-block platform · **Category:** correctness
- **What's wrong:** Every request is matched as `should_block(&url, "", "other")`. With no source URL the engine cannot evaluate `$third-party`/`$first-party`/`domain=`; with `rtype` hard-coded `"other"` it cannot apply `$script`/`$image`/`$xmlhttprequest` options. Windows both over-blocks third-party-only rules and misses type-scoped rules, diverging from Android which derives real source/type.
- **Impact:** Coverage/accuracy gap: `||host^` anchors match, but type- and party-scoped rules are mis-evaluated on Windows.
- **Fix:** Map `args.ResourceContext()` to an adblock request type and supply the page/source URL (the same fix as the Windows-allowlist MEDIUM).

#### [LOW] WebView2 `WebResourceRequested` handler blocks the UI thread synchronously on the engine channel for every request
- **Location:** `src-tauri/src/adblock_win.rs:39-48, 69`
- **Component:** Rust ad-block platform · **Category:** performance
- **What's wrong:** `WebResourceRequested` fires on the WebView2 (UI) thread; `handle()` → `should_block` sends a `Query` to the single `!Send` engine thread and blocks on `answer.recv()`. All requests across all tabs funnel through one serial engine thread, so each subresource stalls the UI thread until the engine replies; a slow/stuck engine stalls the UI. (Android is unaffected — `shouldInterceptRequest` runs on a background thread.)
- **Impact:** Per-request synchronous round-trip on the WebView2 UI thread: potential jank on resource-heavy pages, UI stall if the engine thread blocks.
- **Fix:** Keep a fast local host-set pre-check on the UI thread, or use the args deferral completed from the engine thread; at minimum time-box the `recv` to fail open quickly.
- **Note:** threat-model-7 (info) is the cross-platform restatement of this serialization point.

#### [LOW] POPUP_GUARD documented as shipping on EVERY platform but never reaches Android content pages
- **Location:** `src-tauri/src/adblock_inject.rs:18-19, 48-61`
- **Component:** Rust ad-block platform · **Category:** parity
- **What's wrong:** The doc comment claims the pop-under guard is injected at document-start "on EVERY platform." On Android the content is a native Kotlin WebView; `adblock_inject::script()` is only wired into the Tauri content webview via `nav::spawn_tab` (`nav.rs:123`, `#[cfg(desktop)]`). `MainActivity.kt` has no `addDocumentStartJavaScript`/`evaluateJavascript` of the guard, so the proactive `window.open` override never runs on Android content; Android relies solely on the reactive `onCreateWindow` path.
- **Impact:** The proactive cross-origin `window.open` block doesn't exist on Android content (reactive coverage catches most pop-unders); the "EVERY platform" claim is inaccurate.
- **Fix:** Inject POPUP_GUARD into each Android tab WebView at document start (`WebViewCompat.addDocumentStartJavaScript` or `onPageStarted`), or correct the doc comment.

#### [LOW] Malware "proceed anyway" exception is host-wide and persists for the whole session
- **Location:** `src-tauri/src/safety.rs:109-123`
- **Component:** Rust security features · **Category:** security
- **What's wrong:** `safety.proceed` inserts only the bare host into session exceptions, so proceeding once whitelists every path on that host (in any tab) for the session, with no per-URL or time scoping, and the host-wide nature is not surfaced to the user.
- **Impact:** Proceeding once weakens the guard for the whole host more than the user likely expects.
- **Fix:** Scope the exception to the specific URL (or make the host-wide nature explicit in the interstitial copy) and/or expire it; the listExceptions/removeException UI already allows revocation.

#### [LOW] Android update self-check performs no signature/integrity verification
- **Location:** `src-tauri/src/update.rs:151-173`
- **Component:** Rust security features · **Category:** security
- *The security-feature view of the Android-update-integrity MEDIUM (config-build-ci-4). On Android the "update available" signal rests solely on TLS to GitHub plus an unauthenticated version compare; install integrity then relies on the APK signing key.* Fix: verify a minisign signature on the Android manifest, or document that Android update integrity relies on the APK signature.

#### [LOW] Version comparison treats unparseable components as 0, allowing a downgrade/misleading prompt
- **Location:** `src-tauri/src/update.rs:35-52`
- **Component:** Rust security features · **Category:** correctness
- **What's wrong:** `is_newer` parses each dotted component with `parse().unwrap_or(0)`, so a malformed/date-based/build-metadata version silently becomes 0 in some positions, which can report a lower/equal version as newer; it ignores semver pre-release ordering beyond stripping after `-`. Feeds the Android "available" decision.
- **Impact:** A non-numeric version component coerced to 0 can produce an incorrect newer/older verdict and a misleading Android update prompt. Low because desktop install is still signature/downgrade-guarded by the plugin.
- **Fix:** Use a real semver parse (or reject non-numeric core components instead of coercing to 0); offer an update only when strictly greater and unambiguous.

#### [LOW] Favorites/saved/permissions stores grow unbounded (history is capped, these are not)
- **Location:** `src-tauri/src/places.rs:25-37`
- **Component:** Rust security features · **Category:** resource-leak
- **What's wrong:** `history.rs` caps at `MAX_ENTRIES` (5000) and drains oldest, but `places.rs` (favorites + saved) and `permissions.rs` have no cap. Each add rewrites the entire array (load → push → save whole file), so per-op cost grows with the collection.
- **Impact:** Large collections make every mutation rewrite the whole file with no eviction; mostly a scalability note for personal-use volumes.
- **Fix:** Cap/paginate as history does, or document that these stores are intentionally uncapped.

#### [LOW] Element picker is Linux-only — no cosmetic-pick parity on Windows/macOS/Android
- **Location:** `src-tauri/src/picker.rs:116-137`
- **Component:** Rust security features · **Category:** parity
- **What's wrong:** `picker.start` does anything only under `#[cfg(target_os = "linux")]`; every other target returns `{"ok": false}` and `on_picked` persistence is also Linux-gated. The picker (pick an element → persist `host##selector` → reinstall engine) works only on Linux, even though Win/macOS/Android honor cosmetic rules via `adblock_inject`.
- **Impact:** The element picker is Linux-only; other targets silently return `ok:false`. Functional parity gap, low security impact.
- **Fix:** Implement the picker overlay injection + selector relay on the other platforms, or document the picker as Linux-only with a tracked follow-up.

#### [LOW] Rust `subs.changed` event is emitted but never subscribed by the renderer (stale Filter Lists UI)
- **Location:** `src/hooks/useSubscriptions.ts:15-23` (emits at `subs.rs:114, 186`)
- **Component:** React core / IPC contract · **Category:** parity — *react-core-3 + ipc-contract-3*
- **What's wrong:** The Rust core emits `subs.changed` after background fetches/auto-refresh, but the name is absent from the `shared/types.ts` `IPC` const and no renderer code subscribes (grep returns nothing). `useSubscriptions` loads the list only on mount and after explicit mutations, so a background metadata change (lastUpdated/etag/hash) does not refresh an open Filter Lists tab.
- **Impact:** The Filter Lists settings tab can show out-of-date subscription metadata after a background refresh; no security impact.
- **Fix:** Add `evtSubsChanged: 'subs.changed'` to the `IPC` const, expose `subs.onChanged` in ipcClient, and have `useSubscriptions` re-fetch on the event — or remove the unused Rust emit. (`picker.picked`, info, is the same dead-emit class.)

#### [LOW] `addressParse` cannot navigate single-label/intranet hosts and rejects `host:port` entirely
- **Location:** `src/lib/addressParse.ts:9-46`
- **Component:** React core · **Category:** correctness
- **What's wrong:** `looksLikeHost()` requires a literal `.`, so a bare single-label host (`localhost`, `router`, `nas`) is treated as a SEARCH term. Worse, `localhost:3000` matches `hasScheme()` (the RFC-3986 regex treats `localhost:` as a scheme), then `isAllowedNavigationUrl('localhost:3000')` sees protocol `localhost:` (not in `ALLOWED_NAV_SCHEMES`) and returns "rejected" — neither navigation nor search.
- **Impact:** Typing `localhost`, `localhost:3000`, or any single-label intranet host fails to navigate. Common developer/LAN annoyance.
- **Fix:** Special-case `localhost` and recognize a `host:port` shape (`/^[\w.-]+:\d+(\/|$)/`) as an http(s) candidate before the generic scheme branch.

#### [LOW] `tauriInvoke.on()` does not catch a rejected `listen()` promise (possible unhandled rejection)
- **Location:** `src/lib/tauriInvoke.ts:24-29`
- **Component:** React core · **Category:** correctness
- **What's wrong:** `on()` calls `void listen(...).then(...)` with no `.catch`. If `listen()` rejects (channel unavailable, racing teardown), the rejection is unhandled and the returned cleanup is a no-op for that subscription (the `cancelled` flag won't help since the promise never resolves).
- **Impact:** Noisy unhandled-rejection on a transient listen failure; the failed subscription can't be reasoned about.
- **Fix:** Append `.catch((err) => console.error('listen failed for', tauriEvent, err))`.

#### [LOW] `useNav`: `searchTemplate` goes stale — runtime Settings changes never propagate to the nav hook
- **Location:** `src/hooks/useNav.ts:36-38, 48-67`
- **Component:** React hooks · **Category:** correctness
- **What's wrong:** `searchTemplate` is fetched once per effect run with `[viewId]` as the only dependency. There is no `settings.onChanged` event. When the user changes the default search engine via `useSettings.update` (which updates only `useSettings`' local state), `useNav` keeps the previously-fetched template until `viewId` changes or the app reloads.
- **Impact:** Searches use the wrong (previous) search engine after a Settings change, until a tab switch/reload — identical on all platforms.
- **Fix:** Lift the search template into a shared settings source the hook subscribes to, add a settings-changed event, or have `useSettings.update` broadcast the new template.

#### [LOW] No error handling on any IPC call in the hooks — every fetch/action can reject unhandled
- **Location:** `src/hooks/useNav.ts:33-38, 55-57` (pattern across the whole `src/hooks` directory)
- **Component:** React hooks · **Category:** correctness
- **What's wrong:** The only try/catch in the hooks directory is `useAdblock`'s URL-parse helper. Every IPC interaction is `void aegis.x.y().then(setState)` with no `.catch`, or `await aegis.x.y()` with no surrounding try/catch (useDownloads/useHistory/useSaved/usePermissions/useTabs/useSettings/useSubscriptions/useCustomFilters). `call()` rejects on any backend error, so a rejected IPC surfaces as an unhandled rejection or rejects the action's promise with no recovery; mount-fetch failures leave the hook stuck on empty seed state.
- **Impact:** Backend/IPC failures produce unhandled rejections and a silently stale/empty UI with no error surfaced. Error resilience is uniformly missing across all platforms.
- **Fix:** Add `.catch`/try-catch to mount fetches and action callbacks (at minimum `console.error`); centralizing in `ipcClient`/`tauriInvoke` covers all hooks at once.

#### [LOW] `useTabs`: `onState` subscription has no unmount guard (inconsistent with every other hook)
- **Location:** `src/hooks/useTabs.ts:19-24`
- **Component:** React hooks · **Category:** correctness
- **What's wrong:** Unlike the sibling hooks, `useTabs`' live callback calls `setState(s)` directly without consulting the `active` flag (only the initial `list()` checks it). The synchronous `off()` is race-safe, but a `tabs.state` event in the commit-unmount→`off()` window fires `setState` on an unmounted component; the action callbacks are also unguarded. Benign today (root-mounted, effectively never unmounts).
- **Impact:** A setState-after-unmount warning if a tabs.state event lands during the unmount window; latent if `useTabs` is ever mounted conditionally.
- **Fix:** Guard the callback like the siblings: `const off = aegis.tabs.onState((s) => { if (active) setState(s); });`.

#### [LOW] `useHistory`/`useDownloads`: onChanged-triggered `refresh()` sets state without an unmount guard
- **Location:** `src/hooks/useHistory.ts:29-47` (same in `useDownloads`)
- **Component:** React hooks · **Category:** concurrency
- **What's wrong:** The mount effect's `active` flag guards only the initial `list()` fetch. The `onChanged` subscription calls `void refresh()`, and `refresh()` awaits an IPC fetch then calls `setEntries`/`setDownloads` with no `active` check, so an in-flight refresh resolving after unmount runs setState on an unmounted component.
- **Impact:** A setState-after-unmount warning/wasted work if a changed-event refresh resolves after unmount; benign today (root-mounted).
- **Fix:** Have `refresh()` consult a mounted ref (or pass the effect's `active` flag) before calling setState.

#### [LOW] FavoriteRow inputs initialized from props via `useState` never re-sync when the favorite changes
- **Location:** `src/components/FavoritesManager.tsx:24-25`
- **Component:** React desktop components · **Category:** correctness
- **What's wrong:** `FavoriteRow` seeds editable name/url fields with `useState(favorite.name)`/`useState(favorite.url)`; the list keys each row by `f.id`, so the instance is preserved across re-renders. If the favorites array updates while the manager is open (e.g. the core normalizes the saved URL), the controlled inputs keep the originally-mounted value; Save then writes the stale draft. The classic "derived initial state from props" pitfall.
- **Impact:** Edit fields can show stale values; a subsequent Save can overwrite a normalized value with the old one. Confined to favorites changing while the dialog is open.
- **Fix:** Re-key the row on its value, or sync local state to props via `useEffect`, or treat the inputs as drafts only while focused.

#### [LOW] MyFiltersTab textarea seeds from props once and never re-syncs if the custom-filter text resolves after mount
- **Location:** `src/components/MyFiltersTab.tsx:18`
- **Component:** React desktop components · **Category:** correctness
- **What's wrong:** `const [draft, setDraft] = useState(text)` captures the prop only on first mount; `text` (from `useCustomFilters`) starts at `''` and loads asynchronously. If the Settings modal opens before that `get()` resolves, the textarea initializes to `''` and never updates, so the user sees an empty box and a Save wipes their stored filters.
- **Impact:** On an edge timing path (Settings opened immediately on launch), the editor shows empty and saving overwrites the user's real filters.
- **Fix:** `useEffect(() => setDraft(text), [text])` (save mirrors the persisted value back) or key the component on `text`.

#### [LOW] AdblockShield badge shows a blocked count even when blocking is disabled or the site is allowlisted
- **Location:** `src/components/AdblockShield.tsx:85-102`
- **Component:** React desktop components · **Category:** correctness
- **What's wrong:** The button computes `blockingActive = state.enabled && !allowlisted` and swaps to ShieldOff when inactive, but the numeric badge always renders `props.page` regardless; the popover also shows "Blocked here: {page}" unconditionally. After disabling ad-block or allowlisting the host, the previous count stays until the next navigation resets it — reading as "blocking is off but it still blocked N."
- **Impact:** Cosmetic/UX: the count can contradict the ShieldOff state until reload.
- **Fix:** Render the badge (and "Blocked here" line) only when `blockingActive && props.page > 0`.

#### [LOW] Mobile Home button goes to `about:blank` instead of the configured home URL
- **Location:** `src/components/mobile/MobileApp.tsx:159-164`
- **Component:** React mobile components · **Category:** parity
- *The mobile-button view of the Android-Home parity gap already at MEDIUM (ipcClient.ts:102-109). `MobileMenuSheet`'s Home calls `nav.home` → `aegis.nav.home` → the Android branch hardcodes `about:blank`, ignoring the Home setting that `HomeTab` lets the user configure.* Fix as in the MEDIUM finding (Android `nav.home` branch fetches `settings.home`).

#### [LOW] Capability scoped by window, not webview, on a multi-webview window — relies on an implicit default to exclude untrusted content
- **Location:** `src-tauri/capabilities/default.json:5-13`; `src-tauri/src/nav.rs:105-118`
- **Component:** Config, build, CI & supply chain · **Category:** security
- **What's wrong:** The untrusted content webview is added to the SAME `main` window via `window.add_child` (`content:<id>`). The default capability is scoped `"windows": ["main"]` with no `"webviews"` field; the generated schema warns a window match "will be enabled on all the webviews of that window… On multiwebview windows, prefer specifying webviews." What actually excludes the content webview from `ipc`/`dialog`/`core:event` is that the capability defaults to `local: true` with no `remote` block while the content webview loads `WebviewUrl::External` (remote). Correct today, but it depends on an implicit default; adding a `remote` allowance, or loading any app-origin content into the content webview, would silently expose IPC/dialog/event to it.
- **Impact:** Defense-in-depth gap: privilege separation is enforced only by the remote/local default — safe today but fragile to a config change.
- **Fix:** Explicitly scope the capability to the trusted chrome webview with `"webviews": ["main"]` (and drop/narrow `"windows"`), so the boundary survives changes to the content webview's URL/origin.

#### [LOW] Updater endpoint targets releases/latest while the release workflow publishes a DRAFT, and the signing key is absent
- **Location:** `src-tauri/tauri.conf.json:43-48`; `.github/workflows/tauri-release.yml:78-85`
- **Component:** Config, build, CI & supply chain · **Category:** maintainability
- **What's wrong:** The updater endpoint is `…/releases/latest/download/latest.json`, but `tauri-release.yml` publishes with `releaseDraft: true`; a draft is not served at `/releases/latest/` and its assets aren't downloadable until promoted. Separately `TAURI_SIGNING_PRIVATE_KEY` is "Absent today," so produced updates carry no minisign signature and the desktop updater will (correctly, fail-safe) reject them.
- **Impact:** As configured, the update channel cannot deliver a verified update: drafts aren't at `/latest/`, and absent the signing secret the bundles are unsigned and rejected. The auto-update guarantee in SECURITY.md is aspirational until both are fixed.
- **Fix:** Set `TAURI_SIGNING_PRIVATE_KEY`(+`_PASSWORD`) and publish releases non-draft (or change the release step to publish, not draft) before the `/latest/` endpoint can serve a signed `latest.json`. Track as a release-readiness gate.

#### [LOW] Shield blocked-count badge counts only on Linux
- **Location:** `src-tauri/src/adblock.rs:41-67`; `nav.rs:209-213`
- **Component:** Cross-platform parity sweep · **Category:** parity
- **What's wrong:** `note_blocked`/`reset_page` (→ `adblock.blockedCount`) are wired only on Linux: `note_blocked` from `linux_layout::connect_block_counter` (WebKit resource-load-started), `reset_page` under `#[cfg(target_os = "linux")]`. Both are `#[allow(dead_code)]` because no other platform calls them. Windows/macOS/Android block requests but never count them, so the AdblockShield count shows 0 there despite active blocking.
- **Impact:** The blocked-count UI (a visible trust signal) reads 0 on Win/macOS/Android while Linux shows real counts — cosmetic parity gap.
- **Fix:** Increment the shared `SESSION_BLOCKED`/`PAGE_BLOCKED` counters from each platform's block site (Android `shouldInterceptRequest`, Windows `adblock_win::handle`, macOS via a bridge from the injected block path) and reset per-page on each top-frame nav.
- **Note:** ipc-contract-4 (info) records this plus the Linux-only `view.fullscreen`/`permissions.prompt` events as documented follow-ups.

#### [LOW] Malware blocking shows the interstitial inconsistently: subresource hits silent, no "proceed" on Android
- **Location:** `nav.rs:134-138`; `safety.rs:41-52, 109-123`; `MainActivity.kt:135-159, 376-397`
- **Component:** Cross-platform parity sweep · **Category:** parity
- **What's wrong:** Malware host data is shared (good), but the UX diverges. Desktop runs `is_blocked` in `on_navigation` (subframes too), raising the chrome interstitial + a session "proceed anyway." On Android, malware is surfaced only for main-frame navigations via `shouldOverrideUrlLoading`/Bridge.navigate (`showMalwareWarning`); in `shouldInterceptRequest` a malware subresource is silently dropped with `blockedResponse()` and never warns, and there is no "proceed anyway" path.
- **Impact:** Android users get no interstitial for malware subframes and cannot proceed past a blocked malware site; blocking itself is consistent so the security floor holds, the gap is in surfacing/override parity.
- **Fix:** Bridge a malware-interstitial event from the Android guard (plus a `setExceptionForHost`) so the chrome interstitial + "proceed anyway" work on mobile, and surface subframe-malware hits consistently with desktop.

#### [LOW] Download filename taken unsanitized from the page-controlled URL (silent overwrite within download dir)
- **Location:** `src-tauri/src/downloads.rs:27-36`
- **Component:** Cross-cutting threat model · **Category:** security
- **What's wrong:** The save filename is derived purely from the last URL path segment with no sanitization and no collision handling; `dir(app).join(&filename)` is written directly. Classic `../` traversal is mostly blocked (`rsplit('/')` discards slashes; `url::Url` percent-encodes backslashes), but in-directory clobber and dotfile/hidden-name creation (e.g. `.bashrc`) are real. Page-content-driven (the content webview's `on_download`), unlike the IPC paths.
- **Impact:** A visited page can auto-download a file that silently overwrites an existing same-named file in Downloads, or create dot/hidden files there. No directory escape was confirmed reachable.
- **Fix:** Sanitize the filename (strip separators incl. backslash, leading dots, reserved names) and de-duplicate on collision before assigning `*destination`. (Pairs with the downloads-overwrite MEDIUM.)

---

### INFO

- **[INFO] `add_WebResourceRequested` registration token discarded; add failures swallowed with no fallback** — `src-tauri/src/adblock_win.rs:46-48`. No leak/incorrect behavior in normal use (`should_block` honors the `ENABLED` toggle), but if `AddWebResourceRequestedFilter` succeeds while `add_WebResourceRequested` fails, ad-block is silently inactive on Windows with no diagnostic. Fix: log on `Err`; retain the token+controller if a disable-time detach is ever wanted.

- **[INFO] Injected JS ad-block is trivially detectable and defeatable by the page (inherent to the JS tier)** — `src-tauri/src/adblock_inject.rs:112-118`. `window.fetch.toString()` no longer reports `[native code]`; `XMLHttpRequest.open` stamps `this.__ab` which a script can read/delete to re-enable a request. Most defeatable on macOS (sole network tier). Also `fetch(new URL(...))` (URL object) isn't host-checked, and ws/wss/blob/data aren't covered. Fix: document the limitation; store the flag in a closure-scoped WeakMap; normalize `i` via `String(i.url||i)`; durable macOS fix is real WKWebView interception (out of scope).

- **[INFO] Rust `picker.picked` event emitted but has no IPC-const entry and no renderer subscriber** — `src/lib/ipcClient.ts:247-249` (emit `picker.rs:111`). The picked rule is surfaced synchronously via `picker.start()`'s return value + a toast; the event is orphaned dead contract surface. Fix: drop the emit, or add `picker.picked` + `onPicked` if a live feed is intended.

- **[INFO] `useFavorites`: declared `_currentUrl` param is dead — favorites never re-query on URL change** — `src/hooks/useFavorites.ts:6-23`. Intentional (favorites aren't URL-dependent, unlike `useSaved`); the underscore signals it. Only cost is a misleading signature. Fix: drop the param from the signature and call sites, or leave as-is.

- **[INFO] Mobile shell does not surface navigation failures/crashes (no ErrorOverlay parity)** — `src/components/mobile/MobileApp.tsx:129-154`. DesktopApp subscribes to `onFailed`/`onCrashed` and renders ErrorOverlay; MobileApp does neither, falling back to the native WebView error page (likely acceptable since the native page paints its own). Fix: confirm the native page is the intended fallback, or wire `useNav`'s failed/crashed events into a MobileSheet overlay. (Moot until the `nav.failed`/`nav.crashed` MEDIUM is fixed — those events aren't emitted on any platform.)

- **[INFO] Contracted events `view.fullscreen`, `permissions.prompt`, and `adblock.blockedCount` counting are emitted on Linux only** — `linux_layout.rs:102`; `permissions.rs:124`; `adblock.rs:42-67`. Names/types are consistent across the three contract places (no structural drift), but per-site permission prompts and the shield blocked-count are functional only on Linux. Documented as known follow-ups in `src-tauri/CLAUDE.md`. Fix: tracked with the permissions-parity and blocked-count parity findings above.

- **[INFO] API-unstable Tauri feature in production and a non-mainline reqwest 0.13 line** — `src-tauri/Cargo.toml:24-41`. `tauri` enables `unstable` (the load-bearing `Window::add_child` multi-webview surface, "not semver-frozen"); `reqwest = "0.13"` resolves to 0.13.4 with hyper 1.10.1 (newer/less-trodden than 0.12.x), and rustls feature unification across reqwest and tauri-plugin-updater means a feature change in either could silently alter the resolved TLS provider. Acceptable today; reinforces the need for Rust-side audit/update automation. Fix: keep pinned via Cargo.lock and pair with the cargo-audit + cargo dependabot from the supply-chain MEDIUM so changes arrive as reviewable PRs.

- **[INFO] Android update check fetches manifest but performs no signature verification (informational path)** — `src-tauri/src/update.rs:151-173`. The Android "update available" decision rests on TLS to GitHub + an unauthenticated version compare; install integrity is then the APK's own signing. Documents the parity gap vs the signature-verified desktop updater. (Same as the Android-update MEDIUM, recorded here as the threat-model observation.)

- **[INFO] All ad-block queries (desktop + Android) serialize through one engine thread with a per-call blocking recv** — `src-tauri/src/adblock_engine.rs:60-109`. Because `Engine` is `!Send`, every `should_block` sends a `Query` to a single dedicated thread and blocks on `recv()`, each allocating a fresh mpsc channel; concurrent requests across all tabs are funneled sequentially. Fails open (`unwrap_or(false)`) if the thread is gone (safe). Intentional `!Send` workaround, noted for completeness. Fix: if profiling shows it matters, batch/pre-resolve or keep the query off the network thread's critical path; otherwise leave as-is.

---

### Android-native deep-dive (re-run after the original auditor crashed)

The dedicated Android auditor died on a transient socket error in the first pass; it was re-run with the same verify + second-skeptic rigor. **Key reassurance:** the `addJavascriptInterface("AegisAndroid")` bridge is added **only to the chrome webview** (`MainActivity.kt:328`), which loads local bundled React assets under the strict CSP; the untrusted browsed pages live in separate `tabWebView`s that get **no bridge**, so page content cannot reach `activateTab`/`navigate`/`openExternal`/etc. The interpolated `evaluateJavascript` calls (lines 105, 245, 323, 418) are all safe — nav state via `org.json.JSONObject`, URLs via `JSONObject.quote()`, insets as numeric floats. `shouldInterceptRequest → JNI` fails open by design. **No exploitable bridge or script-injection hole was found.**

#### [MEDIUM] Uppercase `HTTP://` scheme bypasses the Android HTTPS-Only upgrade (downgraded HIGH→MEDIUM by the second skeptic)
- **Location:** `MainActivity.kt:361-374` (and the `url.startsWith("http")` guards at `:140`, `:169`)
- **What's wrong:** `secureUrl()` upgrades with `if (uri.scheme == "http" ...)` — a case-SENSITIVE compare. `android.net.Uri` preserves scheme case, so `HTTP://evil/` has scheme `"HTTP"` != `"http"` and the upgrade is skipped. The `shouldOverrideUrlLoading` (`:169`) and `shouldInterceptRequest` (`:140`) guards are *also* case-sensitive `startsWith("http")`, so an uppercase-scheme **subresource bypasses both the malware-host block AND ad-block** there too. Desktop uses `url::Url` (lowercases the scheme) and is unaffected — an Android-only parity regression.
- **Impact:** HTTPS-Only is defeated via an uppercase scheme on untrusted-content link navigations; uppercase-scheme subresources skip malware + ad-block. **Adjusted to MEDIUM** because `usesCleartextTraffic="false"` + `targetSdk 36` makes the OS block cleartext HTTP in release builds (worst real outcome = a broken navigation, not an interception) — but the upgrade/guard logic is genuinely bypassed.
- **Fix:** Lowercase the scheme before comparing (`uri.scheme?.lowercase()`), rebuild via `buildUpon().scheme("https")` instead of `substring(7)`, and make the `startsWith("http")` guards case-insensitive.

#### [MEDIUM] `android:allowBackup` defaults to true — cookies/history/localStorage are `adb backup`-extractable
- **Location:** `AndroidManifest.xml:8-12`
- **What's wrong:** The `<application>` element never sets `android:allowBackup`, so it defaults to `true`. Android Auto Backup / `adb backup` then captures the WebView cookie store, localStorage/IndexedDB (`domStorageEnabled=true` on every tab), and the Tauri JSON stores (history, favorites, saved pages).
- **Impact:** Session cookies and browsing history of a privacy browser are eligible for cloud/local backup and `adb` extraction — a session-theft / history-leak path that contradicts the product's posture.
- **Fix:** Add `android:allowBackup="false"` (and/or `dataExtractionRules`/`fullBackupContent`) to `<application>`.

#### [MEDIUM] Malware guard: exact-host only + no subframe HTTPS upgrade on Android
- **Location:** `MainActivity.kt:135-181`
- **What's wrong:** `NativeSafety.isMalwareHost` is an exact host-set test (no subdomain match) — consistent with desktop but a weak matcher. And Android upgrades http→https only for main-frame navigations; `shouldInterceptRequest` (which *does* see subframes) runs the malware check but performs **no HTTPS upgrade**, so cleartext iframes aren't upgraded (desktop's `on_navigation` covers subframes).
- **Impact:** Cleartext subframes aren't upgraded on Android; subdomains of a known-malware host bypass the block (all platforms).
- **Fix:** Apply the http→https upgrade to subframe requests in `shouldInterceptRequest` (or document main-frame-only scope); add subdomain-suffix malware matching on Android and desktop.

#### [LOW] Content WebViews never explicitly enable SafeBrowsing or harden file/mixed-content settings
- **Location:** `MainActivity.kt:263-283`
- **What's wrong:** `createTabWebView()` (the untrusted-page WebViews) sets only JS / DOM-storage / UA / multi-window; it never calls `setSafeBrowsingEnabled(true)`, `mixedContentMode`, or explicitly disables `allowFileAccess*` / `allowUniversalAccessFromFileURLs` / `allowContentAccess`. These run on implicit platform defaults (targetSdk 36 mitigates today; minSdk 24 does not).
- **Impact:** SafeBrowsing / mixed-content / file-access posture depends on the running OS version rather than the app's policy — undercuts the malware-protection story.
- **Fix:** Explicitly harden the content tab WebViews (SafeBrowsing on, `MIXED_CONTENT_NEVER_ALLOW`, file/content access off); keep the chrome webview's asset access intact.

#### [LOW] `Bridge.openExternal` fires `ACTION_VIEW` for any scheme — no allowlist
- **Location:** `MainActivity.kt:534-543`
- **What's wrong:** `openExternal(url)` does `startActivity(Intent(ACTION_VIEW, Uri.parse(url)))` with no scheme check. Reachable only from the trusted chrome today (bridge isolation confirmed) and only used for the releases page, but an unvalidated `ACTION_VIEW` is a latent intent-redirection / arbitrary-app-launch sink (`intent:`, `content:`, `market:`, deep links) if any untrusted-influenced URL ever reaches it.
- **Fix:** Restrict to `https`/`http` (or the minimal needed set) before launching.

#### [INFO] (×2)
- `showMalwareWarning` correctly escapes the host for `< > &`, but the same field is later forwarded into `pushNavState` where escaping isn't its responsibility — note for clarity (`MainActivity.kt:378-397`).
- The **debug** build enables cleartext traffic + `debuggable` + JNI-debug (`build.gradle.kts:41-53`) — ensure debug APKs are never distributed; release config is correct.

---

## 3. Cross-platform parity

The bundled ad-block list set (`adblock_lists::ALL`), the core matching engine, and the malware host set are genuinely single-sourced and reach all platforms — that part of the parity mandate is well executed. The gaps below are where a capability exists, is weaker, or is silently inert on another platform. iOS is unstarted (needs macOS + Xcode) and has no implementation, so it is "—" throughout.

| Capability | Linux | Windows | macOS | Android | iOS |
|---|---|---|---|---|---|
| Network ad-block | WebKit content filters | WebView2 `WebResourceRequested` | none (JS-inject tier only) | `shouldInterceptRequest` (JNI) | — |
| Injected / cosmetic ad-block | n/a (filters suffice) | yes (JS tier) | yes (sole tier) | no (POPUP_GUARD not injected; reactive `onCreateWindow` only) | — |
| **Custom filters / subscriptions feed the engine** | **yes** | **NO** (silently inert) | **NO** | **NO** | — |
| **Ad-block toggle honored** | yes | yes (engine) | **NO** (inject tier ignores it) | yes | — |
| **Per-site allowlist honored** | partial (engine yes; filter tier no) | **NO** (network tier; empty source) | **NO** (inject tier) | **yes** | — |
| HTTPS-Only upgrade | yes (gated on setting) | yes | yes | **forces upgrade, ignores `httpsOnly` setting** | — |
| MalwareGuard (block) | yes (subframes too) | yes | yes | yes (subframe silent, main-frame warns) | — |
| MalwareGuard interstitial + "proceed" | yes | yes (chrome) | yes (chrome) | main-frame only; **no "proceed" path** | — |
| UA spoof (Chrome) | yes | yes | yes | yes | — |
| **WebRTC local-IP leak guard** | **NO** | **NO** | **NO** | **NO** | — |
| **Per-site permissions (prompt + remember)** | **yes** | **NO** (`resolve` no-op) | **NO** | **NO** | — |
| Auto-update | yes (minisign-verified) | yes (minisign-verified) | yes (minisign-verified) | **check never fires; no minisign verify; manual APK** | — |
| Multi-tab | yes (GtkFixed reparenting) | yes | yes | yes (native switcher) | — |
| Downloads | yes (no sanitize/dedup) | yes | yes | yes | — |
| Element picker | yes | **NO** (`ok:false`) | **NO** | **NO** | — |
| Shield blocked-count badge | yes | **NO** (reads 0) | **NO** | **NO** | — |
| Home button → configured URL | yes | yes | yes | **NO** (`about:blank`) | — |
| ErrorOverlay (nav failed/crashed) | **NO** (events never emitted) | **NO** | **NO** | **NO** (native page) | — |

Bolded cells are findings in this report. The largest concentration is on **Android** (custom filters/subs inert, HTTPS-Only setting ignored + uppercase-`HTTP://` bypass, permissions inert, auto-update non-functional + unverified, picker absent, Home broken, blocked-count absent, no "proceed" path, `allowBackup` defaults true, content WebViews don't explicitly enable SafeBrowsing) and on **macOS** (the inject tier is the sole ad-block tier yet ignores both the toggle and allowlist; custom filters/subs inert; permissions inert; picker absent). WebRTC leak protection is missing **everywhere** and is the single most security-relevant parity regression.

---

## 4. What's solid

- **The trust boundary itself.** The single `ipc()` chokepoint, the capability ACL that excludes the remote content webview (`local: true`, no `remote`), the `.`→`:` event-name translation (only one `.emit(` exists, inside `emit_event`), the `!Send` adblock `Engine` isolated on one thread with only `String`/`bool` crossing, and the rustls aws-lc-rs provider installed once up-front are all sound. No critical, web-content-reachable RCE or arbitrary-write was found. (rust-ipc-core, threat-model, config-build-ci)
- **The renderer has no DOM-XSS surface.** No `dangerouslySetInnerHTML`, no raw `innerHTML`, no unsanitized-string CSS sink; all page-derived strings (URLs, titles, hosts, tags) render as auto-escaped React text nodes; `primaryColor` flows only through CSSOM `setProperty`. Address parsing rejects `javascript:`/`data:`/`file:` before navigation, and all desktop + mobile nav funnels through `addressParse`. (react-core, react-components-desktop)
- **The IPC contract command side.** Every command channel in the `IPC` const is wired in all three places (`shared/types.ts`, the Rust dispatcher, `ipcClient.ts`); payload keys line up; the no-dots event rule is honored everywhere. The gaps are on the event side only. (ipc-contract)
- **Ad-block platform FFI is careful.** The unsafe WebKit2GTK FFI and WebView2 COM clone (ref-count) interface pointers into handler closures, free GError/filter refs on every path, and the injected JS escapes domains (charset-filtered) and cosmetic CSS (`serde_json::to_string`) correctly — no script-injection or memory-safety hole. The documented WebKit stale-cache race is genuinely fixed (deferred ready-marker), and the engine fails open on parse errors so ad-blocking never breaks a page. (rust-adblock-platform, rust-adblock-engine)
- **The pure tab state machine.** `tab_registry.rs` is cleanly separated from the Tauri layer with 24 unit tests; the idle-sweep exempts active/pinned tabs; the GtkFixed reparenting workaround for tauri#10420 is carefully reasoned; all GTK access goes through `with_webview`. The risks are state-divergence edges, not unsoundness. (rust-tabs)
- **The hooks layer's async discipline.** Mount effects use `active`/`cancelled` flags, the low-level `on()` handles the listen-resolves-after-unsubscribe race, callbacks needing live values use refs, dependency arrays are mostly correct. The residual issues are ordering races and absent error handling, not crashes on the normal path. (react-hooks)
- **The mobile shell's security parity (where wired).** The ad-block toggle + per-host allowlist, site-permission prompt UI, the allowlist/security/permission Settings tabs, and a more-restrictive native MalwareGuard all reuse the desktop hooks correctly; the bridge wiring (`window.AegisAndroid`, `__aegisMobileBack`, `__aegisOpenTab`, `useMobileTabSync`) is correct and idempotent. (react-mobile)
- **Config/build/CI baseline.** The chrome CSP is genuinely tight (`default-src 'self'`, `script-src 'self'`, `object-src 'none'`, no remote scripts), the capability set is minimal, no secrets are committed, build artifacts are gitignored, the npm-audit gate's unit tests are clean and the allowlist is empty (hides nothing). The desktop updater is signature-verified with a public (not secret) minisign key. The material risks are supply-chain coverage gaps, not the runtime boundary. (config-build-ci)
- **Modal/dialog accessibility and destructive-action gating.** A shared `useDialog` focus-trap (`role=dialog`, `aria-modal`, Escape-to-close, focus restore) is used consistently, and clear/replace-import actions are gated behind confirm dialogs — the SafetyInterstitial being the one exception, flagged at MEDIUM. (react-components-desktop)
- **The Android JS-bridge isolation.** `addJavascriptInterface("AegisAndroid")` is added *only* to the chrome webview (`MainActivity.kt:328`), which loads local bundled React assets under the strict CSP; the untrusted browsed pages live in separate `tabWebView`s with **no bridge**, so page content cannot reach the privileged bridge methods. The interpolated `evaluateJavascript` calls use `org.json.JSONObject`/`JSONObject.quote()` escaping (no script injection), and the `shouldInterceptRequest → JNI` ad-block path fails open by design. No exploitable bridge hole was found. (android-native)

---

## 5. Prioritized remediation plan

**Tier 1 — Quick wins (small, high-value, low-risk):**
1. Add a backend scheme allowlist in `nav::dispatch` for `nav.navigate` (and `tabs::open_background`), making the `useNav.ts` comment true. *(HIGH; `nav.rs:336-345`)*
2. Mount `useUpdate()` in `MobileApp` (or at minimum call `aegis.update.checkNow()` on mount) so Android update checks fire. *(HIGH; `MobileApp.tsx:55-72`)*
3. Add a "Go back to safety" primary button to SafetyInterstitial, wire it through `useDialog`, demote "Continue anyway." *(MEDIUM; `SafetyInterstitial.tsx:47-55`)*
4. Fix the npm-audit gate to fail on an `error`/missing-`vulnerabilities` report. *(MEDIUM; `auditCheck.mjs`)*
5. Add `cargo audit`/`cargo deny` + a `cargo` Dependabot ecosystem, and add `pull_request: {}` to `tauri-build-check.yml`. *(MEDIUM; CI/dependabot)*
6. Require `https://` for filter-list subscriptions, refuse non-https redirects, and add a response-size cap. *(MEDIUM ×2; `subs.rs:44-56, 203-216`)*
7. Include `shieldOpen` in the Android Back interceptor and close the shield in `__aegisMobileBack`. *(MEDIUM; `MobileApp.tsx:83-94`)*
8. Add download filename sanitization + collision de-duplication. *(MEDIUM + LOW; `downloads.rs:27-36`)*
9. Read the configured home URL on the Android `nav.home` branch instead of `about:blank`. *(MEDIUM; `ipcClient.ts:102-109`)*
10. Explicitly scope the capability with `"webviews": ["main"]`. *(LOW; `capabilities/default.json`)*
11. Set `android:allowBackup="false"` so cookies/history aren't `adb backup`-extractable. *(MEDIUM; `AndroidManifest.xml`)*
12. Lowercase the Android scheme checks (`secureUrl`, the `startsWith("http")` guards) so uppercase `HTTP://` can't bypass HTTPS-Only / malware / ad-block. *(MEDIUM; `MainActivity.kt:140,169,361-374`)*
13. Restrict `Bridge.openExternal` to `http(s)`; explicitly harden the Android content WebViews (SafeBrowsing on, `MIXED_CONTENT_NEVER_ALLOW`, file/content access off). *(LOW; `MainActivity.kt`)*

**Tier 2 — Durability and untrusted-input hardening:**
11. Make all JSON stores write atomically (temp + fsync + rename) via `jsonstore::save`, and stop silently treating a corrupt load as "empty" (keep a `.bak`). *(MEDIUM; `jsonstore.rs` + mirrors)*
12. Gate the Linux picker `on_picked` on a Rust-side "pick session active" flag and use the webview's real origin instead of the page-supplied host. *(MEDIUM; `linux_layout.rs:23-37`)*
13. Normalize and suffix-match malware hosts (strip trailing dot, block `*.host`) on desktop and the Android JNI; treat loopback via `IpAddr::is_loopback` in `is_local_host`. *(MEDIUM; `safety.rs:41-52`, `nav.rs:68-73`)*
14. Serialize `subs.json` (and write its cache) atomically behind a per-file lock; fix `on_finished` download correlation. *(MEDIUM; `subs.rs`, `downloads.rs:55-67`)*
15. Make `data.import` all-or-nothing with bundle validation + pre-import `.bak`, and either implement merge or remove the merge option. *(MEDIUM ×2; `data.rs:48-89`)*
16. Roll back / log on `spawn_tab` failure; do idle-sweep registry mutation + teardown on one main-thread closure; validate URLs before mutating the registry. *(MEDIUM + LOW; `tabs.rs`)*

**Tier 3 — Close the parity mandate (the deeper, cross-platform work):**
17. **Restore WebRTC IP-leak protection on all four platforms** (single-sourced like ad-block). *(HIGH; the most security-relevant gap)*
18. **Make the ad-block engine rebuildable** and feed it custom filters + subscriptions on every platform; mirror into `adblock_inject::build`; make the injected tier read live enabled+allowlist state. *(HIGH ×3; `adblock_engine.rs`, `adblock_inject.rs`)*
19. Thread the real top-frame source URL into the Windows WebView2 handler so the allowlist (and `$third-party`/type matching) applies. *(MEDIUM + LOW; `adblock_win.rs:66-78`)*
20. Implement per-site permission interception on WebView2 / WKWebView / Android `WebChromeClient`, bridged to the shared store. *(MEDIUM; `permissions.rs`)*
21. Honor the `httpsOnly` setting on Android; bridge a malware interstitial + "proceed" path to Android. *(MEDIUM + LOW; `MainActivity.kt`)*
22. Emit `nav.failed`/`nav.crashed` from the load-error/crash signals on every platform (wire the ErrorOverlay), and wire the blocked-count counters on Win/macOS/Android. *(MEDIUM + LOW; `nav.rs`, `adblock.rs`)*
23. Verify a minisign signature on the Android update manifest and establish a stable Android signing key; set the desktop signing secret and publish releases non-draft so the update channel actually works. *(MEDIUM + LOW; `update.rs`, `tauri-release.yml`, `tauri.conf.json`)*
24. Implement the element picker on the remaining platforms (or document Linux-only). *(LOW; `picker.rs`)*

**Tier 4 — Polish / robustness (low + info):**
25. Subscribe to `subs.changed` (and add it to the `IPC` const) or remove the dead emit; remove/wire the dead `picker.picked` emit. *(LOW + INFO)*
26. Add `.catch`/try-catch to hook IPC calls (centralize in `ipcClient`/`tauriInvoke`); fix the `useNav`/`useAdblock`/`useUpdate`/`useSafety`/`usePermissions` getState-vs-event ordering race; add the missing unmount guards in `useTabs`/`useHistory`/`useDownloads`; fix the stale `searchTemplate`. *(MEDIUM + LOW; `src/hooks`)*
27. Re-sync `FavoriteRow`/`MyFiltersTab` controlled inputs to props; hide the shield badge when blocking is inactive; special-case `localhost`/`host:port` in `addressParse`. *(LOW; `src/components`, `addressParse.ts`)*
28. Recover from mutex poisoning (`unwrap_or_else(|e| e.into_inner())` or `parking_lot`); use `try_state` consistently in `tabs.rs`; fix `host_of` IPv6 bracket parsing; debounce per-navigation session persistence; cap or document unbounded stores; tighten the Android version comparison and "proceed" exception scope. *(LOW; Rust)*
