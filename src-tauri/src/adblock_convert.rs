//! Convert adblock filter-list syntax (EasyList etc.) into WebKit/Safari
//! content-blocker JSON, for the WebKit ad-block tier (Linux/macOS/iOS). Uses the
//! `adblock` crate's built-in `content_blocking` converter (Brave's engine), so we
//! ship one filter-list source and target both the Chromium engine and WebKit.
//! The converted rules include cosmetic `css-display-none` actions, so a single
//! content filter handles network blocking AND element hiding.
#![allow(dead_code)]
use adblock::lists::{FilterSet, ParseOptions};

/// Convert filter-list text into WebKit content-blocker JSON, split into chunks of
/// at most `max_per_chunk` rules each (WebKit caps a single filter near ~50k rules;
/// each chunk is loaded as its own content filter). Returns one JSON array string
/// per chunk. Rules the content-blocker format can't express are dropped.
pub fn to_content_blocker_chunks(
    filter_lists: &[&str],
    max_per_chunk: usize,
) -> Result<Vec<String>, String> {
    // `into_content_blocking` requires debug mode (it reads each rule's raw text).
    let mut set = FilterSet::new(true);
    for list in filter_lists {
        set.add_filters(list.lines(), ParseOptions::default());
    }
    let (rules, _used) = set
        .into_content_blocking()
        .map_err(|_| "into_content_blocking failed".to_string())?;
    let mut chunks = Vec::new();
    for chunk in rules.chunks(max_per_chunk.max(1)) {
        chunks.push(serde_json::to_string(chunk).map_err(|e| e.to_string())?);
    }
    Ok(chunks)
}

#[cfg(test)]
mod tests {
    use super::to_content_blocker_chunks;

    /// Convert one filter list and return the first (single) chunk's JSON, or `"[]"`.
    fn convert_one(list: &str) -> String {
        to_content_blocker_chunks(&[list], usize::MAX)
            .unwrap()
            .into_iter()
            .next()
            .unwrap_or_else(|| "[]".to_string())
    }

    #[test]
    fn converts_a_network_rule_to_a_block_action() {
        let json = convert_one("||ads.example.com^");
        assert_ne!(json, "[]", "expected at least one rule");
        assert!(
            json.contains("ads.example.com") || json.contains("ads\\\\.example"),
            "json: {json}"
        );
        assert!(
            json.contains("\"block\""),
            "expected a block action: {json}"
        );
    }

    #[test]
    fn empty_input_yields_empty_array() {
        assert_eq!(convert_one(""), "[]");
    }

    #[test]
    fn bundled_lists_convert_and_cover_trackers() {
        // The Linux tier blocks page subresources via these converted content filters
        // (NOT the engine), so prove EasyPrivacy's tracker rules survive conversion to
        // WebKit JSON — a tracker EasyList alone would miss must appear in the output.
        let chunks = to_content_blocker_chunks(&crate::adblock_lists::ALL, 25_000).unwrap();
        assert!(
            !chunks.is_empty(),
            "bundled lists must convert to at least one chunk"
        );
        let all: String = chunks.concat();
        assert!(all.contains("doubleclick"), "EasyList ad rule must convert");
        assert!(
            all.contains("google-analytics"),
            "EasyPrivacy tracker rule must convert (Linux content-filter coverage)"
        );
    }

    #[test]
    fn chunks_respect_the_max_size() {
        let rules = (0..50)
            .map(|i| format!("||ads{i}.example.com^"))
            .collect::<Vec<_>>()
            .join("\n");
        let chunks = to_content_blocker_chunks(&[&rules], 10).unwrap();
        assert!(
            chunks.len() >= 5,
            "expected several chunks, got {}",
            chunks.len()
        );
        // each chunk is a valid JSON array
        for c in &chunks {
            assert!(c.starts_with('[') && c.ends_with(']'));
        }
    }
}
