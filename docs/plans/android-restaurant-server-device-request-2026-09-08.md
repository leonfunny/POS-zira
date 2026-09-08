# Remaining gates for Windows/Android restaurant parity

Status: original request and acceptance checklist, superseded in part by `android-windows-pos-parity-master-2026-09-08.md`. Layout client integration and backend metadata implementation now exist in development worktrees; see that plan for verified tests and remaining gates. No production POS, account or printer was changed; backend changes are NOT deployed.

## Independent-register constraint

Android sells independently. Share salon catalog/configuration and completed-order reporting, not Windows live carts, shifts, table occupancy or open checks. Server contracts must enforce authenticated salon scope and device identity where needed. Renderer-supplied salon identity is not authority.

## 1. Actual table layout

Windows reference: `src/main/database/repos/table-repo.ts` supplies local reads/status/covers/upsert; `src/main/database/seed.ts` supplies demo tables. Android now has scoped local storage and lifecycle methods, but does NOT seed demo tables. This change does not implement a layout configuration/import UI.

Backend team: confirm the authenticated layout read contract, or implement it if absent. Required fields: stable table ID, name, zone, capacity, sort order, active flag and revision. Exclude another register's current order/status/covers. Retain local tables referenced by unfinished checks when a layout deactivates/deletes them. Alternatively approve a device-local layout editor; choose one source before client integration.

Acceptance: tenant separation; two terminals using a layout without sharing open checks; no-table counter sales; offline cached layout; failed reads must not become an empty layout.

## 2. Restaurant order metadata round-trip

Verified client limitation: the inspected Windows `src/main/sync/order-sync.ts` and Android `shim/real-transport.ts:buildOrderDto` send order type/mode/tip, but do not forward local table/covers or line notes/course. Android v5 retains these locally, plus allocated discount/payable total per line. This does not prove the backend lacks support: its whitelist/round-trip contract still needs confirmation.

Backend team: confirm accepted and returned fields before extending client DTOs. Required meaning: register ID, client order idempotency ID, optional table reference/label, guest count, dine-in/takeout/delivery, line identity, preparation notes, course, discount allocation, tenders and tip. Specify money units (local integer grosze vs existing API PLN decimals). Validate totals without double-applying discounts. Retry with the same ID must produce one order.

Acceptance: sync/reload/refund/history preserve amounts and metadata; cross-tenant references fail; a lost response and retry never duplicate an order.

## 3. Kitchen, pickup and printing

Android kitchen-category/pickup mutations remain unavailable. Kitchen setters now return failure rather than fake success. Existing remote customer-copy/fiscal-print adapters remain; no live printer was exercised.

Confirm staff-authenticated kitchen routing, submit/status/cancel/reprint and pickup claim/release/settle contracts with idempotency and device ownership. Define printer roles/category routing, line-delta vs full-ticket semantics, send time/course and UNKNOWN/timeout reconciliation. Kitchen acknowledgment differs from payment and customer receipts. Enqueue does not mean printed. Do not invent endpoints or successful client stubs for missing contracts.

## 4. Native acceptance

Need current Android POS model/version and scanner, scale and printer models/connections; confirm whether fiscal printing uses a salon agent. The historical Sunmi plan does not identify the current restaurant's hardware. Independent selling must not depend on a Windows POS session.

Build-host preflight: Node 24.13.0, npm 11.6.2, Java 1.8.0_503; project requires Node 22.22.2, npm 10.8.2, Java 21.0.11. SDK environment variable is unset. Preflight now reports mismatches instead of crashing on npm.cmd. No APK install, signing or production rollout occurred.

After toolchain repair, test native build, rotate/background/kill/restart, persistence, touch/keyboard/scanner, independent shifts, two tables, takeout/delivery, save/recall, payment, offline sync and receipt/fiscal/kitchen failure recovery. Use a named test salon and approved test hardware only.

## Limits

- Unsaved carts remain volatile, matching the current Windows baseline. Recovery begins at Save check/recalled-check editing, not every unsaved cart.
- Pending/uncertain checks without ledger proof stay locked. Owner reconciliation/cancellation UI is not added (also unfinished in the current Windows check implementation).
- Desktop-only auxiliaries such as local drivers, second display, PDF export and other stubbed administration are not made equivalent by sharing the restaurant screen.
- Unit/browser/build success is not native/backend/printer acceptance. Do not label this release 100% parity yet.
