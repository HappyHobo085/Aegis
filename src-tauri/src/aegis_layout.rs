//! Pure geometry for the Linux webview container (`aegis_container.rs`).
//!
//! Deliberately free of GTK and Tauri, so every rule below is unit-testable in a headless
//! `cargo test --lib` run — which the container itself is not, because instantiating a
//! `GtkFixed` subclass needs a display. The split mirrors `tab_registry.rs`: the state
//! machine is pure and fully tested, and the thin platform layer on top of it is not.
//!
//! The rules exist because `GtkFixed` allocates every child to that child's size
//! **request**, and a `WebKitWebView`'s request is GTK's default 1x1. Every layout pass
//! therefore collapsed both webviews to 1x1 and re-expanded them, which re-laid-out the
//! chrome, which re-measured the omnibox, which changed the content inset again — a
//! measured ~57 Hz feedback loop for as long as the omnibox dropdown was open. The
//! container allocates children their *registered* rect instead, so no collapse exists and
//! there is nothing to compensate for.

/// Where a webview that must stay *visible* but out of the way is parked.
///
/// It cannot be `set_visible(false)`: on this stack that backgrounds the page (rAF stalls,
/// which malvertising weaponises to fire a redirect) and does not even reliably hide it —
/// the WebKit native window stays stacked on top. Visible and offscreen avoids both.
pub const PARK_X: i32 = -10000;
pub const PARK_Y: i32 = -10000;

/// No realistic window is 8k wide, so this is a generous ceiling on how large a parked child
/// can be while its far edge still stays negative. Checked at compile time because it involves
/// no run-time value at all — a runtime `assert!` over constants is a warning under clippy, and
/// rightly so.
const _: () = assert!(
    PARK_X + 8192 < 0 && PARK_Y + 8192 < 0,
    "a park coordinate of -10000 does not clear an 8k window; the parked webview's far edge \
     would still be on screen and it would paint over the chrome"
);

/// A rectangle in container-local logical pixels.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl Rect {
    pub fn new(x: i32, y: i32, w: i32, h: i32) -> Self {
        Self { x, y, w, h }
    }
}

/// What a container child is, which decides how it is sized.
///
/// This is the whole policy. `layout()` classifies each child once and the container asks
/// for its rect; nothing else in the crate has to know how a webview is sized.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    /// The chrome webview. Fills the whole window, behind everything — the content
    /// webviews are inset so the toolbar shows in the gap above them.
    Chrome,
    /// A content (tab) webview. `shown` is whether it should be on screen at the inset,
    /// or parked offscreen but still visible.
    Content { shown: bool },
    /// Sized by GTK, never by us. The fullscreen-exit button keeps its natural size; this
    /// exists so it is not collapsed to 1x1 like everything else.
    Passthrough,
    /// The popover surface: one webview at a rect the chrome measured, overlaying the page.
    ///
    /// `rect` is `Some` while a popover is open and `None` when closed. Unlike every other
    /// role this one does not derive its geometry from the window and the insets — it is
    /// positioned by the chrome, because its position IS the thing being rendered. It is a
    /// role rather than a bypass precisely so that going through `set_role` still means the
    /// container resolves and allocates it, and so a parked surface is a role rather than a
    /// special case in the platform layer.
    Surface { rect: Option<Rect> },
}

/// The window's insets: left, top, right. `bottom` is not needed — the chrome and every
/// content webview extend to the bottom edge.
pub type Insets = (i32, i32, i32);

