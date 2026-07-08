# Products Stability & Core UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` and `test-driven-development` to implement this plan task-by-task.

**Goal:** Make the Products tab safe for daily operation, then improve its core usability and restrained feedback.

**Architecture:** Keep sales catalog reads active-only and add a separate admin read for inactive products. Reuse the existing Product Admin mutations, shared Modal, VAT configuration IPC, and ProductModule-level toast state. No database migration or backend endpoint change is allowed.

**Tech Stack:** Electron, React 18, TypeScript, Tailwind CSS, Vitest, Playwright.

---

## Phase 1: Operational correctness

- [x] Keep one idempotency key for retries of the same stock/category-create intent; rotate it after success or when the intent changes.
- [x] Recover partial product saves by refreshing the canonical variant and retrying only the remaining stock mutation.
- [x] Add an admin-only inactive catalog read, inactive filter, and backend-backed reactivate action.
- [x] Make Enter select the first text search result before attempting barcode resolution.
- [x] Load active configured VAT rates, filter to supported non-negative product rates, and fall back to 23/8/5/0.

## Phase 2: Safety and core UX

- [x] Route product overlays through the shared accessible Modal and one guarded close path.
- [x] Keep create/edit/stock/deactivate/reactivate success feedback in ProductModule-level toasts.
- [x] Disable no-op saves, separate basic and advanced fields, and normalize operator-facing terminology.
- [x] Raise primary controls to 44px and restyle product tiles with neutral surfaces plus compact stock status.
- [x] Keep transitions to 150-200ms and disable them under reduced-motion preferences.

## Verification

- [x] Add regression tests before each behavior change and observe them fail.
- [x] Run targeted product tests, then the full Vitest suite.
- [x] Run `npm run typecheck:renderer` and `npm run build`.
- [x] Smoke test at 1280x800 and 1024x700 without mutating a production catalog.

## Deferred

- Audit/history UI, CSV/bulk editing, deep category manager redesign, and a backend `trackInventory`/`itemType` contract.
