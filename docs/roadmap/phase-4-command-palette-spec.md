# Phase 4: Command Palette Enhancement — Spec

> **Status:** Draft
> **Effort:** Low-Medium
> **Impact:** Medium-High
> **Platforms:** All

---

## 1. What

Enhance the existing `CommandPalette` (Ctrl+K) from a basic action list into a
full Spotlight-style fuzzy search across tabs, bookmarks, history, and browser
actions.

## 2. Why

The command palette is the #1 UX innovation in modern browsers (Arc, Zen,
Vivaldi all ship one). Aegis has a basic palette that only lists a handful of
hardcoded actions. Enriching it with fuzzy search and multi-source results makes
every feature reachable in 2-3 keystrokes — the single biggest productivity
upgrade for power users.

## 3. Design

### 3.1 Result sources

| Source        | Data                                                                        | Example                              |
| ------------- | --------------------------------------------------------------------------- | ------------------------------------ |
| **Tabs**      | Open tabs (title + URL)                                                     | "GitHub" → switches to GitHub tab    |
| **Bookmarks** | Favorites list                                                              | "Wikipedia" → opens bookmark         |
| **History**   | Recent history entries                                                      | "reddit" → reopens from history      |
| **Actions**   | Browser actions (new tab, back, forward, reload, zoom, find, settings tabs) | "zoom" → shows zoom controls         |
| **Settings**  | Settings tab names                                                          | "security" → opens Security settings |

### 3.2 Search & ranking

- **Fuzzy matching** — substring match first, then Levenshtein distance for fuzzy
- **Ranking:** exact match > starts-with > contains > fuzzy
- **Searchable fields:** tab title, tab URL, bookmark name, bookmark URL, history title, history URL, action name, settings tab name
- No external dependencies — pure JS fuzzy search

### 3.3 Keyboard navigation

- `↑` / `↓` — move selection
- `Enter` — execute selected result
- `Esc` — close palette
- `Tab` — cycle through result categories (optional)

### 3.4 Visual layout

```
┌─────────────────────────────────────┐
│ 🔍 Search...                        │
├─────────────────────────────────────┤
│ Tabs                                │
│   ▸ GitHub - Aegis                  │
│   ▸ Stack Overflow                  │
│ Bookmarks                           │
│   ▸ Wikipedia                       │
│ Actions                             │
│   ▸ New Tab                         │
│   ▸ Zoom In                         │
│ Settings                            │
│   ▸ Security                        │
└─────────────────────────────────────┘
```

- Section headers for each category
- Highlighted matching text in results
- Scrollable if results overflow

### 3.5 Recent actions

- Track last 5 executed actions in localStorage
- Show as "Recent" section at top when palette is empty (no search query)

## 4. Non-Goals

- AI-powered suggestions
- Extension actions (no extension system yet)
- Profile/workspace switching (Phase 3)
- Cross-device tab results

## 5. Success Criteria

- Users can find any tab, bookmark, history entry, or action within 2-3 keystrokes
- Keyboard-only navigation works fully
- No performance jank with 100+ tabs open
- `npm test` green
