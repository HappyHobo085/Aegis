//! Network ad-blocking via Brave's `adblock` matching engine. Used where the
//! webview can intercept subresource requests and answer synchronously — Android's
//! `WebViewClient.shouldInterceptRequest` (via the JNI export below). Desktop
//! Linux/macOS can't intercept WebKit requests, so they block declaratively with
//! WebKit content filters (`adblock_webkit.rs`); this is their Chromium-side
//! counterpart, reusing the same EasyList and engine the desktop converter parses.

use std::sync::mpsc::{channel, Sender};
use std::sync::OnceLock;

use adblock::lists::{FilterSet, ParseOptions};
use adblock::request::Request;
use adblock::Engine;

/// `adblock::Engine` is `!Send` (its `ResourceStorage` holds a `Box<dyn ...>`), and
/// the only public constructor wraps the network `Blocker` inside it — so the engine
/// can't be shared across the webview's network threads directly. Instead it lives on
/// one dedicated thread that owns it for the process lifetime; callers send a query
/// and block on the reply. Only `String`/`bool` cross threads, so this is `Send`-safe,
/// and there's exactly one engine (~one EasyList parse, ~20 MB) regardless of how many
/// threads `shouldInterceptRequest` runs on.
struct Query {
    url: String,
    source: String,
    rtype: String,
    reply: Sender<bool>,
}

static TX: OnceLock<Sender<Query>> = OnceLock::new();

fn tx() -> &'static Sender<Query> {
    TX.get_or_init(|| {
        let (tx, rx) = channel::<Query>();
        std::thread::spawn(move || {
            const EASYLIST: &str = include_str!("../resources/easylist.txt");
            let mut set = FilterSet::new(false); // false = matching engine (not convert)
            set.add_filters(EASYLIST.lines(), ParseOptions::default());
            let engine = Engine::from_filter_set(set, true);
            while let Ok(q) = rx.recv() {
                let blocked = match Request::new(&q.url, &q.source, &q.rtype) {
                    Ok(req) => engine.check_network_request(&req).matched,
                    Err(_) => false, // fail open: unparseable URL is allowed
                };
                let _ = q.reply.send(blocked);
            }
        });
        tx
    })
}

/// Whether a subresource request to `url`, made by the page at `source_url` (with a
/// best-effort `request_type` such as "script"/"image"/"document"), should be
/// blocked. Fails open on any error, so ad-blocking never breaks a page.
pub fn should_block(url: &str, source_url: &str, request_type: &str) -> bool {
    let (reply, answer) = channel();
    let q = Query {
        url: url.to_owned(),
        source: source_url.to_owned(),
        rtype: request_type.to_owned(),
        reply,
    };
    if tx().send(q).is_err() {
        return false;
    }
    answer.recv().unwrap_or(false)
}

/// JNI bridge for Android's `NativeAdblock.shouldBlock` (a Kotlin `object`, so the
/// symbol is `Java_<pkg>_NativeAdblock_shouldBlock` and the second arg is the
/// singleton instance, ignored). Called from the content WebView's
/// `shouldInterceptRequest`. Lives in `libapp_lib.so`, loaded at startup.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_aegis_browser_NativeAdblock_shouldBlock(
    mut env: jni::JNIEnv,
    _this: jni::objects::JObject,
    url: jni::objects::JString,
    source_url: jni::objects::JString,
    request_type: jni::objects::JString,
) -> jni::sys::jboolean {
    let url: String = env.get_string(&url).map(|s| s.into()).unwrap_or_default();
    let source: String = env
        .get_string(&source_url)
        .map(|s| s.into())
        .unwrap_or_default();
    let rtype: String = env
        .get_string(&request_type)
        .map(|s| s.into())
        .unwrap_or_default();
    should_block(&url, &source, &rtype) as jni::sys::jboolean
}

#[cfg(test)]
mod tests {
    use super::should_block;

    #[test]
    fn blocks_known_ad_domain_allows_normal_site() {
        // `||adnxs.com^` is an unconditional domain anchor in the vendored EasyList.
        assert!(
            should_block("https://adnxs.com/tag.js", "https://news.example.com", "script"),
            "a request to a known ad/tracker domain must be blocked"
        );
        // A normal first-party document must not be blocked.
        assert!(
            !should_block("https://example.com/", "https://example.com/", "document"),
            "a normal first-party page must not be blocked"
        );
        // A normal first-party asset must not be blocked.
        assert!(
            !should_block("https://example.com/styles.css", "https://example.com/", "stylesheet"),
            "a normal first-party asset must not be blocked"
        );
    }
}
