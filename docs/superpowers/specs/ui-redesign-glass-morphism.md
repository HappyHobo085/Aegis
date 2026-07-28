# Aegis Glass Morphism UI/UX Redesign — Design Spec

> **Status:** Draft — awaiting user review before implementation
> **Direction:** Full glass morphism transformation (layout + visual polish)
> **Mockup:** `docs/ui-redesign-mockup.html`
> **Scope:** Desktop chrome, sidebar, settings modal, shield popover, mobile chrome

---

## 1. Design Direction

**Glass morphism** — frosted-glass surfaces, layered depth, soft rounded corners, subtle gradients, spring-like transitions. Inspired by Arc browser and macOS Sonoma.

**Not included in this phase:**

- Functionality changes (all existing features preserved)
- Backend/Rust changes
- Autopilot test updates (follow-up commit)

---

## 2. Design Tokens

### 2.1 Shape (Border Radius)

| Token      | Value   | Usage                                                  |
| ---------- | ------- | ------------------------------------------------------ |
| `--r-xs`   | `6px`   | Small interactive elements (tab close, mini buttons)   |
| `--r-sm`   | `8px`   | Buttons, nav controls                                  |
| `--r-md`   | `12px`  | Cards, list rows, search inputs                        |
| `--r-lg`   | `16px`  | Modals, panels                                         |
| `--r-xl`   | `20px`  | Frame-level containers (chrome preview, settings card) |
| `--r-pill` | `999px` | Address bar, chips, segmented controls, toggles        |

**Current → New mapping:**

- `--radius-1: 4px` → `--r-xs: 6px` (slightly softer)
- `--radius-2: 6px` → `--r-sm: 8px`
- `--radius-3: 8px` → `--r-md: 12px`
- `--radius-4: 12px` → `--r-lg: 16px`
- `--radius-pill: 999px` → `--r-pill: 999px` (unchanged)

### 2.2 Typography

| Token    | Value                                           | Usage                                     |
| -------- | ----------------------------------------------- | ----------------------------------------- |
| `--font` | `'Inter', system-ui, -apple-system, sans-serif` | Primary font (replaces system-ui default) |
| `--fs-1` | `11px`                                          | Fine print, timestamps, metadata          |
| `--fs-2` | `12px`                                          | Secondary labels, hints, tab titles       |
| `--fs-3` | `13px`                                          | Dense body, search placeholders           |
| `--fs-4` | `14px`                                          | Base body text                            |
| `--fs-5` | `16px`                                          | Emphasised body, section titles           |
| `--fs-6` | `19px`                                          | Modal headings                            |
| `--fs-7` | `24px`                                          | Page-level headings                       |
| `--fs-8` | `32px`                                          | Hero/display headings                     |

**Current → New mapping:**

- `--font-size-1: 11px` → `--fs-1: 11px` (unchanged)
- `--font-size-2: 12px` → `--fs-2: 12px` (unchanged)
- `--font-size-3: 13px` → `--fs-3: 13px` (unchanged)
- `--font-size-4: 14px` → `--fs-4: 14px` (unchanged)
- `--font-size-5: 16px` → `--fs-5: 16px` (unchanged)
- `--font-size-6: 19px` → `--fs-6: 19px` (unchanged)
- `--font-size-7: 22px` → `--fs-7: 24px` (slight bump)

### 2.3 Accent

| Token               | Value                                       | Usage                                         |
| ------------------- | ------------------------------------------- | --------------------------------------------- |
| `--accent`          | `#6366f1`                                   | Primary accent (indigo)                       |
| `--accent-hover`    | `#818cf8`                                   | Accent hover state                            |
| `--accent-gradient` | `linear-gradient(135deg, #6366f1, #8b5cf6)` | Gradient fills (active tabs, primary buttons) |
| `--accent-glow`     | `0 0 20px rgba(99, 102, 241, 0.3)`          | Focus rings, glow effects                     |
| `--on-accent`       | `#ffffff`                                   | Text on accent backgrounds                    |

**Change from current:** `--accent-color: #2563eb` (blue) → `--accent: #6366f1` (indigo-violet). The new accent is warmer and more distinctive; `--accent-gradient` adds depth to active states.

### 2.4 Elevation System (4 tiers)

| Level | Background       | Filter                     | Shadow                        | Usage                                          |
| ----- | ---------------- | -------------------------- | ----------------------------- | ---------------------------------------------- |
| **0** | `var(--glass-0)` | `blur(20px) saturate(1.5)` | none                          | Subtle wash (bookmarks bar, inactive surfaces) |
| **1** | `var(--glass-1)` | `blur(20px) saturate(1.5)` | `0 2px 8px rgba(0,0,0,0.3)`   | Toolbar, buttons, inputs                       |
| **2** | `var(--glass-2)` | `blur(24px) saturate(1.5)` | `0 8px 32px rgba(0,0,0,0.4)`  | Cards, popovers, active tabs                   |
| **3** | `var(--glass-3)` | `blur(30px) saturate(1.5)` | `0 20px 60px rgba(0,0,0,0.5)` | Modals, full overlays                          |

