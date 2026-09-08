# Android history / receipt parity — P2 review, 2026-09-08

## Current result

Latest schema follow-up: Windows migration **69** and Android schema **8** now add the nullable `order_items.restaurant_line_id` provenance marker. **50 tests passed in 5 suites**, including fresh databases, v68/v7 upgrades, repeat apply and exported-image reload. This is schema/preservation verification, not completed server history/refund parity. No installed database was opened or migrated; no new APK/build/deployment.

Completed the bounded assessment and the approved refund-print safety correction. **43 tests passed** across `android-refund` (7), `android-shim` (29) and `android-remote-print` (7); no live network/printer call and no APK build or deployment. Android now refuses unsupported refund printing instead of printing the original sale as a refund. History/server import and refund financial parity are still incomplete.

## Durable line-link schema design — approved follow-up

Requirement: retain the exact validated server restaurant snapshot `localLineId` on a mirrored history item, without treating it as authorization or a refund item ID. Add `order_items.restaurant_line_id TEXT`, nullable with SQL NULL default, on Windows migration 69 and Android schema 8. Existing rows (including old SERVER rows) remain NULL; there is no name/SKU/position-based backfill. The client mapper owns validation and writes this marker only for verified SERVER links. Local POS identity and financial authority stay unchanged.

Architecture/tradeoff: one additive nullable column is sufficient; no new table, index, unique constraint, API, state migration or tenant behavior is needed. Unknown provenance is explicit NULL instead of a guessed relationship. The column is not a foreign key: the originating line can belong to another independent register. Tenant validation remains the mapper/request-context responsibility, not this column's authority.

File impact (before implementation): append migration only in `src/main/database/migrations.ts`; add fresh-column plus guarded upgrade/version 8 in `src/renderer/android-pos/shim/db/schema.ts`; update schema assertions in `tests/android-shim-db.test.ts` and migration assertions in `tests/migrations.test.ts`; add a focused migration regression file if needed using synthetic SQL.js databases and the actual Windows migration runner. This report records evidence. Other agents own repository/parser/UI changes; do not modify their files.

Safety gate: prove fresh installation, Windows v68 upgrade, Android v7 upgrade and repeated Android apply preserve every pre-existing order/item value, including pending/local-paid state, notes/course, financial amounts and frozen sync JSON. Verify old SERVER markers remain NULL, newly stored exact markers survive persistence/reapply, and no duplicate column is created. Run focused tests only; no installed database, APK/native build, signing, publish, commit or production operation. Existing N1 APK does not contain this follow-up.

### Schema implementation and verification

- Windows appends migration 69 only; prior migrations are untouched. Android includes the column in fresh DDL and a `PRAGMA table_info`-guarded additive ALTER for existing images before stamping version 8. No backfill, unique/index/foreign-key constraint or authorization change.
- Added `tests/restaurant-line-provenance-migration.test.ts` using the actual Windows migration runner and isolated SQL.js Android images. Six same-SKU/variant lines across pending POS, synchronized local-paid POS and legacy SERVER orders retain every original column value, including different notes/course, discounts and frozen JSON. NULL remains NULL even when an old JSON payload contains a tempting line ID. A manually seeded exact SERVER marker survives export/reload/reapply, while all other markers stay NULL.
- Parent additionally authorized the single version expectation in `tests/android-order-repo-safety.test.ts` (7 → 8). No other changes to that file.
- Command: `npx vitest run tests/restaurant-line-provenance-migration.test.ts tests/migrations.test.ts tests/android-shim-db.test.ts tests/android-order-repo-safety.test.ts tests/migration-runner.test.ts` — **50/50 passed**, 5/5 files. Counts: dedicated migration 4, Windows migration assertions 13, Android shim DB 20, Android order safety 4, Windows runner 9.
- Tier 2 graph confirmed the nearest project/generation and located migration/schema symbols. Coverage for edited/cited files reports source metadata changed and tests/docs excluded; relevant source was read directly, including the actual Windows transaction/version runner. These tests use synthetic databases only and do not establish native device persistence or server mapper correctness.

