# Android restaurant functional parity

## Requirements (design-reasoning)

User requests Windows restaurant functions, not just its theme. STAFF/OWNER use shared UI and check lifecycle. Android is an independent register: separate cart, shifts, table occupancy and open checks. Catalog/completed-order integrations keep the salon backend contract. Full parity requires native/hardware acceptance, not only web build success.

## Architecture and trade-offs

Reuse RestaurantCheckStore and lift the Windows controller into a platform-neutral module with a narrow runtime port and typed Windows wrapper. Avoid two money/check state machines. SQL.js/IndexedDB persists additive v5 restaurant checks, salon-scoped local tables and a durable device identifier. Do not seed demo tables or import Windows live data.

IndexedDB must acknowledge transaction completion, not request success. Missing/unreadable storage fails closed. Preserve corrupt bytes and block boot until explicit recovery. A failed durability barrier locks check/payment commands until restart/reconciliation. One runtime guards async operations with busy state and an auth epoch. Restore checkout fields but retain the current local shift. Never prune open checks. Paid checks require durable COMPLETED orders; pending without proof stays locked. Block tenant clearing with unfinished checks or pending orders.

Table layout must describe the actual restaurant; no fabricated endpoint or seed. Existing Windows read/status/covers/clear APIs are the local reference. Server metadata round-trip/layout configuration, printing and native hardware are separate acceptance gates. If missing backend behavior is required, draft a server change request under AGENTS.md instead of a client workaround.

## File impact and migration

CREATE shared `restaurant-check-controller.ts`; Android `shim/restaurant-runtime.ts`, `shim/db/restaurant-table-repo.ts`; runtime/durability tests and test persistence helper if needed.

MODIFY Windows `src/main/pos/restaurant-check-controller.ts` (wrapper), Android `shim/{index,transport,real-transport,pos-store}.ts`, `shim/db/{schema,db}.ts`, shared restaurant capability/UI where runtime becomes available; affected Android tests to explicitly inject test storage. Preserve unrelated dirty changes.

MIGRATE: additive local schema only, no destructive/server migration. Keep scoped checks/layout across logout; do not clear unfinished transactions on tenant switch.

## Verification order and risks

1. Durability: abort after request success, storage unavailable/read failure, concurrent flush and reload.
2. Shared Windows controller regression.
3. Real Android SQL.js tests: save/open/edit, >20 checks, two tables, restart, distinct devices/users/salons, concurrent operations, failed saves, paid/uncertain boundaries. Synthetic data only.
4. Shared UI using the Android shim and actual capabilities, no counter-only banner when runtime exists.
5. Windows build, Android source/web/bundle/native-assets checks, then native/device acceptance. No production install/restart or real payment without a test context.

## Implemented / remaining

Shared lifecycle is now wired into the real Android shim (synthetic-only installs stay counter-only). Local v5 adds checks, scoped tables/device ID and line discount allocation. Auth/shift/context changes cannot interrupt an active durable operation. Parallel startup reads are serialized; shift hydration retains the actual current local shift. Real saved/recall UI is covered alongside runtime/SQL.js tests. Kitchen category writes now refuse unsupported operations.

Durability policy tightened: corrupt/empty existing images are preserved and block boot pending explicit recovery, NOT replaced with a fresh financial database. Missing/read-failed IndexedDB also fails closed. No pending check is pruned or silently reconciled without a durable order.

Additional file impact: Android order-repo line allocation columns; opt-in browser fixture now includes Checks; Windows-compatible toolchain preflight invocation in `scripts/verify-android-toolchain.mjs`. Test persistence is explicit, not a production memory fallback.

Status: NOT 100% complete. See `android-restaurant-server-device-request-2026-09-08.md` for actual table layout, metadata/backend, kitchen and native acceptance gates. Device models requested asynchronously. Native preflight now reports Node/npm/Java mismatches and missing SDK environment; no APK or production deployment claimed.

## Verification record (2026-09-08)

- 31 related suites / 435 tests passed together; an additional v4-to-v5 preservation test then passed with the other 3 order-repository safety tests (436 unique related tests verified).
- 13 opt-in Chromium theme/responsiveness tests passed, including Android bundled CSS at 1280x800, 1024x768 and 800x1280. These are UI fixtures, not native hardware tests.
- Windows `npm run build` passed; final `typecheck:renderer` passed after the Android edits.
- Final `android:sync` passed: web build, 147-file source boundary, built-bundle boundary and native-assets boundary. This sync copies web assets; it does not produce or install an APK.
- `git diff --check` passed. Native preflight remains blocked as documented in the companion request; no production/real-payment tests performed.
