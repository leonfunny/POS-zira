# P2 follow-up: trustworthy restaurant history

## Requirement

Restaurant staff need historical table, covers, service type, notes and course when reading a Windows or Android order. History must retain correct local line identities and never attach another preparation instruction to the same product. Scope here is server-to-Windows adapter/repository and a browser-safe shared header reader. Parent owns UI and Android assessment. Financial/refund/tenant/upload contracts stay unchanged.

## Evidence and blocking contract gap

Review mirror `C:/Users/maxis/AppData/Local/Temp/pos-backend-review-20260908` contains backend snapshot `externalMetadata.meta.restaurant = {schemaVersion:1,tableId,tableName,covers,lines:[{localLineId,productId,lineIndex,notes,course}]}`. `buildRestaurantPOSSnapshot` derives lineIndex from submitted DTO. `b2b-pos.service.ts` independently creates/saves B2BOrderItem entities; snapshot has no resulting server order-item ID. `posOrderType` stores dine_in/takeout/delivery. Source checked exactly; latest backend confirmation requested.

**Per-line server history restoration is blocked**: returned item array position is not a guaranteed original DTO index, and duplicate product IDs can have different notes/courses. No index/name/product fallback will be implemented. Existing local rows retain their own line metadata.

### Server change request (not implemented here)

Persist an explicit immutable `orderItemId` on each restaurant snapshot line in the same transaction that creates the B2BOrderItem, or expose an equivalently validated per-item restaurant identity. Preserve localLineId and tie it to the actual generated server item ID before commit. Return this link through detail/list/sync read paths. Test duplicate product IDs with distinct notes/courses and reversed item order. Old snapshots without provable links must remain unlinked; do not backfill by relation order. Metadata-only addition can use existing JSON without a schema migration, subject to backend review.

## Safe implementation

1. Strict shared header reader accepts only restaurant mode, schemaVersion 1, integer covers 0..10000, valid optional IDs, and canonical posOrderType dine_in/takeout/delivery. Missing/malformed/legacy headers return null; no guessing from current table layout or business mode.
2. Adapter exposes table_id/covers/order_type only when validated, with an internal provenance marker. Financial code is untouched.
3. Server mirroring stores validated header on newly inserted rows. Existing `source='SERVER'` rows can be repaired from a valid header; locally originated rows are never overwritten. Invalid/missing incoming header does not clear existing data.
4. Per-line mapping remains unchanged; tests explicitly demonstrate that duplicate-product arrays cannot acquire snapshot notes/course by index.

## Trade-off / impact / risks

- Correct partial history is preferred to potentially swapping preparation instructions. No speculative per-item contract adapter is added.
- CREATE `src/shared/restaurant-history-header.ts`, `tests/restaurant-history-header.test.ts`.
- MODIFY `src/main/sync/pos-order-adapter.ts`, `src/main/database/repos/order-repo.ts`, `tests/pos-order-adapter.test.ts`, `tests/order-repo-upsert.test.ts`.
- No migrations, server edits, network writes, deployments or hardware actions.
- HIGH local provenance loss: update only server mirrors with validated marker; preserve local IDs, notes, money and frozen upload JSON.
- HIGH mismatched notes: no line mapping until server identity link exists.
- MED malformed legacy metadata: fail closed to absent header; preserve prior local data.

Verification: shared parser boundary tests, adapter metadata/financial regression, mirror insert/repair preservation, existing retail/billiard adapter and repository suites, TypeScript checks. Graph generation 2026-09-08T08:50:16Z marks current source metadata_changed and tests excluded; exact source reads and direct tests supply verification.

## Verified outcome

Latest backend canonical `c6576a51` confirmed the same missing per-line identity link: B2BOrderItem.id is generated independently and returned relation items have no guaranteed original order. Header restoration is implemented; exact server preparation-line restoration remains blocked by the server change request above. Newly imported restaurant lines without proven course now store null (unknown), not an invented first course; existing local sales and retail imports retain their behavior. tableName is not persisted because this bounded change introduces no migration.

Seven focused/regression suites passed 70 tests before the final explicit legacy-course regression was added. Final test and typecheck results are reported in task handoff. No server mutations, commits, deployments or package installs were performed.

## Approved linked-line extension (next implementation)

User approved the server change request. Backend owner confirms additive `meta.restaurant.lines[].orderItemId` assigned server-side, explicitly linked through calculation by localLineId; matching product identity is exactly `(item.variantId || item.productId)`. Legacy snapshots remain unlinked. Client implementation will validate the entire v1 metadata/item set before exposing any line: unique localLineId and orderItemId, exact server item ID/product identity, required valid course, optional bounded notes, valid header, no unknown line fields, no positional or name fallback.

Parent approved a durable nullable `order_items.restaurant_line_id TEXT` marker storing the verified original localLineId. Native/release owner implements Windows migration 69 and Android schema 8 with default NULL and migration tests. This task owns optional OrderItemRow field, adapter and server-mirror insert/repair, plus parser/repository tests. Parent owns UI: server-origin lines may expose preparation metadata only when this durable marker exists. It grants no permission and changes no refund identity.

Existing source=SERVER line repair requires exact persisted server item ID + product ID; source=POS lines are never changed. Conflicting existing markers or ambiguous metadata produce no line repair. Invalid/legacy payloads preserve previously proven data. New inserts use NULL notes/course/marker when no verified link; no synthetic provenance based on old default course1. Financial and frozen-upload fields stay untouched.

### Linked-line implementation result

- Shared parser and adapter now accept the explicitly linked contract only. Entire metadata and returned item sets must match by unique server ID + canonical product identity; order ID, schema/header, local identity, notes/course bounds and known shape are checked. Reversed duplicate-product arrays are covered. Legacy unlinked snapshots remain ignored.
- Repository inserts the durable restaurant_line_id marker only inside the same transaction as verified notes/course. Existing source=SERVER repairs require matching persisted item ID, order ID and variant ID for the full batch; existing conflicting provenance skips the entire line repair rather than silently rebinding. source=POS context, line IDs, notes, money, refunds and upload snapshots are unchanged.
- Nine focused/regression suites passed 120 tests. Parent independently added real SQL.js/full-migration/export-reopen integration tests, including partial-write rollback; those are owned and verified by the parent. Main/renderer typechecks are rerun before final handoff.
- Migration 69/schema 8 are owned by the native/release agent. Backend linkage and UI visibility are owned by their assigned agents. This task makes no production, commit, native-install or server-write claims.
