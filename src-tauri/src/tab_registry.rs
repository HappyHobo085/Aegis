//! Pure tab state machine. No Tauri types — fully unit-tested. The Tauri layer
//! (tabs.rs) applies the (ViewId, url) "spawn" / ViewId "close" decisions these
//! methods return to real child webviews.
use serde::{Deserialize, Serialize};

pub type ViewId = u32;

#[derive(Clone)]
struct Tab {
    id: ViewId,
    url: String,
    title: String,
    pinned: bool,
    live: bool,
    /// Monotonic ms reference point from which this tab's idle time is measured:
    /// the moment it last stopped being active, or — for a tab created in the
    /// background and never activated — its creation time. (Unused while the tab
    /// is active.) Drives the time-based idle sweep.
    last_active: u64,
}

#[derive(Clone)]
struct ClosedTab {
    url: String,
    title: String,
    position: usize,
    pinned: bool,
}

/// What the chrome renders: the ordered tab list + which is active.
#[derive(Clone, Serialize, PartialEq, Debug)]
pub struct TabMeta {
    pub id: ViewId,
    pub pinned: bool,
    pub live: bool,
}
#[derive(Clone, Serialize, PartialEq, Debug)]
pub struct TabsState {
    pub tabs: Vec<TabMeta>,
    #[serde(rename = "activeId")]
    pub active_id: ViewId,
}

/// Serialized session (tabs.json). Per-tab back/forward history is NOT persisted.
#[derive(Clone, Serialize, Deserialize, Default)]
pub struct PersistedTab {
    pub id: ViewId,
    pub url: String,
    pub title: String,
    pub pinned: bool,
}
#[derive(Clone, Serialize, Deserialize, Default)]
pub struct PersistedSession {
    pub tabs: Vec<PersistedTab>,
    #[serde(rename = "activeId")]
    pub active_id: ViewId,
    #[serde(rename = "nextId")]
    pub next_id: ViewId,
}

/// The result of closing a tab: which webview to destroy + which tab now needs one.
pub struct CloseOutcome {
    pub closed_live: bool,
    pub spawn: Option<(ViewId, String)>,
}

pub struct Registry {
    tabs: Vec<Tab>,
    active_id: ViewId,
    closed_stack: Vec<ClosedTab>,
    next_id: ViewId,
    home_url: String,
}

impl Registry {
    pub fn new(home_url: String) -> Self {
        Registry {
            tabs: vec![Tab {
                id: 1,
                url: home_url.clone(),
                title: String::new(),
                pinned: false,
                live: true,
                last_active: 0,
            }],
            active_id: 1,
            closed_stack: Vec::new(),
            next_id: 2,
            home_url,
        }
    }

    pub fn restore(session: PersistedSession, home_url: String) -> Self {
        if session.tabs.is_empty() {
            return Self::new(home_url);
        }
        let active_id = session.active_id;
        let max_id = session.tabs.iter().map(|t| t.id).max().unwrap_or(0);
        let tabs = session
            .tabs
            .into_iter()
            .map(|p| Tab {
                id: p.id,
                url: p.url,
                title: p.title,
                pinned: p.pinned,
                live: p.id == active_id, // only the active tab is eagerly live
                last_active: 0,
            })
            .collect();
        let mut r = Registry {
            tabs,
            active_id,
            closed_stack: Vec::new(),
            next_id: session.next_id.max(max_id + 1),
            home_url,
        };
        // Guard against a saved active_id that isn't present.
        if r.idx(active_id).is_none() {
            r.active_id = r.tabs[0].id;
            r.tabs[0].live = true;
        }
        r.resort_pinned();
        r
    }

    fn idx(&self, id: ViewId) -> Option<usize> {
        self.tabs.iter().position(|t| t.id == id)
    }

    /// Stable sort: pinned tabs first, relative order preserved within each group.
    fn resort_pinned(&mut self) {
        self.tabs.sort_by_key(|t| !t.pinned);
    }

    pub fn active_id(&self) -> ViewId {
        self.active_id
    }

