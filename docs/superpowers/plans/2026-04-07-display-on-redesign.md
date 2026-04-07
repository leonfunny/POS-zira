# Display On Redesign Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the concierge-style redesign for Display On after `Touch to explore`, including independent persisted display language.

**Architecture:** Add a small set of shared customer-display helpers plus a reusable kiosk shell, then split the current monolithic customer-display check-in/catalog experience into focused screen components. Keep existing IPC/state contracts unless a config save hook is required for display language persistence.

**Tech Stack:** Electron, React 18, TypeScript, Tailwind, Vitest

---

### Task 1: Add docs and config contract

**Files:**
- Create: `docs/superpowers/specs/2026-04-07-display-on-concierge-design.md`
- Create: `docs/superpowers/plans/2026-04-07-display-on-redesign.md`
- Modify: `src/shared/types.ts`
- Modify: `src/main/config/store.ts`
- Modify: `src/preload/preload-display.ts`
- Modify: `src/shared/electron.d.ts`

- [ ] Add `customerDisplayLanguage` to shared config typing.
- [ ] Add `customerDisplayLanguage` to the config schema with the same language enum as POS.
- [ ] Expose `saveConfig` in the display preload bridge.
- [ ] Update display preload typings in `electron.d.ts`.

### Task 2: Add failing tests for customer-display language and flow helpers

**Files:**
- Create: `tests/customer-display-model.test.ts`
- Create: `src/renderer/windows/customer/customer-display-model.ts`

- [ ] Write failing tests for:
  - display language fallback order
  - booking filtering for the booking lookup screen
  - phone digit sanitization / minimum-search behavior
  - browse catalog grouping behavior used by the redesigned flow
- [ ] Run the targeted test file and confirm failure before implementation.
- [ ] Implement only the helper logic required to make those tests pass.

### Task 3: Build the kiosk shell and redesigned screens

**Files:**
- Create: `src/renderer/windows/customer/components/CustomerDisplayShell.tsx`
- Create: `src/renderer/windows/customer/components/CustomerDisplayLanguageMenu.tsx`
- Create: `src/renderer/windows/customer/components/checkin/CheckInHomeScreen.tsx`
- Create: `src/renderer/windows/customer/components/checkin/PhoneCheckInScreen.tsx`
- Create: `src/renderer/windows/customer/components/checkin/BookingLookupScreen.tsx`
- Create: `src/renderer/windows/customer/components/checkin/WalkInScreen.tsx`
- Create: `src/renderer/windows/customer/components/checkin/BrowseCatalogScreen.tsx`
- Modify: `src/renderer/windows/customer/views/CheckInView.tsx`
- Modify: `src/renderer/windows/customer/views/SalonInteractiveView.tsx`
- Modify: `src/renderer/windows/customer/CustomerApp.tsx`
- Modify: `src/renderer/i18n/translations.ts`

- [ ] Replace the current `CheckInView` layout with an orchestrator that uses the new shell and purpose-built screens.
- [ ] Redesign the post-idle home screen around fast-arrival hierarchy.
- [ ] Redesign phone check-in for keypad + live results + fallback.
- [ ] Redesign booking lookup for fast name search and short confirmation path.
- [ ] Redesign walk-in flow for minimal identity first and clear continuation.
- [ ] Redesign browse services as catalog + handoff, not a second primary selection engine.
- [ ] Remove emoji-based category/icon rendering and replace it with consistent SVG/icon treatment.
- [ ] Add or update translations needed by the new UI copy.

### Task 4: Verify behavior and regressions

**Files:**
- Test: `tests/customer-display-model.test.ts`

- [ ] Run the targeted vitest file for new helper logic.
- [ ] Run the existing POS store test file to catch display-flow regressions.
- [ ] Run a renderer typecheck or build command that proves the new customer-display code compiles.
- [ ] Summarize any remaining manual-only checks:
  - touch targets
  - language persistence
  - idle/back flow
  - unchanged `Touch to explore`