## Scope and file impact before implementation

Read-only assessment of Android history sources, local persistence, server-list wiring, line identity and sale/refund receipt payloads compared with Windows. No endpoint creation, source import, API mutation, payment, print job, build, device installation or deployment is authorized by this assessment.

Parent subsequently approved one surgical safety correction: `src/renderer/android-pos/shim/stubs.ts` must stop routing `printRefundReceipt` to the ordinary sale reprint; `tests/android-refund.test.ts` will verify an explicit unsupported failure with `receiptPrinted:false`, a clear message, no sale-printer call and no network. Refund API/state and ordinary receipt reprints remain unchanged. This is an honest feature limitation until a true refund projection and its renderer are verified, not completed refund-print parity.

Shared receipt/UI changes belong to parent; Windows inbound mapper/repository belongs to the client agent. No overlapping edits are made here.

## Findings (bounded source evidence)

1. Android `real-transport.ts:1248–1256` obtains history/details only from local `createOrderRepo`: SQL `orders` and `order_items`. It does not fetch or merge server history in these methods.
2. An existing authenticated list client already exists: `port/api-client.ts:921`, `getServerOrders`, GET `/api/v1/b2b/pos/orders`. Android shim `stubs.ts` still hardcodes `getServerList` to `source:'unconfigured'`, `mirrorFromServer` to `no-server-mirror`, and `getRefundDetail` to unavailable. Scoped search across `src/renderer/android-pos` finds no `getServerOrders` callsite besides its definition. Therefore the missing list behavior is wiring/mapping/cache policy, not evidence that a new backend list endpoint is required.
3. Windows shared history UI requests local history and, when non-fiscal history is enabled, server list; merges by local/backend IDs and uses a server items map. Windows IPC supplies the mapped server list; Android's fixed unconfigured result makes that same UI local-only.
4. Android repo `create` already persists `table_id`, `covers`, `order_type`, `mode`, tip and exact item `id`, notes, course, allocated discount and payable total. `getById`/`getItemsByOrderId` return all columns. `markSynced` changes sync state/backend ID/optional order number, not those metadata columns. Existing reload tests verify restaurant metadata and per-line allocation. Thus successful outbound sync does not itself erase local restaurant metadata.
5. Android `syncOrders` is an outbound pending-order loop, with frozen request and durable acknowledgement. It does not ingest the server order/items response into a history mirror. The newly-uploaded `restaurant.localLineId` must remain the local row ID; identical product/variant/SKU/name is not sufficient line identity when notes/course differ.
6. Android `remote-print.ts:222–251` builds sale receipt data without table/covers/order type. Its item mapper `:182–204` drops notes/course and allocation display fields. `ReceiptData`/`ReceiptItem` currently have no restaurant field contract. Windows sale receipt projection also lacks restaurant fields, so this metadata gap needs a shared schema/rendering decision, not only an Android rename. Windows does support non-fiscal `displayLineDiscount`, absent from the Android mapper.
7. Android sale reprint reads local rows, sets `isReprint`/original date and sends a fresh `POS_RECEIPT_REPRINT` job. Before the safety correction, `printRefundReceipt` invoked this identical sale path: original sale items/total rather than refunded items/amount and `isRefund`. Windows instead constructs a real refund payload (`isRefund`, refund amount/reason/lines/original reference) and `POS_REFUND_RECEIPT`. This can print the wrong document and must not report success as refund printing.
8. Refund persistence does not delete original restaurant columns or item rows, but `markRefunded` replaces `refund_lines` with the latest supplied array while recording cumulative refund amount. Repeated partial refunds therefore risk mismatching cumulative amount and line audit trail. Android also lacks Windows' authoritative refund-detail refresh and exact server-item matching/response validation. This review does not change refund API/state; these are separate financial P2 blockers.
   The current shared UI's `loadAuthoritativeRefundDetail` requires a successful `getRefundDetail` before proceeding. Android's unavailable stub therefore blocks this path; a passing direct transport refund test is not proof that the full refund UI works.
