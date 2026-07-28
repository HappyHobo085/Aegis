# Phase 6: Split View — Spec

> **Status:** Draft
> **Effort:** High
> **Impact:** Medium
> **Platforms:** Linux first, then Windows/macOS

---

## 1. What

Split view — display 2-4 tabs side-by-side in one window. Each pane shows a
different tab's content webview simultaneously.

## 2. Why

Table-stakes in 2026. Chrome, Arc, Zen, and Vivaldi all ship split view.
Users doing research, comparison, or referencing need parallel views without
multiple windows.

## 3. Design

### 3.1 Split modes

| Mode   | Layout       | Description                       |
| ------ | ------------ | --------------------------------- |
| 2-pane | Side-by-side | Two tabs, equal width             |
| 3-pane | 1 + 2        | One tall pane + two stacked panes |
| 4-pane | 2×2 grid     | Four equal quadrants              |

### 3.2 Activation

- **Drag-to-split:** Drag a tab from the TabStrip onto another tab → enters 2-pane split
- **Keyboard:** `Ctrl+Shift+S` → splits active tab with next tab
- **Context menu:** "Split view" option on tab right-click (follow-up)

### 3.3 Behavior

- Each pane has its own content webview (already spawned as background tabs)
- Chrome webview resizes to accommodate multiple content panes
- Address bar reflects the **focused** pane (click a pane to focus it)
- Resize handles between panes (draggable dividers)
- Exit split: close a pane (remaining panes fill space), or drag a tab out
- Pinned tabs can participate in split view
- Private tabs can participate in split view

### 3.4 Layout computation

The existing `computeContentLayout` in `src/lib/contentLayout.ts` handles single-pane
layout. Split view extends this to compute per-pane rectangles:

```
Single:  [content fills inset area]
2-pane:  [pane1 | pane2]  (50/50 split)
3-pane:  [pane1 | pane2]  (50/50 top)
         [      | pane3]  (50/50 bottom-right)
4-pane:  [pane1 | pane2]
         [pane3 | pane4]
```

### 3.5 Per-platform

| Platform | Mechanism                                                     | Status                                   |
| -------- | ------------------------------------------------------------- | ---------------------------------------- |
| Linux    | `GtkFixed` child positioning (existing multi-webview pattern) | Feasible — same pattern as tab switching |
| Windows  | WebView2 `set_bounds` on each controller                      | Feasible — existing `set_bounds` usage   |
| macOS    | `WKWebView` frame positioning                                 | CI-compile-only, needs Mac developer     |
| Android  | Not applicable (single webview)                               | N/A                                      |

## 4. Non-Goals

- Cross-platform parity in v1 (Linux first)
- More than 4 panes
- Detaching panes into separate windows (follow-up)
- Synced scrolling between panes (follow-up)
- Tab tiling across workspaces (Phase 3 dependency)

## 5. Success Criteria

- Users can view 2-4 tabs simultaneously on Linux
- Panes are independently scrollable
- Resize handles work smoothly
- Address bar reflects focused pane
- No crash or layout glitch when entering/exiting split
- `cargo test` and `npm test` green
