// Linux-only webview container: a `GtkFixed` subclass that allocates each child its role's
// rectangle instead of that child's size REQUEST.
//
// WHY A SUBCLASS AND NOT A PLAIN GtkFixed. `GtkFixed` allocates every child to its size
// request, and a `WebKitWebView`'s request is GTK's default 1x1 — so every layout pass
// collapsed both webviews to 1x1 and `size_fixed_children` re-expanded them, re-laying-out
// the chrome each time. The chrome re-measure then changed the omnibox height, which
// changed the content inset, which started another pass: measured ~57 Hz for as long as
// the omnibox dropdown was open. Allocating children their role's rectangle removes the
// collapse, which removes the feedback link.
//
// WHY `GtkFixed` AND NOT `gtk::Container`. A `gtk::Container` subclass was tried first and
// could not accept a single child: GTK logged `GtkContainerClass::add not implemented`
// while the Rust `add` still ran, because `ContainerImpl::add` chains to `parent_add`,
// which calls the BASE class's `add` vfunc — and GTK3's is `gtk_container_add_real`, a
// `g_warning` stub. `GtkFixed` never routes through it: `gtk_fixed_put` parents a child by
// calling `gtk_widget_set_parent` directly. `FixedImpl` requires `ContainerImpl` as a
// supertrait, so that trait is implemented here too, but every method keeps its default
// and none of them is reached.
//
// The geometry rules live in `aegis_layout.rs` (pure, unit-tested); this file is the thin
// GTK shell around them. `put` still owns ORDERING — stacking is child order, which is
// what makes a re-registered widget sit on top (see `linux_layout.rs`) — while `set_role`
// owns GEOMETRY.

use crate::aegis_layout::{Insets, Rect, Role};
use gtk::glib;
use gtk::prelude::*;
use gtk::subclass::prelude::*;

mod imp {
    use super::{Insets, Role};
    use crate::aegis_layout::rect_for;
    use gtk::prelude::*;
    use gtk::subclass::prelude::*;
    use std::cell::RefCell;

    #[derive(Default)]
    pub struct AegisFixed {
        /// child -> what it is. The ROLE is stored rather than a resolved rect on purpose:
        /// `size_allocate` must re-resolve against the container's CURRENT allocation, and a
        /// rect frozen at registration time is exactly the stale geometry this file exists to
        /// remove.
        pub roles: RefCell<Vec<(gtk::Widget, Role)>>,
        /// The window insets a `Role` resolves against. Stored here rather than passed in
        /// because GTK calls `size_allocate` with an allocation and nothing else.
        pub insets: RefCell<Insets>,
    }

    #[glib::object_subclass]
    impl ObjectSubclass for AegisFixed {
        const NAME: &'static str = "AegisFixed";
        type Type = super::AegisFixed;
        type ParentType = gtk::Fixed;
    }

    impl ObjectImpl for AegisFixed {}

    // Defaults only — see the module header for why none of these is ever reached.
    impl ContainerImpl for AegisFixed {}

    impl FixedImpl for AegisFixed {}

    impl WidgetImpl for AegisFixed {
        /// CONSTANT, so GTK never asks "how big would you be for THIS allocation". The
        /// container's size is decided by its parent, never derived from its children.
        fn request_mode(&self) -> gtk::SizeRequestMode {
            gtk::SizeRequestMode::ConstantSize
        }

        /// The container's OWN minimum, never a child's. This is the half that unbreaks
        /// window shrinkability: GTK3 propagates a child's minimum up as the window's, so a
        /// webview carrying its real geometry as a request pins the window to its current
        /// size. Measured four ways before this existed: a (0,0) request shrinks, a real
        /// request is BLOCKED, and no `set_size_request(0,0)` on the container, the Box or
        /// the toplevel overrides it. A `Container` may report whatever it likes, so
        /// reporting a smaller value is legal and is the intended mechanism here.
        fn preferred_width(&self) -> (i32, i32) {
            (0, 0)
        }

        fn preferred_height(&self) -> (i32, i32) {
            (0, 0)
        }

        fn size_allocate(&self, allocation: &gtk::Rectangle) {
            let size = (allocation.width(), allocation.height());
            let insets = *self.insets.borrow();
            // Clone the registry and drop the borrow: `child.size_allocate` must never be
            // able to re-enter this method against a live `RefCell` borrow.
            let registered: Vec<(gtk::Widget, Role)> =
                self.roles.borrow().iter().cloned().collect();

            for (child, role) in registered {
                match rect_for(role, size, insets) {
                    Some(r) => child.size_allocate(&gtk::Rectangle::new(r.x, r.y, r.w, r.h)),
                    None => {
                        // Left to GTK: keep the position `put` gave it, restore its natural
                        // size. Calling `size_allocate` at all matters — skipping it is what
                        // left a stale widget at 1x1.
                        let a = child.allocation();
                        let (_, natural) = child.preferred_size();
                        child.size_allocate(&gtk::Rectangle::new(
                            a.x(),
                            a.y(),
                            natural.width,
                            natural.height,
                        ));
                    }
                }
            }
        }
    }
}

