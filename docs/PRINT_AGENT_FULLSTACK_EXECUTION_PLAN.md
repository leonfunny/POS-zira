# PRINT_AGENT FULLSTACK EXECUTION PLAN

## 1. Purpose

This plan is the implementation guide for stabilizing and completing the `print-agent` desktop app for POS use cases, with focus on:

- 4 POS vertical modes: `retail`, `salon`, `b2b`, `restaurant`
- customer-facing screen with 2 simple states:
  - idle ads mode (no interaction)
  - touch interaction mode (when customer touches screen)

This document is written for full-stack developers and can be executed phase by phase.

---

## 2. Current Reality (from code review)

### Critical issues now

1. Customer display can crash when promo mode has no images.
2. POS window tries to call `window.electronAPI.setConfig(...)` but POS preload does not expose `setConfig`.
3. Renderer TypeScript is not enforced in build; current renderer typecheck has many errors.
4. Touch interaction mode is not implemented in customer display.

### Medium issues now

1. Customer monitor selection behavior is inconsistent with Settings UI expectation.
2. Promo loading and mode transitions have race-condition risk.
3. Duplicate POS layout code paths increase maintenance risk.
4. No automated tests in this app.

---

## 3. Product Rules (must keep simple for salon staff)

1. No technical wording in POS/customer UI.
2. Big buttons, clear labels, minimal steps.
3. If internet fails, checkout flow still works locally.
4. Customer display must auto-recover to idle ads.
5. Any setting change must be obvious and reversible.

---

## 4. Target Architecture

### 4.1 Customer Display State Machine

Use one explicit display state machine in main process:

- `idle`
- `promo`
- `cart`
- `thankyou`
- `interactive`

Transitions:

- `idle -> promo` after idle timeout if promo assets available.
- `promo -> interactive` when touch event received.
- `interactive -> promo` after interaction timeout.
- `cart -> thankyou` on payment complete.
- `thankyou -> promo|idle` after short delay based on promo availability.

### 4.2 Ownership

- Main process (`pos-store`) is source of truth for display state.
- Customer renderer only renders state and emits touch events.
- POS renderer only dispatches business actions; no local display logic forks.

### 4.3 Offline-first

- Orders, shifts, and local catalog remain local-first in sqlite (`sql.js`).
- Customer display must not depend on network for base behavior.

---

## 5. Delivery Plan by Phase

## Phase 0 - Stabilize Build and Crash Paths (P0)

### Task P0-1: Fix promo fallback crash

- Goal: no runtime crash when promo list is empty.
- Files:
  - `src/renderer/windows/customer/views/PromoView.tsx`
  - `src/renderer/windows/customer/views/IdleView.tsx`
  - `src/renderer/windows/customer/CustomerApp.tsx`
- Steps:
  1. Pass translation function to `IdleView` in all call paths.
  2. Add safe fallback UI if translation is unavailable.
  3. Add guard for invalid `currentIndex` when image list changes.
- Done when:
  - switching to promo with zero images does not crash.
  - display renders stable idle screen.

### Task P0-2: Expose config setters in POS preload

- Goal: POS language/config changes work in POS window.
- Files:
  - `src/preload/preload-pos.ts`
  - `src/renderer/components/pos/POSLayout.tsx`
- Steps:
  1. Expose `setConfig`/`saveConfig` in POS preload bridge.
  2. Align return type in renderer.
  3. Add visible error toast/log in POS if save fails.
- Done when:
  - changing POS language persists after restart.

### Task P0-3: Enforce renderer typecheck in build

- Goal: release cannot ship with renderer TS errors.
- Files:
  - `package.json`
  - optional CI workflow file under `.github/workflows/*`
- Steps:
  1. Add `typecheck:renderer` script: `tsc -p tsconfig.renderer.json --noEmit`.
  2. Include typecheck in `build` or CI required check.
  3. Fix all blocking TS errors.
- Done when:
  - `npm run build` fails on renderer type errors.
  - renderer typecheck passes clean.

### Task P0-4: Fix IPC type-contract mismatches

- Goal: preload bridge, shared types, and renderer calls are consistent.
- Files:
  - `src/shared/electron.d.ts`
  - `src/preload/preload.ts`
  - `src/preload/preload-pos.ts`
  - related renderer components and hooks
- Steps:
  1. Audit each IPC function signature and return type.
  2. Normalize to one contract per API.
  3. Remove stale method names/parameter shapes.
- Done when:
  - no TS mismatch from IPC contract layer.

---

## Phase 1 - Implement Customer Touch Interaction Mode (P0)

### Task P1-1: Add touch event channel

- Goal: customer display can tell main process that someone touched screen.
- Files:
  - `src/preload/preload-display.ts`
  - `src/main/windows/window-manager.ts` (or dedicated module)
  - `src/main/modules/pos.module.ts` (if IPC registration centralized)
- Steps:
  1. Add IPC event like `display:touch`.
  2. Register listener in main process.
  3. Dispatch `display/setMode` to `interactive` when valid.