    pub fn url_of(&self, id: ViewId) -> Option<&str> {
        self.idx(id).map(|i| self.tabs[i].url.as_str())
    }

    pub fn tabs_state(&self) -> TabsState {
        TabsState {
            tabs: self
                .tabs
                .iter()
                .map(|t| TabMeta { id: t.id, pinned: t.pinned, live: t.live })
                .collect(),
            active_id: self.active_id,
        }
    }

    pub fn to_persisted(&self) -> PersistedSession {
        PersistedSession {
            tabs: self
                .tabs
                .iter()
                .map(|t| PersistedTab {
                    id: t.id,
                    url: t.url.clone(),
                    title: t.title.clone(),
                    pinned: t.pinned,
                })
                .collect(),
            active_id: self.active_id,
            next_id: self.next_id,
        }
    }

    pub fn create(&mut self, url: Option<String>, background: bool, now_ms: u64) -> (ViewId, String) {
        let id = self.next_id;
        self.next_id += 1;
        let url = url.unwrap_or_else(|| self.home_url.clone());
        self.tabs.push(Tab {
            id, url: url.clone(), title: String::new(),
            pinned: false, live: true, last_active: now_ms,
        });
        if !background {
            if let Some(i) = self.idx(self.active_id) { self.tabs[i].last_active = now_ms; }
            self.active_id = id;
        }
        (id, url)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reg() -> Registry {
        Registry::new("https://home.test/".into())
    }

    #[test]
    fn new_has_one_active_home_tab() {
        let r = reg();
        let s = r.tabs_state();
        assert_eq!(s.tabs.len(), 1);
        assert_eq!(s.active_id, s.tabs[0].id);
        assert!(s.tabs[0].live);
        assert_eq!(r.url_of(s.active_id), Some("https://home.test/"));
    }

    #[test]
    fn persist_round_trips() {
        let mut r = reg();
        r.create(Some("https://a.test/".into()), false, 0);
        let p = r.to_persisted();
        let r2 = Registry::restore(p, "https://home.test/".into());
        let s = r2.tabs_state();
        assert_eq!(s.tabs.len(), 2);
        // Only the active tab is eagerly live after restore.
        assert!(s.tabs.iter().find(|t| t.id == s.active_id).unwrap().live);
        assert!(s.tabs.iter().filter(|t| t.id != s.active_id).all(|t| !t.live));
    }

    #[test]
    fn restore_empty_falls_back_to_one_home_tab() {
        let r = Registry::restore(PersistedSession::default(), "https://home.test/".into());
        assert_eq!(r.tabs_state().tabs.len(), 1);
    }

    #[test]
    fn create_foreground_changes_active() {
        let mut r = reg();                 // tab 1 active
        let (b, _) = r.create(Some("https://b.test/".into()), false, 1234);
        assert_eq!(r.active_id(), b);       // foreground create switches active
    }

    #[test]
    fn create_background_keeps_active() {
        let mut r = reg();                 // tab 1 active
        let before = r.active_id();
        let (b, _) = r.create(Some("https://b.test/".into()), true, 1234);
        assert_eq!(r.active_id(), before);  // background create does NOT switch active
        assert_ne!(b, before);
    }

    #[test]
    fn restore_with_unknown_active_id_falls_back_to_first_tab() {
        let session = PersistedSession {
            tabs: vec![
                PersistedTab { id: 5, url: "https://a.test/".into(), title: String::new(), pinned: false },
                PersistedTab { id: 6, url: "https://b.test/".into(), title: String::new(), pinned: false },
            ],
            active_id: 999, // not present
            next_id: 7,
        };
        let r = Registry::restore(session, "https://home.test/".into());
        let s = r.tabs_state();
        assert_eq!(s.active_id, s.tabs[0].id);                 // fell back to first tab
        assert!(s.tabs.iter().find(|t| t.id == s.active_id).unwrap().live);
    }

    #[test]
    fn url_of_unknown_id_is_none() {
        let r = reg();
        assert_eq!(r.url_of(999), None);
    }
}