glib::wrapper! {
    pub struct AegisFixed(ObjectSubclass<imp::AegisFixed>)
        @extends gtk::Fixed, gtk::Container, gtk::Widget;
}

impl AegisFixed {
    pub fn new() -> Self {
        let f: Self = glib::Object::new();
        f.set_has_window(false);
        f
    }

    /// Publish the window insets every `Role` resolves against. Called before `set_role`
    /// in the same layout pass.
    pub fn set_insets(&self, insets: Insets) {
        *self.imp().insets.borrow_mut() = insets;
    }

    /// Tell the container what `child` is. This is the ONLY way geometry changes, and it
    /// must never be called from `size_allocate` — that would re-enter the allocation this
    /// file exists to make non-looping.
    pub fn set_role(&self, child: &gtk::Widget, role: Role) {
        {
            let mut roles = self.imp().roles.borrow_mut();
            match roles.iter_mut().find(|(w, _)| w == child) {
                Some((_, r)) => *r = role,
                None => roles.push((child.clone(), role)),
            }
        }
        // Queue the CHILD, never the container: queueing the container re-enters
        // size_allocate, which is the loop this whole file exists to break.
        child.queue_resize();
    }

    /// Park a child offscreen while keeping it VISIBLE, which is what hides a background
    /// tab without backgrounding its page (see `aegis_layout::PARK_X`).
    pub fn park(&self, child: &gtk::Widget) {
        self.set_role(child, Role::Content { shown: false });
    }

    /// Forget a child entirely, on close. A stale `gtk::Widget` left here would keep a
    /// destroyed widget alive and get sized on every later pass.
    pub fn forget(&self, child: &gtk::Widget) {
        self.imp().roles.borrow_mut().retain(|(w, _)| w != child);
    }

    /// What a child is currently registered as. Test/diagnostic seam.
    pub fn registered_role(&self, child: &gtk::Widget) -> Option<Role> {
        self.imp()
            .roles
            .borrow()
            .iter()
            .find(|(w, _)| w == child)
            .map(|(_, r)| *r)
    }
}

/// Register the popover surface as this container's **topmost** child, at `rect` (or parked
/// when closed).
///
/// The `remove` + `put` pair is the whole reason this function exists rather than a bare
/// `set_role`: on X11 the container's child order *is* the stacking order, and the surface is
/// a second WebKit webview that must paint over the first. Probed and mutation-verified
/// (spec §6.4) — the exit button already relies on the same rule (`linux_layout.rs`), and
/// this generalises it from a plain GTK widget to two webviews.
///
/// So the split is: **`put` owns ORDERING, `set_role` owns GEOMETRY.** Re-registering on every
/// `popover.set` is cheap (one webview, no page load) and degrades a future ordering mistake
/// into a re-registration rather than a popover painted underneath the page.
///
/// A widget that is not (yet) inside the container is ignored rather than panicking: at boot
/// the surface is `add_child`'d to the window's `GtkBox`, and `linux_layout::layout()` is what
/// pulls strays into the container. So the FIRST `popover.set` may arrive before any layout
/// pass has run, and this must not make that path panic.
pub fn register_surface(widget: &gtk::Widget, rect: Option<Rect>) {
    let Some(fixed) = widget
        .parent()
        .and_then(|p| p.downcast::<AegisFixed>().ok())
    else {
        return;
    };
    fixed.remove(widget);
    fixed.put(widget, 0, 0);
    // `put` does not show a child, and a hidden webview allocates nothing.
    widget.set_size_request(0, 0); // never what sizes it; kept so it pins nothing
    widget.show();
    fixed.set_role(widget, Role::Surface { rect });
}

impl Default for AegisFixed {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    /// These are SOURCE pins, not runtime tests, and that is a limit worth stating plainly:
    /// instantiating a `GtkFixed` subclass needs a real display, which `cargo test --lib` does
    /// not have, so the vtable install cannot be asserted here. What IS asserted is that the
    /// two vfuncs which carry the whole fix are present and shaped correctly, which is what a
    /// future edit would silently break. The vtable install itself is measured, not asserted —
    /// see the Phase 0 probe (PARENTED=2, or the run aborts).
    fn production() -> String {
        crate::test_support::rust_production_source(include_str!("aegis_container.rs"))
    }

