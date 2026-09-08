# P2: explicit restaurant line identity round-trip

## Approved scope / requirements

User approved the preceding server change request with “làm tiếp”. Restore notes/course for the exact restaurant item in history without swapping duplicate products. Backend code/tests stay in the existing Netcup task worktree at base c6576a51; local POS changes stay in POS-zira-release-foundation. No production deploy, payments, printing, device installation or account changes in this slice.

## Design and trade-offs

1. Backend links each restaurant snapshot line to the actual saved B2BOrderItem.id using `orderItemId`, inside the same transaction as order/items creation. Preserve localLineId/productId/lineIndex and existing metadata version. The relation must derive from explicit input → calculated line → entity correspondence, not a later ORM relation order. Client DTO must not accept server-generated orderItemId. Keep request idempotency hashing on the original input, before enrichment.
2. Client validates version/header, unique localLineId and orderItemId, product identity, and line fields. Match by explicit server item ID only; no fallback by product/name/array order. Legacy snapshots without links remain unknown. Financial fields/tenant checks/refund identity never derive from notes.
3. Add nullable `order_items.restaurant_line_id TEXT` in Windows migration 69 and Android schema 8. It records the validated source localLineId only for server-imported items. A durable marker is necessary because old server mirrors have a guessed default course=1; notes/course alone cannot prove their origin. No backfill or deletion. Alternative using an unrelated billiard JSON field was rejected as mixing contracts; an in-memory-only marker would disappear on restart.
4. Existing source=SERVER rows may have notes/course/marker repaired only by exact item ID and validated product identity. Source=POS/local sales retain their IDs, notes, immutable upload and money. Shared UI shows server-line metadata only with the durable verified marker; local Android history continues to use its own stored lines.

## File impact and ownership

- Backend agent: `backend/src/modules/b2b/services/{restaurant-pos-metadata,b2b-pos.service}.ts`, corresponding metadata/idempotency tests, backend design report. No controller/DTO/entity migration unless the verified design requires and parent reviews it.
- Client agent: shared restaurant-history parser/helper, `src/main/sync/pos-order-adapter.ts`, `src/main/database/repos/order-repo.ts`, parser/adapter/repo tests.
- Native agent: `src/main/database/migrations.ts`, `src/renderer/android-pos/shim/db/schema.ts`, relevant migration/schema tests.
- Parent: `src/renderer/components/pos/{RestaurantHistoryMetadata,OrderHistoryModal}.tsx`, `tests/restaurant-history-ui.test.tsx`, this plan and master/rollout diary; independent cross-layer review/tests.

## Verification / risks

- Wrong line note (HIGH): duplicate products with different notes, returned items reversed, duplicate/malformed links, mismatched product, missing IDs; no positional guesses.
- Partial persistence (HIGH): saved order/item enrichment failure rolls back before stock/events/commit; idempotent replay does not recreate entities or stock movements. Backend tests must exercise actual service path.
- Upgrade data loss (HIGH): fresh/old/repeated migrations preserve local pending/paid rows, notes/course, amounts and upload snapshots. Old provenance remains NULL.
- Compatibility (MEDIUM): legacy/billiard/retail tests and money regression suites, renderer/main typecheck, Windows build and Android web boundary verification. No native business acceptance claim from unit/build results.
- Test evidence is separate from release status. Existing APK predates this change. Backend signature/hash contract and production refs must be revalidated before any later deployment.

## Implementation and independent verification (08/09, latest)

- Backend worktree now carries `restaurantLocalLineId` through both PIECE/WEIGHT calculations, strips it before entity persistence, assigns server UUIDs and links the snapshot by explicit local ID. The scoped JSON update requires one affected order and uses the same transaction. Request hashes and financial calculations are unchanged. Two service files and two test files changed; no backend schema migration.
- Shared parser rejects incomplete/duplicate/mismatched links as a whole. Windows adapter/repository preserve server item IDs and persist verified notes/course plus `restaurant_line_id`; repair is limited to exact source=SERVER rows. Local sales, money and frozen uploads are preserved.
- Shared history detail and refund-selection UI require a proven marker for server rows; local history continues to display its own notes. Windows migration 69 / Android schema 8 add a nullable marker, with no legacy backfill. This follows design-reasoning's explicit identity boundary rather than guessing from product or array position.
- Parent POS gate: 35 suites / 472 tests PASS, plus 4 dedicated provenance migration tests PASS (476 distinct tests; agent runs overlap and are not added). New actual-SQLite round-trip suite covers reversed duplicate products, export/reopen, legacy repair, local preservation, invalid metadata, transactional rollback and conflicting markers. Two UI regressions failed before the UI fix and passed afterward.
- Parent backend gate: six metadata/create/refund/entitlement suites / 147 tests PASS on the frozen Netcup source. Agent additionally demonstrated ten new service tests fail on base c6576a51. Transaction tests use a mocked QueryRunner; this is not a live PostgreSQL transaction acceptance test. POS integration tests use real SQL.js with the actual migration runner/adapter/repository and synthetic API data, not a live end-to-end sale.
- Windows `npm run build` PASS. Android `npm run android:sync` PASS, including 150-source / 5-bundle / 7-native-asset boundary checks. Existing bundle-size/Browserslist/sql.js warnings remain. These are not APK or hardware acceptance results.
- Graph generation 2026-09-08T08:50:16Z was stale/untracked for affected files; exact source and diffs were read. Remote graph was unavailable; remote source was authoritative. No exhaustive graph-audit claim.

## Release status and next work

Subsequent user continuation implemented Android list/mirror/import using this contract; see `android-server-history-continuation-2026-09-08.md`. Backend full typecheck was independently rerun and passed. The next-work paragraph below records the handoff before that continuation; refund/receipt/device gates remain open.

No commit, land, production deployment, native APK rebuild/install, payment or print operation in this slice. Backend changes remain in the existing task worktree on base c6576a51; the earlier release manifest does NOT cover the new service/helper hashes. Before production, re-land and rerun the guarded exact-source promotion checks. The existing test APK predates this work.

Next: implement Android server history transport/import using the shared validator, then actual refund-detail/partial-refund history and receipt support. Keep Android local history and independent selling intact. Native signing, device upgrade/data retention and real hardware acceptance remain open; overall parity is not 100%.