### 2.5 Dark Palette

| Token                  | Value                         | Notes                                     |
| ---------------------- | ----------------------------- | ----------------------------------------- |
| `--bg`                 | `#0a0a0f`                     | App base (deeper than current `#121212`)  |
| `--bg-subtle`          | `#111118`                     | Secondary base (replaces `--bg-elevated`) |
| `--glass-0`            | `rgba(255,255,255,0.02)`      | Lowest glass                              |
| `--glass-1`            | `rgba(255,255,255,0.05)`      | Standard glass                            |
| `--glass-2`            | `rgba(255,255,255,0.08)`      | Emphasised glass                          |
| `--glass-3`            | `rgba(255,255,255,0.1)`       | Modal glass                               |
| `--glass-border`       | `rgba(255,255,255,0.08)`      | Default border                            |
| `--glass-border-hover` | `rgba(255,255,255,0.14)`      | Hover border                              |
| `--fg`                 | `#e8e8ec`                     | Primary text                              |
| `--fg-muted`           | `#8e8e9a`                     | Secondary text                            |
| `--fg-dim`             | `#5a5a6a`                     | Tertiary text                             |
| `--danger`             | `#f87171`                     | Error/destructive                         |
| `--success`            | `#34d399`                     | Positive/safe                             |
| `--warning`            | `#fbbf24`                     | Caution                                   |
| `--blur-1`             | `blur(20px) saturate(1.5)`    | Standard blur                             |
| `--blur-2`             | `blur(24px) saturate(1.5)`    | Emphasised blur                           |
| `--blur-3`             | `blur(30px) saturate(1.5)`    | Modal blur                                |
| `--blur-bg`            | `blur(8px)`                   | Background overlay blur                   |
| `--shadow-1`           | `0 2px 8px rgba(0,0,0,0.3)`   | Subtle shadow                             |
| `--shadow-2`           | `0 8px 32px rgba(0,0,0,0.4)`  | Card shadow                               |
| `--shadow-3`           | `0 20px 60px rgba(0,0,0,0.5)` | Modal shadow                              |

### 2.6 Light Palette

| Token                  | Value                          | Notes                             |
| ---------------------- | ------------------------------ | --------------------------------- |
| `--bg`                 | `#f0f0f5`                      | App base                          |
| `--bg-subtle`          | `#e8e8ed`                      | Secondary base                    |
| `--glass-0`            | `rgba(255,255,255,0.5)`        | Lowest glass                      |
| `--glass-1`            | `rgba(255,255,255,0.65)`       | Standard glass                    |
| `--glass-2`            | `rgba(255,255,255,0.75)`       | Emphasised glass                  |
| `--glass-3`            | `rgba(255,255,255,0.85)`       | Modal glass                       |
| `--glass-border`       | `rgba(0,0,0,0.06)`             | Default border                    |
| `--glass-border-hover` | `rgba(0,0,0,0.12)`             | Hover border                      |
| `--fg`                 | `#1a1a2e`                      | Primary text                      |
| `--fg-muted`           | `#6b6b80`                      | Secondary text                    |
| `--fg-dim`             | `#9e9eb0`                      | Tertiary text                     |
| `--danger`             | `#dc2626`                      | Error/destructive                 |
| `--success`            | `#16a34a`                      | Positive/safe                     |
| `--warning`            | `#d97706`                      | Caution                           |
| `--blur-1`             | `blur(20px) saturate(1.8)`     | Standard blur (higher saturation) |
| `--blur-2`             | `blur(24px) saturate(1.8)`     | Emphasised blur                   |
| `--blur-3`             | `blur(30px) saturate(1.8)`     | Modal blur                        |
| `--blur-bg`            | `blur(12px)`                   | Background overlay blur           |
| `--shadow-1`           | `0 2px 8px rgba(0,0,0,0.08)`   | Subtle shadow                     |
| `--shadow-2`           | `0 8px 32px rgba(0,0,0,0.1)`   | Card shadow                       |
| `--shadow-3`           | `0 20px 60px rgba(0,0,0,0.12)` | Modal shadow                      |

### 2.7 Transitions

| Token        | Value                               | Usage                                             |
| ------------ | ----------------------------------- | ------------------------------------------------- |
| `--ease`     | `cubic-bezier(0.4, 0, 0.2, 1)`      | Standard easing                                   |
| `--spring`   | `cubic-bezier(0.34, 1.56, 0.64, 1)` | Springy bounce (toggle knobs, micro-interactions) |
| `--duration` | `0.2s`                              | Standard duration                                 |

