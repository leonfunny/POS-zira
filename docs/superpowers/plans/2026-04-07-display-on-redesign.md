# Display On Redesign Implementation Plan / Session Handoff

> Use `executing-plans` or equivalent discipline if this work continues in another session. This file is the living handoff, not the original untouched checklist.

## Current State
- Concierge-style Display On redesign is implemented on `main`.
- `Touch to explore` remains the idle entry and the post-idle flow has been rebuilt around:
  - `Check in with phone`
  - `I have booking`
  - `Walk in`
  - `Browse services`
- Display On now persists its own language via `customerDisplayLanguage`, separate from POS language.
- Browse overview copy has been clarified to explicit `services` and `from price` text.
- Phone keypad entry now displays grouped digits as `123 456 789` and caps input at 9 digits.
- Post-implementation cleanup has removed dead legacy files and temporary debug plumbing added during troubleshooting.

## Implemented Files
- `docs/superpowers/specs/2026-04-07-display-on-concierge-design.md`
- `src/main/config/store.ts`
- `src/main/modules/pos.module.ts`
- `src/main/pos/pos-store.ts`
- `src/preload/preload-display.ts`
- `src/renderer/i18n/translations.ts`
- `src/renderer/windows/customer/CustomerApp.tsx`
- `src/renderer/windows/customer/customer-display-model.ts`
- `src/renderer/windows/customer/components/CustomerBookingCard.tsx`
- `src/renderer/windows/customer/components/CustomerDisplayPrimitives.tsx`
- `src/renderer/windows/customer/components/CustomerDisplayShell.tsx`
- `src/renderer/windows/customer/components/WalkInServicePicker.tsx`
- `src/renderer/windows/customer/views/CheckInView.tsx`
- `src/renderer/windows/customer/views/SalonInteractiveView.tsx`
- `src/shared/electron.d.ts`
- `src/shared/types.ts`
- `tests/customer-display-model.test.ts`

## Cleanup Applied
- Removed unused customer-display legacy files:
  - `src/renderer/windows/customer/views/InteractiveView.tsx`
  - `src/renderer/windows/customer/views/UpsellStrip.tsx`
- Removed unused `maxDuration` from browse-category summaries.
- Removed temporary customer-display debug bridge code from:
  - `src/preload/preload-display.ts`
  - `src/main/modules/pos.module.ts`
  - `src/renderer/windows/customer/CustomerApp.tsx`
- Added `.superpowers/` to `.gitignore` so local brainstorm artifacts stop polluting git status.

## Verification History
- `npm test`
- `npm run build`

Latest expected evidence before further completion claims:
- full Vitest suite passes
- full build passes

## Completed Checklist

### Task 1: Config and contract
- [x] Add `customerDisplayLanguage` to shared config typing.
- [x] Add `customerDisplayLanguage` to the config schema with the same language enum as POS.
- [x] Expose config save to the customer display so language changes persist.
- [x] Update display preload typings in `electron.d.ts`.

### Task 2: Helper tests and model
- [x] Add tests for display language fallback order.
- [x] Add tests for booking filtering.
- [x] Add tests for phone sanitization and display formatting.
- [x] Add tests for browse category summarization.
- [x] Implement helper logic to satisfy those tests.

### Task 3: UI architecture and flows
- [x] Introduce a shared kiosk shell for redesigned customer-display screens.
- [x] Split customer-display UI into smaller focused components instead of one monolithic view.
- [x] Redesign the post-idle home screen around fast-arrival hierarchy.
- [x] Redesign phone check-in for keypad, live results, and walk-in fallback.
- [x] Redesign booking lookup for fast search and short confirmation flow.
- [x] Redesign walk-in flow for identity first, then service selection.
- [x] Redesign browse services as catalog + handoff, not a second main engine.
- [x] Replace emoji-driven customer-display visuals with consistent SVG/icon treatment.
- [x] Add translations required for the new copy.

### Task 4: Verification
- [x] Run targeted customer-display tests.
- [x] Run broader POS/display regression tests.
- [x] Run full build validation.

## Remaining Manual Checks
- Verify language persistence by changing Display On language, closing the customer window, and reopening it.
- Recheck `Touch to explore` visually after any future shell/layout changes.
- Confirm the interactive fallback in `CustomerApp.tsx` is still needed once salon-only customer-display usage is fully certain.
- Continue iterative polish on spacing, panel density, and hierarchy based on live screenshots rather than assumptions.

## Recommended Next Session
1. Polish remaining “safe” panels that still feel too generic.
2. Audit secondary summaries/side rails for any remaining duplicated information.
3. Validate the full customer-display flow on the real Electron window, not only via screenshots and tests.
