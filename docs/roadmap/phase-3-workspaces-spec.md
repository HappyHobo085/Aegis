# Phase 3 — Workspaces (Named Tab Groups): Spec

## What

Named, color-coded workspace groups. Each workspace owns its own set of tabs and
pinned tabs. Users switch between workspaces instantly — opening a workspace
hides the previous workspace's tabs and shows its own. A default workspace
("General") exists from first run.

## Why

Modern browsers (Arc, Zen, Vivaldi, Chrome) all ship tab grouping or workspaces.
Users managing 11+ tabs need project-based or context-based organization: a
"Work" workspace with pinned Jira/GitHub tabs, a "Personal" workspace with
streaming/social tabs, etc. Without workspaces the tab strip becomes
unmanageable; with them, switching contexts is a single click.

## Design

### Data model

```ts
interface Workspace {
  id: string; // stable UUID-like id (e.g. "ws-default", "ws-abc123")
  name: string; // user-editable label ("Work", "Personal", …)
  color: string; // theme-token name or hex ("blue", "emerald", "#6366f1")
  tabIndex: number; // display order (0-based, controls the workspace switcher order)
}
```

Each tab belongs to exactly one workspace (via a `workspaceId` field on
`TabMeta`). The active workspace determines which tabs appear in the TabStrip.

### Storage

- **In-memory (Rust core):** `tab_registry.rs` holds the workspace list, the
  active workspace id, and the tab→workspace mapping. The registry's
  `tabs_state()` returns only tabs belonging to the active workspace.
- **On-disk:** persisted in `tabs.json` alongside the existing tab list. The
  `PersistedSession` gains a `workspaces` field and each `PersistedTab` gains a
  `workspaceId` field.

### IPC

New channel namespace `workspace.*`:

| Channel              | Payload                                | Returns       |
| -------------------- | -------------------------------------- | ------------- |
| `workspace.list`     | —                                      | `Workspace[]` |
| `workspace.create`   | `{ name, color? }`                     | `Workspace`   |
| `workspace.switch`   | `{ id }`                               | `TabsState`   |
| `workspace.rename`   | `{ id, name }`                         | `Workspace`   |
| `workspace.setColor` | `{ id, color }`                        | `Workspace`   |
| `workspace.remove`   | `{ id }` (moves tabs to default first) | `TabsState`   |
| `workspace.reorder`  | `{ ids: string[] }`                    | `Workspace[]` |

Event: `workspace.state` — emitted after every workspace mutation so the chrome
stays in sync.

### UI

- **WorkspaceSwitcher:** a horizontal bar below (or inside) the `TabStrip`. Each
  workspace is a colored pill/pill-button showing its name. Active workspace is
  highlighted. Clicking switches instantly. A "+" button creates a new workspace.
  Right-click or long-press offers rename/color/reorder/delete.
- **TabStrip filtering:** `tabs_state()` returns only the active workspace's
  tabs, so `TabStrip` rendering is unchanged — it just sees fewer tabs.
- **Default workspace ("General"):** created on first run with `color: "slate"`.
  Cannot be deleted (only renamed).
- **Tab assignment:** new tabs are created in the active workspace. Moving a tab
  between workspaces is a follow-up (drag-to-workspace or context menu).
- **Cross-platform:** all platforms get workspaces. Mobile: `MobileTabSwitcher`
  shows workspace pills at the top; the tab list filters accordingly.

### Scope boundaries

| In scope (v1)                       | Out of scope (follow-up)                |
| ----------------------------------- | --------------------------------------- |
| Create / rename / recolor / delete  | Workspace-specific cookie jars/profiles |
| Switch workspaces (instant)         | AI auto-routing of tabs to workspaces   |
| Tabs isolated per workspace         | Workspace sync across devices           |
| Default "General" workspace         | Drag-to-move tabs between workspaces    |
| Session persistence across restarts | Workspace-specific ad-block allowlists  |
| Per-workspace pinned tabs           | Workspace icons / avatars               |

### Non-goals

- **Workspace-specific profiles/cookie jars:** each workspace uses the same
  browser profile. This is a deliberate v1 simplification — isolating cookies
  per workspace requires a separate webview user-data-folder per workspace
  (Windows gotcha 23) and is a substantial follow-up.
- **AI auto-routing:** automatically assigning tabs to workspaces based on URL
  heuristics. Deferred to a future phase.
- **Workspace sync across devices:** workspaces are local-only in v1. Syncing
  workspace metadata across devices is a future sync-engine extension.

## Success criteria

1. Users can create, rename, recolor, reorder, and delete workspaces.
2. Each workspace has its own independent tab list and pinned tabs.
3. Switching workspaces instantly hides the old tabs and shows the new tabs.
4. The active workspace persists across browser restarts (session file).
5. The default "General" workspace always exists and cannot be deleted.
6. New tabs are created in the current workspace.
7. `npm test` and `cargo test` pass.
