# Popover surface — design spec

**Date:** 2026-10-04
**Status:** design approved in conversation; written spec awaiting review
**Scope:** Linux + Windows + macOS desktop. Android explicitly out of scope (see §10).

---

## 1. Summary

The omnibox dropdown currently displaces the page, and because a GTK sizing quirk
collapses every webview to 1×1 on each layout pass, that displacement feeds back into
its own input and the app enters a **57 Hz layout oscillation** for as long as the
dropdown is open.

This spec replaces the mechanism in two parts:

1. **A custom GTK `Container`** that allocates children their assigned rectangles
   directly, instead of letting `GtkFixed` allocate them to their size _requests_.
   This removes the 1×1 collapse, which removes the feedback link, which makes the
   oscillation structurally impossible — and unbreaks window shrinkability.
2. **A popover surface**: one long-lived Tauri child webview stacked above the
   content webviews, into which all four chrome popovers render. Because the surface
   overlays the page, the page no longer moves or resizes because of a popover at all.

After this, `useChromePopoverInset` and the popover→content-inset path are **deleted**,
not deprecated.

---

## 2. The defect, as measured

Instrumented AppImage, real profile, dropdown opened programmatically:

| observation                                              | value                                          |
| -------------------------------------------------------- | ---------------------------------------------- |
| `view.setContentInset` calls while the dropdown was open | 3474, still climbing at shutdown               |
| oscillation rate                                         | **~57/second**, indefinite                     |
| content webview height                                   | alternating **1280×636 → 1280×260 → 1280×266** |
| layout passes entering with **both** webviews at 1×1     | 2704                                           |
| inset values                                             | `534` ×3472, `540` ×3452 (never settles)       |
| before the dropdown opened                               | stable at `156`                                |

The loop begins on the frame the dropdown opens and ends only when it closes.

### 2.1 Root cause chain

Typing changes the suggestion count → `.omnibox` height changes
(`src/index.css:807` caps it at `max-height: 384px`; `OMNIBOX_LIMIT = 8` in
`src/lib/omnibox.ts:38` keeps 8 rows ≈ 330px, under the cap, so the box height tracks
the row count exactly).

`useMeasuredHeight` (`src/hooks/useMeasuredHeight.ts:32`) observes that height →
`useChromePopoverInset` → the registry's tallest → `contentTop` in `App.tsx:249` →
`useContentInset` → the `view.setContentInset` arm (`src-tauri/src/view.rs:285`) →
`update()` → `apply_inset` → `linux_layout::layout` (`src-tauri/src/linux_layout.rs:761`)
→ `fixed.move_` + `size_fixed_children` (`:912`).

`gtk_fixed_move` queues a resize. `GtkFixed` allocates each child to its size request,
and a `WebKitWebView`'s request is GTK's default **1×1** — so the chrome webview and
the content webview are both collapsed to 1×1 and then re-expanded by
`size_fixed_children` (`:689`, connected `after=true` at `:860`). That collapse
re-lays-out the **chrome**, which re-measures the dropdown, which produces a new inset.

The two stable points are the dropdown measuring its content height (378) against its
clamped `max-height` (384). Two fixed points ⇒ limit cycle.

### 2.2 The two separable defects

- **D1 — the collapse** (the amplifier, and the source of the flash). Every layout pass
  resizes _both_ webviews twice, one of those at 1×1.
- **D2 — tracking a continuously-varying value** (the movement). The content inset
  follows a number that changes as the user types.

The oscillation needs both. D1 alone cannot loop; D2 alone would only move the page a
few times per typed word. Part 1 fixes D1, Part 2 removes D2 for popovers.

---

## 3. Goals and non-goals

**Goals**

- Popovers render above page content; opening or typing in one never resizes, moves or
  re-lays-out the page.
- No 1×1 collapse on any inset change, from any source (FindBar, sidebar, tab switch).
- Window shrinkability restored as a side effect, not traded away.
- All four popovers on one mechanism, so the next popover added cannot reintroduce this.
- Attacker-influenceable strings (page titles reach suggestion rows) are rendered as
  text only and cannot reach any IPC channel.

**Non-goals**

- Android (no child-webview concept — §10).
- Visual redesign of any popover, except the one deliberate change in §11.
- Changing keyboard semantics, ranking, or the ranking's inputs.
- Fixing the sidebar/overlay z-order behaviour, which is unchanged.

---

## 4. Architecture

```
┌─────────────────────────────── Tauri window "main" ───────────────────────────────┐
│                                                                                    │
│   chrome webview (React)          content:N webviews            surface:popover     │
│   fills window, opaque            one per tab, opaque           one, opaque        │
│   owns ALL popover state          the page                       renders popovers   │
│            │                            │                             ▲            │
│            │  popover.set {id,rect,payload}                          │            │
│            ▼                            │                             │            │
│            └──────────► popover.rs ────┴── position/size/stack ──────┘            │
│                            ▲                                                      │
│                            │  popover.picked {id, index|action}                   │
│                            └──────────── chrome validates & acts                 │
└────────────────────────────────────────────────────────────────────────────────────┘
```

Container child order is bottom-to-top: chrome, content webviews, `surface:popover`.

---

## 5. Part 1 — `src-tauri/src/aegis_container.rs` (new)

A **`gtk::Fixed` subclass** replacing the stock `GtkFixed` as the parent of the chrome
webview, every content webview, and the popover surface. It implements `WidgetImpl` and
inherits `put`/`move_`/`remove`/`children`; `FixedImpl` requires `ContainerImpl` as a
supertrait, so that trait is implemented too but keeps every default.