9. Android local history filters implement from/to/paymentMethod/staffName/page/limit, not the full Windows fiscal/invoice filtering contract. The shared modal passes `fiscalOnly`; it is ignored by this repo. Exact parity needs dedicated tests and a decision for fiscal evidence rather than treating an ignored field as supported.

## Existing API versus new endpoint decision

- List: reuse the existing `getServerOrders` endpoint after mapping and tenant/context checks; no new endpoint demonstrated necessary.
- Detail/refund: Windows already calls GET `/api/v1/b2b/pos/orders/cash/:id` or `/invoiced/:id`; Android has not ported that client/detail-refresh path in the bounded files inspected. Verify these existing contracts/permissions and metadata responses before proposing a new endpoint.
- Import must be explicitly read-only history cache/mirror: never call local sale `create()` in a way that decrements stock, opens/reassigns another device's shift/check, emits a new paid sale or re-enqueues upload. Android remains an independent register.
- Initial sale/refund printing must preserve job intent and unknown-outcome guards. Do not piggyback a refund onto sale reprint or invent backend refund rendering support from generic `ReceiptData` typing.

## Required follow-up tests (not claimed done)

- Two lines with same product/SKU but different localLineId, notes, course and discounts survive local read → sync → server response → mirror → detail.
- Existing local pending/uncertain/frozen order is never overwritten by server history; backend IDs deduplicate without dropping local-only rows.
- Server history unavailable remains distinguishable from empty history and local-only; no salon/user switch applies stale responses.
- Partial refund repeated on the exact line preserves previous refund audit, cumulative money and remaining refundable quantity. Wrong/missing server line ID fails closed.
- Sale and refund document payloads remain distinct; restaurant metadata prints only in the approved non-fiscal/kitchen context, not by silently changing legal fiscal semantics.
- Fiscal/invoice filters and history totals/pagination match Windows for the supported sources.

## Evidence and limits

Tier 2 graph project `C-Users-maxis-enail-POS-zira-release-foundation`; supplied generation `2026-09-08T08:50:16Z`. Graph located `getOrderHistory`, `getOrderDetail`, `buildSaleReceiptData`, `buildReceiptItems`, `getServerOrders`, `buildOrdersNamespace`; inbound trace confirms receipt projection serves sale and fiscal coordinators. Direct source was read for the material paths due to changed/excluded coverage; scoped grep is used for missing wiring, not a claim about the entire repository/backend.

Coverage checked for all 17 cited source/test paths plus scope `src/renderer/android-pos`: source paths reported metadata changed with no recorded ranges; relevant tests excluded by fast-pattern; scoped graph coverage reported no recorded gap, which is not proof of completeness. Direct reads covered the relevant method/range for each material finding, and whole-scope literal checks confirmed the currently unconnected Android server list.

No production/server inspection is performed in this P2 assessment. Endpoint existence is evidenced by current clients, not a new live API acceptance test. No APK from earlier N1 includes the new refund-print safety change until a future fresh source snapshot/build.

## Refund-print result contract after safety correction

`printRefundReceipt(orderId)` resolves:

```json
{
  "success": false,
  "receiptPrinted": false,
  "reason": "unsupported",
  "code": "ANDROID_REFUND_RECEIPT_UNSUPPORTED",
  "error": "Refund receipt printing is not available on Android yet. No receipt was printed."
}
```

No fallback to sale reprint, no print job, no printer lookup, no refund state or money mutation. Tests cover both a transport with a receipt coordinator and the synthetic/no-port case, assert no coordinator or network calls, and verify ordinary sale reprint still delegates normally.

Parent-owned UI follow-up: the history row reprint handler already surfaces `result.error`; the nested refund success view's `handlePrintRefundReceipt` currently passes the result to `deriveReceiptOutcome`, which ignores error/code and suggests reprinting from history. Parent has been notified to prefer the explicit unsupported message there. This report does not claim that UI change is already delivered.
