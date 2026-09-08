# P2 follow-up: restaurant history presentation

## Scope and design (before implementation)

- Staff need the historical service type, table ID, covers, course and notes when inspecting or refunding a restaurant order on either Windows or Android. Use the shared React history screen; do not change money, payment/refund request construction, API permissions or DB schema.
- Prefer local detail for a local order. Server-list items must not replace the local item IDs or notes merely because backend_id matches. Only a server-origin row uses server-list items. Fence asynchronous selection responses so an older request cannot replace the newer selected order.
- Render metadata as escaped text, retain multiline notes and allow long IDs/text to wrap. Reuse existing POS translations. Display table ID as an ID, not an invented historical table name; do not look up the current table layout to rename historical data. Unknown values remain absent, not zero/default course.
- Header/course presentation is restaurant-mode only. Existing retail/billiard layouts and financial values stay unchanged.
- Server line metadata requires an explicit association to persisted item identity. The current contract is being verified by the backend agent. Do not guess using product name, product ID or response array order.

## File impact and ownership

Parent modifies `src/renderer/components/pos/OrderHistoryModal.tsx`; creates `src/renderer/components/pos/RestaurantHistoryMetadata.tsx` and `tests/restaurant-history-ui.test.tsx`. Client agent separately owns Windows inbound adapter/repo and its shared header parser; no overlapping edits. No migration, new API, permission or dependency.

## Risk and verification

- High: wrong item identity in refund view. Exercise the actual history screen with conflicting server/local duplicate-product fixtures, assert local detail is used and notes stay on the correct row.
- Medium: late selection response replaces a newer order. Test requests resolving out of order.
- Medium: unknown historical metadata rendered as fact. Test absent/invalid metadata, non-restaurant mode, zero covers, unsupported course, multiline HTML-looking notes.
- Tests render shared components and real modal in happy-dom; this is not native WebView/device or real payment/printing acceptance. Run renderer typecheck and related history/refund/adapter tests after implementation.

## Printing boundary

No fiscal receipt payload/driver edits in this slice. Android remote-print contract and Windows order-copy payload need separate review; displaying notes does not prove they are printed. Existing test APK predates these source changes and must not be relabelled as including this follow-up.

## Outcome

- Actual UI regressions (local detail incorrectly replaced by server items; stale selection response) failed before integration changes and pass after the fix.
- Shared presentation uses existing lowercase dine_in/takeout/delivery contract, labels from all seven POS languages, escaped/wrapping notes and zero covers. Old source=SERVER mirrors do not display unproven default courses/notes. No table-name lookup or schema migration.
- 20 UI tests pass, including duplicate-product refund selection and explicit unsupported Android refund-print feedback. Parent's combined 11-suite history/adapter/refund/financial regression gate passes 128 tests. Android web/sync/boundary verification passes; no native APK built in this follow-up.
- Android agent separately blocked misleading sale reprint for refund receipts. Parent's nested refund reprint UI now prioritizes the returned explicit error over the generic “reprint from history” suggestion.
- Backend agent confirmed canonical c6576a51 lacks orderItemId association on snapshot lines. Per-line server recovery is blocked by the written server change request; financial fields/tenant rules remain unchanged.
- Final frozen-source `npm run build` PASS (renderer typecheck, main TypeScript, Windows renderer); `npm run android:sync` PASS; `git diff --check` PASS. Existing bundle-size/Browserslist and sql.js browser-externalization warnings remain, with boundary verifier passing. No production deploy or native APK update.