**Why `Fixed` and not `Container` (measured, Phase 0 probe A).** The first attempt
subclassed `gtk::Container` and could not accept a single child: GTK logged
`GtkContainerClass::add not implemented`, `PARENTED=0`, while the Rust `add` still ran.
That is not a gtk-rs bug and needs no upstream escalation — `ContainerImpl::add` chains
to `parent_add`, which invokes the **base** `GtkContainer` class's `add` vfunc, and
GTK3's is `gtk_container_add_real`, a `g_warning` stub. `GtkFixed` never routes through
it: `gtk_fixed_put` parents a child by calling `gtk_widget_set_parent` directly. So the
whole `Container`-subclass path is abandoned, and nothing about the design below needed
to change — §5.2's requirements are all still met, now by inheritance rather than by
writing them from scratch.

### 5.1 Two responsibilities

**a) Allocate children their assigned rectangles.** `size_allocate` hands each child
the rectangle registered for it. No child is ever sized from its size request, so
there is no collapse and nothing to compensate for. `size_fixed_children` and its
`after=true` `size-allocate` connection are **deleted**.

**b) Do not derive the preferred size from children.** `get_preferred_width` and
`get_preferred_height` return the container's own minimum, never a child's. This is
the half that unbreaks window shrinkability.

### 5.2 Why this and not `GtkOverlay`

`GtkOverlay` was the previously-rejected candidate because it sizes children to the
container's allocation but has no arbitrary x/y, which this file needs twice: parking a
background tab at (-10000, -10000) while keeping it _visible_ (`set_visible(false)`
backgrounds the page, which malvertising weaponises to fire a redirect), and pinning
the fullscreen-exit button to the top-right corner. A container has both.

**A `GtkFixed` subclass has both by inheritance**, which is what makes it preferable to
both alternatives: `GtkOverlay` is disqualified by the same two requirements, and a
from-scratch `Container` subclass satisfies them only after re-implementing `put`,
`move_`, the child list and the z-order rule — for the same result. Measured, the
subclass keeps `put`/`move_`/`remove`/`children` working unchanged, so the z-order
precedent this file already relies on (§6.2) is preserved verbatim.

### 5.3 Why a container may under-report its preferred size

GTK3 propagates a child's minimum up as its parent's minimum, which is why writing the
webviews' real geometry into their `set_size_request` — the fix that was built,
measured working, shipped and then **reverted** because it made the window
unshrinkable — cannot work. A `Container` is not obliged to report its children's
minimums at all. Reporting a smaller value is legal and is the intended mechanism here;
it breaks the tie between two bugs rather than choosing between them.

### 5.4 Contract

- `size_allocate` must not call `move_`, `put`, or `queue_resize` on itself or any
  child (that would loop). Geometry changes arrive by the owner calling `set_rect` on
  the container, which stores the rect and calls `queue_resize` on the _child_ only.
- `set_rect(child, None)` puts a child back under GTK's own sizing — its `put`
  position and its natural size. The fullscreen exit button uses this, because the
  container must never resize it. Every other child is `Some(rect)`.
- Background tabs are registered at (-10000, -10000) and `set_visible(false)`.
- The fullscreen exit button keeps its natural size; the container never resizes it.
- The container's `preferred_width/height` must be `(0, 0)`, and its `request_mode` must
  be `ConstantSize` so GTK never asks for a size "for" some allocation.
- `put` still owns **ordering** (z-order is child order, §6.2) while `set_rect` owns
  **geometry**. Keeping those two separate is what lets the exit button keep
  `put`-based placement while the webviews get explicit rectangles.

### 5.5 Verification — Phase 0 probe A

A throwaway `src-tauri/examples/*.rs` probe (deleted afterwards; `git status` verified
empty) that builds the real structure and measures, in one run, all three properties.
**RUN 2026-10-04 — GREEN**, `examples/probe_fixedsub.rs`, two real `WebKitWebView`s per
arm. `req` is what the webviews carry in their size request: `zero` is the shipped
`(0,0)`, `real` is the configuration that was built, shipped and reverted.

| arm                          | req  | MIN      | COLLAPSE  | SHRINK      | GROW   |
| ---------------------------- | ---- | -------- | --------- | ----------- | ------ |
| plain `GtkFixed` (ships now) | zero | 1x165    | **10/10** | ok          | ok     |
| plain `GtkFixed`             | real | 1280x800 | 0/10      | **blocked** | ok     |
| subclass, no `size_allocate` | zero | 0x0      | **10/11** | ok          | ok     |
| subclass, no `size_allocate` | real | 0x0      | 0/11      | ok          | ok     |
| subclass, no preferred size  | zero | 1x165    | 0/11      | ok          | ok     |
| subclass, no preferred size  | real | 1280x800 | 0/11      | **blocked** | ok     |
| **full subclass**            | zero | **0x0**  | **0/11**  | **ok**      | **ok** |
| **full subclass**            | real | **0x0**  | **0/11**  | **ok**      | **ok** |

Three things this settles that the spec previously asserted without evidence:

- **The trade-off §5.3 describes is not real.** Rows 1 and 2 reproduce the shipped state
  and the reverted fix exactly, and the last two rows hold **both** properties
  simultaneously — in both request configurations, shrinking _and_ growing. One container
  breaks the tie; there was no tie to break.