/// The rectangle a child of `role` must be allocated, or `None` to leave it to GTK.
///
/// `size` is the container's own current allocation, which is the authority for geometry
/// (the window size passed to `layout()` can be one frame stale, which is exactly why the
/// old compensator read `fixed.allocation()` instead).
///
/// Widths and heights are clamped at zero rather than allowed to go negative: a window
/// narrower than its own left+right insets must not ask GTK for a negative width, and a
/// zero-sized allocation is the honest rendering of "no room".
pub fn rect_for(role: Role, size: (i32, i32), insets: Insets) -> Option<Rect> {
    let (fw, fh) = (size.0.max(0), size.1.max(0));
    let (left, top, right) = insets;
    match role {
        // Behind everything, so it takes the whole window — not the inset area.
        Role::Chrome => Some(Rect::new(0, 0, fw, fh)),
        Role::Content { shown: true } => Some(Rect::new(
            left,
            top,
            (fw - left - right).max(0),
            (fh - top).max(0),
        )),
        // Parked, but it KEEPS its on-screen size so that un-parking it is a pure move
        // rather than a move plus a resize. Sizing it 1x1 while parked is what made the
        // relayout loop so violent.
        Role::Content { shown: false } => Some(Rect::new(
            PARK_X,
            PARK_Y,
            (fw - left - right).max(0),
            (fh - top).max(0),
        )),
        Role::Passthrough => None,
        // Open: the chrome's rect verbatim. Clipping it to the window would be a policy the
        // chrome is better placed to make (it already knows where the popover should open),
        // and the window clips anything that overhangs anyway.
        Role::Surface { rect: Some(r) } => Some(r),
        // Closed: parked at the WINDOW's size, so showing it again is a pure move and the
        // parked webview never re-lays-out. Same reasoning as `Content { shown: false }`,
        // and for the same reason it must stay visible-but-offscreen rather than hidden.
        Role::Surface { rect: None } => Some(Rect::new(PARK_X, PARK_Y, fw, fh)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WIN: (i32, i32) = (1280, 800);
    /// The production toolbar height: `DEFAULT_INSET_TOP` is 164.
    const INSETS: Insets = (0, 164, 0);

    #[test]
    fn the_chrome_webview_fills_the_window_and_not_the_inset_area() {
        // The chrome is BEHIND the content, so it must take the whole window. Sizing it to
        // the inset area instead would leave a bare strip below the toolbar unpainted.
        assert_eq!(
            rect_for(Role::Chrome, WIN, INSETS),
            Some(Rect::new(0, 0, 1280, 800))
        );
    }

    #[test]
    fn a_shown_content_webview_sits_at_the_inset_and_fills_the_rest() {
        assert_eq!(
            rect_for(Role::Content { shown: true }, WIN, INSETS),
            Some(Rect::new(0, 164, 1280, 636))
        );
    }

    #[test]
    fn left_and_right_insets_both_narrow_the_content_webview() {
        // A sidebar is the `left` inset and a right-hand panel is `right`; both must come
        // out of the WIDTH, and neither may leak into the height.
        assert_eq!(
            rect_for(Role::Content { shown: true }, WIN, (360, 164, 40)),
            Some(Rect::new(360, 164, 880, 636))
        );
    }

    #[test]
    fn an_open_surface_is_placed_where_the_chrome_measured_it() {
        // The rect is the whole point of the role: it is NOT derived from the insets, and it
        // must survive untouched, because the chrome positioned a popover to line up with the
        // address input.
        let r = Rect::new(120, 44, 640, 312);
        assert_eq!(
            rect_for(Role::Surface { rect: Some(r) }, WIN, INSETS),
            Some(r)
        );
        // …including under a different inset, which is what proves the insets are not applied.
        assert_eq!(
            rect_for(Role::Surface { rect: Some(r) }, WIN, (360, 900, 40)),
            Some(r)
        );
    }

    #[test]
    fn a_surface_rect_that_overhangs_the_window_is_passed_through_not_clipped() {
        // The window clips anything that overhangs, so clipping here would only be a second,
        // subtly different idea of the truth. A 5000px-wide omnibox dropdown must still be
        // placed at 5000px.
        let r = Rect::new(-40, 44, 5000, 312);
        assert_eq!(
            rect_for(Role::Surface { rect: Some(r) }, WIN, INSETS),
            Some(r)
        );
    }

    #[test]
    fn a_closed_surface_is_parked_offscreen_at_the_window_size() {
        let parked = rect_for(Role::Surface { rect: None }, WIN, INSETS)
            .expect("a parked surface is still SIZED, only moved");
        assert_eq!((parked.x, parked.y), (PARK_X, PARK_Y));
        assert_eq!(
            (parked.w, parked.h),
            (1280, 800),
            "parking must not resize it: showing a popover again is then a pure move"
        );
    }

    #[test]
    fn a_zero_sized_window_park_stays_offscreen() {
        // A window can legitimately be 0-sized mid-resize; the parked rect must still clear
        // the screen rather than landing on (0,0) and painting over the chrome.
        let parked = rect_for(Role::Surface { rect: None }, (0, 0), INSETS).expect("sized");
        assert_eq!((parked.x, parked.y), (PARK_X, PARK_Y));
        assert_eq!((parked.w, parked.h), (0, 0));
    }

    #[test]
    fn a_parked_content_webview_is_offscreen_but_keeps_its_size() {
        let parked = rect_for(Role::Content { shown: false }, WIN, INSETS)
            .expect("a parked webview is still SIZED, only moved");
        assert_eq!((parked.x, parked.y), (PARK_X, PARK_Y));
        // Keeping the size is the point: un-parking is then a pure move. A parked webview
        // collapsed to 1x1 would re-lay-out the whole page on every tab switch.
        assert_eq!((parked.w, parked.h), (1280, 636));
    }

    #[test]
    fn parking_does_not_change_the_size_a_shown_webview_would_have() {
        // Otherwise showing/hiding a tab would also resize it, which is a second way for
        // one layout pass to produce two full-page relayouts.
        let shown = rect_for(Role::Content { shown: true }, WIN, INSETS).unwrap();
        let parked = rect_for(Role::Content { shown: false }, WIN, INSETS).unwrap();
        assert_eq!((shown.w, shown.h), (parked.w, parked.h));
    }

    #[test]
    fn a_pass_through_child_is_left_to_gtk() {
        // The fullscreen exit button keeps its natural size; the container must not resize
        // it, or it becomes 1x1 whenever the window is smaller than 34x34.
        assert_eq!(rect_for(Role::Passthrough, WIN, INSETS), None);
        assert_eq!(rect_for(Role::Passthrough, (0, 0), (0, 0, 0)), None);
    }

    #[test]
    fn a_window_narrower_than_its_own_insets_clamps_at_zero_rather_than_going_negative() {
        // A negative width is not a legal GTK allocation, and the old compensator's
        // `.max(0)` existed for exactly this. Losing the clamp would be a hard GTK
        // assertion, not a cosmetic difference.
        assert_eq!(
            rect_for(Role::Content { shown: true }, (200, 800), (360, 164, 40)),
            Some(Rect::new(360, 164, 0, 636))
        );
        assert_eq!(
            rect_for(Role::Chrome, (-50, -50), INSETS),
            Some(Rect::new(0, 0, 0, 0))
        );
    }

    #[test]
    fn fullscreen_is_inside_ordinary_geometry_and_needs_no_special_case() {
        // Fullscreen is expressed as all-zero insets by `view::apply_inset`, so the content
        // webview edge-to-edge falls out of the same rule. If a special case ever appears
        // here, this test is what notices it stopped being reachable.
        assert_eq!(
            rect_for(Role::Content { shown: true }, WIN, (0, 0, 0)),
            Some(Rect::new(0, 0, 1280, 800))
        );
    }

    #[test]
    fn a_parked_webview_stays_entirely_offscreen_at_every_window_size() {
        // A parked child keeps its on-screen SIZE, so what has to stay negative is the parked
        // rect's FAR edge, not its origin. A park that were merely "well left of the window"
        // would let a wide webview reach back under the chrome and paint over it.
        for (fw, fh) in [(320, 240), (1280, 800), (3840, 2160), (7680, 4320)] {
            let parked = rect_for(Role::Content { shown: false }, (fw, fh), INSETS)
                .expect("a parked webview is still sized");
            assert!(
                parked.x + parked.w < 0 && parked.y + parked.h < 0,
                "a {fw}x{fh} window parks its content at {:?}..x{:?}, which still overlaps the \
                 screen origin",
                parked.x,
                parked.x + parked.w
            );
        }
    }
}