- Done when:
  - touch from customer renderer always reaches main process.

### Task P1-2: Build interactive mode UI

- Goal: simple customer UI appears on touch.
- Files:
  - `src/renderer/windows/customer/CustomerApp.tsx`
  - `src/renderer/windows/customer/views/*`
- Steps:
  1. Add `InteractiveView`.
  2. Capture click/touch/pointer events at root layer.
  3. Add configurable inactivity timer (return to promo/idle).
- Done when:
  - tap on idle/promo opens interactive screen.
  - no tap for timeout returns to promo/idle.

### Task P1-3: Protect state transitions from races

- Goal: async promo loading cannot override newer state.
- Files:
  - `src/main/pos/pos-store.ts`
- Steps:
  1. Add transition token/version or timestamp check.
  2. Deduplicate promo loading paths.
  3. Apply state only if request token is still latest.
- Done when:
  - rapid mode changes do not produce wrong final state.

---

## Phase 2 - Multi-monitor Reliability and Settings UX (P1)

### Task P2-1: Make monitor mapping deterministic

- Goal: selected monitor in Settings always matches actual target display.
- Files:
  - `src/main/windows/window-manager.ts`
  - `src/renderer/components/Settings.tsx`
- Steps:
  1. Define monitor selection strategy explicitly:
     - index `0` means primary only
     - index `n` means exact display index if exists
  2. Remove hidden fallback that contradicts user selection.
  3. Add log when selected monitor is unavailable.
- Done when:
  - opening customer display uses expected monitor every time.

### Task P2-2: Add dynamic display list in settings

- Goal: user chooses from real connected display names.
- Files:
  - main IPC module for display listing
  - preload bridge
  - `src/renderer/components/Settings.tsx`
- Steps:
  1. Expose `display:list` API from main.
  2. Render real options (id, bounds, primary flag).
  3. Save selected display id/index.
- Done when:
  - settings show real monitors instead of fixed options 0..3.

---

## Phase 3 - POS Code Health and Regression Safety (P1)

### Task P3-1: Remove duplicate POS layout path

- Goal: one active UI path for each mode.
- Files:
  - `src/renderer/components/pos/*`
  - `src/renderer/components/pos/templates/*`
- Steps:
  1. Identify unused old layouts.
  2. Migrate any missing behavior into templates.
  3. Remove or archive dead files with clear note.
- Done when:
  - there is one canonical implementation path.

### Task P3-2: Add minimum automated tests

- Goal: protect critical flows before release.
- Suggested tests:
  1. unit test for display state transitions (`pos-store`).
  2. unit test for promo fallback behavior.
  3. integration smoke for IPC bridge contracts.
- Done when:
  - tests run in CI and block regressions in P0/P1 areas.

---

## 6. Database and Data Plan

## 6.1 Current DB usage

- Local sqlite via `sql.js`, persisted to `pos.db`.
- Core POS domain tables already exist (orders, items, shifts, products, staff, tables, customers, quick keys).

## 6.2 Optional schema extension (only if analytics needed)

If product needs touch analytics:

- Add table: `customer_display_events`
  - `id`
  - `event_type` (`touch`, `enter_interactive`, `exit_interactive`, `promo_start`)
  - `created_at`
  - `session_id` (optional)
  - `metadata_json` (optional)

Do not block MVP on this table.

---

## 7. QA Checklist (must pass before release)

### 7.1 Core POS flows

1. Retail checkout: cash/card complete.
2. Salon checkout with staff assignment and tip.
3. B2B checkout with customer and invoice payment mode.
4. Restaurant checkout with table status lifecycle.

### 7.2 Customer display flows

1. Open customer window on selected monitor.
2. Idle ads loop with valid images.
3. Promo mode with no images does not crash.
4. Touch enters interactive mode.
5. Inactivity timeout returns to promo/idle.
6. Payment flow shows cart -> thankyou -> promo/idle.

### 7.3 Failure and recovery

1. Disconnect network during active POS session.
2. Reconnect and verify app remains stable.
3. Close/reopen customer window repeatedly.
4. Hot-plug second monitor during runtime.

---

## 8. Suggested Timeline

- Week 1:
  - Phase 0 complete (all P0 tasks)
- Week 2:
  - Phase 1 complete (touch mode + state-machine hardening)
- Week 3:
  - Phase 2 + Phase 3 + QA + release candidate

---

## 9. Release Gate (hard gate)

Release is allowed only when all are true:

1. No crash in customer display known paths.
2. Renderer typecheck passes.
3. Touch interaction mode passes QA checklist.
4. Monitor selection behavior is deterministic.
5. P0 issues are closed and verified on Windows build.

---

## 10. Out of Scope for this execution

1. New marketing automation feature expansion (already in separate module).
2. Rebuild of staff module domain logic (already existing in ecosystem).
3. Redesign of all POS screens.

This plan focuses on stability, correct behavior, and operator simplicity first.
