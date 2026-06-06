# Module Manager (Settings) — Design

**Date:** 2026-06-02
**Status:** Approved, implemented

## Problem

The POS-zira sidebar only shows modules that the salon's plan entitles (backend
entitlements) minus any `config.hiddenTabs`. There is no UI to see all modules
or turn them on/off, so cashiers can't tailor what shows on a given device, and
plan-locked modules can never be force-shown. Web has a module/feature view; the
desktop app lacks one.

## Goal

A "Modules" section in Settings that lists **all** modules and lets the user
show/hide each one **locally on this device**, including force-showing modules
the plan doesn't entitle.

## Decisions (from brainstorming)

1. **Local only** — toggles write `config.moduleOverrides`; never touch the salon
   plan / backend entitlements.
2. **Override the plan** — an explicit choice wins over entitlement: the user can
   force-show a module the plan doesn't include, or hide an entitled one.
3. **Lock `settings` on** — `settings` is always visible (escape hatch); every
   other module is toggleable.

## Data model

`AgentConfig.moduleOverrides?: Partial<Record<Tab, boolean>>`
- key present → explicit user choice (wins over entitlement)
- key absent → fall back to entitlement default
- New store schema key `moduleOverrides` (object, default `{}`).
- One-time idempotent migration folds legacy `hiddenTabs` → `moduleOverrides[tab]=false`
  (only when no explicit override exists, so re-enabled modules never re-hide).

## Visibility logic (`App.tsx getVisibleTabs`)

```
settings           -> always visible
override is boolean -> use it
otherwise          -> isFeatureEnabled(feature) && !hiddenTabs.includes(tab)
```

## Components

- **`ModuleManager.tsx`** (new) — reuses `MENU_GROUPS` exported from `Sidebar.tsx`
  (single source of grouping/icons/labels). Renders grouped rows with an inline
  toggle, an "outside plan" badge when not entitled, an "always on" lock for
  `settings`, and a "Reset to plan defaults" button (clears `moduleOverrides`).
  Props: `config`, `onConfigChange`, `isModuleEntitled(tab)`, `t`.
- **`Settings.tsx`** — new `modules` tab in the section tablist; renders
  `<ModuleManager/>`. New prop `isModuleEntitled` threaded from `App.tsx`
  (`tab => isFeatureEnabled(TAB_TO_FEATURE[tab])`) so entitlement logic stays in
  one place.

## Files touched

`shared/types.ts`, `main/config/store.ts`, `renderer/App.tsx`,
`renderer/components/Settings.tsx`, `renderer/components/Sidebar.tsx` (export),
`renderer/components/ModuleManager.tsx` (new), `renderer/i18n/translations.ts`
(en/pl/vi keys; component has English fallbacks for other locales).

## Out of scope (YAGNI)

No backend/per-salon entitlement changes, no multi-device sync, no role gating,
no per-module deep config — purely local show/hide on this device.
