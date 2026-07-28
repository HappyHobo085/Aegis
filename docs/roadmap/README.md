# Aegis Improvement Roadmap

> **Created:** 2026-07-24
> **Status:** Active
> **Instruction:** Each phase plan should be DELETED after its implementation is complete.

---

## Overview

Seven phases to improve Aegis across UI/UX, features, parity, and performance.
Each phase has a **spec** (design) and a **plan** (implementation). Plans are
deleted after the phase ships.

---

## Phase 0 — Glass Morphism UI Redesign

|               |             |
| ------------- | ----------- |
| **Impact**    | High        |
| **Effort**    | Medium      |
| **Platforms** | All         |
| **Status**    | Not started |

Frosted-glass surfaces, layered depth, soft rounded corners, subtle gradients,
spring-like transitions. Full visual transformation of the chrome without
behavioral changes.

- Spec: `phase-0-glass-morphism-spec.md` (links to full design in `docs/superpowers/specs/`)
- Plan: `phase-0-glass-morphism-plan.md` (11 tasks)

---

## Phase 1 — Vault Autofill + Sync (Phase B)

|               |                                                        |
| ------------- | ------------------------------------------------------ |
| **Impact**    | High                                                   |
| **Effort**    | High                                                   |
| **Platforms** | All                                                    |
| **Status**    | Not started (spec + plan exist in `docs/superpowers/`) |

Detect login forms, suggest matching credentials, auto-fill on click, save new
credentials after submission. Sync vault records across devices via existing
E2E sync infrastructure.

- Spec: `docs/superpowers/specs/2026-07-23-vault-autofill-sync-design.md`
- Plan: `docs/superpowers/plans/2026-07-23-vault-autofill-sync.md`

---

## Phase 2 — Platform Parity Gaps

|               |                |
| ------------- | -------------- |
| **Impact**    | Medium         |
| **Effort**    | Medium         |
| **Platforms** | macOS, Android |
| **Status**    | Not started    |

Close the cross-platform feature gaps: macOS proxy, Android fp-allowlist,
macOS find-in-page enhancement, element picker cross-platform.

- Spec: `phase-2-parity-gaps-spec.md`
- Plan: `phase-2-parity-gaps-plan.md` (7 tasks)

---

## Phase 3 — Workspaces (Named Tab Groups)

|               |             |
| ------------- | ----------- |
| **Impact**    | High        |
| **Effort**    | Medium      |
| **Platforms** | All         |
| **Status**    | Not started |

Named, color-coded workspace groups with separate tab lists and pinned tabs per
workspace. Quick-switch keyboard shortcut. Extends the existing tab registry.

- Spec: `phase-3-workspaces-spec.md`
- Plan: `phase-3-workspaces-plan.md` (14 tasks)

---

## Phase 4 — Command Palette Enhancement

|               |             |
| ------------- | ----------- |
| **Impact**    | Medium-High |
| **Effort**    | Low-Medium  |
| **Platforms** | All         |
| **Status**    | Not started |

Enrich the existing Ctrl+K palette with fuzzy search across tabs, bookmarks,
history, and actions. Categorized results, keyboard navigation, recent actions.

- Spec: `phase-4-command-palette-spec.md`
- Plan: `phase-4-command-palette-plan.md` (9 tasks)

---

## Phase 5 — Performance & Polish

|               |             |
| ------------- | ----------- |
| **Impact**    | Medium      |
| **Effort**    | Low-Medium  |
| **Platforms** | All         |
| **Status**    | Not started |

Lazy-load heavy settings tabs, bundle analysis, startup profiling, React
effect cleanup audit, injection pipeline optimization, tab idle sweep tuning.

- Spec: `phase-5-performance-spec.md`
- Plan: `phase-5-performance-plan.md` (10 tasks)

---

## Phase 6 — Split View

|               |                                 |
| ------------- | ------------------------------- |
| **Impact**    | Medium                          |
| **Effort**    | High                            |
| **Platforms** | Linux first, then Windows/macOS |
| **Status**    | Not started                     |

Display 2-4 tabs side-by-side. Drag-to-split, keyboard shortcut, resize
handles. Extends the existing multi-webview architecture.

- Spec: `phase-6-split-view-spec.md`
- Plan: `phase-6-split-view-plan.md` (14 tasks)

---

## Recommended Execution Order

```
Phase 0 (UI) ──────────────────────────────┐
Phase 2 (Parity) ──────────────────────────┤  ← Start here (parallelizable)
Phase 4 (Command Palette) ─────────────────┘
Phase 5 (Performance) ─────────────────────  ← Anytime
Phase 1 (Vault Autofill) ──────────────────  ← After Phase 0 (visual foundation)
Phase 3 (Workspaces) ──────────────────────  ← After Phase 0
Phase 6 (Split View) ──────────────────────  ← Last (most complex, depends on Phase 3)
```

Phases 0, 2, 4, and 5 are independent and can be parallelized.
Phase 1 benefits from Phase 0's visual foundation.
Phase 3 benefits from Phase 0's visual foundation.
Phase 6 depends on Phase 3 (workspaces + split interaction).