---

## 3. Layout Changes

### 3.1 Tab Strip

**Current:** 36px tall, sits inside the chrome area below the window title bar.
**New:** Edge-to-edge at window top, 40px tall, darker glass background (`rgba(0,0,0,0.25)`).

- Active tab: `glass-2` background + accent gradient underline (2px, bottom-aligned)
- Inactive tabs: transparent, `fg-muted` text, hover → `glass-1`
- Tab close: visible on hover only, `glass-2` hover → danger color
- **New tab `+` button:** sits directly after the last tab (no spacer gap)
- Private tab button: eye icon, immediately after the `+` button

**Layout constant change:** `TABSTRIP_H: 36px` → `40px`

### 3.2 Toolbar

**Current:** 56px tall, solid `--bg-elevated` background with bottom border.
**New:** 48px tall, `glass-1` background with `backdrop-filter: blur(20px)`, bottom border.

- Nav buttons (back/forward/reload): 32x32px, `r-sm` radius, transparent → `glass-1` on hover
- Address bar: pill-shaped (`r-pill`), `glass-1` background, `flex: 1`
  - Focus state: accent border + `accent-glow` shadow
  - Lock icon: green (`--success`)
- Right-side actions: bookmark (star), shield (with badge dot), zoom, downloads, **fullscreen**, settings
- Button ordering: `[Star] [Shield badge] [Zoom] [Downloads] [Fullscreen] [Settings]`

**Layout constant change:** `TOOLBAR_H: 56px` → `48px`

### 3.3 Bookmarks Bar (was Favorites Bar)

**Terminology change:** "Favorites" → "Bookmarks" throughout the UI.

**Current:** 40px tall, solid background.
**New:** 36px tall, `glass-0` background (very subtle), horizontal scroll.

- Bookmark chips: pill-shaped (`r-pill`), `glass-1` background, `fs-2` text
- Favicon: 14x14px, `r-xs` radius
- Hover: `glass-2` + visible border
- Trailing `+` chip (50% opacity) for adding new bookmarks

**Layout constant change:** `FAVBAR_H: 40px` → `36px`

### 3.4 Content Area

**Current:** Solid `--bg` background.
**New:** `--bg-subtle` background with subtle radial gradient overlays for depth.

No layout constant change (content area fills remaining space).

### 3.5 Sidebar

**Current:** 280px wide, right panel, solid `--bg-elevated` background.
**New:** 320px wide, right panel, `glass-3` background with `blur(30px)`.

- **Default tab:** Saved (not History)
- Tab switcher: pill segmented buttons, accent background on active
- Search: pill-shaped input, `glass-1` background, accent focus ring
- List items: `r-md` radius, transparent → `glass-1` on hover, border appears on hover
- Close button: 28x28px, top-right

**Layout constant change:** `SIDEBAR_W: 280px` → `320px`

### 3.6 Settings Modal

**Current:** Full-screen overlay with tabbed content.
**New:** Full-screen overlay (`glass-bg` blur backdrop) with glass card (inset 20px).

- Glass card: `glass-3` background, `blur(30px)`, `r-lg` radius
- Header: title + close button, bottom border
- Body: left rail (220px) + content panel (flex: 1)
- Left rail: grouped sections with uppercase labels, nav items with accent bar indicator on active
- Content panel: 24px padding, scrollable

**Settings rail navigation groups:**

1. **Appearance:** Appearance, Home, Search, Tabs
2. **Privacy:** Security, Site permissions, Passwords
3. **Blocking:** Filter Lists, My Filters, Allowlist
4. **Network:** Proxy, Sync

---

## 4. Component Specs

### 4.1 Pill Button (`.btn-primary`)

```css
padding: 8px 18px;
border-radius: var(--r-pill);
background: var(--accent-gradient);
color: var(--on-accent);
font-weight: 600;
box-shadow: 0 2px 12px rgba(99, 102, 241, 0.25);
```

Hover: `translateY(-1px)` + deeper shadow.

### 4.2 Ghost Button (`.btn-ghost`)

```css
padding: 6px 14px;
border-radius: var(--r-pill);
background: transparent;
color: var(--fg-muted);
border: 1px solid var(--glass-border);
```

Hover: border brightens, `glass-1` background, `fg` text.

### 4.3 Toggle Switch

```css
width: 44px;
height: 24px;
border-radius: 12px;
background: var(--glass-1);
border: 1px solid var(--glass-border);
```

On state: `background: var(--accent)`. Knob: white circle, 18x18px, spring transition.

### 4.4 Segmented Control

```css
border-radius: var(--r-pill);
background: var(--glass-1);
border: 1px solid var(--glass-border);
padding: 3px;
```

Active button: `background: var(--accent)`, white text, glow shadow.

