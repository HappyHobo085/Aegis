//! Convert adblock filter-list syntax (EasyList etc.) into WebKit/Safari
//! content-blocker JSON, for the WebKit ad-block tier (Linux/macOS/iOS). Uses the
//! `adblock` crate's built-in `content_blocking` converter (Brave's engine), so we
//! ship one filter-list source and target both the Chromium engine and WebKit.
#![allow(dead_code)]
use adblock::lists::{FilterSet, ParseOptions};

/// Parse filter-list text (one rule per line, across all `filter_lists`) and return
/// WebKit content-blocker JSON (the array WebKit's `UserContentFilterStore` expects)
/// plus the count of converted rules. Rules the content-blocker format can't express
/// (e.g. `$redirect`, full-regex) are dropped by the converter.
pub fn to_content_blocker_json(filter_lists: &[&str]) -> Result<(String, usize), String> {
    // `into_content_blocking` requires debug mode (it reads each rule's raw text).
    let mut set = FilterSet::new(true);
    for list in filter_lists {
        set.add_filters(list.lines(), ParseOptions::default());
    }
    let (cb_rules, _used) = set
        .into_content_blocking()
        .map_err(|_| "into_content_blocking failed".to_string())?;
    let count = cb_rules.len();
    let json = serde_json::to_string(&cb_rules).map_err(|e| e.to_string())?;
    Ok((json, count))
}

#[cfg(test)]
mod tests {
    use super::to_content_blocker_json;

    #[test]
    fn converts_a_network_rule_to_a_block_action() {
        let (json, count) = to_content_blocker_json(&["||ads.example.com^"]).unwrap();
        assert!(count >= 1, "expected at least one rule, got {count}");
        assert!(json.contains("ads.example.com") || json.contains("ads\\\\.example"), "json: {json}");
        assert!(json.contains("\"block\""), "expected a block action: {json}");
    }

    #[test]
    fn empty_input_yields_empty_array() {
        let (json, count) = to_content_blocker_json(&[""]).unwrap();
        assert_eq!(count, 0);
        assert_eq!(json, "[]");
    }
}
