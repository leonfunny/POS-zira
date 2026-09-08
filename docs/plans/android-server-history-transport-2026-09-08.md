# Android server history transport — 2026-09-08

## Current result

Implemented the two history ports and exact existing detail GET, using the shared adapter and synchronous Android SERVER-only cache repository. **147 tests passed across 6 suites**, including **31 new history tests**; renderer TypeScript and Android source boundary verification pass. No new APK, installed database, server mutation or deployment. Refund detail remains explicitly unavailable, and Billiard history import is rejected by the repository rather than dropping its policy metadata. Fiscal-only history is a separate parent-owned guard; this slice supplies no fiscal evidence.

## Requirements and scope

Provide the shared Windows history namespace with an Android server-list read and explicit one-order history mirror. Cashier/owner users authenticate with their current staff JWT. Android remains an independent selling register; reading/importing history is not a sale, stock change, shift assignment or upload. Refund detail remains unavailable because refund execution safety is not yet approved.

## Architecture and contracts

Reuse GET `/api/v1/b2b/pos/orders` with existing filters/pagination and GET `/api/v1/b2b/pos/orders/{cash|invoiced}/:id`; only a 404 triggers the other existing detail kind. No new backend endpoint or mutation. Use the client agent's browser-safe shared `adaptServerOrder` / `adaptServerOrderItem` and synchronous Android `upsertFromServer(adapted, items)` returning `{inserted, localOrderId}`. Only an explicit mirror request writes the local cache. List responses never import automatically.

Return `{orders, items, total, page, limit, source}` where `source` distinguishes server, unconfigured and network-error; mirror returns `{success, localOrderId?, wasSplit?, error?}`. Validate server order ID, unique nonblank item IDs, declared parent ownership and declared salon identity before mapping. Absent legacy salon/parent fields rely on the authenticated endpoint contract; mismatches are rejected. No fuzzy item identity or metadata reconstruction.

Capture salon ID, authenticated user ID, token and resolved server URL before asynchronous work. Recheck on each read response, immediately before local mutation, before flush and before returning data. Any staff/salon/server/token switch fails closed with no stale response returned. Auth uses the existing refresh machinery; token rotation invalidates an in-flight history snapshot and requires a fresh read rather than adopting another token implicitly. This is deliberately conservative until a general session-generation API exists.

The captured immutable config-object reference is also checked: `setConfig` replaces it, so staff/salon switch-away-and-back (ABA) still rejects the old response even if values/token are restored. Any config update conservatively requires a fresh history read; no permanent listener is installed. Token-only rotation is compared by value; normal logout/login additionally changes the config identity.

## Tradeoffs and risks

An explicit single-order mirror avoids full-history sync load and duplicate sales. Strict malformed/ownership rejection is preferred to incomplete or silently re-associated lines. The repository owns local-POS protection by local/backend ID and SERVER-only insertion with synced=1 and shift=NULL. No new schema in this slice (69/8 provenance already exists). Main risks are cross-user response leakage, local data overwrite, false empty-history success and flush failure; use captured context, repository collision guards and explicit failure results. No UI text/i18n edits here; existing UI receives errors through its current namespace.

## File impact before coding

- Modify `shim/real-transport.ts`: instantiate guarded history helper using existing auth/config/DB dependencies.
- Modify `port/api-client.ts`: detail GET and optional history request-context guard; retain existing refresh and endpoint handling.
- Modify `shim/transport.ts`: two optional history ports.
- Modify `shim/stubs.ts`: namespace delegation; keep refund detail unavailable.
- Create `shim/server-history.ts`: bounded list/mirror orchestration and response validation.
- Create `tests/android-server-history.test.ts`: mocked network plus isolated database tests.
- This plan/report. Paths above are relative to `src/renderer/android-pos/` except tests/docs.

Client agent owns shared adapter and Android order repository; parent owns UI. No overlapping edits, installed database, APK, deploy, live network write, payment or printing.

## Implementation order and acceptance

First define failing transport tests; then wire typed ports/API guard and helper; integrate shared adapter/repository after client signals ready. Cover list filters and empty/error/unconfigured distinction, cash/invoiced fallback, parent/salon/item rejection, staff/token/server/logout changes during awaits, protected local paid/pending orders, reversed same-product line notes/course, persistence failures and refund unavailability. Run focused Node/Vitest checks only; production/native acceptance remains separate.

Tier 2 graph project `C-Users-maxis-enail-POS-zira-release-foundation`, generation `2026-09-08T08:50:16Z`: five graph matches for API methods/transport/namespace, no remaining pagination. Source metadata changed, so exact direct reads supply current contracts. Windows reference: `src/main/modules/pos.module.ts` history handlers and `src/main/network/api-client.ts` detail GET. No live endpoint request performed.

## Verification and limitations

- Red gate before implementation: 9 failures from unconfigured/no-mirror stubs in the initial 17-test suite. Green final gate: `npx vitest run tests/android-server-history.test.ts tests/android-port-api-client.test.ts tests/android-real-transport.test.ts tests/android-shim.test.ts tests/android-refund.test.ts tests/pos-order-adapter.test.ts` — **147/147** (31+30+32+29+7+18).
- Proven cases: list filters/pagination, no automatic import, empty/error/unconfigured distinction, 404-only alternate detail kind, malformed/foreign/duplicate parent/item identities, raw original-date requirement, staff/salon/server/token/logout changes during response, switch-away-and-back, context checks after lazy DB and durability awaits, exact reversed same-product notes/course, local primary/backend ID collision preservation, no stock/shift alteration, flush failure, and explicit refund-detail unavailability.
- `npm run typecheck:renderer` — PASS. `npm run test:android:boundaries:source` — PASS, 153 source files scanned. `git diff --check` for owned existing source — PASS.
- A direct `npx tsc -p tsconfig.android.json --noEmit` attempt reports three pre-existing configuration/type-surface errors: missing JSX option for AndroidBootApp, missing wasm `?url` declaration, and ImportMeta.env. That configuration is used by the boundary verifier; the project-wide renderer typecheck includes proper JSX/Vite declarations and passes. No config changes made to hide these diagnostics.
- API history guards are optional for pre-existing callers. On an in-flight 401 refresh, a rotated token invalidates the captured history scope; the refreshed session is retained and the next read succeeds. Parent accepted this explicit retry behavior. A synthetic transport retains its prior default limit 50; real Windows-shaped history uses limit 20 unless supplied.
- All network behavior is mocked; all DB writes use isolated SQL.js memory storage. A context change after an already-valid cache transaction/durability operation rejects the response but does not roll back that prior history cache write. It is not a new sale. Broader auth/session generation and native persistence/device acceptance remain separate work.
- Coverage checked for all edited and supporting source/test paths: source metadata changed or new/untracked, tests/docs excluded; direct material-source reads supplement the stale graph. No exhaustive whole-app correctness claim.
