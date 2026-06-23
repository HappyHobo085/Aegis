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
    /// Per-tab navigation history: list of visited URLs.
    history: Vec<String>,
    /// Index into `history` of the currently-displayed page.
    hist_index: usize,
    /// Private (incognito) tab: its content webview uses an ephemeral data partition
    /// and its browsing is excluded from history/sync/downloads + the persisted session.
    private: bool,
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
    pub title: String,
    pub url: String,
    pub private: bool,
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
                history: vec![home_url.clone()],
                hist_index: 0,
                private: false,
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
                history: vec![p.url.clone()],
                hist_index: 0,
                id: p.id,
                url: p.url,
                title: p.title,
                pinned: p.pinned,
                live: p.id == active_id, // only the active tab is eagerly live
                last_active: 0,
                private: false, // restored tabs are never private
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
                .map(|t| TabMeta {
                    id: t.id,
                    pinned: t.pinned,
                    live: t.live,
                    title: t.title.clone(),
                    url: t.url.clone(),
                    private: t.private,
                })
                .collect(),
            active_id: self.active_id,
        }
    }

    pub fn set_title(&mut self, id: ViewId, title: String) {
        if let Some(i) = self.idx(id) {
            self.tabs[i].title = title;
        }
    }

    pub fn to_persisted(&self) -> PersistedSession {
        PersistedSession {
            tabs: self
                .tabs
                .iter()
                .filter(|t| !t.private) // never persist a private tab
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

    pub fn create(
        &mut self,
        url: Option<String>,
        background: bool,
        now_ms: u64,
    ) -> (ViewId, String) {
        self.create_private(url, background, now_ms, false)
    }

    pub fn create_private(
        &mut self,
        url: Option<String>,
        background: bool,
        now_ms: u64,
        private: bool,
    ) -> (ViewId, String) {
        let id = self.next_id;
        self.next_id += 1;
        let url = url.unwrap_or_else(|| self.home_url.clone());
        self.tabs.push(Tab {
            id,
            url: url.clone(),
            title: String::new(),
            pinned: false,
            live: true,
            last_active: now_ms,
            history: vec![url.clone()],
            hist_index: 0,
            private,
        });
        if !background {
            if let Some(i) = self.idx(self.active_id) {
                self.tabs[i].last_active = now_ms;
            }
            self.active_id = id;
        }
        (id, url)
    }

    pub fn is_private(&self, id: ViewId) -> Option<bool> {
        self.idx(id).map(|i| self.tabs[i].private)
    }

    /// Make `id` active. Returns Some(url) if its webview must be (re)spawned.
    pub fn activate(&mut self, id: ViewId, now_ms: u64) -> Option<String> {
        if id == self.active_id || self.idx(id).is_none() {
            return None;
        }
        if let Some(i) = self.idx(self.active_id) {
            self.tabs[i].last_active = now_ms;
        }
        self.active_id = id;
        let i = self.idx(id).unwrap();
        if self.tabs[i].live {
            None
        } else {
            self.tabs[i].live = true;
            Some(self.tabs[i].url.clone())
        }
    }

    /// Close `id`. Pushes it onto the reopen stack and activates a neighbor.
    pub fn close(&mut self, id: ViewId, now_ms: u64) -> CloseOutcome {
        let Some(i) = self.idx(id) else {
            return CloseOutcome {
                closed_live: false,
                spawn: None,
            };
        };
        let t = self.tabs.remove(i);
        // Private tabs are never recoverable — don't record them in the reopen stack.
        if !t.private {
            self.closed_stack.push(ClosedTab {
                url: t.url.clone(),
                title: t.title.clone(),
                position: i,
                pinned: t.pinned,
            });
        }
        if self.tabs.is_empty() {
            let (nid, nurl) = self.create(None, false, now_ms);
            return CloseOutcome {
                closed_live: t.live,
                spawn: Some((nid, nurl)),
            };
        }
        if id == self.active_id {
            let ni = i.min(self.tabs.len() - 1);
            self.active_id = self.tabs[ni].id;
            // No last_active update here: the active tab is exempt from the idle
            // sweep, and a tab's last_active is (re)stamped when it STOPS being
            // active (activate/create/reopen), so the neighbor's idle clock is
            // already correct by the time it could ever be swept.
            if !self.tabs[ni].live {
                self.tabs[ni].live = true;
                let url = self.tabs[ni].url.clone();
                return CloseOutcome {
                    closed_live: t.live,
                    spawn: Some((self.active_id, url)),
                };
            }
        }
        CloseOutcome {
            closed_live: t.live,
            spawn: None,
        }
    }

    pub fn set_pinned(&mut self, id: ViewId, pinned: bool) {
        if let Some(i) = self.idx(id) {
            self.tabs[i].pinned = pinned;
        }
        self.resort_pinned();
    }

    /// Reorder to match `ids` (any omitted ids keep their order at the end), then
    /// re-assert the pinned-first invariant.
    pub fn reorder(&mut self, ids: &[ViewId]) {
        let mut next: Vec<Tab> = Vec::with_capacity(self.tabs.len());
        for id in ids {
            if let Some(pos) = self.tabs.iter().position(|t| t.id == *id) {
                next.push(self.tabs.remove(pos));
            }
        }
        next.append(&mut self.tabs);
        self.tabs = next;
        self.resort_pinned();
    }

    /// Record a navigation. A duplicate of the current entry (a reload, or the event
    /// produced by go_back/go_forward) is ignored. A new URL truncates the forward stack.
    pub fn record_nav(&mut self, id: ViewId, url: &str) {
        if let Some(i) = self.idx(id) {
            let t = &mut self.tabs[i];
            if t.history.get(t.hist_index).map(String::as_str) == Some(url) {
                return;
            }
            t.history.truncate(t.hist_index + 1);
            t.history.push(url.to_string());
            t.hist_index = t.history.len() - 1;
            t.url = url.to_string();
        }
    }

    pub fn can_go_back(&self, id: ViewId) -> bool {
        self.idx(id)
            .map(|i| self.tabs[i].hist_index > 0)
            .unwrap_or(false)
    }

    pub fn can_go_forward(&self, id: ViewId) -> bool {
        self.idx(id)
            .map(|i| {
                let t = &self.tabs[i];
                t.hist_index + 1 < t.history.len()
            })
            .unwrap_or(false)
    }

    /// Move back one entry; returns the URL to navigate to (None if already at the start).
    pub fn go_back(&mut self, id: ViewId) -> Option<String> {
        let i = self.idx(id)?;
        let t = &mut self.tabs[i];
        if t.hist_index == 0 {
            return None;
        }
        t.hist_index -= 1;
        t.url = t.history[t.hist_index].clone();
        Some(t.url.clone())
    }

    /// Move forward one entry; returns the URL to navigate to (None if already at the end).
    pub fn go_forward(&mut self, id: ViewId) -> Option<String> {
        let i = self.idx(id)?;
        let t = &mut self.tabs[i];
        if t.hist_index + 1 >= t.history.len() {
            return None;
        }
        t.hist_index += 1;
        t.url = t.history[t.hist_index].clone();
        Some(t.url.clone())
    }

    /// Discard live, non-active, non-pinned, non-private tabs idle for >= timeout_ms.
    /// `timeout_ms == 0` disables. Returns ids whose webviews the caller must close().
    /// Private tabs are never discarded: their ephemeral session data is gone once the
    /// webview closes, and re-creating a new ephemeral partition on reload would leak
    /// that a private tab exists and expose a blank fresh context instead of the
    /// expected page — contrary to user expectations.
    pub fn sweep_idle(&mut self, now_ms: u64, timeout_ms: u64) -> Vec<ViewId> {
        if timeout_ms == 0 {
            return Vec::new();
        }
        let active = self.active_id;
        let mut victims = Vec::new();
        for t in self.tabs.iter_mut() {
            if t.live
                && t.id != active
                && !t.pinned
                && !t.private
                && now_ms.saturating_sub(t.last_active) >= timeout_ms
            {
                t.live = false;
                victims.push(t.id);
            }
        }
        victims
    }

    /// Reopen the most-recently-closed tab (Ctrl+Shift+T). Returns its (id, url).
    pub fn reopen_closed(&mut self, now_ms: u64) -> Option<(ViewId, String)> {
        let c = self.closed_stack.pop()?;
        let id = self.next_id;
        self.next_id += 1;
        let pos = c.position.min(self.tabs.len());
        self.tabs.insert(
            pos,
            Tab {
                id,
                url: c.url.clone(),
                title: c.title,
                pinned: c.pinned,
                live: true,
                last_active: now_ms,
                history: vec![c.url.clone()],
                hist_index: 0,
                private: false, // reopened tabs are never private
            },
        );
        if let Some(i) = self.idx(self.active_id) {
            self.tabs[i].last_active = now_ms;
        }
        self.active_id = id;
        self.resort_pinned();
        Some((id, c.url))
    }
}

#[cfg(test)]
impl Registry {
    fn discard_for_test(&mut self, id: ViewId) {
        let i = self.idx(id).unwrap();
        self.tabs[i].live = false;
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
        assert!(s
            .tabs
            .iter()
            .filter(|t| t.id != s.active_id)
            .all(|t| !t.live));
    }

    #[test]
    fn restore_empty_falls_back_to_one_home_tab() {
        let r = Registry::restore(PersistedSession::default(), "https://home.test/".into());
        assert_eq!(r.tabs_state().tabs.len(), 1);
    }

    #[test]
    fn create_foreground_changes_active() {
        let mut r = reg(); // tab 1 active
        let (b, _) = r.create(Some("https://b.test/".into()), false, 1234);
        assert_eq!(r.active_id(), b); // foreground create switches active
    }

    #[test]
    fn create_background_keeps_active() {
        let mut r = reg(); // tab 1 active
        let before = r.active_id();
        let (b, _) = r.create(Some("https://b.test/".into()), true, 1234);
        assert_eq!(r.active_id(), before); // background create does NOT switch active
        assert_ne!(b, before);
    }

    #[test]
    fn restore_with_unknown_active_id_falls_back_to_first_tab() {
        let session = PersistedSession {
            tabs: vec![
                PersistedTab {
                    id: 5,
                    url: "https://a.test/".into(),
                    title: String::new(),
                    pinned: false,
                },
                PersistedTab {
                    id: 6,
                    url: "https://b.test/".into(),
                    title: String::new(),
                    pinned: false,
                },
            ],
            active_id: 999, // not present
            next_id: 7,
        };
        let r = Registry::restore(session, "https://home.test/".into());
        let s = r.tabs_state();
        assert_eq!(s.active_id, s.tabs[0].id); // fell back to first tab
        assert!(s.tabs.iter().find(|t| t.id == s.active_id).unwrap().live);
    }

    #[test]
    fn url_of_unknown_id_is_none() {
        let r = reg();
        assert_eq!(r.url_of(999), None);
    }

    #[test]
    fn activate_live_tab_needs_no_spawn() {
        let mut r = reg();
        let (b, _) = r.create(Some("https://b.test/".into()), false, 0); // active=b
        assert_eq!(r.activate(1, 10), None); // tab 1 still live
        assert_eq!(r.active_id(), 1);
        let _ = b;
    }

    #[test]
    fn activating_discarded_tab_returns_its_url_to_spawn() {
        let mut r = reg(); // tab 1 active
        let (b, _) = r.create(Some("https://b.test/".into()), false, 0); // b active
        r.activate(1, 5); // back to tab 1; b is now a background tab
        r.discard_for_test(b); // discard the background tab b
        let url = r.activate(b, 20); // re-activate discarded b -> must respawn
        assert_eq!(url.as_deref(), Some("https://b.test/"));
        assert_eq!(r.active_id(), b);
    }

    #[test]
    fn closing_active_activates_a_neighbor() {
        let mut r = reg(); // tab 1
        let (b, _) = r.create(None, false, 0); // tab 2 (active)
        let out = r.close(b, 0);
        assert!(out.closed_live);
        assert!(out.spawn.is_none()); // neighbor (tab 1) was already live
        assert_eq!(r.active_id(), 1);
        assert_eq!(r.tabs_state().tabs.len(), 1);
    }

    #[test]
    fn closing_the_last_tab_creates_a_fresh_home_tab() {
        let mut r = reg();
        let out = r.close(1, 0);
        let s = r.tabs_state();
        assert_eq!(s.tabs.len(), 1);
        assert!(out.spawn.is_some()); // the replacement home tab must be spawned
        assert_eq!(out.spawn.unwrap().0, s.active_id);
    }

    #[test]
    fn reopen_restores_the_last_closed_tab_as_active() {
        let mut r = reg();
        let (b, _) = r.create(Some("https://b.test/".into()), false, 0);
        r.close(b, 0);
        let (id, url) = r.reopen_closed(0).unwrap();
        assert_eq!(url, "https://b.test/");
        assert_eq!(r.active_id(), id);
    }

    #[test]
    fn closing_a_background_tab_keeps_active_and_needs_no_spawn() {
        let mut r = reg(); // tab 1 active
        let (b, _) = r.create(None, false, 0); // b active
        r.activate(1, 5); // tab 1 active; b is now a live background tab
        let out = r.close(b, 10);
        assert_eq!(r.active_id(), 1); // active unchanged by closing a background tab
        assert!(out.spawn.is_none());
        assert!(out.closed_live); // b had a live webview to destroy
        assert_eq!(r.tabs_state().tabs.len(), 1);
    }

    #[test]
    fn activating_the_current_tab_is_a_noop() {
        let mut r = reg(); // tab 1 active
        assert_eq!(r.activate(1, 5), None);
        assert_eq!(r.active_id(), 1);
    }

    #[test]
    fn reopen_on_empty_stack_returns_none() {
        let mut r = reg();
        assert!(r.reopen_closed(0).is_none());
    }

    #[test]
    fn closing_active_respawns_a_discarded_neighbor() {
        let mut r = reg(); // tab 1
        let (b, _) = r.create(None, false, 0); // b active; tab 1 is a background tab
        r.discard_for_test(1); // discard the neighbor (tab 1)
        let out = r.close(b, 10); // close active b -> neighbor 1 must respawn
        assert_eq!(r.active_id(), 1);
        let (sid, _surl) = out.spawn.expect("discarded neighbor must be respawned");
        assert_eq!(sid, 1);
    }

    #[test]
    fn pinning_moves_the_tab_to_the_front() {
        let mut r = reg(); // tab 1
        let (b, _) = r.create(None, false, 0); // tab 2
        r.set_pinned(b, true);
        assert_eq!(r.tabs_state().tabs[0].id, b);
        assert!(r.tabs_state().tabs[0].pinned);
    }

    #[test]
    fn reorder_respects_given_order_but_keeps_pinned_first() {
        let mut r = reg(); // 1
        let (b, _) = r.create(None, false, 0); // 2
        let (c, _) = r.create(None, false, 0); // 3
        r.set_pinned(c, true); // c pinned -> front
        r.reorder(&[b, 1, c]); // request b,1,c; c stays pinned-first
        let ids: Vec<ViewId> = r.tabs_state().tabs.iter().map(|t| t.id).collect();
        assert_eq!(ids, vec![c, b, 1]);
    }

    #[test]
    fn sweep_discards_idle_background_tabs_only() {
        let mut r = reg(); // tab 1
        let (b, _) = r.create(None, false, 0); // tab 2 active, 1 backgrounded@0
                                               // now = 60_000 ms, timeout = 30_000 ms -> tab 1 (idle 60s) is discarded.
        let victims = r.sweep_idle(60_000, 30_000);
        assert_eq!(victims, vec![1]);
        assert!(!r.tabs_state().tabs.iter().find(|t| t.id == 1).unwrap().live);
        assert!(r.tabs_state().tabs.iter().find(|t| t.id == b).unwrap().live); // active exempt
    }

    #[test]
    fn sweep_exempts_active_and_pinned() {
        let mut r = reg(); // tab 1 active
        let (_b, _) = r.create(None, false, 0); // tab 2 active, 1 backgrounded@0
        r.set_pinned(1, true); // 1 pinned -> exempt
        let victims = r.sweep_idle(999_999, 1);
        assert!(victims.is_empty()); // active(b) + pinned(1) both exempt
    }

    #[test]
    fn sweep_timeout_zero_disables() {
        let mut r = reg();
        let _ = r.create(None, false, 0);
        assert!(r.sweep_idle(u64::MAX, 0).is_empty());
    }

    #[test]
    fn sweep_exempts_private_tabs() {
        let mut r = reg(); // tab 1 (normal, active)
        let (p, _) = r.create_private(None, true, 0, true); // tab 2 private, backgrounded@0
        let (_n, _) = r.create_private(None, false, 0, false); // tab 3 normal, now active
                                                               // long-idle sweep: the normal background tab 1 is a victim; the private tab p is NOT.
        let victims = r.sweep_idle(999_999, 1);
        assert!(victims.contains(&1));
        assert!(
            !victims.contains(&p),
            "a private tab must never be discarded"
        );
    }

    #[test]
    fn sweep_keeps_recently_active_tabs() {
        let mut r = reg(); // tab 1
        let (_b, _) = r.create(None, false, 50_000); // tab 1 backgrounded@50s
        let victims = r.sweep_idle(60_000, 30_000); // idle only 10s < 30s
        assert!(victims.is_empty());
    }

    #[test]
    fn nav_history_tracks_back_forward() {
        let mut r = reg(); // tab 1 @ home: history=[home], index 0
        r.record_nav(1, "https://a.test/");
        r.record_nav(1, "https://b.test/");
        assert!(r.can_go_back(1));
        assert!(!r.can_go_forward(1));
        assert_eq!(r.go_back(1), Some("https://a.test/".to_string()));
        assert_eq!(r.url_of(1), Some("https://a.test/"));
        assert!(r.can_go_back(1)); // still can go back to home
        assert!(r.can_go_forward(1)); // can go forward to b
                                      // the navigation event caused by going back is a no-op (dedup), keeps forward
        r.record_nav(1, "https://a.test/");
        assert!(r.can_go_forward(1));
        assert_eq!(r.go_forward(1), Some("https://b.test/".to_string()));
        // a genuinely new navigation truncates the forward stack
        r.record_nav(1, "https://c.test/");
        assert!(!r.can_go_forward(1));
    }

    #[test]
    fn go_back_forward_at_ends_return_none() {
        let mut r = reg();
        assert_eq!(r.go_back(1), None); // at home, nothing behind
        assert_eq!(r.go_forward(1), None); // nothing ahead
    }

    #[test]
    fn tabs_state_carries_title_and_url() {
        let mut r = reg(); // tab 1 @ home
        r.record_nav(1, "https://a.test/");
        r.set_title(1, "Alpha".into());
        let meta = &r.tabs_state().tabs[0];
        assert_eq!(meta.url, "https://a.test/");
        assert_eq!(meta.title, "Alpha");
    }

    #[test]
    fn create_private_tab_is_marked_private() {
        let mut r = reg();
        let (id, _) = r.create_private(Some("https://x.test/".into()), false, 0, true);
        let meta = r
            .tabs_state()
            .tabs
            .iter()
            .find(|t| t.id == id)
            .cloned()
            .unwrap();
        assert!(meta.private, "a private tab must report private=true");
        // a normal tab stays non-private
        let (n, _) = r.create_private(None, true, 0, false);
        assert!(
            !r.tabs_state()
                .tabs
                .iter()
                .find(|t| t.id == n)
                .unwrap()
                .private
        );
    }

    #[test]
    fn private_tabs_are_excluded_from_persisted_session() {
        let mut r = reg(); // tab 1: normal
        r.create_private(Some("https://normal.test/".into()), true, 0, false); // tab 2: normal
        let (p, _) = r.create_private(Some("https://secret.test/".into()), true, 0, true); // tab 3: private
        let session = r.to_persisted();
        assert!(
            session.tabs.iter().all(|t| t.id != p),
            "the private tab must not be persisted"
        );
        assert_eq!(session.tabs.len(), 2, "only the two normal tabs persist");
        // next_id is still advanced past the private tab so a restore can't collide.
        assert!(session.next_id > p);
        // Defense: restoring a session that doesn't contain the private tab's active_id
        // falls back gracefully (no panic).
        let r2 = Registry::restore(session, "https://home.test/".into());
        let s2 = r2.tabs_state();
        assert!(
            s2.tabs.iter().all(|t| t.id != p),
            "restored session must not contain the private tab"
        );
    }

    #[test]
    fn is_private_reads_the_flag() {
        let mut r = reg();
        let (p, _) = r.create_private(None, true, 0, true);
        assert_eq!(r.is_private(p), Some(true));
        assert_eq!(r.is_private(1), Some(false));
        assert_eq!(r.is_private(9999), None);
    }

    #[test]
    fn restored_tabs_are_never_private() {
        // Defense in depth: even a (hypothetically) malformed session can't resurrect a private tab.
        let session = PersistedSession {
            tabs: vec![PersistedTab {
                id: 5,
                url: "https://a.test/".into(),
                title: String::new(),
                pinned: false,
            }],
            active_id: 5,
            next_id: 6,
        };
        let r = Registry::restore(session, "https://home.test/".into());
        assert!(r.tabs_state().tabs.iter().all(|t| !t.private));
    }

    #[test]
    fn closing_a_private_tab_does_not_push_to_reopen_stack() {
        let mut r = reg(); // tab 1: normal (active)
                           // Create a private tab in the background so tab 1 stays active.
        let (p, _) = r.create_private(Some("https://secret.test/".into()), true, 0, true);
        // Close the private tab.
        r.close(p, 0);
        // The closed_stack must be empty — the private tab's URL must not be recoverable.
        assert!(
            r.reopen_closed(0).is_none(),
            "closing a private tab must NOT push it to the reopen stack"
        );
        // Regression: a normal tab closed afterward IS still reopenable.
        let (b, _) = r.create(Some("https://b.test/".into()), false, 0);
        r.close(b, 0);
        let result = r.reopen_closed(0);
        assert!(
            result.is_some(),
            "a normal closed tab must still be reopenable after a private close"
        );
        assert_eq!(result.unwrap().1, "https://b.test/");
    }

    #[test]
    fn active_private_tab_restore_falls_back_to_valid_active_id() {
        let mut r = reg(); // tab 1: normal
        r.create_private(Some("https://normal.test/".into()), true, 0, false); // tab 2: normal
        let (p, _) = r.create_private(Some("https://secret.test/".into()), false, 0, true); // tab 3: private, now ACTIVE
        assert_eq!(
            r.active_id(),
            p,
            "private tab must be active before persisting"
        );
        // Persist — private tab is excluded from the tab list but active_id still points to p.
        let session = r.to_persisted();
        assert!(
            session.tabs.iter().all(|t| t.id != p),
            "private tab must be absent from the persisted tab list"
        );
        // Restore — active_id (p) is NOT in the persisted tab list.
        // Registry::restore must NOT panic and must fall back to a valid, non-private tab.
        let r2 = Registry::restore(session, "https://home.test/".into());
        let s2 = r2.tabs_state();
        assert!(
            s2.tabs.iter().all(|t| t.id != p),
            "restored session must not contain the private tab"
        );
        assert_ne!(
            s2.active_id, p,
            "active_id after restore must not point to the dropped private tab"
        );
        // The fallback active must actually be present in the tab list.
        assert!(
            s2.tabs.iter().any(|t| t.id == s2.active_id),
            "the fallback active_id must exist in the restored tab list"
        );
    }
}