- **Each half is independently load-bearing.** Dropping `size_allocate` restores the
  collapse (10/11); dropping the preferred-size override restores `SHRINK=blocked` and
  `MIN=1280x800`. Both mutations go red in exactly the cell they should, which is what
  makes this a measurement of the trade-off rather than a single lucky pass.
- **The window is verified in both directions.** `GROW` exists so "shrinks" cannot be
  satisfied by a window that is simply stuck.

Every run asserts `PARENTED=2` and aborts otherwise. That precondition is the whole
reason the result is believable: an earlier revision read back GTK's _unallocated_
default `{-1,-1,1x1}` on every pass and reported `COLLAPSE=11/11` for the **fixed** arm —
because `put` does not show a child and `gtk_widget_size_allocate` is a no-op on an
unshown widget, so the children were never shown at all. That failure is
indistinguishable from a collapse that survived the fix, which is why the precondition is
asserted rather than printed.

Check the probe binary's mtime after building — a failed build silently leaves the
previous binary and the run reads as a legitimate negative result. It was hit for real
during this phase: three consecutive probe runs reported `#readback_failed` from a binary
three minutes older than the source.

---

## 6. Part 2 — `src-tauri/src/popover.rs` (new)

Owns the surface webview's lifecycle, geometry and event plumbing.

### 6.1 Creation

One webview, label `surface:popover`, created at boot via `window.add_child` — the
same call content webviews use (`src-tauri/src/nav.rs:919` / `:928`) — pointing at a
second frontend entry (`popover.html`). It is created **once** and never per tab.

### 6.2 Stacking — child order, not `raise()`

`GdkWindow::raise()` does not reliably lift a widget above WebKit's native windows;
this is already recorded in the tree at `src-tauri/src/linux_layout.rs:932-934`, and
is why the fullscreen exit button is re-registered **last** in the container on every
layout pass (`:935`).

**But that precedent is narrower than it looks, and the difference is load-bearing.**
The exit button is a plain GTK widget. The surface is a _second WebKit webview_, and
WebKit re-raises its own window when it composites — so whether child order alone
determines stacking **between two WebKit webviews** was _unverified_. It is the single
assumption the whole design rests on, so Phase 0 probes it (§6.4) rather than
discovering it in Phase 2.

**PROBED 2026-10-04 — child order HOLDS, so none of the fallbacks below are needed.**
See §6.4 for the measurement. The surface therefore stacks by being registered last,
exactly like the exit button, and no `raise()` call is required of it. The override-
redirect window is off the table. This does **not** change the existing exit-button rule
at `linux_layout.rs:932-934` — that one is a _separate_ fact about a plain GTK widget
against WebKit's native windows, and it stays.

Retained, because it is cheap and because the probe measured a different thing than a
live run will (see §6.4): the surface still re-registers itself last on every layout
pass, so a future change that breaks the order degrades to a re-registration rather than
to a misplaced popover.

### 6.3 Geometry and visibility

`popover.set` carries the rect in window coordinates. The chrome webview fills the
window at (0,0), so **chrome-webview client coordinates are window coordinates** — no
scale conversion is needed on Linux.

Closed ⇒ registered at (-10000, -10000) and `set_visible(false)`, identical to a
background tab.

### 6.4 Verification — Phase 0 probe B

A second throwaway probe builds a window containing **two real `WebKitWebView`s** with
distinct solid backgrounds, registers the second topmost, and reports which one paints
on top. It must also confirm the topmost stays on top across a resize and a
re-layout, since WebKit re-raises its own window when it composites.

**RUN 2026-10-04 — GREEN**, `examples/probe_stack.rs`, 6 arms. It records the order GTK
walks its children in, which is the mechanism the design relies on:

| arm                                                        | sequence | topmost |
| ---------------------------------------------------------- | -------- | ------- |
| 1 `order_b_last`                                           | `A>B`    | **B**   |
| 2 `after_resize`                                           | `A>B`    | **B**   |
| 3 `after_relayout_b_last` (remove+put, as `layout()` does) | `A>B`    | **B**   |
| 4 **CONTROL** reverse, A registered last                   | `B>A`    | **A**   |
| 5 **CONTROL** only B is a child                            | `B`      | B       |
| 6 **CONTROL** only A is a child                            | `A`      | A       |

Arm 4 is what makes the rest a measurement: the answer **follows** child order instead
of being fixed. Arms 5 and 6 prove the recorder is not blind, which is the failure mode a
recorder-only probe has by construction. The probe was **mutation-verified** — an arm
that draws B-then-A regardless of child order flips arms 1–3 to `TOPMOST=A` — and the
unmutated file was restored byte-identical afterwards.