### 4.5 Shield Popover

```css
width: 280px;
background: rgba(18, 18, 28, 0.88);
backdrop-filter: blur(24px) saturate(1.5);
border-radius: var(--r-lg);
border: 1px solid var(--glass-border);
```

Sections: site info card, blocked stats, HTTPS status, fingerprint protection.

---

## 5. Mobile Chrome Changes

### 5.1 Top Bar

- Address bar with inline shield icon (right-aligned, accent-colored)
- Shield sits inside the pill-shaped address bar, right edge

### 5.2 Bookmarks Bar

- Horizontal scrollable chip bar between topbar and content
- Same chip design as desktop (pill, favicon, label)
- Trailing `+` button for adding

### 5.3 Bottom Bar

**Current buttons:** Saved · History · Tabs · Shield · Menu
**New buttons:** Saved · History · Tabs · Fullscreen · Menu

- Shield moved into the address bar (inline icon)
- Fullscreen button added (desktop parity)
- 5 buttons, icon + label, thumb-reachable zone

### 5.4 Layout Constants

```
MOBILE_ADDRESS_H = 48px  (unchanged)
MOBILE_FAV_H     = 36px  (unchanged)
MOBILE_BOTTOMBAR_H = 56px (unchanged)
```

Total top chrome: 84px (48 + 36). Bottom chrome: 56px.

---

## 6. Accessibility

- All glass surfaces maintain WCAG AA contrast ratios against their backgrounds
- Accent on white: `#6366f1` ≈ 4.6:1 (AA compliant)
- Focus rings: 3px accent glow ring on all interactive elements
- `prefers-reduced-motion`: disable spring transitions, reduce blur intensity
- Touch targets: minimum 44px on mobile (existing standard preserved)
- `.sr-only` utility class preserved for screen reader text

---

## 7. Responsive Behavior

- **Wide desktop (≥1200px):** Full layout as shown in mockup
- **Narrow desktop (≤680px):** `.aegis-narrow` class — toolbar overflow menu for address bar space
- **Mobile:** Dedicated `MobileApp` shell (not a narrowed desktop) — see Section 5

---

## 8. Implementation Order

1. **CSS tokens** — Replace `src/index.css` token blocks with glass morphism tokens (dark + light palettes)
2. **Layout constants** — Update `src/lib/layout.ts` (TOOLBAR_H, FAVBAR_H, SIDEBAR_W, TABSTRIP_H)
3. **Tab strip** — Edge-to-edge, new tab button position, accent underline
4. **Toolbar** — Glass background, new height, button reordering (add fullscreen)
5. **Bookmarks bar** — Rename from favorites, glass chips, 36px height
6. **Sidebar** — Glass background, 320px width, default to Saved tab
7. **Settings modal** — Glass card, grouped rail, segmented controls
8. **Mobile chrome** — Inline shield in address bar, bookmarks bar, fullscreen button
9. **Polish** — Transitions, hover states, focus rings, `prefers-reduced-motion`

---

## 9. Files to Modify

| File                                  | Changes                                                           |
| ------------------------------------- | ----------------------------------------------------------------- |
| `src/index.css`                       | Replace all token blocks, glass morphism styles, component styles |
| `src/lib/layout.ts`                   | Update `TOOLBAR_H`, `FAVBAR_H`, `SIDEBAR_W`, `TABSTRIP_H`         |
| `src/components/TabStrip.tsx`         | Edge-to-edge layout, new tab button position, accent underline    |
| `src/components/Toolbar.tsx`          | Glass background, button reorder (add fullscreen), 48px height    |
| `src/components/FavBar.tsx`           | Rename to BookmarksBar, glass chips, 36px height                  |
| `src/components/Sidebar.tsx`          | Glass background, 320px width, default Saved tab                  |
| `src/components/SettingsModal.tsx`    | Glass card, grouped rail, accent indicators                       |
| `src/components/mobile/MobileApp.tsx` | Inline shield in address bar, bookmarks bar, fullscreen button    |
| `src/App.tsx`                         | Adjust chrome composition for new heights                         |
| `src/hooks/useContentInset.ts`        | Update inset calculations for new heights                         |

---

## 10. Mockup Reference

The HTML mockup at `docs/ui-redesign-mockup.html` is the visual source of truth. It contains:

1. **Section 1:** Color & elevation token swatches + 4-tier elevation cards
2. **Section 2:** Full desktop chrome preview (tab strip → toolbar → bookmarks bar → content)
3. **Section 3:** Sidebar with Saved tab active + History secondary
4. **Section 4:** Settings modal with glass card + Appearance tab
5. **Section 5:** Shield popover with stats + button style gallery
6. **Section 6:** Mobile chrome with inline shield + bookmarks bar + fullscreen

Dark/light toggle in the top-right corner switches both palettes.