    /// §5.4: the container's preferred size MUST be (0,0). This is the half that unbreaks
    /// window shrinkability — GTK3 propagates a child's minimum up as the window's, so a
    /// container that derived its preferred size from its webviews would pin the window to
    /// its current size. Measured before this existed: a webview carrying its real geometry
    /// as a request gave `MIN=(900,900)` and `resize(320,240)` BLOCKED, against `(1,1)` and
    /// SHRANK for a (0,0) request. Reverting either arm to `parent_preferred_*` restores
    /// that, so both halves are pinned separately.
    #[test]
    fn the_container_reports_its_own_zero_minimum_not_a_childs() {
        let src = production();
        for axis in ["width", "height"] {
            let vfunc = format!("fn preferred_{axis}(&self) -> (i32, i32)");
            let start = src
                .find(&vfunc)
                .unwrap_or_else(|| panic!("preferred_{axis} vfunc is gone"));
            let body = &src[start..start + 120];
            assert!(
                body.contains("(0, 0)"),
                "preferred_{axis} must return (0, 0). Anything derived from a child makes the \
                 window's minimum that child's, and the window can then only grow."
            );
            assert!(
                !body.contains("parent_preferred"),
                "preferred_{axis} delegates to the parent, which is GtkFixed's own \
                 request-deriving implementation — that is the behaviour being replaced."
            );
        }
    }

    /// §5.4: `request_mode` must be CONSTANT. With `ForSize`, GTK asks the container how big
    /// it would be *for* a given allocation, which is a second, allocation-dependent path
    /// into the same sizing decision this container exists to take over.
    #[test]
    fn the_container_asks_for_no_size_at_all() {
        let src = production();
        assert!(
            src.contains("gtk::SizeRequestMode::ConstantSize"),
            "request_mode is no longer ConstantSize; GTK may again ask the container to derive \
             a size from a for_size allocation."
        );
    }

    /// THE collapse. `size_allocate` must hand each child its ROLE's rectangle and must
    /// never consult `size_request`, which is 1x1 for a WebKit webview and is what collapsed
    /// both webviews on every layout pass.
    #[test]
    fn size_allocate_never_reads_a_childs_size_request() {
        let src = production();
        let start = src
            .find("fn size_allocate(&self, allocation: &gtk::Rectangle)")
            .expect("size_allocate vfunc is gone");
        // The body runs to the end of the `impl WidgetImpl` block.
        let body = &src[start..];
        let body = &body[..body.find("\n    }\n").unwrap_or(body.len())];
        assert!(
            !body.contains("size_request"),
            "size_allocate reads a child's size REQUEST. A WebKit webview's request is GTK's \
             default 1x1, so this reintroduces the 1x1 collapse — the amplifier behind the \
             measured ~57 Hz layout loop."
        );
        assert!(
            body.contains("rect_for"),
            "size_allocate no longer resolves roles through `rect_for`; the geometry rules in \
             aegis_layout have stopped driving the allocation."
        );
    }

    /// §5.4: `size_allocate` must not re-enter the geometry entry point. `set_role` queues a
    /// resize, so calling it from inside `size_allocate` is precisely the loop that made the
    /// old compensator dangerous.
    #[test]
    fn size_allocate_does_not_re_enter_the_geometry_entry_point() {
        let src = production();
        let start = src
            .find("fn size_allocate(&self, allocation: &gtk::Rectangle)")
            .expect("size_allocate vfunc is gone");
        let body = &src[start..];
        let body = &body[..body.find("\n    }\n").unwrap_or(body.len())];
        for forbidden in ["set_role", "queue_resize", "set_insets"] {
            assert!(
                !body.contains(forbidden),
                "size_allocate calls `{forbidden}`, which queues a resize and re-enters \
                 allocation. Geometry must only change through `set_role`, from outside."
            );
        }
    }

    /// The `GtkFixed` choice is load-bearing, not stylistic: a `gtk::Container` subclass
    /// accepts no children at all here, because `ContainerImpl::add` chains to the base
    /// class's `add` vfunc, which in GTK3 is a `g_warning` stub. Keep `FixedImpl`.
    #[test]
    fn the_subclass_is_a_fixed_so_put_can_parent_children() {
        let src = production();
        assert!(
            src.contains("type ParentType = gtk::Fixed"),
            "the container's parent is no longer GtkFixed. Subclassing gtk::Container looks \
             equivalent and is not: `gtk_fixed_put` parents a child by calling \
             `gtk_widget_set_parent` directly, while `ContainerImpl::add` forwards to \
             GtkContainer's abstract `add`, so every child is silently refused."
        );
        assert!(
            src.contains("impl FixedImpl for AegisFixed"),
            "FixedImpl is missing. It is the trait whose IsSubclassable impl installs the \
             GtkFixed vtable entries this container relies on."
        );
    }

    /// A `gboolean`-returning GTK signal handler must return `Some(Value::from(false))`;
    /// returning `None` aborts the process rather than failing a test. There is no such
    /// handler here today, and that is worth pinning — the obvious way to observe draw order
    /// or visibility is to add one, and getting it wrong is a core dump.
    #[test]
    fn no_signal_handler_can_return_none() {
        let src = production();
        assert!(
            !src.contains("connect_local"),
            "a GTK signal handler appeared in the container. A handler on a `gboolean`-returning \
             signal must return Some(glib::Value::from(false)); returning None ABORTS the process."
        );
    }
}