**It records draw ORDER, not pixels, and that substitution is forced by this host.**
Four pixel routes were tried and every one is wrong or unrunnable here: `gtk_widget_draw`
into a Cairo surface is black (WebKit composites outside GTK's draw pass);
`gdk_pixbuf_get_from_window` on our own toplevel returns a flat `#202326` (WebKit's
content lives in separate native child windows); the same call on the root window returns
`#000000`; and ImageMagick's `import -window root` has a dead X11 delegate. The cause is
that `GDK_BACKEND=x11` on this KDE/Wayland host produces an Xwayland surface which is
**never mapped into the X server** — with a probe running, `wmctrl -l` lists nothing and
`xprop -root _NET_CLIENT_LIST_STACKING` prints `window id #`.

**So this is a stronger claim than "the pixels looked right" but a weaker one than "the
surface was seen on screen."** Phase 2's live AppImage run closes the gap; §6.2's
re-registration rule stands until then.

### 6.4a RUN 2026-10-04 — the live AppImage run, and the one thing it could not show

Built AppImage md5 `c691dd13c9d6310f41899fb9c3bd6394`, isolated profile, local test page.
The run, in order, after `popover::dispatch` was instrumented (instrumentation since
removed; `grep -c '###PROBE###'` = 0 in `popover.rs`, `main.tsx`, `PopoverPanel.tsx`):

```
create_surface: webview(surface:popover) registered = true
surface widget at creation: visible=true realized=true
surface on_page_load: "surface:popover" Started  tauri://localhost/popover.html
surface on_page_load: "surface:popover" Finished tauri://localhost/popover.html
popover_ready from="surface:popover"        -> nothing open
dispatch saw popover.set {"actions":["pick"],"id":"test","itemCount":3,
  "payload":{"kind":"test","note":"PHASE 2 GATE PAYLOAD","rows":["alpha","beta","gamma"]},
  "rect":{"height":190,"width":460,"x":140,"y":210}}
place: rect=Some(Rect{x:140,y:210,w:460,h:190}) topmost=true visible=true siblings=4
dispatch popover.set -> Ok(Null)
popover_picked: from="surface:popover" id=test index=Some(0) open=Some(Placed{ id:"test",
  rect:Rect{x:140,y:210,width:460,height:190}, items:3, actions:["pick"] }) accepted=true
```

The surface loads `popover.html`, handshakes under its own capability, receives the
**targeted** payload, renders the panel, reports a pick, and Rust accepts it against the
chrome's declared `itemCount: 3`. Stacking came back `topmost=true` — the surface is the
last child, and §6.2's claim is that child order alone decides. So the `raise()` fallbacks
stay retired; the re-registration rule stays, because it is what _keeps_ it last.

**What this run still cannot show: pixels.** The four dead routes of §6.4 hold on the
real AppImage too — `import -window` on the Aegis window returns a flat `#121212` and
`spectacle -b -n` captures only the wallpaper — for the same Xwayland reason. The
measurement channels used instead were `document.title` (readable via `wmctrl`, and
`wmctrl -l` does list the window without driving its WM title) and Rust `eprintln!`.
**Stacking is therefore still inferred from child order plus GTK's own draw traversal,
not seen.** The owner confirming it by eye on a real desktop is the remaining check.

### 6.5 Opaque, deliberately

The surface paints an **opaque** background. Three of the four popovers are already
solid `var(--bg-elevated)`; only the shield uses glass (§11). Opaque means the
riskiest part of this design — suppressing `WebKitWebView`'s default opaque background
via `draw-background` — is not needed at all.

Consequence: a popover's box-shadow is clipped at the surface's rect. Mitigate by
making the surface rect the popover's full box including its shadow margin, so the
shadow renders inside it.

---

## 7. IPC contract

New channel and event, both in `shared/types.ts`:

```
popover.set   (chrome → Rust → emit_to("surface:popover"))
  { id: string, x: number, y: number, width: number, height: number,
    payload: unknown }

popover.picked (surface → Rust → emit, chrome listens)
  { id: string, index?: number, action?: string, value?: unknown }
```

- `id` identifies which popover is showing (`address-omnibox`, `address-site`,
  `adblock-shield`, `zoom-indicator`), so one surface serves all four.
- The surface **always** receives the current payload for the id it is showing;
  there is no incremental patching, so a dropped frame cannot leave stale rows.
- `popover.picked` is an **event, not a channel** — see §8.
- **Targeted emit is new here.** The crate's `emit_event` uses `app.emit`, which
  broadcasts to _every_ webview, and there is currently no `emit_to` in the codebase
  (`src-tauri/src/lib.rs`). `popover.rs` adds one. It must be `emit_to` and not
  `emit`: a broadcast would hand suggestion payload — which contains history titles,
  and therefore the user's browsing history — to every content webview, including the
  untrusted ones.

### 7.1 Validation (chrome side, always)

The chrome treats the surface as untrusted:

- `index` is bounds-checked against the chrome's own array; an out-of-range index is
  ignored.
- The chrome acts on **its own** suggestion/action object, never on anything in the
  event payload.
- `action` must be a member of a per-popover allowlist.
- An `id` that is not currently open is ignored.

This is why suggestion titles may safely be attacker-influenceable: a poisoned title
can at most cause the chrome to be asked to pick an index it already had.

### 7.2 As built (Phase 2) — three changes to the contract above

**1. `popover.set` carries a nested `rect` plus two extra fields.** The chrome sends

```
popover.set (ipc channel, chrome -> Rust -> emit_to("surface:popover"))
  { id: string, rect: { x, y, width, height },
    itemCount: number, actions: string[], payload: unknown }

popover_picked (COMMAND, surface -> Rust -> emit, chrome listens)
  { id: string, index?: number, action?: string, value?: unknown }

popover_ready  (COMMAND, surface -> Rust)
  {}
```

- `rect` is nested because §8 requires Rust to **validate** the geometry, and a flat
  four-number envelope beside a `payload: unknown` is exactly the shape that lets one
  field drift out of sync with the other. This was not foresight: the first
  implementation read `width`/`height` off the envelope while `PopoverSetArgs` sent them
  nested, and **1 908 frontend and 782 Rust tests were green while the live app
  rejected every popover** (``popover.set: `width` must be a number``). The pin that
  now guards it lives in `shared/ipcCatalog.drift.test.ts` and reads the **Rust
  source's** key paths, both the `.get("x")` literal and the `num("x")` closure form,
  plus the object each is read from.
- `itemCount` + `actions` are not in the §7 shape above, and they have to be: the §7.1
  bounds check and §8's action allowlist are Rust's to enforce (the registry exists
  anyway at re-emit time), and Rust cannot count the rows inside `payload: unknown`.
- **`popover.picked` and `popover_ready` are commands, not events.** `core:event` has
  **no scope support at all** in Tauri 2.11.3 — `core:event` carries
  `global_scope_schema: null` and every one of its permissions is a bare
  `commands: {allow, deny}`, and `permissions/event/autogenerated/reference.md` says so
  in words. So §8's "an explicit allowlist, not the blanket `core:event:default`" is
  unimplementable as written. Rather than fall back to the blanket grant, the surface
  gets **no `emit` permission at all** and reports a pick by invoking a command. That is
  strictly tighter than the spec, not a loosening.

### 7.3 `popover_ready` — the handshake the spec did not anticipate

`emit_to` is fire-and-forget. The payload was emitted before the surface's React-effect
listener had registered, so it was delivered to nobody, permanently — and not as a rare
race: it is the **normal case at every launch**, and it is what a WebKit reload
reproduces (the surface stays blank forever). The measured symptom was a surface placed
at exactly the right rect with `topmost=true visible=true` and nothing in it.

So the surface announces readiness as its last startup step and Rust replays the current
frame. `surfaceApi.start()` deliberately does **not** reuse the existing `on()` helper,
because `on()` resolves its listener in the background — awaiting `ready()` after it
would rebuild the very race it fixes. A test pins the ordering
(`announces readiness only AFTER the backend listener is live`).

**Honest limit:** the replay path is covered by unit tests only. In the live gate run
`ready()` happened to fire _before_ the chrome's first `popover.set`, so that ordering
was not exercised end-to-end on device.

---

## 8. Security boundary

`src-tauri/capabilities/default.json` scopes `core:event:default` to `windows: ["main"]`,
which deliberately keeps every content webview outside IPC.

Add a second capability file for `surface:popover`, granting **listen and emit for the
popover event names only — and no `ipc` invoke**. Withholding invoke is the whole
boundary: the surface cannot reach `settings.set`, `nav.navigate`, or anything else,
because every app command goes through the single `ipc` chokepoint.

The emit scope is an explicit allowlist (`core:event:allow-emit` with a scoped event
list), not the blanket `core:event:default` — the surface must not be able to emit
arbitrary event names that some other listener acts on.

Tests:

- A source-text pin (via `test_support::rust_production_source`) proving the popover
  capability names `surface:popover`, grants **no** `core:` command/invoke permission,
  and scopes emit to the popover event alone.
- A source-text pin proving `default.json` still lists only `["main"]`, so no content
  webview label can acquire a capability by being added to the wrong list.
- A `MockRuntime` test that `popover.rs` applies the chrome-side §7.1 validation —
  bounds, allowlist, open-id — because those are the checks that make a poisoned
  suggestion title harmless.

### 8.1 As built (Phase 2) — the boundary above was inert, and worse than inert

Three things here were wrong in the design text, and the third is a **security fix**,
not a correction of taste.

**1. Both capability files were scoped on the wrong axis.** `resolve_access` matches
`windows` against the **window** label and `webviews` against the **webview** label
(`tauri-2.11.3/src/ipc/authority.rs:439`). The surface is a _child webview of `main`_,
so `windows: ["surface:popover"]` matched **nothing at all**: every grant was dead, the
surface could not listen, report a pick, or handshake, and **nothing errored anywhere**.
Both files are now `webviews`-scoped, and pinned by two tests — one asserting the axis
by name, one asserting the chrome's and the surface's webview scopes are disjoint.

**2. Withholding `ipc` was not a control before this change: the app had no ACL
manifest at all.** Tauri ACL-checks a non-plugin command only
`if plugin_command.is_some() || has_app_acl_manifest || !is_local`
(`tauri-2.11.3/src/webview/mod.rs:1817`), so with no manifest **any local-origin
webview could invoke `ipc`** — and therefore `settings.set`, `nav.navigate`, and every
other channel — with no check whatsoever. Content webviews were excluded only by their
remote origin, which is an accident of where they load from, not a capability decision.
`build.rs` now declares `AppManifest::new().commands(&["ipc", "popover_picked",
"popover_ready"])`, which is what makes `allow-ipc` exist at all. Proof the mechanism is
real rather than theoretical: the build **failed** with `Permission allow-popover-picked
not found` before that line was added.

**3. Which makes the axis fix in (1) load-bearing in the other direction.** With a
manifest present, `default.json`'s `windows: ["main"]` would have matched **every
content webview too** — they share the `main` _window_ — handing every page in every
tab the chrome's full `ipc`. The wrong axis was inert in one direction and a live hole
in the other. `webviews: ["main"]` is the fix, and the chrome's own webview label is
`main` on desktop.

**Residual, recorded rather than papered over:** `core:event:allow-listen` cannot be
scoped either, so the surface _could_ subscribe to any event in the app. It is
mitigated by `connect-src` in the surface's CSP (no egress) and by the fact that it
loads only our own bundle — not by the capability. If that is ever judged too loose, the
fix is a per-webview event surface, not a capability edit.

---

## 9. Renderer changes

### 9.1 Second entry

`vite.config.ts` gains a second Rollup input (`popover.html`); `src/popover.html` and
`src/popover.tsx` mount a minimal React root importing the **same** `index.css`, so
light/dark theming matches without duplication.

### 9.2 Hook replacements

- `useMeasuredHeight` → **`useMeasuredRect`**: returns the element's
  `getBoundingClientRect()` (x, y, w, h), since the surface needs a position, not just
  a height. Its change guard moves from "height differs" to "rect differs".
- `useChromePopoverInset` → **`usePopoverSurface`**: sends `popover.set` with the rect
  and payload; a popover with no payload is closed.
- `useChromePopover.tsx`'s tallest-of-registered-height registry is **deleted**. With
  no inset to compute there is nothing to arbitrate.

### 9.3 Presentational split

Each popover becomes a container in the chrome (owns state, IPC, actions) plus a
**presentational view** that is pure props → markup and is rendered by the surface:

| popover   | container (chrome)                                  | view (surface)                   |
| --------- | --------------------------------------------------- | -------------------------------- |
| omnibox   | `useOmnibox`                                        | `OmniboxDropdown` (already pure) |
| site info | `AddressBar`                                        | site-identity panel              |
| shield    | `useAdblock` + `useFingerprint` + `useWebrtcExempt` | shield popover panel             |
| zoom      | `useZoom`                                           | zoom panel                       |

The views are ordinary React components, so they remain unit-testable in jsdom by
rendering them directly. Interactive controls inside the shield and zoom panels emit
`action` values rather than calling hooks.

### 9.4 Keyboard never crosses the boundary

Focus stays in the chrome's address input. ↑/↓/Enter/Escape are already handled there
(`AddressBar.tsx`); they move `activeIndex` in chrome state, which is sent to the
surface as part of the payload. The surface never takes focus and never handles keys.

This removes the need for the existing `onMouseDown` + `preventDefault` trick — the
input cannot lose focus to the surface, because the surface is a different webview.

### 9.5 Deletions and test consequences

- `useChromePopoverInset` and `useChromePopover.tsx` are deleted.
- `App.tsx:249` becomes `contentTop = chrome.topInset`; the `popoverInset` term goes.
- **`platformContract.drift.test.ts` must be updated, not deleted.** Its rule — every
  component using `useMeasuredHeight` must also call `useChromePopoverInset` — will
  fail the moment the popovers stop registering an inset. Replace it with the
  equivalent: every component using `useMeasuredRect` must also call
  `usePopoverSurface`, keeping the mutation recipe (add a component that measures a
  popover without registering it; the guard must go red and name the file).
  **DONE 2026-10-05, and the two rules COEXIST rather than replacing** — Phase 3 moves only
  the omnibox, so `AdblockShield`, the site-info popover and `ZoomIndicator` are still on the
  inset path and the original rule still has three offenders to name. Phase 4 deletes it with
  `useChromePopover.tsx`. Four rules were added rather than one: the `useMeasuredRect` →
  `usePopoverSurface` linkage; that `AddressBar` registers the `address-site` inset and NOT
  `address-omnibox` (the one-line change that puts the oscillation back, invisible in a
  screenshot); that `OMNIBOX_ACTIONS` declares both `pick` and `hover` (`hover` is easy to
  forget and its absence only shows as Enter opening the wrong row); and that the surface is
  `aria-hidden` while the chrome's copy is hidden with `opacity` — never `visibility: hidden`
  or `display: none`, either of which would leave the input's `aria-controls` dangling.
- `useChromePopover.test.tsx`'s registry tests go with the registry.

### 9.6 As built (Phase 4) — what §9.5 above predicted, and the two rules it did not

Both deletions happened, and `contentTop` is `chrome.topInset`. The `useMeasuredRect` →
`usePopoverSurface` linkage rule stayed, but the inset rule is **gone rather than replaced**,
because with all four popovers on the surface there is nothing left for it to police — so
`platformContract.drift.test.ts` now pins the deletion itself in three ways: the two modules are
**absent**, **no** renderer file imports them (a derived scan, comment-stripped, excluding the
test's own pattern), and `contentTop` is exactly `chrome.topInset`.

Two further rules were added while moving the last three:

- **The hidden-copy CSS rule is pinned as a GROUPED selector covering all four popovers**, and
  its `.aegis-mobile` override must cover all four too. A grouped selector is easy to extend on
  the desktop side and forget on the mobile side, and that failure is four popovers invisible on
  a platform with **no automated gate and no AppImage build**.
- **Every registered kind renders from a MINIMAL valid payload.** A panel that is registered but
  cannot render is a blank popover over the page with no error anywhere, and a shared fixture
  would have hidden exactly that: the site panel needs seven fields the zoom panel does not.

The one thing §9.5 did not anticipate is §12.1's Focus Visible regression, because it is a
property of `useDialog` and this section is about placement.

---

## 10. Cross-platform

| platform | mechanism                                                                                                 | status                                              |
| -------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Linux    | custom container; surface registered topmost                                                              | primary target                                      |
| Windows  | `set_bounds` + show/hide ordering; the surface joins the per-webview set already managed in `apply_inset` | needs a stacking check against WebView2 child HWNDs |
| macOS    | `set_bounds`; WKWebView z-order via view ordering                                                         | needs the same check                                |
| Android  | **none**                                                                                                  | out of scope                                        |

Android is excluded because its content area is a native Kotlin `WebView` in a native
layout, not a Tauri child webview; `MobileApp` already lowers it through
`view.setChromeOverlay`. An equivalent overlay there is a different mechanism and is
not attempted. The mobile popovers keep their current behaviour.

Per the repo's parity rule, Linux/Windows/macOS must all land at the same level before
this is called done. macOS remains CI-compile-only.

---

## 11. One deliberate visual change

`.adblock-shield__popover` currently uses `background: var(--glass-3)`, because it
floats over live page content. The other three already use solid `var(--bg-elevated)`.

It becomes solid. This is what lets the surface be opaque (§6.5) and is consistent with
the other three. It is a visible change to one popover and is accepted deliberately.

---

## 12. Accessibility — the accepted regression

`aria-activedescendant` cannot reference an element in another document, so the
listbox cannot stay in the chrome while its options render in the surface.

**Mitigation:** the surface is `aria-hidden="true"` and purely presentational. The
chrome's input keeps `role=combobox`, `aria-expanded`, and a visually-hidden
`aria-live="polite"` region announcing e.g. "3 of 8, <title>, history".

**What is lost:** a screen-reader user can no longer navigate into the list and click
an option. Arrow keys plus Enter still select. This is a real regression, accepted in
exchange for popovers that overlay the page rather than displace it.

### 12.1 A SECOND, LARGER regression the design did not anticipate (Phase 4)

§12 was written about the **omnibox**, whose rows are `<div role="option">` with no tab
stop — so the chrome's hidden copy stays reachable by keyboard with nothing lost but the
screen-reader _click_. The other three popovers are `role="dialog"` with `useDialog`'s
**focus trap** and focusable action buttons, and the rule that makes the chrome's copy the
accessible one (focus cannot cross a document, and the surface is `aria-hidden`) therefore
leaves their focus trap and their tab stops on an `opacity: 0` element.

Keyboard activation still **works** — Enter on the invisible button runs the real handler and
the visible surface copy updates — but there is **no visible focus ring**. That is a WCAG
2.4.7 Focus Visible failure, and it is a bigger cost than the omnibox's.

The alternatives were weighed and are both worse:

| option                                                            | consequence                                                                                       |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `aria-hidden` + non-focusable chrome copy, surface copy focusable | keyboard users **cannot reach the popover at all** — silently unreachable is worse than invisible |
| hand focus into the surface webview from Rust                     | the surface would own Escape and the arrow keys, contradicting §9.4, and is a project in itself   |

**The real fix is the second one**, and it is deliberately not in this change. The accepted
regression is recorded in `CHANGELOG.md` and in `src-tauri/AGENTS.md` gotcha (h) rather than
buried here, because a user hitting it must be able to find it.

**Android is unaffected by construction:** there is no surface there (one webview, native
content lowered through `view.setChromeOverlay`), so the chrome's copy IS the visible popover
and the hidden-copy rule carries an explicit `.aegis-mobile` override. That override is
pinned by a test, because applying the desktop rule on Android deletes all four popovers and
**no desktop test and no AppImage can see it.**

---

## 13. Verification

**Automated gates**

- `cargo test --lib` — container preferred-size contract, rect→position mapping,
  capability boundary, popover channel validation.
- `npm test` — `useMeasuredRect`, `usePopoverSurface`, the four presentational views,
  the rewritten drift rule, `ipcClient.contract.test.ts` rows for the new channel/event.
- clippy `--all-targets`, `cargo fmt --check`, prettier, and the
  windows-gnu + android + macOS cross-checks.

**Measured, not asserted**

- Oscillation rate with the dropdown open: **~57/s today, must read 0.** This is a
  number, so it is automatable unattended via the same instrumented-AppImage technique.
  **Done 2026-10-05, and measured as an ABSENCE rather than a rate** — see §13.1.
- Container probe: shrink, grow **and** collapse in one run (§5.5). **Done 2026-10-04.**
- Surface stacking probe: which of two webviews paints on top (§6.4). **Done
  2026-10-04**, by draw order rather than by pixel — this host's Xwayland surface is
  never mapped into the X server, so there are no pixels to read (§6.4). **Phase 2's
  live AppImage run did not upgrade it to "seen"**: the same four pixel routes are still
  dead on the real binary (§6.4a). It is now "child order + GTK draw traversal +
  `topmost=true` in a live run", and the remaining check is the owner's eyes on a real
  desktop.
- **Phase 2's gate:** the surface renders a test payload, stacked above content, from a
  targeted emit, and a pick round-trips back through Rust's validation. **Done
  2026-10-04** (§6.4a).

### 13.1 Phase 3, measured — the oscillation gate, as an absence

AppImage md5 `b290d892b17149ac649289d568415528`, isolated profile seeded with 40 history rows
that all match the typed query, so the dropdown reaches its full 8 rows (measured 378 px tall,
just under the 384 px cap). The omnibox is driven from inside the app — synthetic input is not
delivered to this WebKitGTK app on this host — by focusing the real input and dispatching a
native `input` event per character, and a row is then pressed **on the surface** by dispatching
a `mousedown` in that webview.

| build | what it is                                                       | `setContentInset` writes         | final top |
| ----- | ---------------------------------------------------------------- | -------------------------------- | --------- |
| **A** | the shipping code — omnibox on the surface                       | **2** (both at boot, none after) | **156**   |
| **B** | one line re-added: `useChromePopoverInset('address-omnibox', …)` | 5                                | **276**   |

The dropdown opened in both, at the same place, with the surface placed at the same rect
(`x:149 y:121 w:765`), and `popover_picked id=address-omnibox index=Some(0) accepted=true` in
both. Build B's top is 156 + 120 — **exactly the dropdown's height**. So:

- **The page does not move.** 156 in the shipping build; 276 with the inset line restored.
- **The oscillation is gone as an absence, not as a rate.** There is no longer _any path_ from
  the dropdown's geometry to `setContentInset`, so no rate can be produced. **The historical
  ~57/s figure was deliberately not reproduced**: it needed the dropdown's height to be an input
  to the inset, and it no longer is. Quoting "0/s" against a defect that cannot be expressed
  would be a weaker and slightly dishonest claim than this one.

**What this measurement needed three times to become trustworthy**, recorded because each
failure read as a legitimate negative:

1. The first two runs showed only 2 rows on a profile seeded with 40, and **the dropdown never
   opened at all** in an earlier run — a profile with no history cannot open it, so "0 inset
   writes" is also what a run where nothing happened reports. The fix was the **differential
   above**: Build B proves the rig opens the dropdown, because Build B's inset moves.
2. The history store is a **bare JSON array**, not `{ entries: [...] }`. Seeded wrong, the app
   read nothing, rewrote the file, and left the two query-derived rows — which look like a
   working dropdown.
3. The rig **appended** to the field's seeded URL instead of replacing it, so the query was
   `http://…/index.htmlalpha` and matched nothing. First keystroke must replace.
4. Two dead ends worth not repeating: `withGlobalTauri` is **off**, so `window.__TAURI__` does
   not exist in the chrome and a renderer script cannot call `invoke` for a readback; and
   `app.webview_windows()` is **empty** on this host, so there is no `WebviewWindow::title()` to
   read a `document.title` back through. `Webview::title()` does not exist at all in Tauri 2.11.3.

**Not verifiable here, as always:** pixels (§6.4a) and click routing by a real pointer — the
surface row was pressed by dispatching a real `mousedown` _inside that webview_, which exercises
the panel's handler and the whole IPC path, but not the compositor's hit testing.

**A note on what the automated gates did and did not catch here**, because it changes how
much the green suite is worth: the live AppImage run found **three** defects that
**1 916 frontend and 788 Rust green tests did not** — a field-shape mismatch across the
Rust/TypeScript boundary (§7.2), a permanently lost first payload (§7.3), and a
capability scoped on an axis that matched nothing (§8.1). Each side of every one of
those had its own passing test. The cross-language contract is now pinned from the Rust
source's own key paths, but the honest conclusion is that **a green suite is weak
evidence for a boundary between two languages**, and only the running binary settles it.

**Not verifiable on this host**

Anything requiring synthetic input: click routing into the surface, hover, focus, and
the keyboard path end-to-end. GTK/XTEST input is not delivered to this app on this box
(measured, repeatedly), so those are reported as **pending hardware verification**,
never as tested. Shadow clipping is judged by screenshot, which is possible here.

---

## 14. Phasing

| phase | deliverable                              | gate                                                                                             | status              |
| ----- | ---------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------- |
| 0     | **two throwaway probes** (§5.5, §6.4)    | container: shrink and collapse both correct in one run; surface: stacked above a content webview | **done 2026-10-04** |
| 1     | `aegis_container.rs` replaces `GtkFixed` | probe green; oscillation gone; window shrinks; all existing `linux_layout` tests updated         | **done 2026-10-04** |
| 2     | `popover.rs` + second entry + capability | surface renders a test payload, stacked above content                                            | **done 2026-10-04** |
| 3     | omnibox moved                            | oscillation 0 while typing; page does not move                                                   | **done 2026-10-05** |
| 4     | site info, shield, zoom moved            | `useChromePopoverInset` deleted                                                                  | **done 2026-10-05** |
| 5     | drift-test rewrite, docs, CHANGELOG      | full battery green                                                                               | pending             |

Phase 0 also settled the one decision that was open when this document was written: the
container is a **`GtkFixed` subclass**, not a `gtk::Container` subclass (§5), and child
order alone does stack two webviews (§6.2). Neither finding changed any requirement, so
no phase boundary moved.

Phase 1 alone fixes the reported symptom's flash. Phase 3 completes it. Phases 4–5
exist so the mechanism is not left half-built.

---

## 15. Risks

| risk                                                                                                                                                                                                                           | mitigation                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **WebKit-vs-WebKit stacking order does not follow child order.** The surface is a _webview_, not a plain GTK widget, so the exit-button precedent does not cover it — this was the load-bearing assumption of the whole design | **RESOLVED 2026-10-04 by probe B (§6.4): child order holds**, controls + mutation-verified, and the live AppImage run reports `topmost=true` (§6.4a). Re-registration retained. Not upgraded to _seen_ — no pixels are obtainable on this host                                                                                                                       |
| Content webviews accidentally gain IPC                                                                                                                                                                                         | **RESOLVED, and it was a live hole.** Both files are `webviews`-scoped; `webviews: ["main"]` excludes every content webview because content webviews have their own labels. Before the app manifest existed there was no ACL check at all on a local-origin command, so "the capability excludes them" was never what kept them out — their remote origin was (§8.1) |
| Two React roots drift on shared CSS                                                                                                                                                                                            | Both entries import the one `index.css`; a test asserts both entry files reference it                                                                                                                                                                                                                                                                                |
| Container regresses window shrinkability                                                                                                                                                                                       | §5.5 probe measures both properties in one run, every phase                                                                                                                                                                                                                                                                                                          |
| macOS z-order differs from GTK                                                                                                                                                                                                 | Left unverified; macOS is CI-compile-only on this host. Report honestly rather than inferring from Linux.                                                                                                                                                                                                                                                            |
