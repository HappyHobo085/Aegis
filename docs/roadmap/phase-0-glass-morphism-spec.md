# Phase 0 — Glass Morphism UI Redesign: Spec Summary

> **Full design spec:** [`docs/superpowers/specs/ui-redesign-glass-morphism.md`](../superpowers/specs/ui-redesign-glass-morphism.md)
> **Visual mockup:** `docs/ui-redesign-mockup.html`

---

## Design Direction

A **glass morphism** visual transformation — frosted-glass surfaces with layered depth, soft rounded corners, subtle gradients, and spring-like transitions. Inspired by Arc browser and macOS Sonoma. The goal is a modern, premium chrome aesthetic while preserving every existing feature and interaction.

## Scope

| Surface               | Key Changes                                                                                    |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| **Desktop tab strip** | Edge-to-edge, 40px tall, dark glass bg, accent gradient underline on active tab                |
| **Toolbar**           | 48px tall, `glass-1` bg with `backdrop-filter`, pill-shaped address bar with accent focus glow |
| **Bookmarks bar**     | 36px tall, `glass-0` bg, pill-shaped chips with hover glass effect                             |
| **Sidebar**           | 320px wide (was 280), `glass-3` bg with blur, default tab = Saved                              |
| **Settings modal**    | Glass card overlay with `blur(30px)`, grouped left rail with accent indicators                 |
| **Shield popover**    | `glass-2` bg, blur backdrop, rounded `r-lg`                                                    |
| **Mobile chrome**     | Inline shield in address bar, new bookmarks bar chip strip, fullscreen button on bottom bar    |
| **Overlays**          | ErrorOverlay, SafetyInterstitial, ConfirmDialog get glass treatment                            |

## What's NOT Included

- **No functionality changes** — every existing feature, IPC channel, and user interaction is preserved identically
- **No backend/Rust changes** — purely CSS + React component styling
- **No autopilot test updates** — test coverage adjustments are a follow-up commit
- **No layout constant changes in this phase** — height/width adjustments (`TOOLBAR_H`, `TABSTRIP_H`, etc.) are deferred to a separate commit to keep the visual diff clean

## Key Design Tokens

| Category        | Tokens                                                    | Summary                                                          |
| --------------- | --------------------------------------------------------- | ---------------------------------------------------------------- |
| **Shape**       | `--r-xs` through `--r-pill`                               | 6px–999px radius scale; softer than current                      |
| **Typography**  | `--fs-1` through `--fs-8`, `--font: Inter`                | Inter font family; unchanged sizes except `--fs-7` bumps 22→24px |
| **Accent**      | `--accent: #6366f1`, `--accent-gradient`, `--accent-glow` | Shift from blue (#2563eb) to indigo-violet; gradient adds depth  |
| **Glass tiers** | `--glass-0` through `--glass-3`, `--glass-border`         | 4 elevation tiers (wash → modal); separate dark/light values     |
| **Blur**        | `--blur-1`/`--blur-2`/`--blur-3`/`--blur-bg`              | 20/24/30/8px backdrop-filter blur                                |
| **Shadows**     | `--shadow-1`/`--shadow-2`/`--shadow-3`                    | Subtle → modal depth progression                                 |
| **Motion**      | `--ease`, `--spring`, `--duration`                        | Standard + spring bounce easing; 0.2s base duration              |

## Success Criteria

1. **Visual transformation complete** — every chrome surface uses the new glass token system
2. **Dark + light themes consistent** — all tokens defined in both `[data-theme="dark"]` and `[data-theme="light"]`; no hardcoded colors
3. **Zero behavioral changes** — all existing functionality works identically (browse, ad-block, tabs, sidebar, settings, mobile)
4. **`npm test` passes** — no test regressions from CSS-only changes
5. **Accessibility preserved** — WCAG AA contrast ratios, focus rings, `prefers-reduced-motion` block, touch targets ≥44px
